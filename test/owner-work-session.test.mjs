import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {OwnerWorkSession,ownerWorkScope} from '../src/qq-chat/owner-work-session.mjs';

const cwd=path.resolve('qa/work-session-fixture'),account='1234567',owner='7654321',identity='a'.repeat(64);
const parameters=()=>({serviceIdentity:identity,account,owner,roleId:'role-whale',roleRevision:1,model:{provider:'fixture',model:'model-a'},memoryEpoch:0,permissions:{computer:false},cwd});
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE chats(key TEXT PRIMARY KEY,doc TEXT NOT NULL)');db.prepare('INSERT INTO chats VALUES(?,?)').run('private:'+owner,JSON.stringify({key:'private:'+owner,latestSeq:10,readThrough:10}));
 let scope=ownerWorkScope(parameters()),busy=false,who=owner;
 const create=()=>new OwnerWorkSession({db},{scopeNow:()=>scope,ownerNow:()=>who,accountNow:()=>account,isIdle:()=>!busy});
 return {db,create,get scope(){return scope},setScope:v=>scope=v,setBusy:v=>busy=v,setOwner:v=>who=v};
}
const open=(f,s)=>assert.equal(s.install(f.scope,'session-old'),true);
const turn=(f,overrides={})=>({sessionId:'session-old',generation:1,turnId:'turn-1',chatKey:'private:'+owner,sender:owner,reason:'message',...overrides});
const excerpt={version:1,omitted:0,truncated:0,records:[{type:'message',source:'msg:10',role:'user',text:'你好'}]};

test('主人会话绑定身份、模型、人设、权限、记忆版本和工作路径',()=>{
 const p=parameters(),first=ownerWorkScope(p);assert.match(first,/^[a-f0-9]{64}$/);
 for(const changes of [{serviceIdentity:'b'.repeat(64)},{account:'3333333'},{owner:'4444444'},{roleRevision:2},{memoryEpoch:1},{permissions:{computer:true}},{model:{provider:'fixture',model:'model-b'}},{cwd:path.resolve('qa/other')}])assert.notEqual(ownerWorkScope({...p,...changes}),first);
 assert.equal(ownerWorkScope({...p,model:{model:'model-a',provider:'fixture'}}),first);
 assert.throws(()=>ownerWorkScope({...p,serviceIdentity:null}),/不完整/);
});

test('只能为主号私聊的消息回合使用持久会话，群聊、其他私聊和主动唤醒均拒绝',()=>{
 const f=fixture();try{const s=f.create();open(f,s);
  for(const changes of [{reason:'proactive'},{reason:'timer'},{chatKey:'group:7777777'},{chatKey:'private:1234568',sender:'1234568'},{sender:'1234568'}])assert.equal(s.begin(f.scope,turn(f,changes)),false);
  assert.equal(s.begin(f.scope,turn(f)),true);assert.equal(s.begin(f.scope,turn(f,{turnId:'turn-2'})),false);
 }finally{f.db.close();}
});

test('交接以 SQLite 事务核对主人、来源版本、旧映射和空闲状态',()=>{
 const f=fixture();try{const s=f.create();open(f,s);const expected=s.state();
  const candidate={expected,sourceVersion:10,newSessionId:'session-new',excerpt,chatKey:'private:'+owner};
  assert.equal(s.rotate(f.scope,{...candidate,sourceVersion:9}),false);
  assert.equal(s.rotate(f.scope,{...candidate,chatKey:'private:1234568'}),false);
  f.setBusy(true);assert.equal(s.rotate(f.scope,candidate),false);f.setBusy(false);
  assert.equal(s.rotate(f.scope,candidate),true);assert.equal(s.state().sessionId,'session-new');assert.deepEqual(s.state().pendingExcerpt,excerpt);
  assert.equal(s.rotate(f.scope,candidate),false);
 }finally{f.db.close();}
});

test('回合崩溃不能自动重发、不能丢待交接内容，确认完成后才清除',()=>{
 const f=fixture();try{const s=f.create();open(f,s);assert.equal(s.rotate(f.scope,{expected:s.state(),sourceVersion:10,newSessionId:'session-new',excerpt,chatKey:'private:'+owner}),true);
  const next=turn(f,{sessionId:'session-new',generation:2});assert.equal(s.begin(f.scope,next),true);
  const reopened=f.create();assert.equal(reopened.markInterrupted(),true);assert.equal(reopened.state().status,'uncertain');assert.deepEqual(reopened.state().pendingExcerpt,excerpt);
  assert.equal(reopened.begin(f.scope,next),false);assert.equal(reopened.reconcileAndReplace(f.scope,{sessionId:'session-new',generation:2,newSessionId:'session-recovered',confirmedIdle:false,chatKey:'private:'+owner}),false);
  assert.equal(reopened.reconcileAndReplace(f.scope,{sessionId:'session-new',generation:2,newSessionId:'session-recovered',confirmedIdle:true,chatKey:'private:'+owner}),true);
  assert.equal(reopened.state().sessionId,'session-recovered');assert.equal(reopened.state().recoveryMode,1);assert.deepEqual(JSON.parse(f.db.prepare('SELECT pending_excerpt FROM owner_work_previous WHERE reason=?').get('uncertain-recovery').pending_excerpt),excerpt);
  const recovered=turn(f,{sessionId:'session-recovered',generation:3});assert.equal(reopened.begin(f.scope,recovered),true);assert.equal(reopened.finish(f.scope,{...recovered,turnId:'wrong',outcome:'completed'}),false);
  assert.equal(reopened.finish(f.scope,{...recovered,outcome:'completed'}),true);assert.equal(reopened.state().recoveryMode,0);
 }finally{f.db.close();}
});

test('断线、身份或目录不匹配、活动任务与待审批均不恢复或更换映射',async()=>{
 const f=fixture();try{const s=f.create();open(f,s);const good={found:true,owned:true,cwd,running:false,pending:false};
  assert.equal((await s.recover(f.scope,{cwd,probe:async()=>good})).status,'ready');
  assert.equal((await s.recover(f.scope,{cwd,probe:async()=>{throw Error('offline')}})).status,'unavailable');
  assert.equal((await s.recover(f.scope,{cwd,probe:async()=>({found:false})})).status,'not-found');
  assert.equal((await s.recover(f.scope,{cwd,probe:async()=>({...good,cwd:path.resolve('qa/other')})})).status,'ownership-unverified');
  assert.equal((await s.recover(f.scope,{cwd,probe:async()=>({...good,running:true})})).status,'busy-or-unverified');
  assert.equal((await s.recover(f.scope,{cwd,probe:async()=>({...good,pending:true})})).status,'busy-or-unverified');
  const old=f.scope;f.setScope(ownerWorkScope({...parameters(),roleRevision:2}));assert.equal((await s.recover(old,{cwd,probe:async()=>good})).status,'scope-changed');assert.equal(s.install(f.scope,'foreign'),false);assert.equal(s.state().sessionId,'session-old');
 }finally{f.db.close();}
});

test('来源没有变化、身份未变时才能切换；待交接文本未消费前不能二次切换',()=>{
 const f=fixture();try{const s=f.create();open(f,s);const expected=s.state();
  f.db.prepare('UPDATE chats SET doc=? WHERE key=?').run(JSON.stringify({latestSeq:11,readThrough:11}),'private:'+owner);
  assert.equal(s.rotate(f.scope,{expected,sourceVersion:10,newSessionId:'session-new',excerpt,chatKey:'private:'+owner}),false);
  assert.equal(s.rotate(f.scope,{expected,sourceVersion:11,newSessionId:'session-new',excerpt,chatKey:'private:'+owner}),true);
  assert.equal(s.rotate(f.scope,{expected:s.state(),sourceVersion:11,newSessionId:'session-next',excerpt,chatKey:'private:'+owner}),false);
 }finally{f.db.close();}
});

test('交接时即使消息版本一致，只要还有未读消息也不能提交切换',()=>{
 const f=fixture();try{const s=f.create();open(f,s);const expected=s.state();f.db.prepare('UPDATE chats SET doc=? WHERE key=?').run(JSON.stringify({latestSeq:10,readThrough:9}),'private:'+owner);
 assert.equal(s.rotate(f.scope,{expected,sourceVersion:10,newSessionId:'session-new',excerpt,chatKey:'private:'+owner}),false);assert.equal(s.state().sessionId,'session-old');
 }finally{f.db.close();}
});

test('人工核查在同事务仅确认当前账号、主人和会话的不确定工具记录，不改结果',()=>{
 const f=fixture();try{const s=f.create();open(f,s);assert.equal(s.begin(f.scope,turn(f,{through:10})),true);assert.equal(s.markInterrupted(),true);
 f.db.exec('CREATE TABLE owner_tool_journal(scope TEXT,account TEXT,owner TEXT,session_id TEXT,status TEXT,reviewed_at INTEGER)');
 const add=f.db.prepare('INSERT INTO owner_tool_journal VALUES(?,?,?,?,?,NULL)');add.run(f.scope,account,owner,'session-old','uncertain');add.run(f.scope,account,owner,'other-session','uncertain');
 assert.equal(s.reconcileAndReplace(f.scope,{sessionId:'session-old',generation:1,newSessionId:'fresh',confirmedIdle:true,chatKey:'private:'+owner}),true);
 const rows=f.db.prepare('SELECT status,reviewed_at AS reviewedAt FROM owner_tool_journal ORDER BY rowid').all();assert.equal(rows[0].status,'uncertain');assert.ok(rows[0].reviewedAt);assert.equal(rows[1].reviewedAt,null);
 }finally{f.db.close();}
});
