// Independently written manager for an unchanged, separately installed LLBot core.
// QQ conversation generation belongs to Banyu's in-process chat engine.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
import {DesktopQQ} from './desktop-qq.mjs';
const exec=promisify(execFile);
const error=(message,status=400)=>Object.assign(new Error(message),{status});
export function coreProxy(value=''){
 if(typeof value!=='string')throw error('请填写本机代理地址，或留空使用默认连接');
 const v=value.trim();if(!v)return '';
 if(!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/.test(v))throw error('仅支持本机 HTTP 代理，例如 http://127.0.0.1:7897');
 let url;try{url=new URL(v)}catch{throw error('本机代理端口无效')}
 if(!url.port||Number(url.port)<1)throw error('本机代理端口无效');return url.origin;
}
export function coreEnvironment(parent,proxy=''){
 const env={...parent},url=coreProxy(proxy);if(!url)return env;
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])env[key]=url;
 const bypass=['127.0.0.1','localhost','::1',parent.NO_PROXY||'',parent.no_proxy||''].filter(Boolean).join(',');
 env.NO_PROXY=bypass;env.no_proxy=bypass;return env;
}
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''))}catch{return null}};
function write(p,value){fs.mkdirSync(path.dirname(p),{recursive:true});const tmp=p+'.new';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,p);}
const disableTransports=value=>({...value,ob11:{...value.ob11,enable:false,connect:Array.isArray(value.ob11?.connect)?value.ob11.connect.map(c=>({...c,enable:false})):[]},milky:{...value.milky,enable:false},satori:{...value.satori,enable:false}});
export const CORE={version:'8.3.2',webPort:3088,httpPort:3300,wsPort:3301,source:'https://github.com/LLOneBot/LuckyLilliaBot',authorization:'https://auth.luckylillia.com',sha256:'3b29f2bdaafbbb1e0e494e42d81da7566aeb16114e9eb42a5d168c59dbcadcb7'};
export function coreLaunchArgs(core,{mode='direct',account,cdn='cf',freshLogin=false}={}){
 return [path.join(core,'llbot.js'),...(mode==='pmhq'?['--pmhq-host=127.0.0.1','--pmhq-port=3312']:[...(freshLogin?[]:['--qq='+account]),...(cdn==='china'?['--cdn=china']:[])])];
}
export class LocalQQ {
 constructor({root,dataDir,companionRoot,request=fetch,bridge,processes,desktop,now=Date.now,nativeChat=null}={}){
  this.root=root;this.dataDir=dataDir;this.dir=path.join(dataDir,'local-qq');this.companionRoot=companionRoot;this.request=request;this.bridge=bridge;this.desktopOverride=desktop;
  this.core=path.join(root,'components','llbot-'+CORE.version,'bin','llbot');this.cwd=path.join(this.dir,'core');
  this.nativeChat=nativeChat;this.configFile=nativeChat?path.join(this.dir,'connection.json'):path.join(companionRoot,'qq-bridge','config.json');const saved=read(path.join(this.dir,'settings.json'));
  const bridgeConfig=read(this.configFile);
  this.options=saved?{...saved,mode:saved.mode==='pmhq'?'pmhq':'direct'}:{account:String(nativeChat?.store.settings().account||''),owner:String(nativeChat?.store.settings().owner||bridgeConfig?.ownerQQ||''),consented:false,mode:'pmhq'};
  this.processes=processes||{inspect:()=>this.processAction('inspect'),start:options=>this.spawnCore(options),stop:()=>this.processAction('stop')};
  this.now=now;this.statusVersion=0;this.cached=null;this.at=0;this.pending=null;this.busy=null;this.failure='';this.restoreResult='';this.restoreDeadlineAt=0;this.scanRequested=false;
  this.qrBootAt=Number(read(path.join(this.dir,'process.json'))?.qrBootAt)||0;
  this.scanRequested=this.qrBootAt>0;
 }
 get installed(){return ['llbot.js','node.exe','sign-proxy.win-x64.node'].every(x=>fs.existsSync(path.join(this.core,x)));}
 get mode(){return this.options.mode==='pmhq'?'pmhq':'direct';}
 get desktop(){return this.desktopOverride||(this.desktopInstance??=new DesktopQQ({root:this.root,dataDir:this.dataDir,account:this.options.account,owner:this.options.owner,qqExecutable:read(path.join(this.dataDir,'machine-settings.json'))?.qqExecutable}));}
 get active(){return this.nativeChat?this.nativeChat.configured():read(this.configFile)?.snowluma?.provider==='llbot';}
 get authFile(){return path.join(this.cwd,'data','auth_token.txt');}
 authorizationSummary(online=false){
  let saved='';try{saved=fs.readFileSync(this.authFile,'utf8').trim()}catch{}
  if(!saved)return {state:'missing',saved:false,pending:false,detail:'尚未填写接入授权',checkedAt:this.now()};
  const used=read(path.join(this.dir,'desktop','pmhq_config.json'))?.auth_token;
  const pending=typeof used==='string'&&used!==saved;
  const confirmed=online&&used===saved;
  return {state:pending?'pending':confirmed?'in-use':'saved',saved:true,pending,detail:pending?'新授权已保存，重启电脑后应用':confirmed?'当前接管连接可用':'已保存，连接后确认是否可用',checkedAt:this.now()};
 }
 savedLogin(){const value=read(path.join(this.cwd,'data','qq-session-'+this.options.account+'.json'));return {available:!!(value&&String(value.uin)===this.options.account&&String(value.uin)!==this.options.owner&&typeof value.enc==='string'&&value.enc),savedAt:Number.isFinite(value?.savedAt)?value.savedAt:null};}
 qrInitializationPending(){if(!this.qrBootAt)return false;try{return fs.statSync(path.join(this.cwd,'data','temp','login-qrcode.png')).mtimeMs<this.qrBootAt}catch{return true}}
 credentials(){const p=path.join(this.dir,'credentials.json');let c=read(p);if(!c){c={web:randomBytes(32).toString('hex'),onebot:randomBytes(32).toString('hex')};write(p,c)}return c;}
 baseState(){return {installed:this.installed,version:CORE.version,active:this.active,account:this.options.account,owner:this.options.owner,hasAuthorization:!!(fs.existsSync(this.authFile)&&fs.readFileSync(this.authFile,'utf8').trim()),consented:this.options.consented===true,authorization:this.mode==='pmhq'?this.authorizationSummary():undefined,authorizationUrl:CORE.authorization,sourceUrl:CORE.source,mode:this.mode,passwordLogin:false,requiresClient:this.mode==='pmhq',savedLogin:this.mode==='direct'?this.savedLogin():{available:false,savedAt:null},proxyUrl:this.options.proxyUrl||'',cdn:this.options.cdn==='china'?'china':'cf',running:false,online:false,loginKnown:false,canActivate:false,state:'stopped',detail:'新 QQ 核心尚未启动',failure:this.failure,restoreDeadlineAt:this.restoreDeadlineAt};}
 invalidateStatus(){this.statusVersion++;this.at=0;this.cached=null;}
 setRestoreState(result='',failure=''){this.restoreResult=result;this.failure=failure;this.restoreDeadlineAt=result==='restoring'?this.now()+45000:0;this.invalidateStatus();}
 async native(route,body){
  if(!['/api/login-info','/api/login-qrcode','/api/auth-token/status','/api/logout','/api/quick-login'].includes(route))throw error('QQ 核心操作不在允许范围内',403);
  if(this.mode==='pmhq'&&['/api/login-qrcode','/api/logout','/api/quick-login'].includes(route))throw error('当前使用电脑 QQ 登录，请在 QQ 客户端管理小号',409);
  if(route==='/api/quick-login'&&(String(body?.uin)!==this.options.account||String(body?.uin)===this.options.owner))throw error('只允许恢复已指定的机器人小号',403);
  const c=this.credentials();let r;try{r=await this.request('http://127.0.0.1:'+CORE.webPort+route,{method:body===undefined?'GET':'POST',headers:{'X-Webui-Token':createHash('sha256').update(c.web).digest('hex'),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(route.endsWith('qrcode')?20000:route==='/api/quick-login'?30000:4000)});}catch{throw error(route.endsWith('qrcode')?'获取二维码超时，请稍后重试，或点击“重新连接扫码”':'QQ 核心连接暂时中断，请稍后重试',503);}
  let result;try{result=await r.json()}catch{throw error('QQ 核心返回无效响应',502)}
  if(!r.ok||result.success!==true){
   if(route==='/api/quick-login'&&/session.*(?:失效|过期|expired|invalid)|(?:登录状态|登录会话|会话).*(?:失效|过期)|身份验证失败|session authentication failed/i.test(String(result.message||'')))throw error('QQ 已拒绝上次保存的登录状态，需要重新扫码登录',409);
   throw error(route==='/api/login-qrcode'?'QQ 登录服务尚未准备好，可先恢复上次登录，或重新连接后取码':'QQ 核心暂未准备好，请稍后重试',503);
  }return result.data;
 }
 async status(force=false){
  if(this.pending)return this.pending;if(!force&&this.cached&&this.now()-this.at<3000)return this.cached;
  const version=this.statusVersion;
  const pending=(async()=>{const s=this.baseState();if(!s.installed){s.state='missing';s.detail='此电脑尚未安装新 QQ 核心';return s;}
   if(s.mode==='pmhq')s.desktop=await this.desktop.status();
   if(!await this.processes.inspect()){s.detail=s.mode==='pmhq'?'点击连接电脑 QQ，随后在 QQ 客户端登录小号':s.hasAuthorization?'点击启动新核心，准备登录小号':'先填写新核心的授权令牌';return s;}
   s.running=true;s.state='starting';s.detail='QQ 核心已启动，正在准备登录';
   const [loginResult,authResult]=await Promise.allSettled([this.native('/api/login-info'),s.mode==='pmhq'?Promise.resolve({applicable:false}):this.native('/api/auth-token/status')]);
   if(version!==this.statusVersion)return s;
   const auth=authResult.status==='fulfilled'?authResult.value:null;
   s.authorization={valid:auth?.validation==='valid',applicable:auth?.applicable!==false,state:String(auth?.validation||(authResult.status==='rejected'?'unknown':'idle')),message:this.safe(auth?.message||auth?.loginError||'')};
   if(loginResult.status==='rejected'){
    s.state='checking';s.detail='暂时无法确认 QQ 登录状态，正在重新检查；请勿重复扫码。';return s;
   }
   const info=loginResult.value;s.nativeMode=typeof info?.mode==='string'?info.mode:null;
   if((s.mode==='pmhq'&&info?.mode!=='pmhq')||(s.mode==='direct'&&info?.mode&&info.mode!=='direct')){s.state='mode-mismatch';s.detail='QQ 接入方式尚未切换完成，请重新连接电脑 QQ；未接管其他登录';return s;}
   s.loginKnown=true;
    s.online=info?.online===true;s.identity=s.online?{id:String(info.uin||''),name:String(info.nick||'鲸鲸')}:null;
    s.accountMatches=s.online&&s.identity.id===s.account&&s.identity.id!==s.owner;
    s.canActivate=!!s.accountMatches;
    if(s.online&&!s.accountMatches){s.state='wrong-account';s.detail=s.mode==='pmhq'?'当前电脑 QQ 不是指定小号，已阻止接管；请在 QQ 客户端换成鲸鲸小号':'当前扫码账号不是指定小号，已阻止接入聊天，请退出后换小号登录';if(s.mode==='pmhq'&&await this.processes.stop()){s.running=false;s.detail+='。聊天接管已停止，QQ 窗口仍保留';}}
    else if(s.online){s.state='online';s.detail=`${s.identity.name}已登录 · QQ ${s.identity.id}`;s.failure='';this.failure='';this.restoreResult='';this.restoreDeadlineAt=0;this.scanRequested=false;}
    else if(s.mode==='pmhq'){s.state=s.desktop?.conflict?'client-conflict':s.desktop?.launching?'starting':'awaiting-client';s.detail=s.desktop?.conflict?'已有其他 QQ 窗口，请先确认并关闭后，再启动鲸鲸小号':s.desktop?.qqRunning?'请在电脑 QQ 中登录鲸鲸小号，登录后工作台会自动连接':'电脑 QQ 正在启动，准备好后请在 QQ 中登录小号';}
    else if(authResult.status==='rejected'){s.state='connection-error';s.detail='QQ 当前未在线，授权状态暂时无法检查，请稍后重试。';}
    else if(!s.hasAuthorization||auth?.validation!=='valid'){s.state=auth?.validation==='error'?'connection-error':'authorization';s.detail=s.authorization.message||'正在连接授权服务，请稍候；此时还不能获取 QQ 二维码';}
    else if(this.restoreResult==='rejected'){s.state='login-required';s.detail=this.failure;}
    else if(this.restoreResult==='restoring'&&this.now()<this.restoreDeadlineAt){s.state='restoring';s.detail='正在恢复上次登录，请稍候；暂时无需重新扫码。';}
    else if(this.restoreResult==='restoring'||this.restoreResult==='pending'){this.restoreResult='pending';this.restoreDeadlineAt=0;s.state='restore-pending';s.detail=this.failure||'恢复请求已受理，但尚未确认上线。可以稍后重试恢复，或选择重新扫码。';}
    else if(this.qrInitializationPending()){s.state='starting';s.detail='正在初始化扫码服务，请稍候；二维码就绪后会自动显示';}
    else if(s.savedLogin.available&&!this.scanRequested){s.state='saved-login';s.detail='本机保存了上次登录，可以先尝试免扫码恢复';}
    else{s.state='awaiting-scan';s.detail='请使用鲸鲸小号扫描二维码并在手机确认';}
   if(s.mode==='pmhq')s.authorization={...this.authorizationSummary(s.accountMatches),applicable:false};
   s.restoreDeadlineAt=this.restoreDeadlineAt;
   return s;
  })().then(s=>{
   // An operation can finish while an older observation is in flight. Do not
   // let that observation overwrite the newer restore result or login state.
   if(version!==this.statusVersion){if(this.pending===pending)this.pending=null;return this.status(true);}
   this.at=this.now();s.observedAt=this.at;return this.cached=s;
  }).finally(()=>{if(this.pending===pending)this.pending=null});this.pending=pending;return pending;
 }
 safe(value){let s=String(value||'').slice(0,500);for(const p of [this.authFile,path.join(this.dir,'credentials.json')]){try{const v=fs.readFileSync(p,'utf8').trim();if(v)s=s.split(v).join('[已隐藏]')}catch{}}
  const credentials=read(path.join(this.dir,'credentials.json'));for(const secret of Object.values(credentials||{}))if(typeof secret==='string'&&secret)s=s.split(secret).join('[已隐藏]');
  return s.replace(/(?:Bearer\s+|auth[_-]?token[=: ]+)[\w.\-]+/gi,'[已隐藏]').replace(/https?:\/\/\S+/g,'[服务地址]');}
 async save(values){return this.exclusive(()=>this.saveSettings(values));}
 async install(){
  if(await this.processes.inspect())throw error('QQ 核心正在运行，请先停止聊天接管再检查组件',409);
  const script=path.join(this.root,'sharing','Install-CoreUI.ps1');if(!fs.existsSync(script))throw error('请在工作台文件夹运行“安装新QQ核心.cmd”',503);
  await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{cwd:this.root,windowsHide:false,detached:true,stdio:'ignore'});child.once('error',()=>reject(error('安装窗口未能打开',503)));child.once('spawn',()=>{child.unref();resolve()})});
  return {ok:true,opened:true};
 }
 async saveSettings({authorization,account,consented,proxyUrl,cdn,mode}={}){
  const proxy=proxyUrl===undefined?undefined:coreProxy(proxyUrl);
  if(cdn!==undefined&&!['cf','china'].includes(cdn))throw error('请选择 QQ 核心提供的连接线路');
  if(mode!==undefined&&!['direct','pmhq'].includes(mode))throw error('QQ 接入方式无效');
  if(mode!==undefined&&mode!==this.mode&&(this.active||await this.processes.inspect()))throw error('当前接入正在使用，请通过“启用电脑 QQ”安全切换',409);
  if(account!==undefined&&(!/^\d{5,12}$/.test(String(account))||String(account)===this.options.owner))throw error('请填写机器人小号，不能使用主人主号');
  if(account!==undefined&&String(account)!==this.options.account&&(this.active||await this.processes.inspect()))throw error('请先停用并停止新核心，再修改小号',409);
  if(authorization!==undefined){if(typeof authorization!=='string'||authorization.trim().length<8||authorization.length>8192||/[\r\n\0]/.test(authorization))throw error('请填写有效的授权令牌');if(consented!==true&&!this.options.consented)throw error('请先阅读并确认新核心的授权服务说明');fs.mkdirSync(path.dirname(this.authFile),{recursive:true});fs.writeFileSync(this.authFile,authorization.trim(),{mode:0o600});}
  this.options={...this.options,...(mode===undefined?{}:{mode}),...(proxy===undefined?{}:{proxyUrl:proxy}),...(cdn===undefined?{}:{cdn}),...(account===undefined?{}:{account:String(account)}),consented:consented===true||this.options.consented};if(account!==undefined)this.desktopInstance=null;write(path.join(this.dir,'settings.json'),this.options);this.invalidateStatus();return this.status(true);
 }
 async exclusive(fn){if(this.busy)throw error('QQ 核心正在执行操作，请稍后再试',409);this.busy=Promise.resolve().then(fn);try{return await this.busy}finally{this.busy=null;this.at=0;}}
 configure(){
  const c=this.credentials();const data=path.join(this.cwd,'data');fs.mkdirSync(data,{recursive:true});fs.writeFileSync(path.join(data,'webui_token.txt'),c.web,{mode:0o600});
  const config={webui:{enable:true,host:'127.0.0.1',port:CORE.webPort},milky:{enable:false,http:{host:'127.0.0.1',port:3310,prefix:'',accessToken:''},webhook:{urls:[],accessToken:''}},satori:{enable:false,host:'127.0.0.1',port:3360,token:''},ob11:{enable:true,connect:[{type:'http',enable:true,host:'127.0.0.1',port:CORE.httpPort,token:c.onebot,reportSelfMessage:false,reportOfflineMessage:false,messageFormat:'array',debug:false},{type:'ws',enable:true,host:'127.0.0.1',port:CORE.wsPort,token:c.onebot,heartInterval:30000,reportSelfMessage:false,reportOfflineMessage:false,messageFormat:'array',debug:false}]},enableLocalFile2Url:false,log:true,logLevel:'info',autoDeleteFile:false,musicSignUrl:'',msgCacheExpire:120,ffmpeg:path.join(this.core,'ffmpeg.exe')};
  // Before a fresh QR login LLBot reads its default configuration, not config_<qq>.
  // Keep the same loopback management endpoint throughout the login transition.
  const defaultFile=path.join(this.core,'default_config.json');
  {
   const defaults=fs.existsSync(defaultFile)?read(defaultFile):config;if(!defaults||typeof defaults!=='object')throw error('QQ 核心默认配置无法读取，未启动',503);
   // PMHQ may attach to a QQ client before its account is known. Only the
   // explicitly configured bot account may expose message transports.
   write(defaultFile,{...disableTransports(defaults),webui:config.webui});
  }
  for(const name of fs.readdirSync(data)){
   if(!/^config_\d+\.json$/.test(name)||name==='config_'+this.options.account+'.json')continue;
   const file=path.join(data,name),other=read(file);if(!other||typeof other!=='object')throw error('其他 QQ 账号的接入配置无法核对，未启动核心',503);
   write(file,disableTransports(other));
  }
  write(path.join(data,'config_'+this.options.account+'.json'),config);
 }
 async available(port){return new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));});}
 async start(){if(this.starting)return this.starting;this.starting=this.exclusive(()=>this.startCore()).finally(()=>{this.starting=null});return this.starting;}
 async startCore({freshLogin=false}={}){
  if(!this.installed)throw error('尚未安装新 QQ 核心',503);if(!this.options.consented||!this.baseState().hasAuthorization)throw error('请先填写授权令牌并确认服务说明');
  if(this.mode==='pmhq'&&!this.desktop.installed)throw error('电脑 QQ 接管组件尚未安装完整，请检查 PMHQ 文件',503);
  const running=await this.processes.inspect();
  if(running){const current=await this.status(true);if(current.state==='mode-mismatch')throw error('现有核心仍是另一种登录方式，请使用“启用电脑 QQ”完成切换',409);if(this.mode==='pmhq'){await this.startDesktop();this.invalidateStatus();}return this.status(true);}
  for(const port of [CORE.webPort,CORE.httpPort,CORE.wsPort])if(!await this.available(port))throw error(`本机 ${port} 端口已被占用，未启动其他进程`,409);
  if(this.mode==='pmhq')await this.startDesktop();
  this.configure();await this.processes.start({freshLogin});this.failure='';this.invalidateStatus();return this.status(true);
 }
 async startDesktop(){return this.desktop.start({authorization:fs.readFileSync(this.authFile,'utf8').trim(),cdn:this.options.cdn==='china'?'china':'cf',proxyUrl:this.options.proxyUrl||''});}
 async attachDesktop({confirmed=false,account}={}){return this.exclusive(async()=>{
  if(this.mode!=='pmhq'||confirmed!==true||account!==this.options.account||account===this.options.owner)throw error('请先确认当前 QQ 登录的是指定小号',409);
  if(!this.installed||!this.options.consented||!this.baseState().hasAuthorization)throw error('请先完成 QQ 接入授权',409);
  if(await this.processes.inspect()){const info=await this.native('/api/login-info');if(info?.mode!=='pmhq')throw error('核心接入方式不符，请先切换电脑 QQ 模式',409);}
  await this.desktop.attachExisting({confirmedAccount:account,authorization:fs.readFileSync(this.authFile,'utf8').trim(),cdn:this.options.cdn==='china'?'china':'cf',proxyUrl:this.options.proxyUrl||''});
  this.invalidateStatus();return this.startCore();
 });}
 async enableDesktop(){return this.exclusive(async()=>{
  if(!this.installed||!this.desktop.installed)throw error('电脑 QQ 接管组件尚未安装完整',503);
  if(!this.options.consented||!this.baseState().hasAuthorization)throw error('请先填写授权令牌并确认服务说明');
  const running=await this.processes.inspect();
  if(running&&this.mode==='pmhq'){const current=await this.status(true);if(current.nativeMode==='pmhq')return this.startCore();if(!current.loginKnown&&current.state!=='mode-mismatch')throw error('当前无法确认 QQ 接入状态，未重启核心',503);}
  if(running&&!await this.processes.stop())throw error('无法确认旧 QQ 核心进程身份，未停止其他进程',409);
  if(!running)for(const port of [CORE.webPort,CORE.httpPort,CORE.wsPort])if(!await this.available(port))throw error(`本机 ${port} 端口被其他进程占用，未切换登录方式`,409);
  this.options={...this.options,mode:'pmhq'};write(path.join(this.dir,'settings.json'),this.options);
  this.qrBootAt=0;this.scanRequested=false;this.setRestoreState();
  return this.startCore();
 });}
 async openClient(){if(this.mode!=='pmhq')throw error('请先启用电脑 QQ 接入',409);return this.exclusive(async()=>{await this.startCore();await this.desktop.open();return this.status(true)});}
 async recover(){return this.exclusive(async()=>{
  if(this.mode==='pmhq')return this.startCore();
  const s=await this.status(true);if(s.online)return s;
  if(s.running&&!s.loginKnown)throw error('当前无法确认 QQ 登录状态，请稍后重试，未重启核心',503);
  this.scanRequested=true;this.setRestoreState();
  if(!this.options.consented||!s.hasAuthorization)throw error('请先填写授权令牌并确认服务说明');
  if(s.running&&!await this.processes.stop())throw error('无法确认扫码核心进程身份，未停止其他进程',409);
  this.cached=null;return this.startCore({freshLogin:true});
 });}
 async restore(){if(this.mode==='pmhq')return this.start();if(this.renewingQr||this.readingQr)throw error('正在获取二维码，请稍后再恢复登录',409);return this.exclusive(async()=>{
  let s=await this.status(true);if(s.online)return s;
  if(s.state==='restoring')return s;
  if(s.running&&!s.loginKnown)throw error('当前无法确认 QQ 登录状态，请稍后再恢复登录',503);
  if(!s.savedLogin.available)throw error('本机没有此小号的已保存登录，请扫码登录',409);
  if(!this.options.consented||!s.hasAuthorization)throw error('请先完成 QQ 核心授权',409);
  if(!s.running){await this.startCore();for(let i=0;i<12;i++){s=await this.status(true);if(s.online)return s;if(s.authorization?.valid)break;await new Promise(r=>setTimeout(r,500));}}
  s=await this.status(true);if(!s.authorization?.valid)throw error('授权服务尚未连通，请检查网络后重试恢复登录',503);
  this.scanRequested=false;this.setRestoreState('restoring');
  try{
   await this.native('/api/quick-login',{uin:this.options.account});
   this.setRestoreState('restoring');
  }catch(e){this.setRestoreState(e.status===409?'rejected':'pending',e.status===409?e.message:'恢复请求暂未确认，请检查网络后重试；尚不能判断保存的登录状态是否失效。');}
  return this.status(true);
 });}
 async processAction(action){
  if(process.platform!=='win32')return false;const script=path.join(this.root,'scripts','qq-core-process.ps1');
  try{const {stdout}=await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Action',action,'-StateDirectory',this.dir,'-EngineDirectory',this.core],{windowsHide:true,timeout:10000});return stdout.trim()==='true'}catch{return false}
 }
 async spawnCore({freshLogin=false}={}){
  this.qrBootAt=this.mode==='direct'&&freshLogin?Date.now():0;
  fs.mkdirSync(path.join(this.cwd,'data','logs'),{recursive:true});const out=fs.openSync(path.join(this.cwd,'data','logs','core.stdout.log'),'a'),err=fs.openSync(path.join(this.cwd,'data','logs','core.stderr.log'),'a');
  // LLBot without --qq starts fresh QR login; the saved session stays intact.
  // Retrying an expired --qq session can leave native signing uninitialized.
  const args=coreLaunchArgs(this.core,{...this.options,mode:this.mode,freshLogin});
  let child;try{child=spawn(path.join(this.core,'node.exe'),args,{cwd:this.cwd,windowsHide:true,shell:false,detached:true,stdio:['ignore',out,err],env:{...coreEnvironment(process.env,this.options.proxyUrl),...(this.mode==='direct'?{LOCALAPPDATA:path.join(this.dir,'cache')}:{}),TEMP:path.join(this.cwd,'data','temp'),TMP:path.join(this.cwd,'data','temp')}});
   await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve)});child.unref();
  }finally{fs.closeSync(out);fs.closeSync(err)}
  const pid=child.pid;let started;
  try{const {stdout}=await exec('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`],{windowsHide:true,timeout:10000});started=stdout.trim()}catch{throw error('QQ 核心启动后退出，请检查本机日志',503)}
  write(path.join(this.dir,'process.json'),{pid,started,executable:path.join(this.core,'node.exe'),qrBootAt:this.qrBootAt});
 }
 async qr({renew=false}={}){
  if(this.mode==='pmhq')throw error('当前使用电脑 QQ 登录，请打开 QQ 客户端登录小号',409);
  if(this.renewingQr)return this.renewingQr;
  if(this.busy)throw error('QQ 核心正在恢复连接，请等待完成后再获取二维码',409);
  this.scanRequested=true;this.setRestoreState();
  if(!renew){this.readingQr??=this.readQr().finally(()=>{this.readingQr=null});return this.readingQr;}
  this.renewingQr=(async()=>{
   if(this.readingQr)await this.readingQr.catch(()=>{});
   await this.recover();
   for(let i=0;i<12;i++){const s=await this.status(true);if(s.online)throw error('QQ 已经登录，无需扫码',409);if(s.authorization?.valid)return this.readQr();if(!s.running)throw error('扫码服务未能启动，请点击“重新连接扫码”',503);await new Promise(r=>setTimeout(r,500));}
   throw error('扫码服务正在重新连接，请稍后刷新二维码',503);
  })().finally(()=>{this.renewingQr=null});return this.renewingQr;
 }
 async readQr(){const s=await this.status(true);if(!s.running)throw error('请先启动新核心');if(s.online)throw error('QQ 已经登录，无需扫码',409);if(!s.authorization?.valid)throw error(s.authorization?.message||'请先完成新核心授权',409);
  // The native core's signing initialization and manual QR fetch can race.
  // Let its own startup loop create the first QR before asking the management API.
  if(this.qrBootAt){
   if(this.qrInitializationPending())throw error('QQ 登录服务正在初始化，请稍候再获取二维码',503);
   this.qrBootAt=0;
  }
  const q=await this.native('/api/login-qrcode');let image=String(q?.pngBase64QrcodeData||'');if(image&&!image.startsWith('data:'))image='data:image/png;base64,'+image;
  if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)||image.length>2000000)throw error('暂未获取到有效二维码，请稍后刷新',503);return {image,expiresAt:Date.now()+Math.min(300,Math.max(1,Number(q.expireTime)||60))*1000};
 }
 async stop(){return this.exclusive(async()=>{const exists=await this.processes.inspect();if(exists&&!await this.processes.stop())throw error('无法确认 QQ 核心进程身份，未停止其他进程',409);this.invalidateStatus();return this.status(true)});}
 async logout(){if(this.mode==='pmhq')throw error('请在 QQ 客户端管理小号登录；工作台不会退出电脑 QQ',409);return this.exclusive(async()=>{if(this.active)throw error('请先切回旧接入，再退出新核心账号，避免中断聊天',409);await this.native('/api/logout',{});return this.status(true)});}
 async activate(){return this.exclusive(async()=>{
  const s=await this.status(true);if(!s.canActivate)throw error('新核心必须先登录指定小号，才能接管聊天',409);if(this.active)return {ok:true,active:true};
  // Check the real OneBot account and health, independently from the manager UI.
  const c=this.credentials();const one=async action=>{const r=await this.request(`http://127.0.0.1:${CORE.httpPort}/${action}`,{method:'POST',headers:{authorization:'Bearer '+c.onebot,'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(4000)});const v=await r.json();if(!r.ok||v.status!=='ok'||v.retcode!==0)throw error('新 QQ 核心接口尚未就绪',409);return v.data;};
  const [identity,health]=await Promise.all([one('get_login_info'),one('get_status')]);if(String(identity.user_id)!==this.options.account||health.online!==true||health.good===false)throw error('新 QQ 核心账号或收发状态不符合要求，未切换',409);
  if(this.nativeChat){await this.nativeChat.connect();return {ok:true,active:true};}
  const before=read(this.configFile);if(!before?.snowluma)throw error('未找到现有 QQ 桥接配置',503);
  const backup=path.join(this.dir,'previous-upstream.json');write(backup,{snowluma:before.snowluma,switchedAt:new Date().toISOString()});
  write(this.configFile,{...before,snowluma:{...before.snowluma,provider:'llbot',homeDir:'',launcherPath:'',wsUrl:`ws://127.0.0.1:${CORE.wsPort}`,httpUrl:`http://127.0.0.1:${CORE.httpPort}`,accessToken:c.onebot,followDiscoveredEndpoint:false}});
  try{const r=await this.bridge.proxy('/api/restart','POST',{});if(r.status!==200)throw Error('restart');}
  catch{const current=read(this.configFile);write(this.configFile,{...current,snowluma:before.snowluma});throw error('桥接未能重启，已恢复原接入配置',503)}
  this.cached=null;return {ok:true,active:true,restarting:true};
 });}
 async rollback(){return this.exclusive(async()=>{
  if(this.nativeChat)throw error('当前使用伴屿原生引擎，无需切换旧桥接',409);
  if(!this.active)return {ok:true,active:false};const saved=read(path.join(this.dir,'previous-upstream.json'));if(!saved?.snowluma)throw error('没有可恢复的旧接入配置',409);
  const current=read(this.configFile);write(this.configFile,{...current,snowluma:saved.snowluma});
  try{const r=await this.bridge.proxy('/api/restart','POST',{});if(r.status!==200)throw Error('restart');}catch{write(this.configFile,{...read(this.configFile),snowluma:current.snowluma});throw error('桥接未能重启，仍保留新接入配置',503)}
  await this.bridge.connect();return {ok:true,active:false,restarting:true};
 });}
}
