import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {OwnerWorkAuthority} from '../src/qq-chat/owner-work-authority.mjs';

const oldScope='a'.repeat(64),newScope='b'.repeat(64),identity='c'.repeat(64),permissionDigest='d'.repeat(64);
const cwd=path.resolve('qa/work-authority-fixture'),owner='123456789',account='987654321',key='private:'+owner;
const proof={found:true,owned:true,running:false,pending:false,cwd};
function fixture(t,{bind=true}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE chats(key TEXT PRIMARY KEY,doc TEXT NOT NULL);
 CREATE TABLE owner_work_session(slot INTEGER PRIMARY KEY,scope TEXT,session_id TEXT,generation INTEGER,status TEXT,turn_id TEXT,turn_through INTEGER,pending_excerpt TEXT,updated_at INTEGER,completed_count INTEGER,recovery_mode INTEGER);
 CREATE TABLE owner_work_previous(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT,session_id TEXT,generation INTEGER,reason TEXT,at INTEGER,pending_excerpt TEXT);`);
 db.prepare('INSERT INTO chats VALUES(?,?)').run(key,JSON.stringify({key,latestSeq:12,readThrough:5}));
 db.prepare('INSERT INTO owner_work_session VALUES(1,?,?,1,?,NULL,8,?,0,1,0)').run(oldScope,'old-session','idle',JSON.stringify({records:['old']}));
 let scope=oldScope,auth={serviceIdentity:identity,permissionDigest,owner,account,cwd},idle=true,probes=0,created=0,discarded=[];
 const control=new OwnerWorkAuthority({db},{scopeNow:()=>scope,authorityNow:()=>auth,isIdle:()=>idle,now:()=>123});
 if(bind)control.bind(oldScope,{sessionId:'old-session',generation:1,observed:proof});
 db.prepare("UPDATE owner_work_session SET status='uncertain'").run();scope=newScope;
 return {db,control,get scope(){return scope},setScope:v=>scope=v,setAuth:v=>auth={...auth,...v},setIdle:v=>idle=v,get probes(){return probes},get created(){return created},discarded,request:()=>({acknowledged:true,probe:async()=>{probes++;return {...proof};},createCandidate:async()=>{created++;return 'new-session';},discardCandidate:async s=>discarded.push(s)})};
}
test('人设等作用域变更后人工核查：原子保存旧会话、推进旧回合水位并绑定新会话',async t=>{
 const f=fixture(t),result=await f.control.recoverChangedScope(f.request());assert.equal(result.sessionId,'new-session');assert.equal(result.previousSessionPreserved,true);assert.equal(f.probes,2);
 const row=f.control.row();assert.equal(row.scope,newScope);assert.equal(row.sessionId,'new-session');assert.equal(row.generation,2);assert.equal(row.status,'idle');
 const chat=JSON.parse(f.db.prepare('SELECT doc FROM chats WHERE key=?').get(key).doc);assert.equal(chat.readThrough,8);assert.equal(chat.latestSeq,12);
 const prior=f.db.prepare('SELECT * FROM owner_work_previous').get();assert.equal(prior.session_id,'old-session');assert.equal(prior.reason,'uncertain-scope-recovery');assert.ok(prior.pending_excerpt);
 const binding=f.control.binding(row);assert.equal(binding.owner,owner);assert.equal(binding.serviceIdentity,identity);assert.deepEqual(f.discarded,[]);
});
test('旧不确定会话缺少事前绑定时不能补绑或恢复',async t=>{
 const f=fixture(t,{bind:false});await assert.rejects(f.control.recoverChangedScope(f.request()),/缺少身份绑定/);assert.equal(f.created,0);assert.equal(f.control.row().status,'uncertain');
 assert.throws(()=>f.control.bind(oldScope,{sessionId:'old-session',generation:1,observed:proof}),/状态已改变/);
});
test('必须明确人工核查，QQ、DSH 或访问权限变化不能恢复',async t=>{
 const f=fixture(t);await assert.rejects(f.control.recoverChangedScope({...f.request(),acknowledged:false}),/人工核查/);
 for(const changes of [{owner:'111111111'},{account:'222222222'},{serviceIdentity:'e'.repeat(64)},{permissionDigest:'f'.repeat(64)},{cwd:path.resolve('qa/elsewhere')}]){f.setAuth(changes);await assert.rejects(f.control.recoverChangedScope(f.request()),/不能自动恢复/);f.setAuth({owner,account,serviceIdentity:identity,permissionDigest,cwd});}
 assert.equal(f.created,0);assert.equal(f.control.row().sessionId,'old-session');
});
test('旧会话不在、工作区不符、仍在运行或有待处理项目时不创建新会话',async t=>{
 const f=fixture(t);for(const observed of [{...proof,found:false},{...proof,cwd:path.resolve('qa/other')},{...proof,running:true},{...proof,pending:true},{...proof,owned:false}])await assert.rejects(f.control.recoverChangedScope({...f.request(),probe:async()=>observed}));
 assert.equal(f.created,0);assert.equal(f.control.row().status,'uncertain');
});
test('创建候选期间身份变化不能跨身份丢弃候选或切换原会话',async t=>{
 const f=fixture(t),options=f.request();options.createCandidate=async()=>{f.setAuth({serviceIdentity:'f'.repeat(64)});return 'foreign-candidate';};
 await assert.rejects(f.control.recoverChangedScope(options),/已改变/);assert.equal(f.control.row().sessionId,'old-session');assert.deepEqual(f.discarded,[]);
});
test('创建候选后旧会话开始工作，则保留旧状态并安全丢弃本身份候选',async t=>{
 const f=fixture(t),options=f.request();let n=0;options.probe=async()=>++n===1?proof:{...proof,running:true};
 await assert.rejects(f.control.recoverChangedScope(options),/仍在运行/);assert.deepEqual(f.discarded,['new-session']);assert.equal(f.control.row().status,'uncertain');
});
test('事务校验失败时消息水位不推进、旧记录不变',async t=>{
 const f=fixture(t),options=f.request();options.createCandidate=async()=>{f.db.prepare("UPDATE owner_work_session SET turn_through=99").run();return 'new-session';};
 await assert.rejects(f.control.recoverChangedScope(options),/已改变/);assert.equal(JSON.parse(f.db.prepare('SELECT doc FROM chats WHERE key=?').get(key).doc).readThrough,5);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM owner_work_previous').get().n,0);assert.deepEqual(f.discarded,['new-session']);
});
test('并发恢复仅允许一项，且用户之后新增消息不会被旧水位标为已读',async t=>{
 const f=fixture(t),options=f.request();let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);options.createCandidate=async()=>{started();await gate;return 'new-session';};
 const first=f.control.recoverChangedScope(options);await entered;await assert.rejects(f.control.recoverChangedScope(f.request()),/正在进行/);
 f.db.prepare('UPDATE chats SET doc=? WHERE key=?').run(JSON.stringify({key,latestSeq:15,readThrough:5}),key);release();await first;const chat=JSON.parse(f.db.prepare('SELECT doc FROM chats WHERE key=?').get(key).doc);assert.equal(chat.readThrough,8);assert.equal(chat.latestSeq,15);
});
function addJournal(f){f.db.exec('CREATE TABLE owner_tool_journal(id TEXT PRIMARY KEY,scope TEXT,account TEXT,owner TEXT,status TEXT,reviewed_at INTEGER)');return (id,scope,acct,who,status,reviewed=null)=>f.db.prepare('INSERT INTO owner_tool_journal VALUES(?,?,?,?,?,?)').run(id,scope,acct,who,status,reviewed);}
test('跨 scope 恢复只将旧作用域和已验证 QQ 身份的不确定操作标为已核查，不改操作结果',async t=>{
 const f=fixture(t),add=addJournal(f);add('match',oldScope,account,owner,'uncertain');add('reviewed',oldScope,account,owner,'uncertain',44);add('other-owner',oldScope,account,'111111111','uncertain');add('other-account',oldScope,'222222222',owner,'uncertain');add('new-scope',newScope,account,owner,'uncertain');add('success',oldScope,account,owner,'success');
 await f.control.recoverChangedScope(f.request());const rows=Object.fromEntries(f.db.prepare('SELECT id,status,reviewed_at FROM owner_tool_journal').all().map(r=>[r.id,r]));
 assert.equal(rows.match.status,'uncertain');assert.equal(rows.match.reviewed_at,123);assert.equal(rows.reviewed.reviewed_at,44);for(const id of ['other-owner','other-account','new-scope','success'])assert.equal(rows[id].reviewed_at,null);assert.equal(rows.success.status,'success');
});
test('身份不符或旧作用域仍有运行操作时不能核查日志或恢复',async t=>{
 const f=fixture(t),add=addJournal(f);add('uncertain',oldScope,account,owner,'uncertain');f.setAuth({account:'222222222'});await assert.rejects(f.control.recoverChangedScope(f.request()),/不能自动恢复/);assert.equal(f.db.prepare('SELECT reviewed_at FROM owner_tool_journal WHERE id=?').get('uncertain').reviewed_at,null);
 f.setAuth({account});add('running',oldScope,account,owner,'running');await assert.rejects(f.control.recoverChangedScope(f.request()),/执行中/);assert.equal(f.db.prepare('SELECT reviewed_at FROM owner_tool_journal WHERE id=?').get('uncertain').reviewed_at,null);assert.equal(f.control.row().status,'uncertain');
});
test('日志已核查与消息水位和映射切换在同一事务：后续出错整体回滚',async t=>{
 const f=fixture(t),add=addJournal(f);add('uncertain',oldScope,account,owner,'uncertain');f.db.prepare('DELETE FROM chats WHERE key=?').run(key);
 await assert.rejects(f.control.recoverChangedScope(f.request()),/会话记录不存在/);assert.equal(f.db.prepare('SELECT reviewed_at FROM owner_tool_journal WHERE id=?').get('uncertain').reviewed_at,null);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM owner_work_previous').get().n,0);assert.equal(f.control.row().sessionId,'old-session');assert.deepEqual(f.discarded,['new-session']);
});
