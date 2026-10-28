import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {DshSessionCleanup,dshServiceIdentity} from '../src/dsh-session-cleanup.mjs';

const base=path.resolve('qa/dsh-session-cleanup-tests');fs.mkdirSync(base,{recursive:true});
const dir=()=>fs.mkdtempSync(path.join(base,'case-'));
const a='a'.repeat(64),b='b'.repeat(64);
const workspace=path.resolve('qa/dsh-session-cleanup-tests/model-workspace'),goodVerify=async()=>true;
const item=(channel,identity,sessionId)=>({channel,identity,sessionId,expectedCwd:workspace});

test('DSH 身份绑定本机凭据和配置目录，不含端口或凭据原文',t=>{
 const root=dir(),secret=randomBytes(32).toString('base64url'),file=path.join(root,'.credentials.yaml');
 fs.writeFileSync(file,JSON.stringify({records:{'client-connection/browser-session':{kind:'grant',payload:{version:1,secret}}}}));
 const first=dshServiceIdentity({directory:root}),again=dshServiceIdentity({directory:root});
 assert.match(first,/^[a-f0-9]{64}$/);assert.equal(first,again);assert.ok(!first.includes(secret));
 assert.notEqual(dshServiceIdentity({directory:root,instanceId:'separate-store'}),first);
 fs.writeFileSync(file,JSON.stringify({records:{'client-connection/browser-session':{kind:'grant',payload:{version:1,secret:randomBytes(32).toString('base64url')}}}}));
 assert.notEqual(dshServiceIdentity({directory:root}),first);assert.equal(dshServiceIdentity({directory:path.join(root,'missing')}),null);
 fs.writeFileSync(file,'records: {}');assert.equal(dshServiceIdentity({directory:root}),null);
});

test('注册同步持久化；当前活动回合及其它 DSH 身份绝不被自动归档',async t=>{
 const root=dir(),q=new DshSessionCleanup(root,{ownerPid:11001,runId:'worker-1'});t.after(()=>q.close());
 const live=item('qq',a,'qq-live'),finished=item('weixin',a,'wx-finished'),foreign=item('qq',b,'foreign');
 assert.equal(q.register(live),true);assert.equal(q.register(live),false);q.register(finished);q.register(foreign);assert.equal(q.finish(finished),true);assert.equal(q.finish(foreign),true);
 const archived=[],r=await q.retry({verify:goodVerify,identity:a,archive:async({sessionId})=>{archived.push(sessionId);return true;}});
 assert.deepEqual(archived,['wx-finished']);assert.equal(r.completed,1);assert.deepEqual(q.stats(),{active:1,pending:1,cancelPending:0,unbound:0});
 assert.equal(q.confirmArchived(live,true),true);assert.equal(q.finish(foreign),false);assert.equal(q.confirmArchived(foreign,true),true);assert.equal(q.stats().active+q.stats().pending,0);
});

test('归档未确认、失败和 not-found 均保留，按退避间隔重试，成功后才移除',async t=>{
 const root=dir();let clock=100000;const q=new DshSessionCleanup(root,{now:()=>clock});t.after(()=>q.close());const entry=item('qq',a,'fixture-retain');q.register(entry);q.finish(entry);
 const calls=[],first=await q.retry({verify:goodVerify,identity:a,archive:async({sessionId})=>{calls.push(sessionId);throw Object.assign(Error('missing'),{code:'session/not-found'});}});
 assert.equal(first.failed,1);assert.equal(q.stats().pending,1);assert.equal((await q.retry({verify:goodVerify,identity:a,archive:async()=>true})).attempted,0);
 clock+=30000;assert.equal((await q.retry({verify:goodVerify,identity:a,archive:async()=>undefined})).failed,1);assert.equal(q.stats().pending,1);
 clock+=60000;assert.equal((await q.retry({verify:goodVerify,identity:a,archive:async()=>true})).completed,1);assert.equal(q.stats().pending,0);assert.deepEqual(calls,['fixture-retain']);
});

test('仅确认旧进程已退出的活动会话才先取消再归档；不能确定仍保留',async t=>{
 const root=dir(),old=new DshSessionCleanup(root,{ownerPid:111,runId:'old'});old.register(item('qq',a,'old-session'));await old.close();
 let ownerAlive=true,clock=100000;const current=new DshSessionCleanup(root,{ownerPid:222,runId:'new',now:()=>clock,isProcessAlive:()=>ownerAlive});t.after(()=>current.close());
 const actions=[],call=(verb,answer=true)=>async({sessionId})=>{actions.push([verb,sessionId]);return answer;};
 assert.equal((await current.retry({verify:goodVerify,identity:a,cancel:call('cancel'),archive:call('archive')})).attempted,0);assert.equal(current.stats().active,1);
 ownerAlive=false;assert.equal((await current.retry({verify:goodVerify,identity:a,cancel:call('cancel',false),archive:call('archive')})).failed,1);assert.deepEqual(actions,[['cancel','old-session']]);
 clock+=30000;assert.equal((await current.retry({verify:goodVerify,identity:a,cancel:call('cancel'),archive:call('archive')})).completed,1);
 assert.deepEqual(actions.slice(1),[['cancel','old-session'],['archive','old-session']]);assert.equal(current.stats().active,0);
});

test('中断回合保留待取消状态；取消成功后归档失败，下次只重试归档',async t=>{
 const root=dir();let clock=100000;const q=new DshSessionCleanup(root,{now:()=>clock});t.after(()=>q.close());const entry=item('weixin',a,'incomplete');q.register(entry);q.finish(entry,{cancelRequired:true});assert.equal(q.stats().cancelPending,1);
 const actions=[];const first=await q.retry({verify:goodVerify,identity:a,cancel:async()=>{actions.push('cancel');return true;},archive:async()=>{actions.push('archive');throw Error('offline');}});assert.equal(first.failed,1);assert.deepEqual(actions,['cancel','archive']);assert.equal(q.stats().pending,1);
 clock+=30000;await q.retry({verify:goodVerify,identity:a,cancel:async()=>{actions.push('cancel-again');return true;},archive:async()=>{actions.push('archive-again');return true;}});assert.deepEqual(actions,['cancel','archive','archive-again']);assert.equal(q.stats().pending,0);
});

test('身份不可用不影响会话登记，也绝不自动归档；同一客户端确认后可清除',async t=>{
 const root=dir(),q=new DshSessionCleanup(root);t.after(()=>q.close());const entry=item('qq',null,'unbound-session');q.register(entry);assert.equal(q.stats().unbound,1);
 assert.equal(q.has({channel:'qq',identity:null,sessionId:'unbound-session'}),true);assert.equal(q.has({channel:'weixin',identity:null,sessionId:'unbound-session'}),false);assert.equal(q.has({channel:'qq',identity:a,sessionId:'unbound-session'}),false);
 assert.equal((await q.retry({verify:goodVerify,identity:null,archive:async()=>{throw Error('must not run');}})).unavailable,true);assert.equal(q.listUnbound()[0].sessionId,'unbound-session');
 assert.throws(()=>q.confirmArchived(entry,false),/确认归档/);assert.equal(q.confirmArchived(entry,true),true);assert.equal(q.stats().unbound,0);
 q.register(entry);q.finish(entry);assert.equal(q.listUnbound()[0].state,'pending');assert.equal(q.confirmArchived(entry,true),true);
});

test('并发重试限批、超时保留，并且只调用已登记的指定渠道会话',async t=>{
 const root=dir(),q=new DshSessionCleanup(root,{requestTimeoutMs:200});t.after(()=>q.close());for(const entry of [item('qq',a,'q1'),item('qq',a,'q2'),item('weixin',a,'w1')]){q.register(entry);q.finish(entry);}
 let started,release;const opened=new Promise(r=>started=r),gate=new Promise(r=>release=r),ids=[];
 const pending=q.retry({verify:goodVerify,identity:a,channel:'qq',limit:1,archive:async({sessionId})=>{ids.push(sessionId);started();await gate;return true;}});await opened;
 assert.equal((await q.retry({verify:goodVerify,identity:a,archive:async()=>true})).busy,true);release();assert.equal((await pending).completed,1);assert.deepEqual(ids,['q1']);
 assert.equal((await q.retry({verify:goodVerify,identity:a,channel:'qq',archive:async()=>new Promise(()=>{})})).failed,1);assert.equal(q.stats().pending,2);
 const r=await q.retry({verify:goodVerify,identity:a,channel:'weixin',archive:async({sessionId})=>{ids.push(sessionId);return true;}});assert.equal(r.completed,1);assert.deepEqual(ids,['q1','w1']);assert.equal(q.stats().pending,1);
});

test('工作台退出会中断悬挂的清理请求，并把未归档项留给下次启动',async t=>{
 const root=dir(),q=new DshSessionCleanup(root,{requestTimeoutMs:30000});const entry=item('qq',a,'shutdown-pending');q.register(entry);q.finish(entry);
 let start;const entered=new Promise(r=>start=r);const task=q.retry({verify:goodVerify,identity:a,archive:async()=>{start();return new Promise(()=>{});}});await entered;
 let timer;try{await Promise.race([q.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('关闭超时')),1000);})]);}finally{clearTimeout(timer);}
 assert.equal((await task).failed,1);const reopened=new DshSessionCleanup(root);t.after(()=>reopened.close());assert.equal(reopened.stats().pending,1);
});

test('核对回合所属工作区不匹配或当前服务没有该ID时，不能取消或归档',async t=>{
 const root=dir();let clock=100000;const q=new DshSessionCleanup(root,{now:()=>clock});t.after(()=>q.close());const entry=item('qq',a,'only-banyu-session');q.register(entry);q.finish(entry,{cancelRequired:true});
 const actions=[];const handlers={cancel:async()=>{actions.push('cancel');return true;},archive:async()=>{actions.push('archive');return true;}};
 const otherWorkspace=path.resolve(root,'different-store');let seen;
 let result=await q.retry({identity:a,verify:async context=>{seen=context;return otherWorkspace===context.expectedCwd;},...handlers});
 assert.equal(result.failed,1);assert.deepEqual(actions,[]);assert.equal(q.stats().cancelPending,1);assert.equal(seen.sessionId,entry.sessionId);assert.equal(seen.channel,'qq');assert.equal(seen.expectedCwd,workspace);assert.ok(seen.signal instanceof AbortSignal);
 clock+=30000;result=await q.retry({identity:a,verify:async({sessionId})=>['different-session'].includes(sessionId),...handlers});assert.equal(result.failed,1);assert.deepEqual(actions,[]);
 clock+=60000;result=await q.retry({identity:a,verify:goodVerify,...handlers});assert.equal(result.completed,1);assert.deepEqual(actions,['cancel','archive']);
});

test('未提供核验回调或旧记录缺少工作区路径时保留记录并退避',async t=>{
 const root=dir();let clock=100000;const q=new DshSessionCleanup(root,{now:()=>clock});t.after(()=>q.close());const verified=item('qq',a,'needs-verifier');q.register(verified);q.finish(verified);
 const actions=[];assert.equal((await q.retry({identity:a,archive:async()=>{actions.push('archive');return true;}})).failed,1);assert.deepEqual(actions,[]);assert.equal(q.stats().pending,1);
 assert.equal((await q.retry({identity:a,verify:goodVerify,archive:async()=>true})).attempted,0);
 clock+=30000;assert.equal((await q.retry({identity:a,verify:goodVerify,archive:async()=>true})).completed,1);
 const unknown={channel:'weixin',identity:a,sessionId:'missing-workspace'};q.register(unknown);q.finish(unknown);assert.equal(q.stats().unbound,1);assert.equal(q.listUnbound()[0].sessionId,'missing-workspace');
 let verifyCalls=0;const result=await q.retry({identity:a,verify:async()=>{verifyCalls++;return true;},archive:async()=>{actions.push('archive');return true;}});assert.equal(result.failed,1);assert.equal(verifyCalls,0);assert.deepEqual(actions,[]);assert.equal(q.stats().pending,1);
});

test('旧版队列表安全增列，已有未知路径的记录不会自动处理',async t=>{
 const root=dir(),db=new DatabaseSync(path.join(root,'dsh-session-cleanup.sqlite'));db.exec(`CREATE TABLE dsh_sessions(id INTEGER PRIMARY KEY,channel TEXT NOT NULL,identity TEXT NOT NULL,session_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','pending','cancel_pending')),owner_pid INTEGER NOT NULL,run_id TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,UNIQUE(identity,session_id));`);db.prepare("INSERT INTO dsh_sessions(channel,identity,session_id,state,owner_pid,run_id,created_at) VALUES('qq',?,'old-unknown','pending',1,'old',1)").run(a);db.close();
 const q=new DshSessionCleanup(root);t.after(()=>q.close());assert.equal(q.stats().unbound,1);let called=false;const result=await q.retry({identity:a,verify:goodVerify,archive:async()=>{called=true;return true;}});assert.equal(result.failed,1);assert.equal(called,false);assert.equal(q.listUnbound()[0].sessionId,'old-unknown');
});

test('旧 activeSession 指针只对有身份和同工作区登记的条目匹配，不修改队列',async t=>{
 const root=dir(),q=new DshSessionCleanup(root);t.after(()=>q.close());const entry=item('qq',a,'legacy-active');q.register(entry);q.finish(entry);
 assert.equal(q.has(entry),true);assert.equal(q.has({channel:'qq',identity:a,sessionId:entry.sessionId}),true);
 assert.equal(q.has({...entry,identity:null}),false);assert.equal(q.has({...entry,identity:b}),false);assert.equal(q.has({...entry,channel:'weixin'}),false);assert.equal(q.has({...entry,expectedCwd:path.resolve(root,'other')}),false);
 const noCwd={channel:'qq',identity:a,sessionId:'old-unknown-cwd'};q.register(noCwd);assert.equal(q.has(noCwd),true);assert.equal(q.has({...noCwd,expectedCwd:workspace}),false);assert.equal(q.stats().active,1);assert.equal(q.stats().pending,1);
});
