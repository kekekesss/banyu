import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createApp} from '../src/server.mjs';
import {defaults} from '../src/qq-chat/store.mjs';

test('导入 QQ 历史时不把内部电脑操作确认当作聊天记忆',async t=>{
 const base=path.resolve('qa/memory-approval-tests');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'case-'));
 const channel={status:()=>({state:'disconnected'}),disconnect:async()=>{}};
 const app=createApp({port:0,dataDir:root,adapters:{qq:channel,weixin:channel}});app.models.health=async()=>({ready:false});await app.start();t.after(()=>app.close());
 const owner='123456789',account='987654321',key='private:'+owner;app.nativeQQ.store.saveSettings({...defaults(),owner,account});app.nativeQQ.store.saveChat({key,name:'测试'});
 app.nativeQQ.store.append(key,'in','喜欢吃米饭',{meta:{messageId:'test1',name:'用户'}});app.nativeQQ.store.append(key,'out','电脑操作请求和确认码',{status:'sent',meta:{internalApproval:true}});
 const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/memory/import-history',{method:'POST',headers:{'content-type':'application/json','x-admin-token':app.token},body:'{}'});assert.equal(response.status,200);const result=await response.json();assert.equal(result.added,1);const items=app.memoryBank.list({kind:'chat'}).items;assert.equal(items.length,1);assert.ok(!JSON.stringify(items).includes('确认码'));
});
