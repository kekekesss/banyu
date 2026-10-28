import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {QQChat,parseQQEvent} from '../src/qq-chat/engine.mjs';
import {QQStore,defaults,validateSettings} from '../src/qq-chat/store.mjs';
import {publicIPv4,publicAddresses} from '../src/qq-chat/web.mjs';
import {createApp} from '../src/server.mjs';
import {openLocalLink} from '../src/local-links.mjs';
const qa=path.resolve('qa/native-tests');fs.mkdirSync(qa,{recursive:true});
async function fixture(t,model=async()=>({text:'本鲸在呢。'})){
 const dir=fs.mkdtempSync(path.join(qa,'case-'));fs.mkdirSync(path.join(dir,'local-qq'));fs.writeFileSync(path.join(dir,'local-qq/credentials.json'),JSON.stringify({onebot:'PRIVATE-ONEBOT',web:'PRIVATE-WEB'}));
 const store=new QQStore(path.join(dir,'qq-chat')),cfg=defaults();Object.assign(cfg,{owner:'123456789',account:'987654321',privateAllow:['123456789'],groupAllow:['123450001'],mergeMs:0});store.saveSettings(cfg);
 class Client extends EventEmitter{constructor(){super();this.sent=[];this.online=true;this.account='987654321'}onEvent(fn){this.on('event',fn)}onPrivateMessage(fn){this.on('private',fn)}onGroupMessage(fn){this.on('group',fn)}async connect(){}close(){}async raw(action,params){if(action==='get_login_info')return {user_id:this.account,nickname:'测试小号'};if(action==='get_status')return {online:this.online,good:true};if(action.startsWith('send_')){this.sent.push({action,params});if(this.fail)throw Error('unconfirmed');return {message_id:this.sent.length};}return []}}
 const client=new Client(),q=new QQChat({root:path.dirname(dir),dataDir:dir,store,model,clientFactory:()=>client});await q.connect();
 t.after(async()=>{await q.disconnect();store.close()});
 const event=(overrides={})=>({post_type:'message',message_type:'private',self_id:987654321,user_id:123456789,message_id:100,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'你好'}}],sender:{nickname:'测试主人'},...overrides});
 const flush=async(key='private:123456789')=>{clearTimeout(q.timers.get(key));q.timers.delete(key);await q.wake(key)};
 return {q,store,client,event,flush,dir};
}
test('原生QQ私聊接收去重、会话历史与发送确认均由伴屿保存',async t=>{
 const f=await fixture(t);await f.q.receive(f.event());assert.equal((await f.q.receive(f.event())).ignored,'duplicate');await f.flush();
 assert.equal(f.client.sent.length,1);assert.equal(f.client.sent[0].params.user_id,123456789);assert.equal(f.store.messages('private:123456789').length,2);assert.equal(f.store.messages('private:123456789')[1].status,'sent');
 assert.equal(f.q.status().engine,'banyu-native');assert.equal(f.q.status().state,'connected');
});
test('群白名单、提及触发、自身消息和主号不能冒充机器人',async t=>{
 const f=await fixture(t);assert.equal((await f.q.receive(f.event({self_id:123456789}))).ignored,'access');assert.equal((await f.q.receive(f.event({user_id:987654321}))).ignored,'access');
 assert.equal((await f.q.receive(f.event({message_type:'group',group_id:555550001,message_id:2}))).ignored,'access');
 const ordinary=f.event({message_type:'group',group_id:123450001,message_id:3});assert.equal((await f.q.receive(ordinary)).stored,true);assert.equal(f.q.timers.size,0);
 await f.q.receive({...ordinary,message_id:4,message:[{type:'at',data:{qq:'987654321'}},{type:'text',data:{text:'在吗'}}]});assert.equal(f.q.timers.size,1);await f.flush('group:123450001');assert.equal(f.client.sent[0].action,'send_group_msg');
 f.client.account='123456789';assert.equal(await f.q.verified(),false);await f.q.receive(f.event({message_id:5}));await f.flush();assert.equal(f.client.sent.length,1);
});
test('合并连续消息且同一会话只有一个模型回合，期间新消息下一轮处理',async t=>{
 let release,started;const opened=new Promise(r=>started=r),modelCalls=[];
 const f=await fixture(t,async input=>{modelCalls.push(input);if(modelCalls.length===1){started();await new Promise(r=>release=r)}return {text:'收到。'}});
 await f.q.receive(f.event());await f.q.receive(f.event({message_id:101,message:[{type:'text',data:{text:'还有一句'}}]}));
 clearTimeout(f.q.timers.get('private:123456789'));const task=f.q.wake('private:123456789');await opened;
 await f.q.receive(f.event({message_id:102}));await f.q.wake('private:123456789');assert.equal(modelCalls.length,1);release();await task;
 assert.equal(modelCalls[0].history.filter(m=>m.role==='user').length,2);await f.flush();assert.equal(modelCalls.length,2);
});
test('生成期间暂停或移出白名单会阻止回传',async t=>{
 let release,started;const opened=new Promise(r=>started=r);const f=await fixture(t,async()=>{started();await new Promise(r=>release=r);return {text:'不应发送'}});
 await f.q.receive(f.event());clearTimeout(f.q.timers.get('private:123456789'));const task=f.q.wake('private:123456789');await opened;f.q.updateSettings({paused:true});release();await task;assert.equal(f.client.sent.length,0);
});
test('发送结果未知不自动重发，工具已发则不重复发送最终文字',async t=>{
 let q;const f=await fixture(t,async({handle})=>{await q.agent('send_message',{handle,text:'工具已经发出'},'call-1');await q.agent('send_message',{handle,text:'工具已经发出'},'call-1');return {text:'工具已经发出'}});q=f.q;
 await q.receive(f.event());await f.flush();assert.equal(f.client.sent.length,1);
 f.client.fail=true;await q.receive(f.event({message_id:103}));await f.flush();assert.equal(f.client.sent.length,2);assert.equal(f.store.messages('private:123456789').at(-1).status,'uncertain');
});
test('工具handle不能跨会话或在回合结束后发送，等待可被新消息唤醒',async t=>{
 let q,handle,waiting,started;const opened=new Promise(r=>started=r);const f=await fixture(t,async input=>{handle=input.handle;started();waiting=q.agent('wait_for_messages',{handle,timeoutMs:10000});const context=await waiting;assert.ok(context.messages.some(m=>m.text==='新消息'));return {text:'看到了'}});q=f.q;
 await q.receive(f.event());clearTimeout(q.timers.get('private:123456789'));const task=q.wake('private:123456789');await opened;
 await assert.rejects(q.agent('send_message',{handle:'other',text:'不应发送'}));await q.receive(f.event({message_id:104,message:[{type:'text',data:{text:'新消息'}}]}));await task;
 assert.equal(f.client.sent.length,1);assert.equal(q.timers.size,0);await assert.rejects(q.agent('send_message',{handle,text:'已经结束'}));
});
test('主动聊天开关、空闲间隔及免打扰由原生引擎执行',async t=>{
 const f=await fixture(t);f.q.now=()=>new Date('2026-10-24T12:00:00Z').getTime();f.q.random=()=>0;
 f.store.saveChat({...f.store.chat('private:123456789'),lastIncomingAt:f.q.now()-6000000,nextProactiveAt:f.q.now()-1});
 f.q.updateSettings({proactive:{enabled:false,minMs:60000,maxMs:60000,idleMs:60000,probability:1}});await f.q.tick();assert.equal(f.q.timers.size,0);
 f.q.updateSettings({proactive:{enabled:true,minMs:60000,maxMs:60000,idleMs:60000,probability:1},quietFrom:'19:00',quietTo:'21:00'});await f.q.tick();assert.equal(f.q.timers.size,0);
 f.q.updateSettings({quietFrom:'',quietTo:''});await f.q.tick();assert.equal(f.q.timers.size,1);
});
test('人设编辑保留版本冲突检查，不篡改其它角色',async t=>{
 const f=await fixture(t),role=f.store.role('whale');f.store.saveRole({...role,prompt:'新版人设'});assert.throws(()=>f.store.saveRole({...role,prompt:'旧页面覆盖'}),/其它页面/);assert.equal(f.store.role('whale').prompt,'新版人设');
 assert.throws(()=>validateSettings({privateAllow:['not-a-qq']},defaults()));assert.throws(()=>validateSettings({proactive:{enabled:true,minMs:1,maxMs:2,idleMs:1,probability:1}},defaults()));
});

test('删除角色不会删除聊天，使用中的角色和过期编辑页均受保护',async t=>{
 const f=await fixture(t);f.store.append('private:123456789','in','保留的消息');
 assert.throws(()=>f.store.deleteRole('whale'),e=>e.status===409);
 const role=f.store.saveRole({name:'待删角色',prompt:'临时'});f.store.saveRole({...role,prompt:'新编辑'});
 assert.throws(()=>f.store.deleteRole(role.id,role.revision),e=>e.status===409);
 f.store.deleteRole(role.id,f.store.role(role.id).revision);assert.equal(f.store.role(role.id),null);assert.equal(f.store.messages('private:123456789')[0].body,'保留的消息');assert.equal(f.store.settings().roleId,'whale');
});

test('固定授权入口只使用夸克，不接受任意链接或其它浏览器',async()=>{
 const calls=[],launch=(exe,args,options)=>{calls.push({exe,args,options});const c=new EventEmitter();c.unref=()=>{};queueMicrotask(()=>c.emit('spawn'));return c;},quark=path.resolve('fixture/quark.exe');
 await openLocalLink('qq-authorization',{quark,exists:()=>true,launch});assert.equal(calls[0].args[0],'https://auth.luckylillia.com');assert.equal(calls[0].options.shell,false);
 await assert.rejects(openLocalLink('https://other.test',{quark,exists:()=>true,launch}),e=>e.status===404);
 await openLocalLink('qq-docs',{quark,exists:()=>true,launch});assert.equal(calls[1].args[0],'https://luckylillia.com');assert.equal(calls[1].exe,quark);assert.equal(calls[1].options.shell,false);
 await assert.rejects(openLocalLink('qq-authorization',{quark:path.resolve('msedge.exe'),exists:()=>true,launch}),e=>e.status===409);assert.equal(calls.length,2);
});

test('长回复遵守单条上限且限制回合发送次数',async t=>{
 const f=await fixture(t,async()=>({text:'鲸'.repeat(250)}));f.q.updateSettings({replyLimit:100});await f.q.receive(f.event());await f.flush();
 assert.deepEqual(f.client.sent.map(m=>m.params.message[0].data.text.length),[100,100,50]);
});

test('DSH连接失效后标记待连接，下一次检查重新发现模型而非固定旧端口',async t=>{
 const f=await fixture(t);let now=Date.now(),discovered=0;f.q.now=()=>now;f.q.lastHealth=now;f.q.model=null;f.q.modelReady=true;
 f.q.dsh={call:async()=>{throw Error('previous DSH port closed')}};
 f.q.ensureModel=async()=>{discovered++;f.q.modelReady=true;f.q.dsh={call:async()=>({presets:[{id:'banyu-qq'}]})};return f.q.dsh;};
 await f.q.tick();assert.equal(f.q.modelReady,false);assert.equal(discovered,0);
 now+=31000;await f.q.tick();assert.equal(f.q.modelReady,true);assert.equal(discovered,1);
});
test('公开网页读取拒绝私网、保留地址及混合DNS结果',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.1.1','172.16.0.1','192.168.0.1','198.18.0.1','100.64.0.1','::1'])assert.equal(publicIPv4(ip),false);
 assert.equal(publicIPv4('1.1.1.1'),true);await assert.rejects(publicAddresses('example.test',{lookup:async()=>['1.1.1.1','127.0.0.1']}));
 assert.equal(parseQQEvent({post_type:'message',message_type:'private',user_id:1}),null);
});
test('原生QQ管理与模型工具分开鉴权，旧页面无法再作为引擎入口',async t=>{
 const dir=fs.mkdtempSync(path.join(qa,'server-')),stub={status:()=>({state:'disconnected'}),disconnect:async()=>{},connect:async()=>{}};
 const app=createApp({port:0,dataDir:dir,adapters:{qq:stub,weixin:stub},nativeQQOptions:{autoConnect:false}});app.models.health=async()=>({ready:false});await app.start();t.after(()=>app.close());
 const base='http://127.0.0.1:'+app.server.address().port,headers={'x-admin-token':app.token,'content-type':'application/json'};
 assert.equal((await fetch(base+'/api/qq-chat')).status,401);assert.equal((await fetch(base+'/api/qq-chat',{headers})).status,200);
 assert.equal((await fetch(base+'/api/qq-agent',{method:'POST',headers,body:'{}'})).status,401);
 assert.equal((await fetch(base+'/api/qq-chat',{headers:{'x-qq-agent-token':app.nativeQQ.agentToken}})).status,401);
 assert.equal((await fetch(base+'/qq-workbench/')).status,404);assert.equal((await fetch(base+'/qq-chat.js')).status,200);
 const state=await(await fetch(base+'/api/state',{headers})).json();assert.equal(state.qqNative,true);assert.ok(!JSON.stringify(state).includes(app.nativeQQ.agentToken));
});
