import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {QQChat} from '../src/qq-chat/engine.mjs';
import {defaults} from '../src/qq-chat/store.mjs';

const base=path.resolve('qa/computer-qq-integration-tests');fs.mkdirSync(base,{recursive:true});
const owner='123456789',account='987654321';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{fail=false,executor,prepare}={}){const root=fs.mkdtempSync(path.join(base,'case-')),sent=[],executed=[],images=[];const q=new QQChat({root,dataDir:root,workIdentity:()=>('a'.repeat(64)),...(prepare?{computerPrepare:prepare}:{}),computerExecutor:executor|| (async action=>{executed.push(action);if(fail)throw Error('执行结果未确认');return {kind:action.kind,exitCode:0,output:'',stderr:''};})});const c={...defaults(),computerEnabled:true,owner,account,mergeMs:10000};q.store.saveSettings(c);q.stopped=false;q.client={raw:async(action,args)=>{if(action==='get_login_info')return {user_id:account};if(action==='get_status')return {online:true};if(action==='send_private_msg'){if(args.message[0].type==='image')images.push(args);else sent.push(args.message[0].data.text);return {message_id:sent.length+images.length};}throw Error('unexpected action');}};q.dsh={call:async()=>({})};q.modelReady=true;t.after(()=>q.close());return {q,c,sent,executed,images};}
function active(q,c,extra={}){const scope=q.ownerWork.scope(),work={scope,sessionId:'session-fixture',generation:1,turnId:'turn-fixture'};q.store.db.prepare("INSERT OR REPLACE INTO owner_work_session(slot,scope,session_id,generation,status,turn_id,pending_excerpt,updated_at) VALUES(1,?,?,1,'running',?,NULL,?)").run(scope,work.sessionId,work.turnId,Date.now());const turn={key:'private:'+owner,handle:'fresh-handle',abort:new AbortController(),sent:0,started:Date.now(),memoryEpoch:undefined,reason:'message',owner,account,ownerDirect:true,settingsSnapshot:JSON.stringify(c),roleRevision:q.store.role(c.roleId).revision,modelClient:q.dsh,work,...extra};q.active.set(turn.key,turn);q.handles.set(turn.handle,turn);return turn;}
const input=(body,extra={})=>({post_type:'message',message_type:'private',self_id:account,user_id:owner,message_id:1,message:body,...extra});

const desktopTarget={screen:{x:0,y:0,width:1000,height:800},window:{handle:'123',pid:42,process:'fixture',title:'test',started:'12345',left:0,top:0,right:900,bottom:700}};
const desktopShot={kind:'screenshot',mediaType:'image/png',imageBase64:'iVBORw0KGgo=',screen:desktopTarget.screen};
test('免确认由本机设置控制；仅主人任务直接执行，群聊和主动唤醒仍拒绝',async t=>{
 const {q,c,sent,executed}=fixture(t);assert.equal(c.computerRequireConfirmation,true);const settings=q.updateSettings({computerRequireConfirmation:false}),turn=active(q,settings);
 const result=await q.agent('computer_action',{handle:turn.handle,action:{kind:'command',command:'Write-Output 42'}});
 assert.equal(result.exitCode,0);assert.equal(sent.length,0);assert.equal(executed.length,1);assert.equal(q.computerStatus().requireConfirmation,false);
 for(const extra of [{reason:'proactive'},{ownerDirect:false},{key:'group:123450001'}]){q.active.clear();q.handles.clear();const bad=active(q,settings,extra);await assert.rejects(q.agent('computer_action',{handle:bad.handle,action:{kind:'command',command:'echo 1'}}),/主人 QQ 私聊|没有操作权限/);}
 assert.equal(executed.length,1);assert.throws(()=>q.updateSettings({computerRequireConfirmation:'false'}));
});
test('更改确认方式取消待确认请求，不会将旧请求自动执行',async t=>{
 const {q,c,executed}=fixture(t),turn=active(q,c),pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'command',command:'echo 1'}}),rejected=assert.rejects(pending,/未获确认/);
 await tick();q.updateSettings({computerRequireConfirmation:false});await rejected;assert.equal(executed.length,0);assert.equal(turn.abort.signal.aborted,true);
});
test('简单确认只批准最新唯一申请；重复消息、旧消息和过期回复不执行',async t=>{
 const {q,c,executed}=fixture(t),turn=active(q,c),action={kind:'command',command:'echo 1'};
 let pending=q.agent('computer_action',{handle:turn.handle,action});await tick();
 assert.deepEqual(await q.receive(input('确认',{message_id:801})),{confirmed:true});await pending;
 pending=q.agent('computer_action',{handle:turn.handle,action});await tick();
 assert.equal((await q.receive(input('确认',{message_id:801}))).ignored,'duplicate');
 assert.equal((await q.receive(input('确认',{message_id:802,time:1}))).ignored,'computer-confirmation-format');assert.equal(executed.length,1);
 const rejected=assert.rejects(pending,/未获确认/);await q.receive(input('拒绝',{message_id:803}));await rejected;
 assert.equal((await q.receive(input('确认',{message_id:804}))).ignored,'computer-confirmation-format');assert.equal(executed.length,1);
});
test('QQ screenshot -> confirmed click -> new screenshot; previous observation cannot replay',async t=>{
 const calls=[],f=fixture(t,{prepare:async()=>desktopTarget,executor:async a=>{calls.push(a.kind);return a.kind==='screenshot'?desktopShot:{kind:a.kind,exitCode:0};}}),{q,c,sent}=f,turn=active(q,c);
 const screenshot=q.agent('computer_action',{handle:turn.handle,action:{kind:'screenshot'}});await tick();
 assert.equal(calls.length,0);const approve=()=>'确认';
 await q.receive(input(approve(),{message_id:101}));const first=await screenshot;assert.ok(first.observationId);assert.equal(first.qqDelivery.status,'sent');assert.equal(f.images.length,1);assert.equal(f.images[0].user_id,Number(owner));assert.equal(f.images[0].message[0].data.file,'base64://'+desktopShot.imageBase64);await q.sendScreenshot(turn,first);assert.equal(f.images.length,1);
 const click=q.agent('computer_action',{handle:turn.handle,observationId:first.observationId,action:{kind:'click',x:10,y:10,button:'left'}});await tick();
 assert.deepEqual(calls,['screenshot']);await q.receive(input(approve(),{message_id:102}));const result=await click;
 assert.deepEqual(calls,['screenshot','click','screenshot']);assert.equal(f.images.length,1);assert.ok(result.observation.observationId);assert.notEqual(first.observationId,result.observation.observationId);
 const stale=await q.agent('computer_action',{handle:turn.handle,observationId:first.observationId,action:{kind:'key',key:'ENTER'}});assert.equal(stale.status,'not-executed');assert.equal(calls.length,3);
 assert.equal(q.toolJournal.records({scope:turn.work.scope,account,owner}).length,2);assert.ok(!JSON.stringify(q.toolJournal.records({scope:turn.work.scope,account,owner})).includes('iVBOR'));
});
test('owner stop cancels waiting screenshot, blocks further computer calls, never executes',async t=>{
 const {q,c,sent,executed}=fixture(t,{prepare:async()=>desktopTarget}),turn=active(q,c);
 const pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'screenshot'}}),rejected=assert.rejects(pending,/未获确认/);await tick();
 assert.ok(sent.some(x=>x.includes('直接回复')||x.includes('回复“确认”')));assert.equal((await q.receive(input('停止电脑操作',{message_id:200}))).computerStopped,true);await rejected;
 assert.equal(executed.length,0);assert.equal(turn.abort.signal.aborted,false);
 assert.equal((await q.agent('computer_action',{handle:turn.handle,action:{kind:'command',command:'echo 1'}})).status,'not-executed');
});
test('截图发送没有回执时不声称已发，不重发且停止后续桌面动作',async t=>{
 const {q,c,sent}=fixture(t,{prepare:async()=>desktopTarget,executor:async()=>desktopShot}),turn=active(q,c),raw=q.client.raw;let attempts=0;
 q.client.raw=async(name,args)=>{if(name==='send_private_msg'&&args.message[0].type==='image'){attempts++;return {};}return raw(name,args);};
 const pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'screenshot'}});await tick();await q.receive(input('确认'));const result=await pending;
 assert.equal(result.qqDelivery.status,'uncertain');assert.equal(attempts,1);assert.equal(q.desktop.status(turn).halted,true);
 assert.ok(!JSON.stringify(q.store.messages(turn.key)).includes('imageBase64'));assert.ok(!JSON.stringify(q.store.messages(turn.key)).includes(desktopShot.imageBase64));
 const next=await q.agent('computer_action',{handle:turn.handle,observationId:result.observationId,action:{kind:'click',x:1,y:1,button:'left'}});assert.equal(next.status,'not-executed');assert.equal(attempts,1);
});
test('stop during asynchronous window inspection prevents approval and execution',async t=>{
 let release;const inspected=new Promise(resolve=>release=resolve);
 const {q,c,sent,executed}=fixture(t,{prepare:async()=>{await inspected;return desktopTarget;}}),turn=active(q,c);
 const pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'screenshot'}}),rejected=assert.rejects(pending,/状态已改变/);
 await tick();assert.equal(q.computer.current.status,'checking');assert.equal(q.stopComputer().stopped,true);release();await rejected;
 assert.equal(sent.length,0);assert.equal(executed.length,0);assert.equal(q.computer.current,null);
});

test('failed post-action observation stops the turn and records uncertain result without retry',async t=>{
 let screenshots=0;const calls=[],{q,c,sent}=fixture(t,{prepare:async()=>desktopTarget,executor:async a=>{calls.push(a.kind);if(a.kind==='screenshot'){if(++screenshots>1)throw Error('fixture capture failed');return desktopShot;}return {kind:a.kind,exitCode:0};}}),turn=active(q,c);
 const pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'screenshot'}});await tick();await q.receive(input('确认',{message_id:301}));const image=await pending;
 const action=q.agent('computer_action',{handle:turn.handle,observationId:image.observationId,action:{kind:'type',text:'test'}}),rejected=assert.rejects(action,/结果不确定/);await tick();await q.receive(input('确认',{message_id:302}));await rejected;
 assert.equal(turn.abort.signal.aborted,true);assert.deepEqual(calls,['screenshot','type','screenshot']);assert.equal(q.toolJournal.unresolved({scope:turn.work.scope,account,owner}),1);
});

test('省略 cwd 的真实模型请求显示默认目录，确认前不执行，确认后保留命令空格',async t=>{
 const {q,c,sent,executed}=fixture(t),turn=active(q,c),command="Write-Output 'banyu-text'";
 const pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'command',command}});
 await tick();assert.equal(executed.length,0);assert.equal(sent.length,1);
 const shown=JSON.parse(sent[0].split('\n').find(line=>line.startsWith('{')));
 assert.deepEqual(shown,{kind:'command',command,cwd:q.ownerWork.cwd});
 assert.deepEqual(await q.receive(input('确认')),{confirmed:true});
 assert.equal((await pending).exitCode,0);assert.deepEqual(executed,[shown]);
});

test('参数错误返回明确未执行原因，显式无效目录不替换，不发送申请',async t=>{
 const {q,c,sent,executed}=fixture(t),turn=active(q,c);
 for(const action of [{kind:'command',command:'echo 1',cwd:''},{kind:'command',command:'echo 1',cwd:null},{kind:'command',command:'echo 1',extra:true},{kind:'command'},{kind:'click',x:1,y:2}]){
  const result=await q.agent('computer_action',{handle:turn.handle,action});
  assert.equal(result.status,'not-executed');assert.equal(result.reason,'invalid-action');assert.match(result.detail,/不是连接故障/);
 }
 assert.equal(sent.length,0);assert.equal(executed.length,0);assert.equal(q.computer.current,null);
});
test('整段说明加确认不会执行或进入模型，单独口令可正确确认',async t=>{const {q,c,sent,executed}=fixture(t),turn=active(q,c);let captured=0;q.memoryBank={capture(){captured++;},settings:()=>({shared:false})};const pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'command',cwd:'D:\\gpt',command:'Write-Output 42'}});await tick();assert.match(sent[0],/回复“确认”/);const line='确认';assert.deepEqual(await q.receive(input(sent[0]+'\n确认')),{ignored:'computer-confirmation-format'});assert.equal(executed.length,0);assert.equal(captured,0);assert.equal(q.store.messages(turn.key).filter(x=>x.direction==='in').length,0);assert.match(sent[1],/未批准电脑操作/);assert.deepEqual(await q.receive(input(line,{message_id:2})),{confirmed:true});await pending;assert.equal(executed.length,1);q.active.clear();q.handles.clear();assert.deepEqual(await q.receive(input(line,{message_id:3})),{ignored:'computer-confirmation-format'});assert.equal(executed.length,1);assert.equal(captured,0);});
test('确认说明发送失败时不能执行',async t=>{const {q,c,executed}=fixture(t),turn=active(q,c),raw=q.client.raw;q.client.raw=async(name,args)=>{if(name==='send_private_msg'&&/电脑操作请求/.test(args.message[0].data.text))throw Error('transport-failed');return raw(name,args);};await assert.rejects(q.agent('computer_action',{handle:turn.handle,action:{kind:'command',cwd:'D:\\gpt',command:'Write-Output 42'}}),/消息结果未确认/);assert.equal(executed.length,0);assert.equal(q.computer.current,null);});
test('电脑开关默认关闭，关闭立即作废待确认申请且不执行',async t=>{assert.equal(defaults().computerEnabled,false);const {q,c,sent,executed}=fixture(t);const turn=active(q,c);const pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'command',cwd:'D:\\gpt',command:'Write-Output 42'}});const rejected=assert.rejects(pending,/未获确认/);await tick();assert.equal(sent.length,1);q.updateSettings({computerEnabled:false});await rejected;assert.equal(turn.abort.signal.aborted,true);assert.equal(executed.length,0);assert.equal(q.computerStatus().enabled,false);const next=active(q,q.store.settings());await assert.rejects(q.agent('computer_action',{handle:next.handle,action:{kind:'screenshot'}}),/主人 QQ 私聊|没有操作权限/);assert.equal(executed.length,0);});
test('电脑操作仅主人私聊确认，确认消息不进入聊天记忆，原回合仍可回复',async t=>{const {q,c,sent,executed}=fixture(t),turn=active(q,c);const pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'command',cwd:'D:\\gpt',command:'Write-Output 42'}},'action');await tick();assert.equal(sent.length,1);const code=q.computer.current.code;assert.equal((await q.receive(input('确认 '+code,{user_id:'222222222',message_id:2}))).ignored,'access');assert.equal(executed.length,0);assert.deepEqual(await q.receive(input('确认 '+code)),{confirmed:true});assert.equal((await pending).exitCode,0);assert.equal(executed.length,1);assert.equal(q.toolJournal.records({scope:turn.work.scope,account,owner})[0].status,'success');assert.equal(turn.sent,0);assert.equal(q.store.messages(turn.key).filter(x=>x.direction==='in').length,0);assert.equal(q.store.messages(turn.key)[0].meta.internalApproval,true);await q.sendText(turn,'完成','final');assert.equal(sent[1],'完成');});
test('群聊、主动唤醒和设置变更都不能批准电脑操作',async t=>{const {q,c,executed}=fixture(t);for(const extra of [{reason:'proactive'},{ownerDirect:false},{key:'group:123450001'},{settingsSnapshot:'stale'}]){q.active.clear();q.handles.clear();const turn=active(q,c,extra);await assert.rejects(q.agent('computer_action',{handle:turn.handle,action:{kind:'screenshot'}}),/主人 QQ 私聊|没有操作权限/);}assert.equal(executed.length,0);});
test('确认提示完整保留含 think 标签的命令，主人确认的内容与执行一致',async t=>{const {q,c,sent,executed}=fixture(t),turn=active(q,c),action={kind:'command',cwd:'D:\\gpt',command:"Write-Output '<think>原样</think>'"};const pending=q.agent('computer_action',{handle:turn.handle,action},'action');await tick();assert.deepEqual(JSON.parse(sent[0].split('\n').find(line=>line.startsWith('{'))),action);const code=q.computer.current.code;assert.deepEqual(await q.receive(input('确认 '+code)),{confirmed:true});await pending;assert.deepEqual(executed,[action]);});
test('等待 QQ 身份核验时设置变化，核验完成后再次拒绝',async t=>{const {q,c}=fixture(t),turn=active(q,c);let release;const gate=new Promise(resolve=>release=resolve);q.verified=async()=>{await gate;q.identity={id:account};return true;};const check=q.computerAccess(turn);q.store.saveSettings({...c,paused:true});release();assert.equal(await check,false);});
test('待确认提示不进入工具读取的聊天上下文',async t=>{const {q,c}=fixture(t),turn=active(q,c),pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'command',cwd:'D:\\gpt',command:'Write-Output 42'}},'action');await tick();assert.deepEqual((await q.agent('get_context',{handle:turn.handle})).messages,[]);turn.abort.abort();await assert.rejects(pending,/未获确认/);});
test('OneBot 断开会立即取消待确认操作',async t=>{const {q,c,executed}=fixture(t);class Client extends EventEmitter{onEvent(){}onPrivateMessage(){}onGroupMessage(){}async connect(){}close(){}async raw(name){if(name==='get_login_info')return {user_id:account};if(name==='get_status')return {online:true};if(name==='send_private_msg')return {message_id:1};}}const client=new Client();q.client=null;q.clientFactory=()=>client;fs.mkdirSync(path.join(q.dataDir,'local-qq'),{recursive:true});fs.writeFileSync(path.join(q.dataDir,'local-qq','credentials.json'),JSON.stringify({onebot:'fixture'}));await q.connect();const turn=active(q,c),pending=q.agent('computer_action',{handle:turn.handle,action:{kind:'command',cwd:'D:\\gpt',command:'Write-Output 42'}},'action');await tick();client.emit('close');await assert.rejects(pending,/未获确认/);assert.equal(turn.abort.signal.aborted,true);assert.equal(executed.length,0);await q.disconnect();});
test('执行器返回结果进入带来源交接记录，异常则中止回合并保留不确定状态',async t=>{const good=fixture(t),turn=active(good.q,good.c),action={kind:'command',cwd:'D:\\gpt',command:'Write-Output 42'},pending=good.q.agent('computer_action',{handle:turn.handle,action},'first');await tick();const code=good.q.computer.current.code;await good.q.receive(input('确认 '+code));await pending;const entries=good.q.ownerWork.capture().records.filter(r=>r.type==='tool-result');assert.equal(entries.length,1);assert.match(entries[0].source,/^qq-tool:/);assert.equal(entries[0].status,'success');assert.match(entries[0].text,/实际效果需另行核实/);
 const bad=fixture(t,{fail:true}),failedTurn=active(bad.q,bad.c),failed=bad.q.agent('computer_action',{handle:failedTurn.handle,action},'second');const rejected=assert.rejects(failed,/结果不确定/);await tick();const code2=bad.q.computer.current.code;await bad.q.receive(input('确认 '+code2));await rejected;assert.equal(failedTurn.abort.signal.aborted,true);assert.equal(bad.q.toolJournal.unresolved({scope:failedTurn.work.scope,account,owner}),1);bad.q.ownerWork.finish(failedTurn.work,false);assert.equal(bad.q.ownerWork.state.state().status,'uncertain');});
