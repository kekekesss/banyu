// Associate only sessions created by this workbench with safe, retryable
// archive operations. The chat history and memory store are never modified.
import path from 'node:path';
import {dshServiceIdentity} from './dsh-session-cleanup.mjs';

const key=value=>{if(typeof value!=='string'||!path.isAbsolute(value))return null;const normalized=path.resolve(value);return process.platform==='win32'?normalized.toLowerCase():normalized;};
export class DshSessionBinding{
 constructor({cleanup,channel,rpc,expectedCwd,identity=dshServiceIdentity(),identityNow=dshServiceIdentity,warn=()=>{}}){this.cleanup=cleanup;this.channel=channel;this.rpc=rpc;this.cwd=expectedCwd;this.identity=identity;this.identityNow=identityNow;this.warn=warn;}
 warning(){try{this.warn('DSH 会话暂未自动整理，请在 DSH 查看。');}catch{}}
 register(sessionId){
  if(!this.cleanup)return null;
  let identity=this.identity;try{if(identity!==this.identityNow())identity=null;}catch{identity=null;}
  const entry={channel:this.channel,identity,sessionId,expectedCwd:this.cwd};
  try{this.cleanup.register(entry);return entry;}catch{this.warning();return null;}
 }
 async finalize(sessionId,entry,{completed=false}={}){
  if(!sessionId)return {archived:false,tracked:false};
  try{await this.rpc('workspace/archiveSession',{sessionId},AbortSignal.timeout(3500));if(entry)this.cleanup.confirmArchived(entry,true);return {archived:true,tracked:!!entry};}
  catch{if(entry)try{this.cleanup.finish(entry,{cancelRequired:!completed});}catch{}this.warning();return {archived:false,tracked:!!entry};}
 }
 async retry(){
  if(!this.cleanup)return;
  let identity;try{identity=this.identityNow();}catch{return;}if(!identity)return;
  const verify=async({sessionId,expectedCwd,signal})=>{
   if(identity!==this.identityNow())return false;
   const result=await this.rpc('session/list',{},signal),items=result?.items;
   if(!Array.isArray(items))return false;const item=items.find(v=>v?.sessionId===sessionId);
   return !!item&&item.running===false&&key(item.cwd)!==null&&key(item.cwd)===key(expectedCwd);
  };
  // A failed or crashed turn may have been opened manually in DSH since.
  // Confirm it is no longer running; never forcibly cancel it or its tasks.
  return this.cleanup.retry({identity,verify,cancel:verify,archive:async({sessionId,signal})=>{if(identity!==this.identityNow())return false;await this.rpc('workspace/archiveSession',{sessionId},signal);return true;}});
 }
}
