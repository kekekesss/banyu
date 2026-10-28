// MIT. Original Banyu application supervisor. QQ and Weixin share this worker.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const exec=promisify(execFile),self=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(self),'..');
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function identity(pid){
 if(!Number.isInteger(pid)||pid<1)return null;
 if(process.platform!=='win32'){try{process.kill(pid,0);return {pid};}catch{return null;}}
 const command=`[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue;if($p){$g=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($g){@{pid=$p.ProcessId;exe=$p.ExecutablePath;command=$p.CommandLine;started=$g.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}}`;
 const {stdout}=await exec(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-Command',command],{windowsHide:true,timeout:10000});
 return stdout.trim()?JSON.parse(stdout.trim()):null;
}
function portBusy(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});let ended=false;const finish=value=>{if(ended)return;ended=true;socket.destroy();resolve(value);};socket.setTimeout(800,()=>finish(true));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));});}
export class DeskRuntime{
 constructor({workspace=root,workerFile='src/server.mjs',port=3200,workerEnvironment={}}={}){
  this.root=workspace;this.workerFile=path.resolve(workspace,workerFile);this.port=port;this.workerEnvironment=workerEnvironment;this.dir=path.join(workspace,'data/desk-runtime');this.logs=path.join(workspace,'logs');
  this.lease=path.join(this.dir,'supervisor.json');this.statusFile=path.join(this.dir,'status.json');this.stopFile=path.join(this.dir,'stop-request.json');this.worker=null;this.stopped=false;this.nonce=randomUUID();
 }
 status(value){fs.mkdirSync(this.dir,{recursive:true});const tmp=this.statusFile+'.new';fs.writeFileSync(tmp,JSON.stringify({...value,observedAt:Date.now()},null,2),{mode:0o600});fs.renameSync(tmp,this.statusFile);}
 async acquire(){
  fs.mkdirSync(this.dir,{recursive:true});const mine=await identity(process.pid);
  if(!mine)throw Error('无法核对工作台守护身份');
  for(let n=0;n<3;n++){
   try{fs.writeFileSync(this.lease,JSON.stringify({...mine,script:self,nonce:this.nonce}),{flag:'wx',mode:0o600});return true;}catch(e){if(e.code!=='EEXIST')throw e;}
   const previous=read(this.lease);if(!previous)throw Error('工作台守护记录损坏，未启动重复实例');
   const actual=await identity(Number(previous.pid));
   if(actual&&(process.platform!=='win32'||actual.started===previous.started&&actual.exe===previous.exe&&actual.command&&actual.command===previous.command&&previous.script===self))return false;
   // Delete only our unchanged stale lease. Never stop a PID read from a file.
   if(read(this.lease)?.nonce===previous.nonce)fs.unlinkSync(this.lease);
  }
  throw Error('工作台守护正在启动，请稍候');
 }
 release(){if(read(this.lease)?.nonce===this.nonce)fs.unlinkSync(this.lease);}
 async stop(){if(this.stopped)return;this.stopped=true;const child=this.worker;if(child&&child.exitCode===null){if(child.connected)try{child.send({type:'shutdown'});}catch{child.kill();}else child.kill();const timer=setTimeout(()=>{if(child.exitCode===null)child.kill();},12000);timer.unref();child.once('exit',()=>clearTimeout(timer));}}
 async run(){
  const port=this.port;if(!Number.isInteger(port)||port<1024||port>65535)throw Error('工作台端口无效');
  if(!fs.existsSync(this.workerFile)||!this.workerFile.startsWith(path.resolve(this.root)+path.sep))throw Error('工作台程序路径无效');
  if(!await this.acquire())return;
  let failures=0;const controls=setInterval(()=>{if(read(this.stopFile)?.nonce===this.nonce)this.stop();},250);controls.unref();
  try{
   fs.mkdirSync(this.logs,{recursive:true});
   if(await portBusy(port))throw Error('工作台端口已被占用，未启动重复实例');
   while(!this.stopped){
    if(await portBusy(port)){this.status({state:'occupied',supervisorPid:process.pid});break;}
    const began=Date.now(),out=fs.openSync(path.join(this.logs,'desk-worker.out.log'),'a'),err=fs.openSync(path.join(this.logs,'desk-worker.err.log'),'a');
    try{this.worker=spawn(process.execPath,[this.workerFile],{cwd:this.root,windowsHide:true,shell:false,stdio:['ignore',out,err,'ipc'],env:{...process.env,WHALE_PORT:String(port),WHALE_DATA_DIR:path.join(this.root,'data'),...this.workerEnvironment}});}finally{fs.closeSync(out);fs.closeSync(err);}
    const child=this.worker;
    this.status({state:'running',supervisorPid:process.pid,workerPid:child.pid||null});
    const ended=once(child,'exit').catch(()=>[-1]);
    try{const proof=await identity(child.pid);if(proof&&child.exitCode===null)fs.writeFileSync(path.join(this.root,'data/server-process.json'),JSON.stringify({pid:proof.pid,started:proof.started}),{mode:0o600});}catch{}
    let [code]=await ended;
    if(this.stopped)break;
    if(code===2){this.status({state:'occupied',supervisorPid:process.pid,lastExit:code});break;}
    failures=Date.now()-began>60000?0:Math.min(failures+1,5);
    const delay=Math.min(30000,1000*2**failures);this.status({state:'restarting',supervisorPid:process.pid,lastExit:code,retryAt:Date.now()+delay});
    for(let elapsed=0;elapsed<delay&&!this.stopped;elapsed+=250)await sleep(Math.min(250,delay-elapsed));
   }
  }finally{clearInterval(controls);if(read(this.stopFile)?.nonce===this.nonce)fs.unlinkSync(this.stopFile);this.status({state:'stopped',supervisorPid:process.pid});this.release();}
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===self){
 const runtime=new DeskRuntime();
 process.on('SIGINT',()=>runtime.stop());process.on('SIGTERM',()=>runtime.stop());
 // This channel exists only in isolated integration tests started by a parent.
 if(process.send)process.on('message',message=>{if(message?.type==='stop')runtime.stop();});
 runtime.run().then(()=>process.exit(0)).catch(()=>{console.error('伴屿后台未能启动，请查看本机状态与日志。');process.exit(1);});
}
