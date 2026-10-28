// Coordinates the QQ owner-only session. No ordinary/group/proactive session is reused.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {inboxItemsOfProjections} from '../../vendor/dsh-client.js';
import {dshServiceIdentity} from '../dsh-session-cleanup.mjs';
import {AutomaticHandoff,handoffPrompt} from '../dsh-handoff.mjs';
import {OwnerWorkSession,ownerWorkScope} from './owner-work-session.mjs';
import {OwnerWorkAuthority} from './owner-work-authority.mjs';
const sameCwd=(a,b)=>{if(typeof a!=='string'||!path.isAbsolute(a)||typeof b!=='string'||!path.isAbsolute(b))return false;const left=path.resolve(a),right=path.resolve(b);return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;};

export class OwnerWorkController{
 constructor(qq,{identity=dshServiceIdentity}={}){
  this.qq=qq;this.identity=identity;this.turn=null;this.model=null;
  this.cwd=path.resolve(process.env.BANYU_MODEL_WORKSPACE||'data/model-workspace');
  this.state=new OwnerWorkSession(qq.store,{scopeNow:()=>this.scope(),ownerNow:()=>qq.store.settings().owner,accountNow:()=>qq.store.settings().account,isIdle:()=>this.idle(),now:qq.now});
  this.authority=new OwnerWorkAuthority(qq.store,{scopeNow:()=>this.scope(),authorityNow:()=>this.authorityContext(),isIdle:()=>this.idle(),now:qq.now});
  this.state.markInterrupted();
  this.handoff=new AutomaticHandoff({
   readState:async()=>this.state.state(),
   readProjection:async sessionId=>this.model.call('session/projections',{sessionId}),
   isIdle:async(_scope,old)=>{if(!this.idle()||this.scope()!==old.scope||this.unresolved())return false;const checked=await this.probe(old.sessionId);return checked.found===true&&checked.owned===true&&checked.running===false&&checked.pending===false;},
   capture:async()=>this.capture(),
   prepareCandidate:async(_scope,old)=>{if(this.scope()!==old.scope)throw Error('会话身份已变');return {sessionId:await this.create(),ready:true};},
   commit:async(_scope,{expected,sourceVersion,newSessionId,excerpt})=>this.state.rotate(expected.scope,{expected,sourceVersion,newSessionId,excerpt,chatKey:'private:'+this.qq.store.settings().owner}),
   retire:async(_scope,old)=>{if(this.scope()!==old.scope)throw Error('会话身份已变');this.resumeRetirements(this.model);},
   discard:async(_scope,candidate)=>this.discard(candidate.sessionId)
  });
 }
 authorityContext(){const c=this.qq.store.settings(),chat=this.qq.store.chat('private:'+c.owner);if(this.qq.model||this.qq.deepseekAPI?.uses('qq'))throw Error('主人会话需要 DSH 模型');const policy={enabled:c.enabled,paused:c.paused,chatPaused:!!chat.paused,privateAllow:[...c.privateAllow].sort(),privateDeny:[...c.privateDeny].sort(),source:'dsh'};return {serviceIdentity:this.identity(),account:c.account,owner:c.owner,permissionDigest:createHash('sha256').update(JSON.stringify(policy)).digest('hex'),cwd:this.cwd};}
 unresolved(){const state=this.state.state();if(!state||state.scope!==this.scope()||!this.qq.toolJournal)return 0;const c=this.qq.store.settings();return this.qq.toolJournal.unresolved({scope:state.scope,account:c.account,owner:c.owner});}
 scope(){
  try{const c=this.qq.store.settings(),role=this.qq.store.role(c.roleId),identity=this.identity();
   return ownerWorkScope({serviceIdentity:identity,account:c.account,owner:c.owner,roleId:c.roleId,roleRevision:role?.revision,model:c.model,memoryEpoch:this.qq.memoryBank?.epoch??null,permissions:{settings:c},cwd:this.cwd});
  }catch{return null;}
 }
 idle(){const active=this.qq.active,key='private:'+this.qq.store.settings().owner;return !this.qq.computer?.current&&!this.qq.timers.has(key)&&(active.size===0||active.size===1&&this.turn&&active.get(this.turn.key)===this.turn);}
 async create(){fs.mkdirSync(this.cwd,{recursive:true});const result=await this.model.call('session/create',{cwd:this.cwd,agentPreset:'banyu-qq'});if(typeof result?.sessionId!=='string'||!result.sessionId)throw Error('DSH 未创建会话');return result.sessionId;}
 async discard(sessionId){
  // This candidate was created here and never prompted. Archive refuses active work.
  if(!this.model||!this.identity())return;
  const binding=this.qq.sessionBinding(this.model,this.cwd),entry=binding.register(sessionId);
  await binding.finalize(sessionId,entry,{completed:true});
 }
 queueRetirement(sessionId){
  if(!this.qq.sessionCleanup)throw Error('归档队列不可用');
  const identity=this.identity();if(!identity)throw Error('DSH 身份不可用');
  if(this.qq.sessionCleanup.has?.({channel:'qq',identity,sessionId,expectedCwd:this.cwd}))return;
  const binding=this.qq.sessionBinding(this.model,this.cwd),entry=binding.register(sessionId);
  if(!entry||!this.qq.sessionCleanup.finish(entry))throw Error('旧会话未能登记归档');
  binding.retry().catch(()=>{});
 }
 resumeRetirements(model){
  if(!model?.base||typeof model.call!=='function')return;this.model=model;const scope=this.scope();if(!scope)return;
  for(const row of this.state.pendingRetirements(scope)){this.queueRetirement(row.sessionId);this.state.queuedRetirement(scope,row.id);}
 }
 async probe(sessionId){
  const [list,projection]=await Promise.all([this.model.call('session/list',{}),this.model.call('session/projections',{sessionId})]);
  const item=Array.isArray(list?.items)?list.items.find(v=>v.sessionId===sessionId):null;
  if(!item)return {found:false};
  const v=projection?.values;
  // Unlike an inbox-only check, a safe handoff/recovery requires the host to
  // explicitly expose each relevant projection. An unfamiliar host fails closed.
  if(!v||typeof v!=='object'||v.agentPreset!=='banyu-qq'||!v.inbox||!Array.isArray(v.inbox['next-turn'])||!Array.isArray(v.inbox['next-step'])||!v.userQuestions||!Array.isArray(v.userQuestions.active)||!v.permissions||typeof v.permissions.currentValue!=='string'||!Array.isArray(v.subagentCatalog)||!Object.hasOwn(v,'subagent')||!v.agentTeam||!Array.isArray(v.agentTeam.members)||!Array.isArray(v.agentTeam.tasks)||!v.plan||typeof v.plan.active!=='boolean'||typeof v.plan.pending!=='boolean')throw Error('会话待处理状态无法核验');
  const subagent=v.subagent;if(subagent!==null&&(typeof subagent!=='object'||Array.isArray(subagent)||Object.keys(subagent).length))throw Error('子代理状态无法核验');
  const members=v.agentTeam.members;if(members.length!==1||members[0]?.role!=='lead')throw Error('团队成员状态无法核验');
  const pending=inboxItemsOfProjections(v).length>0||v.userQuestions.active.length>0||v.subagentCatalog.length>0||v.agentTeam.tasks.length>0||v.plan.active||v.plan.pending;
  return {found:true,owned:true,cwd:item.cwd,running:item.running,pending};
 }
 capture(){
  const c=this.qq.store.settings(),key='private:'+c.owner,chat=this.qq.store.chat(key),rows=this.qq.store.messages(key,{limit:100});if(this.unresolved())throw Error('电脑操作结果尚待核对');
  const records=rows.filter(m=>!m.meta.internalApproval&&(m.direction==='in'||m.direction==='out'&&m.status==='sent')).map(m=>({type:'message',source:'qq:'+m.seq,role:m.direction==='in'?'user':'assistant',time:new Date(m.at).toISOString(),text:m.body}));
  if(this.qq.toolJournal)records.push(...this.qq.toolJournal.records({scope:this.scope(),account:c.account,owner:c.owner}));records.sort((a,b)=>String(a.time).localeCompare(String(b.time)));
  return {sourceVersion:Number(chat.latestSeq||0),records};
 }
 async begin(turn,model){
  if(!turn.ownerDirect||!model?.base||typeof model.call!=='function'||this.qq.model||this.qq.deepseekAPI?.uses('qq'))return null;
  this.turn=turn;this.model=model;
  const scope=this.scope();if(!scope){if(this.state.state())throw Error('DSH 会话身份不可用，已保留原会话');this.turn=null;return null;}
  let current=this.state.state();
  if(!current||current.scope!==scope){
   if(current&&current.status!=='idle')throw Error('旧会话操作结果待核对，暂不切换');
   const candidate=await this.create();let installed=false;
   try{installed=current?this.state.replaceScope(scope,{expected:current,newSessionId:candidate,sourceVersion:turn.latestSeq,chatKey:turn.key}):this.state.install(scope,candidate);}finally{if(!installed)await this.discard(candidate);}
   if(!installed)throw Error('会话期间收到新消息或设置已变化，未切换');
   current=this.state.state();
  }
  const recovery=await this.state.recover(scope,{cwd:this.cwd,probe:id=>this.probe(id)});
  if(recovery.status!=='ready')throw Error(recovery.status==='needs-review'?'上次电脑操作结果待核对，未自动重发':'DSH 会话暂不可安全恢复：'+recovery.status);
  current=recovery.state;const observed=await this.probe(current.sessionId);this.authority.bind(scope,{sessionId:current.sessionId,generation:current.generation,observed});if(this.unresolved())throw Error('上次电脑操作结果待核对');const turnId=randomUUID();
  if(!this.state.begin(scope,{sessionId:current.sessionId,generation:current.generation,turnId,chatKey:turn.key,reason:turn.reason,sender:turn.owner,through:turn.latestSeq}))throw Error('主人会话已变化，未启动回合');
  return {scope,sessionId:current.sessionId,generation:current.generation,turnId,first:current.completedCount===0,recovery:current.recoveryMode===1,excerpt:current.pendingExcerpt?handoffPrompt(current.pendingExcerpt):''};
 }
 finish(work,completed){if(work)this.state.finish(work.scope,{...work,outcome:completed?'completed':'uncertain'});this.turn=null;}
 async check(){if(!this.model||!this.idle())return;const state=this.state.state();if(!state||state.status!=='idle'||state.scope!==this.scope())return;const result=await this.handoff.check(state.scope);if(result.status==='handed-off')this.qq.store.log('info','DSH 上下文已自动交接，旧会话已保留。');}
 status(){const state=this.state.state(),pendingArchive=this.state.pendingRetirementCount();if(!state)return {status:'not-started',pendingArchive};if(state.status==='uncertain'||state.status==='running'&&!this.turn)return {status:'needs-review',pendingArchive,detail:'上次回合可能已操作电脑。请先人工核查；确认后才能继续，旧请求不会重发。'};if(state.scope!==this.scope())return {status:'scope-changed',pendingArchive,detail:'账号、角色、模型或权限已改变，旧会话保留。'};return {status:state.status,pendingArchive,detail:state.pendingExcerpt?'交接资料将在下一轮提供。':''};}
 async resolve(acknowledged){
  if(acknowledged!==true)throw Object.assign(Error('请先确认已核查上次操作结果'),{status:400});
  if(!this.idle())throw Object.assign(Error('当前还有回合或电脑操作，暂不能恢复'),{status:409});
  const scope=this.scope(),state=this.state.state();if(!scope||!state||state.status!=='uncertain')throw Object.assign(Error('当前没有可恢复的不确定回合'),{status:409});
  const model=await this.qq.ensureModel();if(!model?.base||typeof model.call!=='function')throw Object.assign(Error('请先连接原来的 DSH'),{status:409});this.model=model;
  if(state.scope!==scope){await this.authority.recoverChangedScope({acknowledged:true,probe:id=>this.probe(id),createCandidate:()=>this.create(),discardCandidate:id=>this.discard(id)});this.qq.store.log('info','已人工核查主人会话，旧请求不会重新执行。');return {status:'idle',detail:'已恢复；请发送新消息继续，旧请求不会重发。'};}
  const observed=await this.probe(state.sessionId);
  if(!observed.found||!observed.owned||!sameCwd(observed.cwd,this.cwd)||observed.running!==false||observed.pending!==false)throw Object.assign(Error('DSH 会话仍在运行或有待处理事项，暂不能恢复'),{status:409});
  const candidate=await this.create();let ok=false;
  try{const again=await this.probe(state.sessionId);if(again.found&&again.owned&&sameCwd(again.cwd,this.cwd)&&again.running===false&&again.pending===false)ok=this.state.reconcileAndReplace(scope,{sessionId:state.sessionId,generation:state.generation,newSessionId:candidate,confirmedIdle:true,chatKey:'private:'+this.qq.store.settings().owner});}finally{if(!ok)await this.discard(candidate);}
  if(!ok)throw Object.assign(Error('会话状态已改变，请重新检查'),{status:409});
  this.qq.store.log('info','已人工核查主人会话，旧请求不会重新执行。');return {status:'idle',detail:'已恢复；请发送新消息继续，旧请求不会重发。'};
 }
}
