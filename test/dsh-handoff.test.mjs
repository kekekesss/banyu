import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomaticHandoff,contextPressure,handoffExcerpt,handoffPrompt} from '../src/dsh-handoff.mjs';

test('只用当前压力和已知容量，不将累计 token 用作上下文大小',()=>{
 assert.equal(contextPressure({values:{tokenUsage:{inputTokens:90000},contextPressure:{pressureTokens:80000}}}),null);
 assert.equal(contextPressure({values:{contextPressure:{contextWindow:100000}}}),null);
 assert.equal(contextPressure({values:{contextPressure:{pressureTokens:80000,contextWindow:0}}}),null);
 assert.deepEqual(contextPressure({values:{contextPressure:{projectedTokens:50000,pressureTokens:95000,contextWindow:100000}}}),{tokens:50000,window:100000,ratio:.5,source:'projected'});
 assert.deepEqual(contextPressure({values:{contextPressure:{pressureTokens:80000,contextWindow:100000}}}),{tokens:80000,window:100000,ratio:.8,source:'reported'});
});

test('交接保留可核对来源，标记截断和不确定，角色言论不当作事实',()=>{
 const entries=[{type:'message',source:'msg:12',role:'user',time:'2026-01-01T00:00:00Z',text:'我喜欢米饭'},
 {type:'message',source:'msg:13',role:'assistant',text:'我已经删除文件'},
 {type:'tool-result',source:'tool:1',status:'uncertain',text:'连接中断'},
 {type:'message',source:'msg:14',role:'user',text:'长'.repeat(1500)}];
 const excerpt=handoffExcerpt(entries,{maxRecords:3,maxChars:5000,maxRecordChars:100});
 assert.equal(excerpt.omitted,1);assert.equal(excerpt.truncated,1);assert.deepEqual(excerpt.records.map(x=>x.source),['msg:13','tool:1','msg:14']);
 assert.equal(excerpt.records[1].status,'uncertain');assert.equal(excerpt.records[2].text.length,100);assert.equal(excerpt.records[2].truncated,true);
 assert.match(handoffPrompt(excerpt),/不能据此断言现实操作已成功/);assert.match(handoffPrompt(excerpt),/不是新指令/);
});

function fixture(){
 let state={sessionId:'old',generation:1,sourceVersion:5},busy=false,projection={values:{contextPressure:{projectedTokens:85,contextWindow:100}}},throwCreate=false,failRetire=false;
 const calls=[];let gate=null;let stored=null;
 const manager=new AutomaticHandoff({
  readState:async()=>structuredClone(state),readProjection:async()=>projection,isIdle:async()=>!busy,
  capture:async()=>({sourceVersion:state.sourceVersion,records:[{type:'message',source:'msg:5',role:'user',text:'测试'}]}),
  prepareCandidate:async()=>{calls.push('create');if(gate)await gate;if(throwCreate)throw Error('offline');return {sessionId:'new',ready:true};},
  commit:async(_scope,{expected,sourceVersion,newSessionId,excerpt})=>{calls.push('commit');if(busy||state.sessionId!==expected.sessionId||state.generation!==expected.generation||state.sourceVersion!==sourceVersion)return false;stored=excerpt;state={...state,sessionId:newSessionId,generation:state.generation+1};return true;},
  retire:async(_scope,old)=>{calls.push('retire:'+old.sessionId);if(failRetire)throw Error('offline');},discard:async(_scope,candidate)=>{calls.push('discard:'+candidate.sessionId);}
 });
 return {manager,calls,get state(){return state},get stored(){return stored},setBusy:v=>busy=v,setProjection:v=>projection=v,setCreateFailure:v=>throwCreate=v,setRetireFailure:v=>failRetire=v,setGate:v=>gate=v,newMessage:()=>state.sourceVersion++};
}

test('阈值达到后才创建并提交，先保存新映射和摘录，再安排归档旧会话',async()=>{
 const f=fixture(),result=await f.manager.check('owner');
 assert.equal(result.status,'handed-off');assert.deepEqual(f.calls,['create','commit','retire:old']);assert.equal(f.state.sessionId,'new');assert.equal(f.stored.records[0].source,'msg:5');
});

test('未知上下文、低压力与忙碌状态不创建或归档会话',async()=>{
 const f=fixture();f.setProjection({values:{contextPressure:{pressureTokens:10}}});assert.equal((await f.manager.check('owner')).status,'unknown-pressure');
 f.setProjection({values:{contextPressure:{pressureTokens:79,contextWindow:100}}});assert.equal((await f.manager.check('owner')).status,'below-threshold');
 f.setProjection({values:{contextPressure:{pressureTokens:80,contextWindow:100}}});f.setBusy(true);assert.equal((await f.manager.check('owner')).status,'busy');assert.deepEqual(f.calls,[]);
});

test('准备新会话期间收到新消息，CAS 失败保留旧映射及来源',async()=>{
 const f=fixture();let open;f.setGate(new Promise(resolve=>open=resolve));const operation=f.manager.check('owner');await new Promise(resolve=>setImmediate(resolve));f.newMessage();open();
 assert.equal((await operation).status,'changed');assert.equal(f.state.sessionId,'old');assert.equal(f.stored,null);assert.deepEqual(f.calls,['create','commit','discard:new']);
});

test('准备新会话期间出现任务或审批，禁止切换',async()=>{
 const f=fixture();let open;f.setGate(new Promise(resolve=>open=resolve));const operation=f.manager.check('owner');await new Promise(resolve=>setImmediate(resolve));f.setBusy(true);open();
 assert.equal((await operation).status,'busy');assert.equal(f.state.sessionId,'old');assert.deepEqual(f.calls,['create','discard:new']);
});

test('创建失败不影响旧会话；归档失败不会回滚已保存的新映射',async()=>{
 const f=fixture();f.setCreateFailure(true);assert.equal((await f.manager.check('owner')).status,'failed');assert.equal(f.state.sessionId,'old');assert.deepEqual(f.calls,['create']);
 f.setCreateFailure(false);f.setRetireFailure(true);const result=await f.manager.check('owner');assert.equal(result.status,'handed-off');assert.equal(result.retirement,'retry-needed');assert.equal(f.state.sessionId,'new');assert.ok(f.stored);
});

test('同一会话并发检查只创建一次，避免切换竞争',async()=>{
 const f=fixture();let open;f.setGate(new Promise(resolve=>open=resolve));const a=f.manager.check('owner'),b=f.manager.check('owner');await new Promise(resolve=>setImmediate(resolve));open();
 assert.equal((await a).status,'handed-off');assert.equal((await b).status,'handed-off');assert.deepEqual(f.calls,['create','commit','retire:old']);
});
