import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveWebAddresses} from '../src/qq-chat/web.mjs';
test('QQ image DNS failure uses only exact allowed host fallback and retains public address checks',async()=>{
 const primary=async()=>{throw Error('DNS unavailable')};let calls=0;
 const fallback=async host=>{calls++;assert.equal(host,'multimedia.nt.qq.com.cn');return ['1.1.1.1'];};
 assert.deepEqual(await resolveWebAddresses('multimedia.nt.qq.com.cn',{primary,fallback}),['1.1.1.1']);
 assert.equal(calls,1);
 for(const host of ['127.0.0.1','evil.example','multimedia.nt.qq.com.cn.evil.example'])await assert.rejects(resolveWebAddresses(host,{primary,fallback}));
 await assert.rejects(resolveWebAddresses('multimedia.nt.qq.com.cn',{primary,fallback,lookup:async()=>[]}));
 assert.equal(calls,1);
 for(const addresses of [[],['127.0.0.1'],['1.1.1.1','192.168.1.1']])await assert.rejects(resolveWebAddresses('multimedia.nt.qq.com.cn',{primary,fallback:async()=>addresses}),/有效公网/);
 assert.deepEqual(await resolveWebAddresses('multimedia.nt.qq.com.cn',{primary:async()=>['8.8.8.8'],fallback}),['8.8.8.8']);
 assert.equal(calls,1);
});
