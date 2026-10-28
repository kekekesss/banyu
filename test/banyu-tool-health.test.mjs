import test from 'node:test';
import assert from 'node:assert/strict';
import {banyuToolHealth} from '../src/qq-chat/tool-health.mjs';
import {DshConnection} from '../src/dsh-connection.mjs';
import {apply} from '../plugins/banyu-qq-preset/scope-v3.mjs';
test('工具状态区分缺失、禁用、启动失败和插件激活',async()=>{
 for(const [entries,ready] of [[[],false],[[{entryId:'include:mcp-banyu',enabled:false}],false],[[{entryId:'include:mcp-banyu',enabled:true,fiberPhase:'failed'}],false],[[{entryId:'include:mcp-banyu',enabled:true,fiberPhase:'active'}],true]])assert.equal((await banyuToolHealth({call:async()=>({entries})})).ready,ready);
 assert.equal((await banyuToolHealth({call:async()=>{throw Error('offline')}})).ready,false);
});
test('DSH 管理方法参数不被错误包装，普通方法仍用 request',async()=>{
 const calls=[];const api=new DshConnection('http://127.0.0.1:1234',{cookie:()=>'',request:async(_,options)=>{const r=JSON.parse(options.body);calls.push(r.payload.args);return {ok:true,json:async()=>({rpcId:r.rpcId,type:'server-response',result:{ok:true,value:{}}})};}});
 await api.call('pluginManager/setPluginEnabled',{id:'include:mcp-banyu',enabled:true});await api.call('pluginManager/setBundleEnabled',{name:'banyu-qq-preset',enabled:true});await api.call('session/projections',{sessionId:'test'});
 assert.deepEqual(calls,[{id:'include:mcp-banyu',enabled:true},{name:'banyu-qq-preset',enabled:true},{request:{sessionId:'test'}}]);
});
test('MCP延迟注册、断开和重连时同步精确白名单，任何阶段不暴露其它工具',()=>{
 let known=['shell'],listener,guard;const masks=new Set();const visible=()=>known.filter(n=>[...masks].every(mask=>mask.includes(n)));const changed=()=>listener?.();
 apply({on(event,fn){assert.equal(event,'tools/change');listener=fn;},tools:{presentAs(){},schemas(){return known.map(name=>({name}));},restrict({allow}){assert.ok(allow.every(n=>known.includes(n)),'DSH rejects unknown tool names');masks.add(allow);changed();assert.ok(!visible().includes('shell'));return ()=>{masks.delete(allow);changed();assert.ok(!visible().includes('shell'));};},guard(fn){guard=fn;}}});
 assert.deepEqual(visible(),[]);known.push('mcp__banyu__computer_action','mcp__banyu__get_context','mcp__banyu__arbitrary');changed();assert.deepEqual(visible(),['mcp__banyu__computer_action','mcp__banyu__get_context']);
 known=['shell'];changed();assert.deepEqual(visible(),[]);known.push('mcp__banyu__computer_action');changed();assert.deepEqual(visible(),['mcp__banyu__computer_action']);assert.equal(masks.size,1);
 assert.equal(guard({name:'mcp__banyu__computer_action'}),undefined);assert.equal(typeof guard({name:'shell'}),'string');assert.equal(typeof guard({name:'mcp__banyu__arbitrary'}),'string');
});
