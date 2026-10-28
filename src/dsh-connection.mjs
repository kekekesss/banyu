// MIT. Banyu's local DSH carrier, implemented against the host RPC contract.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash,createHmac} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import yaml from 'js-yaml';
import WebSocket from 'ws';
const run=promisify(execFile);
export function localDshUrl(value){
 const u=new URL(value);
 if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('DSH 只允许本机接口');
 return u.origin;
}
export async function dshListeners(){
 if(process.platform!=='win32')return [];
 const {stdout}=await run('powershell.exe',['-NoProfile','-Command',"Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object {'DSH='+$_.Id};netstat.exe -ano -p tcp"],{windowsHide:true,timeout:12000,maxBuffer:1024*1024});
 const owners=new Set([...stdout.matchAll(/^DSH=(\d+)\s*$/gm)].map(m=>m[1]));
 return [...new Set(stdout.split(/\r?\n/).flatMap(line=>{const m=/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);return m&&owners.has(m[2])?['http://127.0.0.1:'+m[1]]:[]}))];
}
export function dshCookie(base,{directory=process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),now=Date.now()}={}){
 const authority=new URL(localDshUrl(base)).host;
 const record=yaml.load(fs.readFileSync(path.join(directory,'.credentials.yaml'),'utf8'))?.records?.['client-connection/browser-session'];
 if(record?.kind!=='grant'||record.payload?.version!==1||typeof record.payload.secret!=='string')throw Error('DSH 本机连接凭据尚未准备好');
 const secret=Buffer.from(record.payload.secret,'base64url');if(secret.length!==32)throw Error('DSH 本机凭据格式不受支持');
 const payload=Buffer.from(JSON.stringify({version:1,authority,issuedAt:now,expiresAt:now+3600000})).toString('base64url');
 return 'dsh-auth-'+createHash('sha256').update(authority).digest('base64url')+'=v1.'+payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
}
const noArguments=new Set(['agentPresets/list','settings/describe','session/modelCatalog','pluginInventory/list']);
export const visibleText=message=>(Array.isArray(message?.content)?message.content:[]).filter(p=>p.type==='text'&&typeof p.text==='string').map(p=>p.text).join('');
export class DshConnection{
 constructor(base,{request=fetch,cookie,timeout=12000}={}){this.base=localDshUrl(base);this.request=request;this.auth=cookie||(()=>dshCookie(this.base));this.timeout=timeout;}
 async call(method,value={},signal){
  if(!/^[A-Za-z$][A-Za-z0-9$]*(?:\/[A-Za-z][A-Za-z0-9]*)+$/.test(method))throw Error('DSH 操作无效');
  const rpcId=randomUUID(),argument=noArguments.has(method)?{}:['pluginManager/setBundleEnabled','pluginManager/setPluginEnabled'].includes(method)?value:method==='session/list'?{_request:value}:{request:value};
  const response=await this.request(this.base+'/api/'+method,{method:'POST',redirect:'error',headers:{'content-type':'application/json',cookie:await this.auth()},body:JSON.stringify({type:'client-request',rpcId,method,payload:{args:argument}}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeout)]):AbortSignal.timeout(this.timeout)});
  if(!response.ok)throw Error('DSH 本机接口暂不可用（'+response.status+'）');
  const answer=await response.json();if(answer.type!=='server-response'||answer.rpcId!==rpcId||typeof answer.result?.ok!=='boolean')throw Error('DSH 接口协议不匹配');
  if(!answer.result.ok){const code=String(answer.result.error?.code||'failed').replace(/[^A-Za-z0-9/_-]/g,'').slice(0,100);throw Object.assign(Error('DSH 调用失败：'+code),{code});}
  return answer.result.value;
 }
 async turn({sessionId,preset,selection,prompt,content,signal,onEvent=()=>{},onSession=()=>{},timeout=180000,cancelOnFailure}={}){
  signal?.throwIfAborted();
  let created=false,cwd=null;if(!sessionId){cwd=path.resolve(process.env.BANYU_MODEL_WORKSPACE||'data/model-workspace');fs.mkdirSync(cwd,{recursive:true});sessionId=(await this.call('session/create',{cwd,agentPreset:preset},signal)).sessionId;created=true;}
  onSession(sessionId,{cwd,created});if(selection)await this.call('session/selectModel',{sessionId,...selection},signal);
  const deadline=AbortSignal.timeout(timeout),combined=signal?AbortSignal.any([signal,deadline]):deadline;
  const streamId=randomUUID(),url=new URL('/api/remote.mux',this.base);url.protocol='ws:';
  const socket=new WebSocket(url,{headers:{cookie:await this.auth()},handshakeTimeout:10000,maxPayload:16*1024*1024,perMessageDeflate:false});
  let activeTurn=null,lastText='',usage=null,readyResolve,readyReject,finishResolve,finishReject,settled=false,readyTimer;
  const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j}),finished=new Promise((r,j)=>{finishResolve=r;finishReject=j});ready.catch(()=>{});finished.catch(()=>{});
  const fail=()=>{const e=Error(combined.aborted?'模型回合已取消或超时':'模型事件连接中断');readyReject(e);finishReject(e);};
  const abort=()=>{socket.terminate();fail();};combined.addEventListener('abort',abort,{once:true});
  socket.on('error',fail);socket.on('close',()=>{if(!settled)fail()});
  socket.on('open',()=>socket.send(JSON.stringify({type:'open',streamId,endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId},maxMessages:1}}}})));
  socket.on('message',raw=>{
   let m;try{m=JSON.parse(raw)}catch{return}if(m.streamId!==streamId)return;
   if(m.type==='error'||m.type==='end'){fail();return}if(m.type!=='item')return;
   if(m.value?.type==='snapshot'){readyResolve();return;}
   if(m.value?.type!=='event')return;const e=m.value.event;if(!e?.type)return;
   try{onEvent(e)}catch{}
   if(e.type==='turn/start'){activeTurn=e.data?.turn;lastText='';}
   if(activeTurn===null)return;
   if(e.type==='assistant/message'&&e.data?.turn===activeTurn&&!e.data?.interrupted){const text=visibleText(e.data.message);if(text)lastText=text;usage=e.data.usage||usage;}
   if(e.type==='turn/end'&&e.data?.turn===activeTurn){settled=true;finishResolve({sessionId,created,text:lastText,reason:e.data.reason,usage});}
  });
  try{
   await Promise.race([ready,new Promise((_,j)=>{readyTimer=setTimeout(()=>j(Error('模型订阅超时')),10000);readyTimer.unref()})]);clearTimeout(readyTimer);combined.throwIfAborted();
   await this.call('session/prompt',{sessionId,requestId:randomUUID(),mode:'queue',content:content||[{type:'text',text:String(prompt||'')}]},combined);
   const result=await finished;if(result.reason?.kind!=='completed')throw Error('模型回合未正常完成');return result;
  }catch(e){if(cancelOnFailure??created)await this.call('session/cancel',{sessionId}).catch(()=>{});throw e;}
  finally{settled=true;clearTimeout(readyTimer);combined.removeEventListener('abort',abort);socket.terminate();}
 }
}
export async function findDsh({base='',preset='',request=fetch,cookie,listeners=dshListeners}={}){
 // A working known endpoint needs no process/port scan. If it disappeared or
 // has the wrong preset, discover again so DSH restarts with a new port work.
 let found=false;const seen=new Set();
 const check=async candidate=>{if(!candidate||seen.has(candidate))return null;seen.add(candidate);try{const api=new DshConnection(candidate,{request,cookie,timeout:3500});const list=await api.call('agentPresets/list');if(!Array.isArray(list.presets))return null;found=true;return !preset||list.presets.some(p=>p.id===preset&&!p.broken)?api:null;}catch{return null;}};
 const known=await check(base);if(known)return known;
 for(const candidate of await listeners().catch(()=>[])){const api=await check(candidate);if(api)return api;}
 throw Object.assign(Error(found?'DSH 已连接，但伴屿模型预设尚未加载':'未连接 DSH'),{code:found?'PRESET_MISSING':'DSH_NOT_FOUND'});
}
