import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {Store,fail,text,name,validateRole,validateZone} from './store.mjs';
import {Engine} from './engine.mjs';
import {Models} from './model.mjs';
import {QQChannel} from './adapters/qq.mjs';
import {WeixinChannel} from './adapters/weixin.mjs';
import {LocalQQ} from './local-qq.mjs';
import {QQChat} from './qq-chat/engine.mjs';
import {openLocalLink} from './local-links.mjs';
import {MemoryBank} from './memory.mjs';
import {DeepSeekAPI} from './deepseek-api.mjs';
import {ChannelModels} from './channel-models.mjs';
import {DshSessionCleanup} from './dsh-session-cleanup.mjs';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const build=JSON.parse(fs.readFileSync(path.join(root,'build.json'),'utf8'));
const colors=['blue','green','violet','amber'];
export function createApp({dataDir=path.join(root,'data'),generate,adapters,token,port=3200,weixinOptions,localQQOptions,nativeQQOptions,deepseekOptions}={}){
 const store=new Store(dataDir),deepseekAPI=new DeepSeekAPI(store,deepseekOptions),sessionCleanup=new DshSessionCleanup(dataDir);
 const memoryBank=new MemoryBank(dataDir,{canUse:r=>{if(r.channel==='qq'){const c=nativeQQ.store.settings(),[kind,id]=r.conversation.split(':');return r.account===c.account&&!(kind==='group'?c.groupDeny:c.privateDeny).includes(id);}return r.account===(store.secret('weixin')?.accountId||'');}});
 const machineFile=path.join(dataDir,'machine-settings.json');
 const machine=fs.existsSync(machineFile)?JSON.parse(fs.readFileSync(machineFile,'utf8').replace(/^\uFEFF/,'')):{};
 const nativeQQ=new QQChat({root,dataDir,memoryBank,sessionCleanup,localState:()=>localQQ.status(),...nativeQQOptions});
 const localQQ=new LocalQQ({root,dataDir,bridge:nativeQQ,nativeChat:nativeQQ,...localQQOptions});
 const channelModels=new ChannelModels(store,{qqStore:nativeQQ.store,legacyDeepseek:deepseekAPI,...deepseekOptions});nativeQQ.deepseekAPI=channelModels.adapter('qq');
 const models=new Models(store,root,{deepseekAPI:channelModels.adapter('weixin'),sessionCleanup});
 const tokenFile=path.join(dataDir,'admin-token');
 token=token||(fs.existsSync(tokenFile)?fs.readFileSync(tokenFile,'utf8').trim():randomBytes(32).toString('hex'));
 if(!fs.existsSync(tokenFile))fs.writeFileSync(tokenFile,token,{mode:0o600});
 let channels,loginPoll=null,health={ready:false,provider:'DeepSeek Harness',note:'正在检查模型接入'},healthAt=0,healthTask,healthRevision,healthTaskRevision;
 const engine=new Engine(store,{memoryBank,policyRevision:()=>channelModels.revision('weixin'),generate:generate||((p)=>models.generate(p)),send:(c,b)=>channels[c.channel_id].send(c,b),isChannelReady:id=>['connected','connecting'].includes(channels[id]?.status().state)});
 const usesExistingQQ=!adapters;
 channels=adapters||{qq:nativeQQ,weixin:new WeixinChannel(store,e=>engine.accept(e),weixinOptions)};
 async function modelHealth(force=false){const revision=channelModels.revision('weixin');if(healthTask&&healthTaskRevision===revision)return healthTask;if(!force&&healthRevision===revision&&Date.now()-healthAt<15000)return health;const task=models.health().then(h=>{if(channelModels.revision('weixin')===revision){health=h;healthAt=Date.now();healthRevision=revision;}return h;}).finally(()=>{if(healthTask===task)healthTask=null;});healthTaskRevision=revision;healthTask=task;return task;}
 function afterModelChange(channel){if(channel==='qq'){for(const turn of nativeQQ.active.values())turn.abort.abort();nativeQQ.modelReady=false;nativeQQ.dsh=null;}else{models.endpoint=null;models.lastProbe=0;healthAt=0;healthRevision=null;}fs.writeFileSync(path.join(dataDir,'launcher-settings.json'),JSON.stringify({provider:channelModels.source('weixin'),qqNeedsDsh:!!nativeQQ.store.settings().account&&channelModels.source('qq')==='dsh'}),{mode:0o600});}
 deepseekAPI.onSave=(config,input)=>{channelModels.importLegacyDirect(config,input);for(const channel of ['qq','weixin'])if(input[channel==='qq'?'useForQQ':'useForWeixin']!==undefined)afterModelChange(channel);};
 async function testPlatformModel(channel){if(channelModels.source(channel)!=='dsh')return channelModels.client(channel).generate({role:'请只回复收到。',question:'连接测试'});if(channel==='weixin')return (generate||((p)=>models.generate(p)))({role:'请只回复收到。',question:'连接测试',knowledge:[],history:[]});const client=await nativeQQ.ensureModel(),c=nativeQQ.store.settings();if(nativeQQ.model)return String((await client({key:'test',prompt:'请只回复收到。',history:[],signal:AbortSignal.timeout(30000)}))?.text||'');let sid,binding,entry,completed=false;try{const result=await client.turn({preset:'banyu-qq',selection:{provider:c.model.provider,model:c.model.model},prompt:'请只回复收到。不调用任何工具。',onSession:(id,meta={})=>{sid=id;if(meta.created!==false){binding=nativeQQ.sessionBinding(client,meta.cwd||undefined);entry=binding.register(id);}},signal:AbortSignal.timeout(120000)});completed=true;return result.text;}finally{if(sid)await (binding||nativeQQ.sessionBinding(client)).finalize(sid,entry,{completed});}}

 const safeModel=()=>({...store.setting('model'),hasKey:!!store.secret('model-api-key')});
 const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 const exists=(kind,id)=>{const v=store.get(kind,id);if(!v)fail('记录不存在',404);return v};
 const uniqueName=(kind,value,id)=>{if(store.list(kind).some(x=>x.id!==id&&x.name===value&&!x.archived))fail('这个名称已经存在',409)};
 const memorySubjects=()=>{const c=nativeQQ.store.settings(),qq=nativeQQ.store.chats().map(chat=>({channel:'qq',account:c.account,conversation:chat.key,name:chat.name||chat.key,zone:''}));if(c.owner&&!qq.some(x=>x.conversation==='private:'+c.owner))qq.push({channel:'qq',account:c.account,conversation:'private:'+c.owner,name:'主人 '+c.owner,zone:''});const known=[...qq,...store.conversations().filter(c=>c.channelId==='weixin').map(c=>({channel:'weixin',account:store.secret('weixin')?.accountId||'',conversation:c.kind+':'+c.externalId,name:c.name,zone:c.zoneId||''}))];return [...known,...memoryBank.subjects().filter(s=>!known.some(k=>k.channel===s.channel&&k.conversation===s.conversation))];};
 function importHistory(){if(!memoryBank.settings().recording)fail('请先在设置中开启记录新消息',409);const before=memoryBank.list().counts.chats||0;let scanned=0;const q=nativeQQ.store.settings();for(const chat of nativeQQ.store.chats()){if(!nativeQQ.allowed(chat.key)&&!memoryBank.settings().shared)continue;for(const m of nativeQQ.store.messages(chat.key,{limit:1000})){if(scanned++>=10000)break;if(m.meta.internalApproval||m.direction==='out'&&m.status!=='sent')continue;const r={channel:'qq',account:q.account,conversation:chat.key,name:chat.name||chat.key,speaker:m.direction==='out'?'机器人':(m.meta.name||'用户')+(m.meta.sender?' ('+m.meta.sender+')':''),direction:m.direction,content:m.body,source:m.direction==='in'&&m.meta.messageId?'incoming:'+m.meta.messageId:'history:'+m.seq,at:m.at};if(memoryBank.canUse(r))memoryBank.capture(r);}if(scanned>=10000)break;}if(scanned<10000)for(const contact of store.conversations().filter(c=>c.channelId==='weixin')){const c=store.rawConversation(contact.id);for(const m of store.messages(c.id,1000)){if(scanned++>=10000)break;if(m.direction==='out'&&m.status!=='sent')continue;engine.remember({...c,zone_id:m.id>=c.history_start?c.zone_id:''},m.id,m.direction,m.body,m.createdAt);}if(scanned>=10000)break;}return {ok:true,added:Math.max(0,(memoryBank.list().counts.chats||0)-before),scanned:Math.min(scanned,10000),limit:10000};}
 async function body(req){if(!String(req.headers['content-type']).startsWith('application/json'))fail('请使用 JSON 请求',415);let raw='',size=0;for await(const chunk of req){size+=chunk.length;if(size>512000)fail('内容过大',413);raw+=chunk;}try{const b=JSON.parse(raw);if(!b||typeof b!=='object'||Array.isArray(b))fail('请求内容无效');return b}catch{fail('请求内容无效')}}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
  res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   const actualPort=server.address()?.port||port;const hosts=[`127.0.0.1:${actualPort}`,`localhost:${actualPort}`];
   if(!hosts.includes(req.headers.host))fail('仅允许本机访问',403);
   const url=new URL(req.url,'http://'+req.headers.host),route=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
   if(route[0]!=='api'){
    if(req.method!=='GET')fail('请求方式无效',405);
    const file={'/':'index.html','/app.js':'app.js','/local-qq.js':'local-qq.js','/qq-chat.js':'qq-chat.js','/qq-chat.css':'qq-chat.css','/persona-editor.js':'persona-editor.js','/persona-editor.css':'persona-editor.css','/workspace-chrome.js':'workspace-chrome.js','/workspace-chrome.css':'workspace-chrome.css','/deepseek.js':'deepseek.js','/memory.js':'memory.js','/memory.css':'memory.css','/appearance.js':'appearance.js','/appearance.css':'appearance.css','/quiet-ui.js':'quiet-ui.js','/quiet-ui.css':'quiet-ui.css','/weixin-settings.js':'weixin-settings.js','/weixin-settings.css':'weixin-settings.css','/style.css':'style.css','/qq.css':'qq.css','/minimal.css':'minimal.css','/icon.svg':'icon.svg'}[url.pathname];if(!file)fail('页面不存在',404);
    res.setHeader('content-type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8');res.end(fs.readFileSync(path.join(root,'public',file)));return;
   }
   if(url.pathname==='/api/health'&&req.method==='GET'){json(res,{ok:true,app:'whale-service-desk',version:build.version,revision:build.revision});return;}
   const agentRoute=url.pathname==='/api/qq-agent',expected=agentRoute?nativeQQ?.agentToken:token;
   const given=String(req.headers[agentRoute?'x-qq-agent-token':'x-admin-token']||'');if(!expected||Buffer.byteLength(given)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(given),Buffer.from(expected)))fail('请从桌面快捷方式重新打开工作台',401);
   if(req.headers.origin&&!hosts.map(x=>'http://'+x).includes(req.headers.origin))fail('不允许跨站请求',403);
   if(req.headers['sec-fetch-site']==='cross-site')fail('不允许跨站请求',403);
   const mutation=['POST','PUT','DELETE'].includes(req.method);const b=mutation&&req.method!=='DELETE'?await body(req):{};
   const [,kind,id,action]=route,method=req.method;
   let result;
   if(agentRoute){if(method!=='POST'||!nativeQQ)fail('工具接口不存在',404);try{result=await nativeQQ.agent(b.action,b.args,String(b.callId||''));}catch(e){if(b.action==='computer_action'&&e.message==='电脑操作未获确认或确认已过期')result={status:'not-executed',reason:'approval-not-granted',detail:'未收到有效确认，操作未执行。不能声称只是回执丢失；不要自动重新申请，等待主人重新提出任务。'};else throw e;}}
   else if(kind==='links'&&method==='POST')result=await openLocalLink(id,{quark:machine.quarkExecutable||'D:\\Quark\\quark.exe'});
   else if(kind==='qq-chat'){
    if(!nativeQQ)fail('原生 QQ 引擎尚未启用',409);
    if(method==='GET'&&!id)result=nativeQQ.dashboard();
    else if(id==='computer-stop'&&method==='POST')result=nativeQQ.stopComputer();
    else if(id==='owner-work-resolve'&&method==='POST')result=await nativeQQ.ownerWork.resolve(b.acknowledged);
    else if(id==='model-catalog'&&method==='GET')result=await nativeQQ.modelCatalog();
    else if(id==='check-connection'&&method==='POST'){const checks=await nativeQQ.checkConnection();const gateway=await localQQ.status(true);result={...checks,authorization:gateway.mode==='pmhq'?localQQ.authorizationSummary(gateway.accountMatches):gateway.authorization,login:{ready:gateway.accountMatches===true,state:gateway.state,detail:gateway.detail}};}
    else if(id==='settings'&&method==='PUT'){try{result=nativeQQ.updateSettings(b)}catch(e){e.status||=400;throw e;}}
    else if(id==='roles'&&method==='POST'){try{result=nativeQQ.store.saveRole({name:b.name,prompt:b.prompt})}catch(e){e.status||=400;throw e;}}
    else if(id==='roles'&&action&&method==='PUT'){if(!nativeQQ.store.role(action))fail('角色不存在',404);result=nativeQQ.store.saveRole({...b,id:action});if(nativeQQ.store.settings().roleId===action)for(const turn of nativeQQ.active.values())turn.abort.abort();}
    else if(id==='roles'&&action&&method==='DELETE'){const rev=url.searchParams.get('revision');if(rev!==null&&!/^\d+$/.test(rev))fail('角色版本无效');result=nativeQQ.store.deleteRole(action,rev===null?undefined:Number(rev));}
    else if(id==='groups'&&method==='GET'){if(!await nativeQQ.verified())fail('QQ 尚未在线',409);const groups=await nativeQQ.client.raw('get_group_list');result=(Array.isArray(groups)?groups:[]).map(g=>({id:String(g.group_id),name:String(g.group_name||g.group_id)}));}
    else if(id==='chats'&&action){if(!/^(private|group):\d{5,12}$/.test(action))fail('会话标识无效');if(method==='GET')result=nativeQQ.store.messages(action,{limit:100});else if(method==='PUT'){if(typeof b.paused!=='boolean')fail('会话开关无效');const c=nativeQQ.store.chat(action);result=nativeQQ.store.saveChat({...c,paused:b.paused});if(b.paused)nativeQQ.active.get(action)?.abort.abort();}else fail('操作不存在',404);}
    else if(id==='glossary'&&method==='POST'){nativeQQ.store.saveTerm(b.term,b.meaning);result={ok:true};}
    else fail('原生 QQ 操作不存在',404);
   }
   else if(kind==='state'&&method==='GET'){modelHealth().catch(()=>{});result={modelSettings:Object.fromEntries(['qq','weixin'].map(c=>[c,channelModels.summary(c)])),deepseek:deepseekAPI.config(),stats:store.stats(),dshCleanup:sessionCleanup.stats(),computerControl:nativeQQ.computerStatus(),paused:store.setting('paused')===true,channels:Object.fromEntries(Object.entries(channels).map(([k,v])=>[k,v.status()])),model:health,bindings:store.bindings(),dataDir,qqWorkbench:usesExistingQQ,qqNative:!!nativeQQ,localQQ:await localQQ.status()};if(usesExistingQQ&&localQQ.active){const q=result.channels.qq,g=result.localQQ;q.gateway='llbot';if(!g.accountMatches){q.state=g.state==='checking'?'connecting':['restoring','reconnecting'].includes(g.state)?'reconnecting':g.state==='restore-pending'?'error':'disconnected';q.account=null;q.detail=g.detail;}}}
   else if(kind==='local-qq'){
    if(method==='GET'&&id==='state')result=await localQQ.status();
    else if(method==='POST'&&id==='settings')result=await localQQ.save(b);
    else if(method==='POST'&&id==='qr'){if(b.renew!==undefined&&typeof b.renew!=='boolean')fail('刷新参数无效');result=await localQQ.qr({renew:b.renew===true});}
    else if(method==='POST'&&id==='enable-desktop')result=await localQQ.enableDesktop();
    else if(method==='POST'&&id==='open-client')result=await localQQ.openClient();
    else if(method==='POST'&&id==='attach-desktop')result=await localQQ.attachDesktop(b);
    else if(method==='POST'&&id==='install')result=await localQQ.install();
    else if(method==='POST'&&['start','stop','logout','activate','rollback','recover','restore'].includes(id))result=await localQQ[id]();
    else fail('接口不存在',404);
   }
   else if(kind==='qq-workbench')fail('QQ 设置已迁入伴屿原生页面',410);
   else if(kind==='model-settings'){
    if(!['qq','weixin'].includes(id))fail('请选择 QQ 或微信',404);
    if(method==='GET'&&!action)result=channelModels.read(id);
    else if(method==='GET'&&action==='catalog')result=id==='qq'?await nativeQQ.modelCatalog():await models.catalog();
    else if(method==='PUT'&&!action){result=channelModels.save(id,b);afterModelChange(id);}
    else if(method==='POST'&&action==='test'){try{result={ok:true,reply:String(await testPlatformModel(id)).slice(0,300)};}catch(e){fail(e.message||'模型测试失败，请检查本平台设置',503);}}
    else fail('模型设置接口不存在',404);
   }
   else if(kind==='deepseek-api'){
    if(!id&&method==='GET')result={config:deepseekAPI.config(),health:await deepseekAPI.health()};
    else fail('模型现已按 QQ 和微信分开，请刷新工作台后再设置',410);
   }
   else if(kind==='memory'){
    if(id==='settings'&&method==='GET')result=memoryBank.settings();
    else if(id==='settings'&&method==='PUT')result=memoryBank.updateSettings(b);
    else if(id==='subjects'&&method==='GET')result=memorySubjects();
    else if(id==='import-history'&&method==='POST')result=importHistory();
    else if(!id&&method==='GET')result=memoryBank.list(Object.fromEntries(url.searchParams));
    else if(!id&&method==='POST'){const subject=memorySubjects().find(s=>s.channel===b.channel&&s.conversation===b.conversation);if(!subject)fail('请选择已有会话，或先给机器人发一条消息');result=memoryBank.note({...b,...subject});}
    else if(/^\d+$/.test(id||'')&&method==='GET')result=memoryBank.get(id);
    else if(/^\d+$/.test(id||'')&&method==='PUT')result=memoryBank.update(id,b);
    else if(/^\d+$/.test(id||'')&&method==='DELETE')result=memoryBank.remove(id,Number(url.searchParams.get('revision')));
    else fail('记忆操作不存在',404);
   }
   else if(['roles','zones','knowledge'].includes(kind)){
    if(!id&&method==='GET')result=store.list(kind).filter(x=>!x.archived);
    else if(kind==='zones'&&action&&method==='POST'){
     exists(kind,id);if(action==='bind')store.bind(id,b);else if(action==='unbind')store.unbind(id,b);else fail('操作不存在',404);result={ok:true};
    }else if((!id&&method==='POST')||(id&&method==='PUT')){
     const prior=id?exists(kind,id):{};let value;
     if(kind==='roles')value=validateRole(b,prior);
     if(kind==='zones')value=validateZone(b,store,prior);
     if(kind==='knowledge'){if(b.zoneId!=='*'&&(!store.get('zones',b.zoneId)||store.get('zones',b.zoneId).archived))fail('请选择资料所属分区');value={...prior,title:name(b.title),body:text(b.body,60000),zoneId:b.zoneId,enabled:b.enabled!==false};if(!value.body)fail('资料内容不能为空');}
     if(kind!=='knowledge')uniqueName(kind,value.name,id);
     result=store.put(kind,id||randomUUID(),value);store.log('info',`已保存${kind==='roles'?'角色':kind==='zones'?'分区':'资料'}。`);
    }else if(id&&method==='DELETE'){
     exists(kind,id);if(kind==='roles'&&store.list('zones').some(z=>z.roleId===id))fail('这个角色仍被分区使用，请先修改分区的角色',409);if(kind==='roles'&&store.list('roles').length<=1)fail('至少保留一个角色',409);
     if(kind==='zones'){store.put(kind,id,{...exists(kind,id),archived:true,enabled:false});for(const binding of store.bindings(id))store.unbind(id,binding)}else store.remove(kind,id);result={ok:true};
    }else fail('操作不存在',404);
   }else if(kind==='conversations'){
    if(!id&&method==='GET')result=store.conversations();
    else {const c=store.rawConversation(id);if(!c)fail('会话不存在',404);if(method==='GET')result={...store.conversations().find(x=>x.id===id),messages:store.messages(id,100)};
     else if(method==='POST'&&action==='reply'){const reply=text(b.text,2500);if(!reply)fail('回复不能为空');try{await engine.humanReply(id,reply)}catch{fail('发送失败，请检查接入端及有效回复上下文',409)}result={ok:true};}
     else if(method==='POST'&&action==='handoff'){store.handoff(id,'运营者主动接管');result={ok:true};}
     else if(method==='POST'&&action==='resume'){store.resume(id);result={ok:true};}else fail('操作不存在',404);
    }
   }else if(kind==='tickets'&&method==='GET')result=store.tickets();
   else if(kind==='logs'&&method==='GET')result=store.logs();
   else if(kind==='pause'&&method==='POST'){store.setting('paused',b.paused===true);result={ok:true};}
   else if(kind==='preview'&&method==='POST'){const zone=exists('zones',b.zoneId);const question=text(b.text,4000);if(!question)fail('请输入试聊内容');try{result=await engine.plan(zone,question)}catch{fail('模型暂不可用，请到接入与模型检查连接',503)}}
   else if(kind==='model'){
    if(method==='GET')result={config:safeModel(),health:await modelHealth()};
    else if(method==='PUT'){
     if(!['dsh','openai'].includes(b.provider))fail('模型来源无效');
     const current=channelModels.read('weixin');channelModels.save('weixin',{revision:current.revision,source:b.provider,[b.provider]:b.provider==='dsh'?{baseUrl:b.baseUrl||'',providerId:b.providerId||'workbuddy-ai',model:b.model||'deepseek-v4.1-flash'}:{baseUrl:b.baseUrl,model:b.model,apiKey:b.apiKey,clearKey:b.clearKey===true}});afterModelChange('weixin');result=store.setting('model');
    }else if(method==='POST'&&id==='test'){try{const reply=await (generate||((p)=>models.generate(p)))({role:'请只回复“收到”。',question:'连接测试',knowledge:[],history:[]});result={ok:true,reply:String(reply).slice(0,300)}}catch{fail('模型测试失败，请检查 DSH 客服预设或 API 设置',503)}}else fail('操作不存在',404);
   }else if(kind==='channels'&&channels[id]&&method==='POST'){
    const channel=channels[id];
    if(action==='settings'&&id==='qq'&&usesExistingQQ)fail('QQ 已复用鲸鲸工作台，请到 QQ 页管理小号');
    if(action==='settings'&&id==='qq'){
     if(channel.bot)fail('请先断开 QQ 再修改凭据',409);const old=store.secret('qq')||{},appId=text(b.appId,40),appSecret=b.appSecret?text(b.appSecret,256):old.appId===b.appId?old.appSecret:'';
     if(!/^\d{5,30}$/.test(appId)||!appSecret||appSecret.length<8)fail('请填写官方机器人的 AppID 和 AppSecret');store.secret('qq',{appId,appSecret});result=channel.status();
    }else if(action==='connect'){if(id==='qq'&&nativeQQ)await localQQ.start();await channel.connect();store.put('channels',id,{...store.get('channels',id),autoConnect:true});result=channel.status();}
    else if(action==='disconnect'){if(id==='qq'&&usesExistingQQ)fail('请在 QQ 工作台的登录页管理小号连接');await channel.disconnect();store.put('channels',id,{...store.get('channels',id),autoConnect:false});result=channel.status();}
    else if(action==='login-start'&&id==='weixin'){result=await channel.startLogin();}
    else if(action==='login-poll'&&id==='weixin'){if(b.verifyCode!==undefined&&!/^\d{4,8}$/.test(b.verifyCode))fail('请输入手机上显示的 4–8 位数字验证码');if(!loginPoll)loginPoll=channel.pollLogin(b.verifyCode).finally(()=>{loginPoll=null});result=await loginPoll;}
    else fail('操作不存在',404);
   }else if(kind==='export'&&method==='GET'){res.setHeader('content-disposition','attachment; filename="whale-workspace.json"');result={version:1,exportedAt:new Date().toISOString(),roles:store.list('roles'),zones:store.list('zones'),knowledge:store.list('knowledge')};}
   else fail('接口不存在',404);
   json(res,result);
  }catch(error){if(!res.headersSent)json(res,{error:error.status?error.message:'操作失败，请检查设置和接入状态'},error.status||500);else res.end();}
 });
 server.requestTimeout=150000;server.headersTimeout=10000;
 async function start(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});if(!adapters&&localQQ.active)localQQ.start().catch(()=>store.log('warn','QQ 接管未能恢复连接，请到 QQ 页检查。'));if(nativeQQ&&!adapters&&nativeQQ.autoConnect)nativeQQ.connect().catch(()=>store.log('warn','QQ 消息连接暂不可用。'));for(const [id,c]of Object.entries(channels))if(store.get('channels',id)?.autoConnect)c.connect().catch(()=>store.log('warn',`${id} 尚未恢复连接，请检查设置。`));modelHealth().catch(()=>{});return server.address().port;}
 async function close(){await Promise.allSettled(Object.values(channels).map(c=>c.disconnect()));await Promise.allSettled([...engine.queues.values()]);await new Promise(r=>server.close(r));await sessionCleanup.close();nativeQQ?.close();memoryBank.close();store.close();}
 return {server,store,engine,models,memoryBank,deepseekAPI,channelModels,channels,localQQ,nativeQQ,sessionCleanup,start,close,token};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=createApp({port:Number(process.env.WHALE_PORT||3200),dataDir:process.env.WHALE_DATA_DIR||path.join(root,'data')});
 app.start().then(port=>console.log(`伴屿双端工作台已启动：http://127.0.0.1:${port}（从桌面快捷方式进入）`)).catch(()=>{console.error('工作台启动失败，请检查端口是否占用。');process.exit(1)});
 let stopping=false;const stop=async explicit=>{if(stopping)return;stopping=true;if(explicit){await Promise.allSettled(Object.values(app.channels).map(c=>c.disconnect()));await app.localQQ.stop().catch(()=>{});}await app.close();process.exit(0);};
 for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>stop(false));
 if(process.send)process.on('message',message=>{if(message?.type==='shutdown')stop(true);});
}
