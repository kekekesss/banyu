import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {DshConnection} from '../src/dsh-connection.mjs';

test('DSH 事件连接失败只取消本次新建会话，复用会话默认不取消',async t=>{
 const ws=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>ws.once('listening',r));t.after(()=>new Promise(r=>ws.close(r)));ws.on('connection',socket=>socket.close());
 const calls=[],request=async(_url,options)=>{const envelope=JSON.parse(options.body);calls.push(envelope.method);return {ok:true,json:async()=>({type:'server-response',rpcId:envelope.rpcId,result:{ok:true,value:envelope.method==='session/create'?{sessionId:'own-session'}:{}}})}};
 const c=new DshConnection(`http://127.0.0.1:${ws.address().port}`,{request,cookie:async()=>''});let metadata;
 await assert.rejects(c.turn({preset:'fixture',onSession:(_id,meta)=>metadata=meta,timeout:5000}),/连接中断/);assert.equal(metadata.created,true);assert.ok(metadata.cwd);assert.deepEqual(calls,['session/create','session/cancel']);
 calls.length=0;await assert.rejects(c.turn({sessionId:'existing-user-session',onSession:(_id,meta)=>metadata=meta,timeout:5000}),/连接中断/);assert.deepEqual(metadata,{cwd:null,created:false});assert.deepEqual(calls,[]);
 calls.length=0;await assert.rejects(c.turn({sessionId:'deliberate',cancelOnFailure:true,timeout:5000}),/连接中断/);assert.deepEqual(calls,['session/cancel']);
});
