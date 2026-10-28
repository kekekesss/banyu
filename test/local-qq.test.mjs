import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {LocalQQ,CORE,coreProxy,coreEnvironment,coreLaunchArgs} from '../src/local-qq.mjs';

import {createApp} from '../src/server.mjs';

const base=path.resolve('qa/local-qq-tests');fs.mkdirSync(base,{recursive:true});
test('本机代理只应用于核心子进程，保留本机直连且拒绝远程、凭据与路径',()=>{
 for(const value of ['https://example.com:7897','http://192.168.1.1:7897','http://u:p@localhost:7897','http://localhost:7897/path','http://localhost:0','http://localhost:65536','http://localhost:7897?key=secret',null])assert.throws(()=>coreProxy(value));
 assert.equal(coreProxy(' http://127.0.0.1:7897/ '),'http://127.0.0.1:7897');
 const parent={HTTPS_PROXY:'old',NO_PROXY:'example.test',KEEP:'same'},before={...parent};const child=coreEnvironment(parent,'http://127.0.0.1:7897');
 assert.deepEqual(parent,before);assert.equal(child.HTTPS_PROXY,'http://127.0.0.1:7897');assert.equal(child.http_proxy,child.HTTP_PROXY);assert.equal(child.KEEP,'same');for(const host of ['127.0.0.1','localhost','::1','example.test'])assert.ok(child.NO_PROXY.split(',').includes(host));assert.deepEqual(coreEnvironment(parent,''),parent);
});

test('授权区分已保存、当前使用和待应用，网络未知时不声称授权失效',async t=>{
 const {g}=fixture(t,{mode:'pmhq'});await g.save({authorization:'AUTH-ORIGINAL-PRIVATE',consented:true});
 assert.equal(g.authorizationSummary(false).state,'saved');
 const file=path.join(g.dir,'desktop/pmhq_config.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({auth_token:'AUTH-ORIGINAL-PRIVATE'}));
 assert.equal(g.authorizationSummary(true).state,'in-use');assert.equal(g.authorizationSummary(false).state,'saved');
 await g.save({authorization:'AUTH-NEW-PRIVATE',consented:true});const summary=g.authorizationSummary(true);assert.equal(summary.state,'pending');assert.equal(summary.pending,true);assert.ok(!JSON.stringify(summary).includes('AUTH-'));
 assert.equal(JSON.parse(fs.readFileSync(file)).auth_token,'AUTH-ORIGINAL-PRIVATE','保存新令牌不改动正在运行的接管配置');
});
function fixture(t,{identity='1990000002',online=true,healthy=true,restartStatus=200,mode='direct',nativeMode=mode}={}){
 const root=fs.mkdtempSync(path.join(base,'case-')),dataDir=path.join(root,'data'),companionRoot=path.join(root,'old');fs.mkdirSync(path.join(companionRoot,'qq-bridge'),{recursive:true});
 const old={snowluma:{homeDir:'D:/old-snow',accessToken:'OLD-QQ-TOKEN',httpUrl:'http://127.0.0.1:3000'},role:'USER-ROLE',access:{allow:{groups:['123456789']}},socialV2:{proactive:{enabled:true}}};fs.writeFileSync(path.join(companionRoot,'qq-bridge/config.json'),JSON.stringify(old));
 const core=path.join(root,'components','llbot-'+CORE.version,'bin','llbot');fs.mkdirSync(core,{recursive:true});for(const f of ['node.exe','llbot.js','sign-proxy.win-x64.node'])fs.writeFileSync(path.join(core,f),'fixture');
 const settings=path.join(dataDir,'local-qq','settings.json');fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,JSON.stringify({account:'1990000002',owner:'1990000001',consented:false,mode}));
 let running=true;const requests=[];const bridge={proxy:async(p,m,b)=>{requests.push({p,m,b});return {status:restartStatus,value:{ok:true}}},connect:async()=>{requests.push({p:'connect'})}};
 const request=async(url,options)=>{requests.push({url:String(url),options});const p=new URL(url).pathname;let data;
  if(p==='/api/login-info')data={online,uin:identity,nick:'鲸鲸',mode:nativeMode,secret:'NATIVE-SECRET-DO-NOT-RETURN'};
  else if(p==='/api/auth-token/status')data={validation:'valid',hasToken:true};
  else if(p==='/api/login-qrcode')data={pngBase64QrcodeData:'data:image/png;base64,aGVsbG8=',expireTime:60};
  else if(p==='/get_login_info')data={user_id:Number(identity),nickname:'鲸鲸'};
  else if(p==='/get_status')data={online,good:healthy};
  else if(p==='/api/logout')running=false;
  else throw Error('Unexpected endpoint '+p);
  return new Response(JSON.stringify({success:true,status:'ok',retcode:0,data}));
 };
 const desktopCalls=[];const desktop={installed:true,status:async()=>({installed:true,running:true,qqRunning:true,qqExecutable:'D:/fixture/QQ.exe',port:3312}),start:async options=>{desktopCalls.push({action:'start',options})},open:async()=>{desktopCalls.push({action:'open'})}};
 const g=new LocalQQ({root,dataDir,companionRoot,bridge,request,desktop,processes:{inspect:async()=>running,start:async()=>{running=true},stop:async()=>{running=false;return true}}});g.available=async()=>true;
 return {g,root,dataDir,companionRoot,requests,old,desktopCalls,setRunning:v=>running=v,setOnline:v=>online=v,setNativeMode:v=>nativeMode=v};
}
function savedSession(g,uin=g.options.account){const p=path.join(g.cwd,'data','qq-session-'+g.options.account+'.json');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify({uin,enc:'PRIVATE-ENCRYPTED-SESSION',savedAt:123456}));return p;}

test('已登录客户端接管仍须管理员确认指定账号及电脑模式，凭据只传本机组件',async t=>{
 const f=fixture(t),calls=[];await f.g.save({authorization:'PRIVATE-ATTACH-AUTH',consented:true});
 f.g.options.mode='pmhq';f.setNativeMode('pmhq');f.setRunning(true);f.setOnline(false);
 f.g.desktop.attachExisting=async options=>calls.push(options);
 for(const input of [{account:f.g.options.account},{account:f.g.options.owner,confirmed:true},{account:'other',confirmed:true}])await assert.rejects(f.g.attachDesktop(input));
 assert.equal(calls.length,0);
 await f.g.attachDesktop({account:f.g.options.account,confirmed:true});assert.equal(calls.length,1);assert.equal(calls[0].confirmedAccount,f.g.options.account);
 assert.equal(calls[0].authorization,'PRIVATE-ATTACH-AUTH');
 f.g.options.mode='direct';await assert.rejects(f.g.attachDesktop({account:f.g.options.account,confirmed:true}));assert.equal(calls.length,1);
});

test('新安装默认电脑QQ模式，旧未指定模式的设置仍保留direct直到明确切换',t=>{
 const {g,root,dataDir,companionRoot}=fixture(t);const file=path.join(g.dir,'settings.json');
 fs.writeFileSync(file,JSON.stringify({account:g.options.account,owner:g.options.owner,consented:true}));
 assert.equal(new LocalQQ({root,dataDir,companionRoot,desktop:g.desktop}).mode,'direct');
 fs.unlinkSync(file);
 assert.equal(new LocalQQ({root,dataDir,companionRoot,desktop:g.desktop}).mode,'pmhq');
});
test('客户端启动参数固定使用本机PMHQ端口，不把账号或direct线路交给LLBot',()=>{
 const args=coreLaunchArgs('D:/fixture/llbot',{mode:'pmhq',account:'1990000002',cdn:'china',freshLogin:true});
 assert.deepEqual(args.slice(1),['--pmhq-host=127.0.0.1','--pmhq-port=3312']);
 const direct=coreLaunchArgs('D:/fixture/llbot',{mode:'direct',account:'1990000002',cdn:'china'});
 assert.deepEqual(direct.slice(1),['--qq=1990000002','--cdn=china']);
});
test('客户端模式以原生模式和小号身份判断登录，不依赖direct授权状态或扫码恢复',async t=>{
 const {g,requests,desktopCalls}=fixture(t,{mode:'pmhq'});
 await g.save({authorization:'DESKTOP-AUTH-LOCAL',consented:true});
 const s=await g.restore();assert.equal(s.mode,'pmhq');assert.equal(s.state,'online');assert.equal(s.nativeMode,'pmhq');assert.equal(s.accountMatches,true);assert.equal(s.savedLogin.available,false);assert.equal(s.desktop.port,3312);
 assert.ok(desktopCalls.some(c=>c.action==='start'));
 assert.ok(!requests.some(c=>/quick-login|auth-token\/status|login-qrcode/.test(c.url||'')));
 await assert.rejects(g.qr(),/电脑 QQ/);await assert.rejects(g.logout(),/QQ 客户端/);
 for(const route of ['/api/quick-login','/api/login-qrcode','/api/logout'])await assert.rejects(g.native(route,{uin:g.options.account}),/QQ 客户端/);
 assert.ok(!JSON.stringify(s).includes('DESKTOP-AUTH-LOCAL'));
});
test('客户端未登录、模式不符和主号登录都不能接管消息',async t=>{
 const offline=fixture(t,{mode:'pmhq',online:false}).g;
 const waiting=await offline.status(true);assert.equal(waiting.state,'awaiting-client');assert.equal(waiting.canActivate,false);assert.match(waiting.detail,/电脑 QQ/);
 for(const nativeMode of ['direct',undefined]){
  const f=fixture(t,{mode:'pmhq',nativeMode:'direct'});f.setNativeMode(nativeMode);
  const s=await f.g.status(true);assert.equal(s.state,'mode-mismatch');assert.equal(s.loginKnown,false);assert.equal(s.canActivate,false);await assert.rejects(f.g.activate(),/指定小号/);
 }
 const owner=fixture(t,{mode:'pmhq',identity:'1990000001'}).g;let stopped=0;const stop=owner.processes.stop;owner.processes.stop=async()=>{stopped++;return stop()};
 const wrong=await owner.status(true);assert.equal(wrong.state,'wrong-account');assert.equal(wrong.running,false);assert.equal(stopped,1);await assert.rejects(owner.activate(),/指定小号/);
});
test('切换电脑QQ仅停止自有node并保留session、密钥、人设及桥接配置',async t=>{
 const f=fixture(t),{g,setNativeMode,desktopCalls}=f;await g.save({authorization:'MIGRATE-DESKTOP-AUTH',consented:true});
 const session=savedSession(g),sessionBefore=fs.readFileSync(session,'utf8'),credentials=g.credentials(),configBefore=fs.readFileSync(g.configFile,'utf8'),order=[];
 const stop=g.processes.stop,start=g.processes.start,desktopStart=g.desktop.start;
 g.processes.stop=async()=>{order.push('stop-node');return stop()};g.desktop.start=async o=>{order.push('desktop');return desktopStart(o)};
 g.processes.start=async o=>{order.push('start-node');setNativeMode('pmhq');return start(o)};
 const s=await g.enableDesktop();assert.equal(s.mode,'pmhq');assert.equal(s.online,true);assert.deepEqual(order,['stop-node','desktop','start-node']);
 assert.equal(JSON.parse(fs.readFileSync(path.join(g.dir,'settings.json'))).mode,'pmhq');
 assert.equal(fs.readFileSync(session,'utf8'),sessionBefore);assert.equal(fs.readFileSync(g.authFile,'utf8'),'MIGRATE-DESKTOP-AUTH');assert.deepEqual(g.credentials(),credentials);assert.equal(fs.readFileSync(g.configFile,'utf8'),configBefore);assert.equal(desktopCalls.length,1);
});
test('身份不符不停止或切换，桌面启动失败后保持已选客户端模式而不退回扫码',async t=>{
 const denied=fixture(t).g;await denied.save({authorization:'DENIED-MODE-AUTH',consented:true});denied.processes.stop=async()=>false;
 await assert.rejects(denied.enableDesktop(),/进程身份/);assert.equal(denied.mode,'direct');
 const failed=fixture(t).g;await failed.save({authorization:'FAILED-MODE-AUTH',consented:true});failed.desktop.start=async()=>{throw Object.assign(Error('请先关闭未受管的QQ'),{status:409})};
 await assert.rejects(failed.enableDesktop(),/未受管/);assert.equal(failed.mode,'pmhq');assert.equal(JSON.parse(fs.readFileSync(path.join(failed.dir,'settings.json'))).mode,'pmhq');
});
test('默认和其他QQ账号关闭全部消息通道，仅指定小号开放且不删除已有凭据',async t=>{
 const {g}=fixture(t,{mode:'pmhq'});const defaults=path.join(g.core,'default_config.json'),other=path.join(g.cwd,'data/config_1990000001.json');fs.mkdirSync(path.dirname(other),{recursive:true});
 const old={webui:{port:3080},ob11:{enable:true,connect:[{enable:true,token:'PRESERVE-OTHER-TOKEN',port:3300}]},milky:{enable:true},satori:{enable:true},keep:'other-account-setting'};
 fs.writeFileSync(defaults,JSON.stringify(old));fs.writeFileSync(other,JSON.stringify(old));g.configure();
 for(const file of [defaults,other]){const value=JSON.parse(fs.readFileSync(file));assert.equal(value.ob11.enable,false);assert.ok(value.ob11.connect.every(c=>c.enable===false));assert.equal(value.ob11.connect[0].token,'PRESERVE-OTHER-TOKEN');assert.equal(value.milky.enable,false);assert.equal(value.satori.enable,false);assert.equal(value.keep,old.keep)}
 const bot=JSON.parse(fs.readFileSync(path.join(g.cwd,'data/config_1990000002.json')));assert.equal(bot.ob11.enable,true);assert.deepEqual(bot.ob11.connect.map(c=>c.port),[3300,3301]);assert.ok(bot.ob11.connect.every(c=>c.host==='127.0.0.1'));
});
test('并发启动合并PMHQ与node启动，停止只处理node且打开客户端不调用logout',async t=>{
 const {g,setRunning,desktopCalls,requests}=fixture(t,{mode:'pmhq',online:false});await g.save({authorization:'DESKTOP-START-AUTH',consented:true});setRunning(false);
 const desktopStart=g.desktop.start;let release,starts=0;g.desktop.start=async o=>{await new Promise(r=>release=r);return desktopStart(o)};
 const start=g.processes.start;g.processes.start=async o=>{starts++;return start(o)};
 const a=g.start(),b=g.start();while(!release)await new Promise(r=>setImmediate(r));release();await Promise.all([a,b]);assert.equal(starts,1);assert.equal(desktopCalls.length,1);
 g.desktop.start=desktopStart;g.desktop.stop=async()=>{throw Error('不允许关闭电脑QQ')};await g.stop();assert.equal((await g.status(true)).running,false);
 await g.openClient();assert.equal(desktopCalls.at(-1).action,'open');assert.ok(!requests.some(x=>x.url?.endsWith('/api/logout')));
});

test('恢复只使用指定小号的保存状态，不泄露凭据、不要求密码或重启在线核心',async t=>{
 const {g,setOnline,requests,old}=fixture(t,{online:false});await g.save({authorization:'RESTORE-AUTH',consented:true});const file=savedSession(g),before=fs.readFileSync(file,'utf8');
 assert.equal((await g.status(true)).state,'saved-login');assert.equal(g.baseState().passwordLogin,false);assert.ok(!JSON.stringify(g.baseState()).includes('PRIVATE-ENCRYPTED-SESSION'));
 const previous=g.request;g.request=async(url,options)=>{if(new URL(url).pathname==='/api/quick-login'){assert.deepEqual(JSON.parse(options.body),{uin:'1990000002'});setOnline(true);return new Response(JSON.stringify({success:true,data:{result:'0'}}));}return previous(url,options)};
 assert.equal((await g.restore()).state,'online');assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readFileSync(g.authFile,'utf8'),'RESTORE-AUTH');assert.deepEqual(JSON.parse(fs.readFileSync(g.configFile)),old);assert.ok(!requests.some(x=>x.url?.endsWith('/api/login-qrcode')));
 g.request=async()=>{throw Error('Already online: no new login expected')};g.status=async()=>({online:true,accountMatches:true});assert.equal((await g.restore()).online,true);
});
test('未保存、主号凭据及无授权时均不尝试快速登录',async t=>{
 const {g,requests}=fixture(t,{online:false});await assert.rejects(g.restore(),/没有此小号/);savedSession(g,'1990000001');await assert.rejects(g.restore(),/没有此小号/);savedSession(g);await assert.rejects(g.restore(),/授权/);await assert.rejects(g.native('/api/quick-login',{uin:'1990000001'}),/机器人小号/);assert.ok(!requests.some(x=>x.url?.endsWith('/api/quick-login')));
});
test('恢复失败有明确结果并保留原凭据，网络未就绪不会误认为重新授权成功',async t=>{
 const {g}=fixture(t,{online:false});await g.save({authorization:'RESTORE-AUTH',consented:true});const file=savedSession(g);const before=fs.readFileSync(file,'utf8'),previous=g.request;
 g.request=async(url,options)=>new URL(url).pathname==='/api/quick-login'?new Response(JSON.stringify({success:false,message:'session 已失效，请扫码重新登录'}),{status:500}):previous(url,options);
 const result=await g.restore();assert.equal(result.state,'login-required');assert.equal(result.online,false);assert.match(result.detail,/重新扫码/);assert.equal(fs.readFileSync(file,'utf8'),before);
 g.request=async(url,options)=>new URL(url).pathname==='/api/auth-token/status'?new Response(JSON.stringify({success:true,data:{validation:'error',message:'网络连接失败'}})):previous(url,options);
 assert.equal((await g.status(true)).state,'connection-error');await assert.rejects(g.restore(),/授权服务尚未连通/);
});
test('授权检查瞬断不会推翻本轮已确认的小号在线，登录检查失败也不会沿用假在线',async t=>{
 const {g}=fixture(t);await g.save({authorization:'STATUS-AUTH',consented:true});const previous=g.request;
 g.request=async(url,options)=>{if(new URL(url).pathname==='/api/auth-token/status')throw Error('temporary auth outage');return previous(url,options)};
 const online=await g.status(true);assert.equal(online.state,'online');assert.equal(online.online,true);assert.equal(online.loginKnown,true);assert.equal(online.accountMatches,true);assert.equal(online.authorization.state,'unknown');assert.equal(typeof online.observedAt,'number');
 g.request=async(url,options)=>{if(new URL(url).pathname==='/api/login-info')throw Error('temporary manager outage');return previous(url,options)};
 const unknown=await g.status(true);assert.equal(unknown.state,'checking');assert.equal(unknown.loginKnown,false);assert.equal(unknown.online,false);assert.equal(unknown.canActivate,false);assert.equal(unknown.identity,undefined);assert.doesNotMatch(unknown.detail,/已失效|重新扫码登录/);
 let stopped=0;g.processes.stop=async()=>{stopped++;return true};await assert.rejects(g.recover(),/无法确认/);assert.equal(stopped,0,'管理接口未知时不误重启实际在线的核心');
});
test('快速登录超过四秒仍保持等待，重复点击不重发请求，稍后上线会清除恢复状态',async t=>{
 const {g,setOnline}=fixture(t,{online:false});let now=100000,quickRequests=0;g.now=()=>now;await g.save({authorization:'SLOW-RESTORE-AUTH',consented:true});savedSession(g);const previous=g.request;
 g.request=async(url,options)=>{if(new URL(url).pathname==='/api/quick-login'){quickRequests++;return new Response(JSON.stringify({success:true,data:{result:'0'}}))}return previous(url,options)};
 const started=await g.restore();assert.equal(started.state,'restoring');assert.equal(started.restoreDeadlineAt,145000);
 now+=8000;assert.equal((await g.status(true)).state,'restoring');assert.equal((await g.restore()).state,'restoring');assert.equal(quickRequests,1);
 now+=5000;setOnline(true);const done=await g.status(true);assert.equal(done.state,'online');assert.equal(done.restoreDeadlineAt,0);assert.equal(done.failure,'');assert.equal(g.restoreResult,'');assert.equal(quickRequests,1);
});
test('恢复等待到期只表示未确认，不断言登录失效，也不后台反复尝试',async t=>{
 const {g,setOnline}=fixture(t,{online:false});let now=200000,quickRequests=0;g.now=()=>now;await g.save({authorization:'PENDING-RESTORE-AUTH',consented:true});const file=savedSession(g),before=fs.readFileSync(file,'utf8'),previous=g.request;
 g.request=async(url,options)=>{if(new URL(url).pathname==='/api/quick-login'){quickRequests++;return new Response(JSON.stringify({success:true,data:{result:'0'}}))}return previous(url,options)};
 await g.restore();now+=45001;const pending=await g.status(true);assert.equal(pending.state,'restore-pending');assert.equal(pending.online,false);assert.equal(pending.restoreDeadlineAt,0);assert.doesNotMatch(pending.detail,/失效|撤销|已拒绝/);
 for(let i=0;i<3;i++){now+=60000;assert.equal((await g.status(true)).state,'restore-pending')}
 assert.equal(quickRequests,1);assert.equal(fs.readFileSync(file,'utf8'),before);
 setOnline(true);assert.equal((await g.status(true)).state,'online');assert.equal(quickRequests,1);
});
test('明确拒绝恢复才需要重新登录，普通网络失败保持未确认且均无自动重试',async t=>{
 for(const rejected of [true,false]){
  const {g}=fixture(t,{online:false});await g.save({authorization:'REFUSED-RESTORE-AUTH',consented:true});savedSession(g);let quickRequests=0;const previous=g.request;
  g.request=async(url,options)=>{if(new URL(url).pathname==='/api/quick-login'){quickRequests++;if(!rejected)throw Error('network unavailable');return new Response(JSON.stringify({success:false,message:'session 已失效，请重新登录'}),{status:409})}return previous(url,options)};
  const result=await g.restore();assert.equal(result.state,rejected?'login-required':'restore-pending');assert.equal(result.online,false);
  for(let i=0;i<3;i++)assert.equal((await g.status(true)).state,result.state);assert.equal(quickRequests,1);
 }
});
test('快速登录的通用 HTTP 409 冲突不能被当成保存状态失效',async t=>{
 const {g}=fixture(t,{online:false});await g.save({authorization:'CONFLICT-RESTORE-AUTH',consented:true});savedSession(g);const previous=g.request;let quickRequests=0;
 g.request=async(url,options)=>{if(new URL(url).pathname==='/api/quick-login'){quickRequests++;return new Response(JSON.stringify({success:false,message:'Another login operation is in progress'}),{status:409})}return previous(url,options)};
 const result=await g.restore();assert.equal(result.state,'restore-pending');assert.doesNotMatch(result.detail,/已拒绝|需要重新扫码/);assert.equal((await g.status(true)).state,'restore-pending');assert.equal(quickRequests,1);
});
test('恢复结果变化时丢弃已在途的旧状态查询，不让旧离线结果覆盖新在线状态',async t=>{
 const {g,setOnline}=fixture(t,{online:false});await g.save({authorization:'RACE-RESTORE-AUTH',consented:true});savedSession(g);const previous=g.request;
 let finishQuick,releaseOldAuth,holdAuth=false,quickRequests=0;
 g.request=async(url,options)=>{
  const route=new URL(url).pathname;
  if(route==='/api/quick-login'){quickRequests++;await new Promise(r=>finishQuick=r);return new Response(JSON.stringify({success:true,data:{result:'0'}}))}
  if(route==='/api/auth-token/status'&&holdAuth){holdAuth=false;await new Promise(r=>releaseOldAuth=r)}
  return previous(url,options);
 };
 const restoring=g.restore();while(!finishQuick)await new Promise(r=>setImmediate(r));
 holdAuth=true;const observation=g.status(true);while(!releaseOldAuth)await new Promise(r=>setImmediate(r));
 setOnline(true);finishQuick();await new Promise(r=>setImmediate(r));releaseOldAuth();
 const [result,concurrent]=await Promise.all([restoring,observation]);assert.equal(result.state,'online');assert.equal(concurrent.state,'online');assert.equal(g.cached.state,'online');assert.equal(quickRequests,1);
});
test('并发取码共用请求，恢复期间禁止取码，避免覆盖登录状态',async t=>{
 const {g}=fixture(t,{online:false});await g.save({authorization:'RESTORE-AUTH',consented:true});savedSession(g);let requests=0,release;const previous=g.request;
 g.request=async(url,options)=>{if(new URL(url).pathname==='/api/login-qrcode'){requests++;await new Promise(r=>release=r);}return previous(url,options)};
 const a=g.qr(),b=g.qr();while(!release)await new Promise(r=>setImmediate(r));await assert.rejects(g.restore(),/正在获取二维码/);release();assert.deepEqual(await a,await b);assert.equal(requests,1);
 let finish;const lock=g.exclusive(()=>new Promise(r=>finish=r));await Promise.resolve();await assert.rejects(g.qr(),/恢复连接/);finish();await lock;
});
test('新核心状态只返回小号与安全摘要，不暴露开发者或本机密钥',async t=>{
 const {g}=fixture(t);await g.save({authorization:'PRIVATE-AUTH-TOKEN',consented:true});const c=g.credentials();const s=await g.status(true),raw=JSON.stringify(s);assert.equal(s.canActivate,true);assert.equal(s.identity.id,'1990000002');for(const secret of ['PRIVATE-AUTH-TOKEN','NATIVE-SECRET',c.web,c.onebot])assert.ok(!raw.includes(secret));assert.ok(!g.safe('Auth token='+c.web).includes(c.web));
});
test('连接设置独立保存，保持已登录核心、人设与授权不变',async t=>{
 const {g,old}=fixture(t);await g.save({authorization:'KEEP-AUTHORIZATION',consented:true});g.processes.stop=async()=>{throw Error('不应停止已登录核心')};g.processes.start=async()=>{throw Error('不应重启')};
 const state=await g.save({proxyUrl:'http://127.0.0.1:7897/'});assert.equal(state.online,true);assert.equal(state.proxyUrl,'http://127.0.0.1:7897');assert.equal(fs.readFileSync(g.authFile,'utf8'),'KEEP-AUTHORIZATION');assert.deepEqual(JSON.parse(fs.readFileSync(g.configFile)),old);assert.equal(JSON.parse(fs.readFileSync(path.join(g.dir,'settings.json'))).proxyUrl,state.proxyUrl);
 await assert.rejects(g.save({proxyUrl:'http://remote.test:7897',authorization:'REPLACE-AUTHORIZATION'}));assert.equal(fs.readFileSync(g.authFile,'utf8'),'KEEP-AUTHORIZATION');assert.equal((await g.save({proxyUrl:''})).proxyUrl,'');
 const line=await g.save({cdn:'china'});assert.equal(line.cdn,'china');assert.equal(line.online,true);assert.equal(fs.readFileSync(g.authFile,'utf8'),'KEEP-AUTHORIZATION');await assert.rejects(g.save({cdn:'https://other-host.test',authorization:'REPLACE-AUTHORIZATION'}));assert.equal(fs.readFileSync(g.authFile,'utf8'),'KEEP-AUTHORIZATION');
});
test('主号及其他账号均不能接管 QQ，接口健康检查不通过也不能切换',async t=>{
 for(const identity of ['1990000001','123456789']){const {g,old}=fixture(t,{identity});const s=await g.status(true);assert.equal(s.state,'wrong-account');await assert.rejects(g.activate(),/指定小号/);assert.deepEqual(JSON.parse(fs.readFileSync(g.configFile)),old);}
 const {g,old}=fixture(t,{healthy:false});await assert.rejects(g.activate(),/收发状态/);assert.deepEqual(JSON.parse(fs.readFileSync(g.configFile)),old);
});
test('切换和恢复只更换 QQ 上游，保留当前角色、白名单和主动聊天及期间的新设置',async t=>{
 const {g,old}=fixture(t);await g.activate();let config=JSON.parse(fs.readFileSync(g.configFile));assert.equal(config.snowluma.provider,'llbot');assert.equal(config.snowluma.followDiscoveredEndpoint,false);for(const k of ['role','access','socialV2'])assert.deepEqual(config[k],old[k]);
 config.role='USER-UPDATED-ROLE';fs.writeFileSync(g.configFile,JSON.stringify(config));await g.rollback();config=JSON.parse(fs.readFileSync(g.configFile));assert.deepEqual(config.snowluma,old.snowluma);assert.equal(config.role,'USER-UPDATED-ROLE');assert.equal(config.socialV2.proactive.enabled,true);
});
test('桥接重启失败会撤销切换；并发切换拒绝执行第二次写入',async t=>{
 const {g,old}=fixture(t,{restartStatus:503});await assert.rejects(g.activate(),/恢复原接入/);assert.deepEqual(JSON.parse(fs.readFileSync(g.configFile)),old);
 let release;const pending=g.exclusive(()=>new Promise(r=>release=r));await Promise.resolve();await assert.rejects(g.activate(),/正在执行/);release();await pending;
});
test('核心启动必须显式授权，扫码不接受远程图片和任意上游接口',async t=>{
 const {g,setRunning}=fixture(t,{online:false});setRunning(false);await assert.rejects(g.start(),/授权/);await assert.rejects(g.save({authorization:'test-authorization'}),/确认/);await assert.rejects(g.save({account:'1990000001'}),/主号/);await g.save({authorization:'PRIVATE-AUTH',consented:true});await g.start();assert.equal((await g.qr()).image,'data:image/png;base64,aGVsbG8=');
 const config=JSON.parse(fs.readFileSync(path.join(g.cwd,'data/config_1990000002.json')));assert.equal(config.webui.host,'127.0.0.1');assert.ok(config.ob11.connect.every(x=>x.host==='127.0.0.1'&&x.token.length===64));await assert.rejects(g.native('https://evil.com/'),/允许范围/);g.request=async()=>new Response(JSON.stringify({success:true,data:{pngBase64QrcodeData:'https://evil.com/qr.png'}}));await assert.rejects(g.qr());
});

test('双端的新核心接口保留管理员鉴权与同源检查，不能下载本机凭据',async t=>{
 const {root,dataDir,companionRoot}=fixture(t);const stub={status:()=>({state:'disconnected'}),connect:async()=>{},disconnect:async()=>{},send:async()=>{}};const app=createApp({port:0,dataDir,qqWorkbenchRoot:companionRoot,adapters:{qq:stub,weixin:stub},localQQOptions:{root,processes:{inspect:async()=>false}}});await app.start();t.after(()=>app.close());const origin='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await fetch(origin+'/api/local-qq/state')).status,401);const headers={'x-admin-token':app.token,'content-type':'application/json'};assert.equal((await fetch(origin+'/api/local-qq/settings',{method:'POST',headers:{...headers,origin:'https://evil.com'},body:'{}'})).status,403);
 assert.equal((await fetch(origin+'/api/local-qq/state',{headers})).status,200);assert.equal((await fetch(origin+'/api/local-qq/native',{method:'POST',headers,body:'{}'})).status,404);assert.equal((await fetch(origin+'/data/local-qq/credentials.json')).status,404);
 const routed=[];app.localQQ.enableDesktop=async()=>{routed.push('enable');return {mode:'pmhq'}};app.localQQ.openClient=async()=>{routed.push('open');return {mode:'pmhq'}};
 for(const route of ['enable-desktop','open-client']){
  const endpoint=origin+'/api/local-qq/'+route;
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,origin:'https://evil.com'},body:'{}'})).status,403);
  assert.equal((await fetch(endpoint,{method:'POST',headers,body:'{}'})).status,200);
 }
 assert.deepEqual(routed,['enable','open']);
});
test('恢复扫码只重连未登录的自有核心，保留令牌与凭据',async t=>{
 const {g}=fixture(t,{online:false});await g.save({authorization:'RECOVERY-AUTH-TOKEN',consented:true});const before=fs.readFileSync(g.authFile,'utf8'),credentials=g.credentials();let stops=0,starts=0;const previous={...g.processes};g.processes.stop=async()=>{stops++;return previous.stop()};g.processes.start=async()=>{starts++;return previous.start()};
 const s=await g.recover();assert.equal(stops,1);assert.equal(starts,1);assert.equal(s.running,true);assert.equal(fs.readFileSync(g.authFile,'utf8'),before);assert.deepEqual(g.credentials(),credentials);
});
test('恢复扫码绕开保存会话的自动重登，正常启动仍恢复会话，凭据文件不删除',async t=>{
 const {g,setRunning}=fixture(t,{online:false});await g.save({authorization:'FRESH-QR-AUTH',consented:true});
 const file=savedSession(g),before=fs.readFileSync(file,'utf8'),modes=[],start=g.processes.start;
 const defaults=path.join(g.core,'default_config.json');fs.writeFileSync(defaults,JSON.stringify({webui:{host:'127.0.0.1',port:3080},other:'keep'}));
 g.processes.start=async options=>{modes.push(options.freshLogin);return start()};
 await g.recover();assert.deepEqual(modes,[true]);assert.equal(fs.readFileSync(file,'utf8'),before);
 assert.deepEqual(JSON.parse(fs.readFileSync(defaults)),{webui:{enable:true,host:'127.0.0.1',port:3088},other:'keep',ob11:{enable:false,connect:[]},milky:{enable:false},satori:{enable:false}});
 setRunning(false);await g.start();assert.deepEqual(modes,[true,false]);assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('已在线时恢复扫码不停止核心；身份无法确认时不继续启动',async t=>{
 const online=fixture(t).g;let stops=0;online.processes.stop=async()=>{stops++;return true};assert.equal((await online.recover()).online,true);assert.equal(stops,0);
 const {g}=fixture(t,{online:false});await g.save({authorization:'RECOVERY-AUTH-TOKEN',consented:true});g.processes.stop=async()=>false;g.processes.start=async()=>{throw Error('不应启动')};await assert.rejects(g.recover(),/进程身份/);
});
test('全新扫码等待核心初始化，旧二维码文件不能触发提前取码',async t=>{
 const {g,requests}=fixture(t,{online:false});await g.save({authorization:'QR-STARTUP-AUTH',consented:true});
 const file=path.join(g.cwd,'data','temp','login-qrcode.png');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'old');fs.utimesSync(file,1,1);g.qrBootAt=Date.now()-100;
 assert.equal((await g.status(true)).state,'starting');
 await assert.rejects(g.qr(),e=>e.status===503&&/初始化/.test(e.message));assert.equal(requests.filter(x=>x.url?.endsWith('/api/login-qrcode')).length,0);
 fs.writeFileSync(file,'new');assert.equal((await g.status(true)).state,'awaiting-scan');assert.ok((await g.qr()).image);assert.equal(requests.filter(x=>x.url?.endsWith('/api/login-qrcode')).length,1);
});
test('二维码网络超时返回可恢复的503提示，不泄漏底层错误和令牌',async t=>{
 const {g}=fixture(t);g.request=async()=>{throw new Error('private network diagnostic with token')};await assert.rejects(g.native('/api/login-qrcode'),e=>e.status===503&&e.message.includes('重新连接扫码')&&!e.message.includes('private network'));
});
test('手动刷新重建登录二维码，同一时间的刷新请求合并且不更换令牌',async t=>{
 const {g}=fixture(t,{online:false});await g.save({authorization:'RENEW-QR-TOKEN',consented:true});let renewed=0;const previous=g.processes.start;g.processes.start=async()=>{renewed++;await previous();};
 await g.qr();assert.equal(renewed,0,'普通读取沿用当前有效码');const [a,b]=await Promise.all([g.qr({renew:true}),g.qr({renew:true})]);assert.equal(renewed,1,'同时刷新只重连一次');assert.deepEqual(a,b);assert.equal(fs.readFileSync(g.authFile,'utf8'),'RENEW-QR-TOKEN');
});
