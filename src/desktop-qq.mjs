// Manage the separately installed, unchanged PMHQ desktop adapter. LLBot's
// Node process remains owned by LocalQQ; restarting that process never exits QQ.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec=promisify(execFile);
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))}catch{return null}};
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.new';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}
export const DESKTOP_QQ_PORT=3312;
const componentHashes={
 'pmhq.exe':'945edd552a31f7e6e9b21620a8f50729965956d062df5fe12fb7de4276d510e7',
 'pmhq.dll':'ebeae2141cf6b95551a6bf47ad656dfc522dd5691361cc899b6c208c70d1f800',
};
export function verifyDesktopComponents(directory){
 for(const [file,hash] of Object.entries(componentHashes)){
  let actual;try{actual=createHash('sha256').update(fs.readFileSync(path.join(directory,file))).digest('hex')}catch{return false}
  if(actual!==hash)return false;
 }
 return true;
}
export function desktopQQEnvironment(parent,temp,proxy=''){
 if(typeof proxy!=='string')throw error('QQ 连接代理地址无效');
 const value=proxy.trim(),env={...parent,TEMP:temp,TMP:temp};
 if(value){
  if(!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/.test(value))throw error('QQ 接管仅支持本机 HTTP 代理');
  let url;try{url=new URL(value)}catch{throw error('QQ 连接代理端口无效')}
  if(!url.port||Number(url.port)<1)throw error('QQ 连接代理端口无效');
  for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])env[name]=url.origin;
 }
 const bypass=['127.0.0.1','localhost','::1',parent.NO_PROXY||'',parent.no_proxy||''].filter(Boolean).join(',');
 env.NO_PROXY=bypass;env.no_proxy=bypass;
 return env;
}

export class DesktopQQ {
 constructor({root,dataDir,account,owner,qqExecutable,request=fetch,processes,launch=spawn}={}){
  this.root=root;this.account=String(account||'');this.owner=String(owner||'');this.qqExecutable=qqExecutable||'';
  this.dir=path.join(dataDir,'local-qq','desktop');this.components=path.join(root,'components','llbot-8.3.2','bin','pmhq');
  this.executable=path.join(this.components,'pmhq.exe');this.configFile=path.join(this.dir,'pmhq_config.json');
  this.processFile=path.join(this.dir,'pmhq-process.json');this.qqFile=path.join(this.dir,'qq-process.json');
  this.port=DESKTOP_QQ_PORT;this.request=request;this.launch=launch;this.pendingStart=null;this.statusPending=null;
  this.verify=()=>verifyDesktopComponents(this.components);
  this.processes=processes||{
   inspect:(record,kind)=>this.processAction('inspect',{record,kind}),
   capture:(pid,kind,notBefore)=>this.processAction('capture',{pid,kind,notBefore}),
   listQQ:()=>this.processAction('list'),
   validateQQ:()=>this.processAction('validate'),
   secure:()=>this.processAction('secure'),
   show:record=>this.processAction('show',{record,kind:'qq'}),
  };
 }
 get installed(){return Object.keys(componentHashes).every(file=>fs.existsSync(path.join(this.components,file)));}
 async processAction(action,{record,kind,pid,notBefore}={}){
  if(process.platform!=='win32')return action==='list'?[]:false;
  const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(this.root,'scripts','desktop-qq-process.ps1'),'-Action',action,'-StateDirectory',this.dir,'-EngineDirectory',this.components,'-QQExecutable',this.qqExecutable];
  if(kind)args.push('-Kind',kind);
  if(record)args.push('-ProcessId',String(record.pid),'-ExpectedStarted',String(record.started));
  else if(pid)args.push('-ProcessId',String(pid));
  if(notBefore)args.push('-NotBefore',String(notBefore));
  try{const {stdout}=await exec('powershell.exe',args,{windowsHide:true,timeout:15000});return JSON.parse(stdout.trim())}catch{return action==='list'?[{unverified:true}]:false}
 }
 async status(){
  if(this.statusPending)return this.statusPending;
  this.statusPending=(async()=>{
   const state={installed:this.installed,running:false,qqRunning:false,launching:false,conflict:false,qqExecutable:this.qqExecutable,port:this.port,detail:'电脑 QQ 接管尚未启动'};
   if(!state.installed){state.detail='缺少电脑 QQ 接管组件';return state}
   const pmhq=read(this.processFile);let qq=read(this.qqFile);
   const managed=pmhq?await this.processes.inspect(pmhq,'pmhq'):false;
   if(managed&&!qq){await this.captureQQFromLogs(pmhq);qq=read(this.qqFile);}
   let managedQQ=qq?await this.processes.inspect(qq,'qq'):false;
   if(managed&&!managedQQ){await this.captureQQFromLogs(pmhq);qq=read(this.qqFile);managedQQ=qq?await this.processes.inspect(qq,'qq'):false;}
   state.running=!!managed;state.qqRunning=!!managedQQ;
   if(managed){state.launching=!managedQQ;state.detail=managedQQ?'电脑 QQ 接管已启动，请在 QQ 客户端确认小号登录':'正在启动电脑 QQ，请稍候';return state}
   const existing=await this.processes.listQQ();state.conflict=!Array.isArray(existing)||existing.length>0;
   if(state.conflict)state.detail=managedQQ?'QQ 窗口仍在运行，但接管服务已退出；请先退出鲸鲸小号的 QQ 窗口，再启动接管':'检测到未由工作台管理的 QQ 窗口，请先退出该 QQ 窗口后再启动接管';
   return state;
  })().finally(()=>{this.statusPending=null});return this.statusPending;
 }
 async available(){return new Promise(resolve=>{const server=net.createServer();server.once('error',()=>resolve(false));server.listen(this.port,'127.0.0.1',()=>server.close(()=>resolve(true)));});}
 async start(options={}){
  if(this.pendingStart)return this.pendingStart;
  this.pendingStart=this.startOnce(options).finally(()=>{this.pendingStart=null});return this.pendingStart;
 }
 async attachExisting({confirmedAccount,...options}={}){
  if(confirmedAccount!==this.account||confirmedAccount===this.owner)throw error('请先确认当前 QQ 登录的是指定小号',409);
  if(this.pendingStart)return this.pendingStart;
  this.pendingStart=this.startOnce({...options,attach:true}).finally(()=>{this.pendingStart=null});return this.pendingStart;
 }
 async startOnce({authorization,cdn='cf',proxyUrl='',attach=false}={}){
  if(!/^\d{5,12}$/.test(this.account)||this.account===this.owner)throw error('电脑 QQ 接管只允许指定的机器人小号');
  if(!path.isAbsolute(this.qqExecutable)||path.basename(this.qqExecutable).toLowerCase()!=='qq.exe'||!fs.existsSync(this.qqExecutable))throw error('未找到已配置的电脑 QQ，请检查安装路径',503);
  if(!['cf','china'].includes(cdn))throw error('QQ 接管连接线路无效');
  const temp=path.join(this.dir,'temp'),env=desktopQQEnvironment(process.env,temp,proxyUrl);
  const current=await this.status();if(current.running)return current;
  if(current.conflict&&!attach)throw error(current.detail,409);
  if(!current.installed||!await this.verify())throw error('电脑 QQ 接管组件不完整或校验不一致，未启动',503);
  if(!await this.processes.validateQQ())throw error('无法确认配置路径中的官方 QQ 客户端，未启动',409);
  if(!await this.available())throw error('电脑 QQ 接管端口已被其他进程占用，未启动新的 QQ',409);
  if(typeof authorization!=='string'||authorization.trim().length<8||authorization.length>8192||/[\r\n\0]/.test(authorization))throw error('请先保存有效的 QQ 接管授权令牌');
  let existingQQ;
  if(attach){
   const list=await this.processes.listQQ();
   if(!Array.isArray(list)||list.length!==1||list[0].unverified||!Number.isSafeInteger(list[0].pid)||list[0].pid<1||typeof list[0].started!=='string'||typeof list[0].executable!=='string'||path.resolve(list[0].executable).toLowerCase()!==path.resolve(this.qqExecutable).toLowerCase())throw error('请仅保留指定小号的一个 QQ 窗口，再确认连接',409);
   existingQQ=await this.processes.capture(list[0].pid,'qq');
   if(!existingQQ||existingQQ.started!==list[0].started||!await this.processes.inspect(existingQQ,'qq'))throw error('QQ 进程已变化，请重新确认，未连接其它窗口',409);
  }
  fs.mkdirSync(temp,{recursive:true});
  if(!await this.processes.secure())throw error('无法保护本机 QQ 接管配置，未写入授权令牌',503);
  write(this.configFile,{qq_path:this.qqExecutable,quick_login_qq:this.account,default_host:'127.0.0.1',default_port:this.port,auth_token:authorization.trim(),pmhq_api_token:'',headless:false,debug:false,debug_pb:false,qq_console:false});
  // Explicit inline mode avoids PMHQ's default proxy mode, which would edit
  // the QQ application's shared proxy settings. Credentials stay out of argv.
  const args=['--mode=inline',...(existingQQ?['--pid='+existingQQ.pid]:['--launch-qq','--qq='+this.account]),'--config='+this.configFile,'--qq-path='+this.qqExecutable,'--host=127.0.0.1','--port='+this.port,'--dll='+path.join(this.components,'pmhq.dll'),'--work-dir='+this.dir,'--cdn='+cdn];
  const startedAt=Date.now(),logOffsets={};
  for(const name of ['pmhq.stdout.log','pmhq.stderr.log']){try{logOffsets[name]=fs.statSync(path.join(this.dir,name)).size}catch{logOffsets[name]=0}}
  const out=fs.openSync(path.join(this.dir,'pmhq.stdout.log'),'a',0o600),err=fs.openSync(path.join(this.dir,'pmhq.stderr.log'),'a',0o600);
  let child;
  // File handles survive this manager's exit. Pipes tied to the workbench
  // would break when its backend is updated and could terminate PMHQ logging.
  try{
   child=this.launch(this.executable,args,{cwd:this.dir,windowsHide:true,shell:false,detached:true,stdio:['ignore',out,err],env});
   await new Promise((resolve,reject)=>{child.once('error',()=>reject(error('电脑 QQ 接管启动失败，请检查本机日志',503)));child.once('spawn',resolve)});
  }finally{fs.closeSync(out);fs.closeSync(err)}
  const record=await this.processes.capture(child.pid,'pmhq',startedAt);
  if(!record)throw error('无法核对新启动的接管进程，未记录或接管其他 QQ',503);
  write(this.processFile,{...record,startedAt,logOffsets});if(existingQQ)write(this.qqFile,existingQQ);child.unref();this.statusPending=null;return this.status();
 }
 async captureQQFromLogs(pmhq){
  if(!Number.isFinite(pmhq.startedAt)||!pmhq.logOffsets)return;
  for(const name of ['pmhq.stdout.log','pmhq.stderr.log']){
   let handle;try{
    const offset=pmhq.logOffsets[name];if(!Number.isSafeInteger(offset)||offset<0)continue;
    const file=path.join(this.dir,name),size=fs.statSync(file).size;if(size<=offset)continue;
    handle=fs.openSync(file,'r');const buffer=Buffer.alloc(Math.min(65536,size-offset));fs.readSync(handle,buffer,0,buffer.length,offset);
    const text=buffer.toString('utf8').replace(/\u001b\[[0-9;]*m/g,'');
    for(const match of text.matchAll(/(?:QQ\s*进程\s*PID|QQ\s*process\s*PID)\s*[:：]\s*(\d+)/gi)){
     const pid=Number(match[1]);if(!Number.isSafeInteger(pid)||pid<=0)continue;
     const record=await this.processes.capture(pid,'qq',pmhq.startedAt);if(record){write(this.qqFile,record);return;}
    }
   }catch{}finally{if(handle!==undefined)fs.closeSync(handle)}
  }
 }
 async open(){
  const record=read(this.qqFile);
  if(!record||!await this.processes.inspect(record,'qq'))throw error('尚未找到工作台启动的 QQ 窗口，请先启动电脑 QQ 接管',409);
  if(!await this.processes.show(record))throw error('QQ 已在后台运行，请从任务栏右下角的 QQ 图标打开鲸鲸小号窗口',409);
  return {ok:true,detail:'已打开鲸鲸小号的 QQ 窗口'};
 }
}
