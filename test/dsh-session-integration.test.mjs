import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {QQChat} from '../src/qq-chat/engine.mjs';
import {QQStore,defaults} from '../src/qq-chat/store.mjs';
import {Models} from '../src/model.mjs';
import {DshSessionCleanup} from '../src/dsh-session-cleanup.mjs';

const base=path.resolve('qa/dsh-session-integration-tests');fs.mkdirSync(base,{recursive:true});
const response=value=>({type:'server-response',result:{ok:true,value}});
const failed={type:'server-response',result:{ok:false,error:{code:'workspace/session-active'}}};

test('QQ归档失败保留登记，不重发消息或改变聊天和人设',async t=>{
 const dir=fs.mkdtempSync(path.join(base,'case-'));fs.mkdirSync(path.join(dir,'local-qq'));fs.writeFileSync(path.join(dir,'local-qq','credentials.json'),JSON.stringify({onebot:'fixture'}));
 const store=new QQStore(path.join(dir,'qq-chat')),cfg=defaults();Object.assign(cfg,{owner:'123456789',account:'987654321',mergeMs:0});store.saveSettings(cfg);const role=store.role(cfg.roleId).prompt;
 const cleanup=new DshSessionCleanup(dir);class Client extends EventEmitter{constructor(){super();this.sent=[];}onEvent(){}onPrivateMessage(){}onGroupMessage(){}async connect(){}close(){}async raw(action,args){if(action==='get_login_info')return {user_id:'987654321'};if(action==='get_status')return {online:true};if(action.startsWith('send_')){this.sent.push(args);return {message_id:9}}}}
 const transport=new Client(),q=new QQChat({root:dir,dataDir:dir,store,sessionCleanup:cleanup,clientFactory:()=>transport});
 const calls=[],model={call:async(method)=>{calls.push(method);if(method==='workspace/archiveSession')throw Error('offline')},turn:async({onSession})=>{onSession('qq-fixture',{created:true,cwd:path.resolve(dir)});return {sessionId:'qq-fixture',text:'正常回复'};}};
 q.ensureModel=async()=>model;await q.connect();t.after(async()=>{await q.disconnect();store.close();await cleanup.close()});
 await q.receive({post_type:'message',message_type:'private',self_id:987654321,user_id:123456789,message_id:1,message:'你好'});clearTimeout(q.timers.get('private:123456789'));await q.wake('private:123456789');
 assert.equal(transport.sent.length,1);assert.equal(store.messages('private:123456789').length,2);assert.equal(store.role(cfg.roleId).prompt,role);assert.equal(cleanup.stats().pending,1);assert.equal(cleanup.stats().unbound,1);assert.equal(store.chat('private:123456789').activeSession,null);assert.deepEqual(calls,['workspace/archiveSession']);
});

test('微信 DSH 返回归档业务失败时持久化排队，原始模型错误不被掩盖',async t=>{
 const dir=fs.mkdtempSync(path.join(base,'case-')),cleanup=new DshSessionCleanup(dir);t.after(()=>cleanup.close());const logs=[];
 const store={setting:()=>({providerId:'fixture',model:'model'}),log:(...args)=>logs.push(args)},api={callUnary:async(method)=>method==='session/modelCatalog'?response({groups:[{id:'fixture',models:[{id:'model'}]}]}):failed,sessions:{create:async()=>response({sessionId:'wx-fixture'}),selectModel:async()=>{throw Error('selection failed')}}};
 const models=new Models(store,dir,{sessionCleanup:cleanup});models.discover=async()=>api;
 await assert.rejects(models.generate({question:'hello'}),/selection failed/);assert.equal(cleanup.stats().cancelPending,1);assert.equal(cleanup.stats().unbound,1);assert.equal(logs.length,1);
});

test('旧 QQ 活动指针只移交到待核对队列，不对 DSH 强行取消或归档',async t=>{
 const dir=fs.mkdtempSync(path.join(base,'case-')),store=new QQStore(path.join(dir,'qq-chat')),cleanup=new DshSessionCleanup(dir);const chat=store.chat('private:123456789');store.saveChat({...chat,activeSession:'legacy-unverified',processing:true});const q=new QQChat({root:dir,dataDir:dir,store,sessionCleanup:cleanup});t.after(async()=>{store.close();await cleanup.close()});
 q.recoverSessions();assert.equal(store.chat('private:123456789').activeSession,null);assert.equal(cleanup.stats().cancelPending,1);assert.equal(cleanup.stats().unbound,1);assert.equal(cleanup.listUnbound()[0].sessionId,'legacy-unverified');
});
