import test from 'node:test';
import assert from 'node:assert/strict';
import {Models} from '../src/model.mjs';

test('微信切换 DSH 设置时，旧的发现请求不能覆盖新连接',async()=>{
 let model={provider:'dsh',baseUrl:'http://127.0.0.1:3001',providerId:'old',model:'old-model'},started,release;
 const waiting=new Promise(r=>started=r),hold=new Promise(r=>release=r),store={setting:()=>model},calls=[];
 const response={type:'server-response',result:{ok:true,value:{presets:[{id:'whale-service-chat'}]}}};
 const models=new Models(store,'.',{clientFactory:base=>({base,agentPresets:{list:async()=>{calls.push(base);if(base.endsWith(':3001')){started();await hold;}return response;}}})});
 models.lastProbe=Date.now();const old=models.discover();await waiting;
 model={provider:'dsh',baseUrl:'http://127.0.0.1:3002',providerId:'new',model:'new-model'};
 const current=await models.discover();assert.equal(current.base,'http://127.0.0.1:3002');assert.equal(models.endpoint,current.base);
 release();await assert.rejects(old,/设置已更改/);assert.equal(models.endpoint,'http://127.0.0.1:3002');assert.deepEqual(calls,['http://127.0.0.1:3001','http://127.0.0.1:3002']);
});
