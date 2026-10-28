import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {QQChat} from '../src/qq-chat/engine.mjs';
import {defaults} from '../src/qq-chat/store.mjs';

const base=path.resolve('qa/owner-work-integration-tests');fs.mkdirSync(base,{recursive:true});
const owner='123456789',account='987654321';
const event=(id,body)=>({post_type:'message',message_type:'private',self_id:account,user_id:owner,message_id:id,message:body,sender:{nickname:'主人'}});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(base,'case-')),sent=[],sessions=new Map(),calls=[],prompts=[];
 const q=new QQChat({root:dir,dataDir:dir,workIdentity:()=>('a'.repeat(64))});q.store.saveSettings({...defaults(),owner,account,mergeMs:10000});q.stopped=false;
 q.client={raw:async(name,args)=>name==='get_login_info'?{user_id:account}:name==='get_status'?{online:true}:name.startsWith('send_')?(sent.push(args),{message_id:sent.length}):null};
 q.sessionCleanup={finish:()=>true};q.sessionBinding=()=>({register:sessionId=>({sessionId}),retry:async()=>{},finalize:async()=>({archived:true,tracked:true})});
 let count=0,pressure=20,fail=false,mutateProjection=v=>v;
 const dsh={base:'http://127.0.0.1:1234',call:async(method,args)=>{calls.push([method,args]);
  if(method==='session/create'){const sessionId='session-'+(++count);sessions.set(sessionId,{sessionId,cwd:args.cwd,running:false});return {sessionId};}
  if(method==='session/list')return {items:[...sessions.values()]};
  if(method==='session/projections')return {values:mutateProjection({agentPreset:'banyu-qq',contextPressure:{projectedTokens:pressure,contextWindow:100},inbox:{'next-turn':[],'next-step':[]},userQuestions:{active:[],settled:[]},permissions:{currentValue:'fixture'},subagent:null,subagentCatalog:[],agentTeam:{members:[{id:'lead',name:'lead',role:'lead',phase:'active'}],tasks:[]},plan:{active:false,pending:false}})};
  return {};
 },turn:async({sessionId,prompt,onSession})=>{prompts.push({sessionId,prompt});onSession(sessionId,{created:false});if(fail)throw Error('模拟连接中断');return {sessionId,text:'收到',reason:{kind:'completed'}};}};
 q.dsh=dsh;q.modelReady=true;t.after(()=>q.close());
 return {q,sent,sessions,calls,prompts,setPressure:v=>pressure=v,setFail:v=>fail=v,setProjection:v=>mutateProjection=v};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,50));

test('主人多轮复用，接近上限后原子交接，继续使用新会话且不复制旧 handle',async t=>{
 const f=await fixture(t);await f.q.receive(event(1,'第一句'));await f.q.wake('private:'+owner);await settle();
 assert.equal(f.prompts[0].sessionId,'session-1');assert.equal(f.q.ownerWork.state.state().completedCount,1);
 f.setPressure(85);await f.q.receive(event(2,'第二句'));await f.q.wake('private:'+owner);await settle();
 assert.equal(f.prompts[1].sessionId,'session-1');const handoff=f.q.ownerWork.state.state();assert.equal(handoff.sessionId,'session-2');assert.ok(handoff.pendingExcerpt.records.some(r=>r.text==='第一句'));
 const oldHandle=/"handle":"([^"]+)"/.exec(f.prompts[1].prompt)[1];assert.ok(!JSON.stringify(handoff.pendingExcerpt).includes(oldHandle));
 f.setPressure(20);await f.q.receive(event(3,'第三句'));await f.q.wake('private:'+owner);await settle();
 assert.equal(f.prompts[2].sessionId,'session-2');assert.match(f.prompts[2].prompt,/旧会话摘录/);assert.ok(!f.prompts[2].prompt.includes(oldHandle));assert.equal(f.q.ownerWork.state.state().pendingExcerpt,null);assert.equal(f.sent.length,3);
 assert.ok(f.sessions.has('session-1'));
});

test('人设修订变更创建不同作用域的新会话，旧会话不跨身份归档',async t=>{
 const f=await fixture(t);await f.q.receive(event(1,'你好'));await f.q.wake('private:'+owner);await settle();const role=f.q.store.role('whale');f.q.store.saveRole({...role,prompt:'新的人设'});
 await f.q.receive(event(2,'再次问好'));await f.q.wake('private:'+owner);await settle();assert.deepEqual(f.prompts.map(p=>p.sessionId),['session-1','session-2']);assert.ok(f.sessions.has('session-1'));
 assert.equal(f.calls.filter(([m,a])=>m==='workspace/archiveSession'&&a.sessionId==='session-1').length,0);
 assert.equal(f.q.store.db.prepare('SELECT COUNT(*) AS n FROM owner_work_previous WHERE reason=?').get('scope-changed').n,1);
});

test('模型断线可能已经执行过操作：保留不确定状态，后续消息不重发旧回合',async t=>{
 const f=await fixture(t);f.setFail(true);await f.q.receive(event(1,'请操作电脑'));await f.q.wake('private:'+owner);assert.equal(f.q.ownerWork.state.state().status,'uncertain');assert.equal(f.prompts.length,1);
 f.setFail(false);f.q.modelReady=true;await f.q.receive(event(2,'继续'));await f.q.wake('private:'+owner);assert.equal(f.prompts.length,1);assert.equal(f.q.ownerWork.state.state().status,'uncertain');
 assert.equal(f.q.dashboard().ownerWork.status,'needs-review');await assert.rejects(f.q.ownerWork.resolve(false),/核查/);f.q.modelReady=true;if(process.platform==='win32')f.sessions.get('session-1').cwd=f.sessions.get('session-1').cwd.toUpperCase();assert.equal((await f.q.ownerWork.resolve(true)).status,'idle');
 assert.equal(f.q.store.chat('private:'+owner).readThrough,1);await f.q.receive(event(3,'新的请求'));await f.q.wake('private:'+owner);assert.equal(f.prompts.length,2);assert.ok(!f.prompts[1].prompt.includes('请操作电脑'));assert.ok(f.prompts[1].prompt.includes('新的请求'));
});

test('中断后人设变化仍可经人工核查安全恢复，旧请求不重投',async t=>{
 const f=await fixture(t);f.setFail(true);await f.q.receive(event(1,'请检查电脑'));await f.q.wake('private:'+owner);assert.equal(f.q.ownerWork.state.state().status,'uncertain');
 const role=f.q.store.role('whale');f.q.store.saveRole({...role,prompt:'调整后的人设'});assert.equal(f.q.ownerWork.status().status,'needs-review');f.setFail(false);f.q.modelReady=true;
 const result=await f.q.ownerWork.resolve(true);assert.equal(result.status,'idle');assert.equal(f.q.ownerWork.state.state().sessionId,'session-2');assert.ok(f.sessions.has('session-1'));
 await f.q.receive(event(2,'新的问题'));await f.q.wake('private:'+owner);assert.equal(f.prompts.length,2);assert.ok(!f.prompts[1].prompt.includes('请检查电脑'));assert.ok(f.prompts[1].prompt.includes('新的问题'));
});

test('对专用预设、审批问题、队列、子代理或未知状态无法核验时禁止自动复用',async t=>{
 const f=await fixture(t);await f.q.receive(event(1,'第一条'));await f.q.wake('private:'+owner);await settle();
 for(const mutate of [v=>({...v,agentPreset:'other'}),v=>({...v,userQuestions:{active:[{}],settled:[]}}),v=>({...v,subagentCatalog:[{kind:'diagnostic'}]}),v=>({...v,subagent:{id:'child'}}),v=>({...v,inbox:{'next-turn':[{}],'next-step':[]}}),v=>({...v,permissions:undefined}),v=>({...v,plan:{active:true,pending:false}}),v=>({...v,agentTeam:{...v.agentTeam,tasks:[{}]}}),v=>({...v,agentTeam:{...v.agentTeam,members:[...v.agentTeam.members,{role:'child'}]}})]){
  f.setProjection(mutate);f.q.modelReady=true;await f.q.receive(event(10+f.prompts.length+Math.random(),'继续'));await f.q.wake('private:'+owner);assert.equal(f.prompts.length,1);
 }
});

test('主人未读超出条数或字符预算时按最早顺序完整处理，不跳过长消息',async t=>{
 const f=await fixture(t);f.q.store.saveSettings({...f.q.store.settings(),memoryMessages:4,memoryChars:4000});
 for(let i=1;i<=6;i++)await f.q.receive(event(i,'第'+i+'条'));
 await f.q.wake('private:'+owner);assert.equal(f.prompts.length,1);for(let i=1;i<=4;i++)assert.ok(f.prompts[0].prompt.includes('第'+i+'条'));assert.ok(!f.prompts[0].prompt.includes('第5条'));assert.equal(f.q.store.chat('private:'+owner).readThrough,4);
 await f.q.wake('private:'+owner);assert.ok(f.prompts[1].prompt.includes('第5条'));assert.ok(f.prompts[1].prompt.includes('第6条'));
 const long='长'.repeat(4500);await f.q.receive(event(7,long));await f.q.receive(event(8,'后面的消息'));await f.q.wake('private:'+owner);
 assert.ok(f.prompts[2].prompt.includes(long));assert.ok(!f.prompts[2].prompt.includes('后面的消息'));
 await f.q.wake('private:'+owner);assert.ok(f.prompts[3].prompt.includes('后面的消息'));
});

test('get_context 按最早未读顺序暴露并先记水位，断线人工恢复不重播已看过的消息',async t=>{
 const f=await fixture(t);let observed=[];f.q.dsh.turn=async({sessionId,prompt,onSession})=>{f.prompts.push({sessionId,prompt});onSession(sessionId,{created:false});
  const handle=/"handle":"([^"]+)"/.exec(prompt)[1];for(let i=2;i<=46;i++)await f.q.receive(event(i,'输入'+i));
  observed=(await f.q.agent('get_context',{handle})).messages;assert.equal(observed.length,40);assert.equal(observed[0].text,'输入2');assert.equal(observed.at(-1).text,'输入41');
  await assert.rejects(f.q.agent('mark_read',{handle,through:f.q.store.chat('private:'+owner).latestSeq}),/已读序号/);throw Error('断线');};
 await f.q.receive(event(1,'开始工作'));await f.q.wake('private:'+owner);assert.equal(f.q.ownerWork.state.state().status,'uncertain');assert.equal(f.q.ownerWork.state.state().turnThrough,observed.at(-1).seq);
 f.q.modelReady=true;await f.q.ownerWork.resolve(true);assert.equal(f.q.store.chat('private:'+owner).readThrough,observed.at(-1).seq);
 f.q.dsh.turn=async({sessionId,prompt,onSession})=>{f.prompts.push({sessionId,prompt});onSession(sessionId,{created:false});return {sessionId,text:'收到',reason:{kind:'completed'}};};
 await f.q.receive(event(47,'新的请求'));await f.q.wake('private:'+owner);assert.ok(!f.prompts[1].prompt.includes('输入41'));assert.ok(f.prompts[1].prompt.includes('输入42'));assert.ok(f.prompts[1].prompt.includes('新的请求'));
});

test('自动交接准备期间收到新消息时保留原会话，不将未读消息放入交接',async t=>{
 const f=await fixture(t);f.setPressure(85);let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),original=f.q.dsh.call;
 f.q.dsh.call=async(method,args)=>{if(method==='session/create'&&f.sessions.size===1){entered();await gate;}return original(method,args);};
 await f.q.receive(event(1,'已处理'));await f.q.wake('private:'+owner);await started;await f.q.receive(event(2,'交接期间新消息'));release();await settle();
 assert.equal(f.q.ownerWork.state.state().sessionId,'session-1');assert.equal(f.q.ownerWork.state.state().pendingExcerpt,null);assert.ok(f.q.store.chat('private:'+owner).latestSeq>f.q.store.chat('private:'+owner).readThrough);
});

test('切换后归档登记失败保留可持久重试状态，重连后登记',async t=>{
 const f=await fixture(t);f.setPressure(85);f.q.sessionCleanup.finish=()=>false;await f.q.receive(event(1,'需要交接'));await f.q.wake('private:'+owner);await settle();
 assert.equal(f.q.ownerWork.state.state().sessionId,'session-2');assert.equal(f.q.ownerWork.state.pendingRetirementCount(),1);
 f.q.sessionCleanup.finish=()=>true;f.q.ownerWork.resumeRetirements(f.q.dsh);assert.equal(f.q.ownerWork.state.pendingRetirementCount(),0);
});
