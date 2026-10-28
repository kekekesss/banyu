import test from 'node:test';
import assert from 'node:assert/strict';
import {findDsh} from '../src/dsh-connection.mjs';

function requestWith(routes,calls){return async(url,options)=>{calls.push(url);const req=JSON.parse(options.body),value=routes[new URL(url).origin];if(!value)return {ok:false,status:503};return {ok:true,json:async()=>({type:'server-response',rpcId:req.rpcId,result:{ok:true,value}})};};}
const cookie=()=>'';
test('已知 DSH 可用时直接连接，无需扫描端口',async()=>{
 const calls=[];let scans=0;const api=await findDsh({base:'http://127.0.0.1:3001',preset:'banyu-qq',cookie,request:requestWith({'http://127.0.0.1:3001':{presets:[{id:'banyu-qq'}]}},calls),listeners:async()=>{scans++;return [];}});
 assert.equal(api.base,'http://127.0.0.1:3001');assert.equal(scans,0);assert.equal(calls.length,1);
});
test('DSH 换端口后自动发现新端口，重复地址不重复探测',async()=>{
 const calls=[];let scans=0;const api=await findDsh({base:'http://127.0.0.1:3001',preset:'banyu-qq',cookie,request:requestWith({'http://127.0.0.1:3002':{presets:[{id:'banyu-qq'}]}},calls),listeners:async()=>{scans++;return ['http://127.0.0.1:3001','http://127.0.0.1:3002'];}});
 assert.equal(api.base,'http://127.0.0.1:3002');assert.equal(scans,1);assert.equal(calls.length,2);
});
test('已连接但预设缺失时保留准确提示，不连接非本机地址',async()=>{
 const calls=[];await assert.rejects(findDsh({base:'http://127.0.0.1:3001',preset:'banyu-qq',cookie,request:requestWith({'http://127.0.0.1:3001':{presets:[]}},calls),listeners:async()=>['https://example.org']}),e=>e.code==='PRESET_MISSING');assert.equal(calls.length,1);
});
