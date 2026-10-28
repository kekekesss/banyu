import { retrieve } from './knowledge.mjs';
import {MEMORY_RULES} from './memory.mjs';

export class Engine{
 constructor(store,{generate,send,memoryBank,policyRevision=()=>0,isChannelReady=()=>true,onChange=()=>{}}){this.store=store;this.memoryBank=memoryBank;this.policyRevision=policyRevision;this.generate=generate;this.send=send;this.isChannelReady=isChannelReady;this.onChange=onChange;this.queues=new Map();this.lastSent=new Map();this.active=0;this.waiters=[];}
 remember(c,id,direction,body,at){return this.memoryBank?.capture({channel:c.channel_id,account:c.channel_id==='weixin'?this.store.secret('weixin')?.accountId||'':'',conversation:c.kind+':'+c.external_id,zone:c.zone_id||'',name:c.name,speaker:direction==='out'?'机器人':c.name,direction,source:'history:'+id,boundary:id,content:body,at});}
 async slot(fn){if(this.active>=3)await new Promise(r=>this.waiters.push(r));this.active++;try{return await fn()}finally{this.active--;this.waiters.shift()?.();}}
 async accept(event){
  if(!event.messageId||!event.conversationId||!['qq','weixin'].includes(event.channelId)||!['private','group'].includes(event.kind))return {ignored:'invalid'};
  if(event.channelId==='weixin'&&event.kind!=='private')return {ignored:'unsupported-group'};
  if(!this.store.receipt(event.channelId,String(event.messageId)))return {ignored:'duplicate'};
  const c=this.store.conversation(event);event={...event,routeZoneId:c.zone_id,storedMessageId:this.store.message(c.id,'in',String(event.text||'[非文字消息]').slice(0,30000))};this.onChange();
  this.remember(c,event.storedMessageId,'in',String(event.text||'[非文字消息]'));event.memoryThrough=this.memoryBank?.snapshot();
  const pending=this.queues.get(c.id)||Promise.resolve();
  const task=pending.catch(()=>{}).then(()=>this.slot(()=>this.process(c.id,event)));
  this.queues.set(c.id,task);try{return await task}finally{if(this.queues.get(c.id)===task)this.queues.delete(c.id)}
 }
 eligible(zone,event){if(event.kind==='private'||zone.trigger==='all')return true;if(zone.trigger==='mention')return event.mentioned===true;return zone.keywords.some(x=>String(event.text).includes(x));}
 async plan(zone,text,history=[],memories=[]){
  const role=this.store.get('roles',zone.roleId);if(!role)throw new Error('分区角色不存在');
  if(/转人工|人工客服|找人工|找真人/.test(text))return {reply:'已放入人工待办，请等待工作人员回复。',handoff:true,reason:'用户请求人工',sources:[]};
  const refs=retrieve(this.store,zone.id,text);
  if(zone.type==='service'&&!refs.length)return {reply:zone.fallback,handoff:true,reason:'资料库中没有足够依据',sources:[]};
  const prompt={role:role.prompt,zone:zone.name,mode:zone.type,rules:zone.instructions,knowledge:refs.map(x=>({title:x.title,content:x.body})),history:history.slice(-12).map(x=>({role:x.direction==='in'?'user':'assistant',text:x.body.slice(0,2500)})),memories,memoryRules:MEMORY_RULES,question:text};
  const reply=String(await this.generate(prompt)).trim();if(!reply)throw new Error('模型没有返回回复');
  return {reply:reply.slice(0,2500),handoff:false,reason:'模型基于本分区资料与角色生成',sources:refs.map(x=>x.title)};
 }
 async process(id,event){
  let c=this.store.rawConversation(id);const zoneId=this.store.route(c.channel_id,c.kind,c.external_id);const zone=zoneId?this.store.get('zones',zoneId):null;
  if(!zone||zoneId!==event.routeZoneId||!zone.enabled||zone.archived||this.store.setting('paused')===true)return {ignored:'unassigned-or-disabled'};
  if(c.human)return {ignored:'human'};if(!this.eligible(zone,event))return {ignored:'trigger'};
  if(this.store.usage(zone.id)>=zone.dailyLimit){this.store.handoff(id,'分区达到今日自动回复上限');return {ignored:'budget'};}
  if(Date.now()-(this.lastSent.get(id)||0)<zone.cooldownSeconds*1000)return {ignored:'cooldown'};
  this.store.increment(zone.id);
  const modelRevision=this.policyRevision(),memoryEpoch=this.memoryBank?.epoch,memories=this.memoryBank?.context({channel:c.channel_id,account:c.channel_id==='weixin'?this.store.secret('weixin')?.accountId||'':'',conversation:c.kind+':'+c.external_id,zone:zone.id,query:event.text,through:event.memoryThrough,boundary:c.history_start})||[];
  let result;
  try{result=await this.plan(zone,event.text||'[用户发送了非文字内容，请人工查看]',this.store.messages(id,40).filter(x=>(x.direction==='out'||x.id<event.storedMessageId)&&x.id>=c.history_start&&x.status!=='failed'&&x.status!=='sending').slice(-12),memories);}
  catch(error){this.store.handoff(id,'模型暂不可用');this.store.log('error',`分区「${zone.name}」模型调用失败，需要人工处理。`);this.onChange();return {error:'model',detail:error.message};}
  c=this.store.rawConversation(id);
  if(c.human||this.store.setting('paused')===true||this.store.route(c.channel_id,c.kind,c.external_id)!==zone.id||!this.store.get('zones',zone.id)?.enabled||!this.isChannelReady(c.channel_id)||memoryEpoch!==this.memoryBank?.epoch||modelRevision!==this.policyRevision())return {ignored:'policy-changed'};
  if(result.handoff)this.store.handoff(id,result.reason);
  const messageId=this.store.message(id,'out',result.reply,'sending');
  try{await this.send({...c,context:JSON.stringify(event.context||{})},result.reply);this.store.messageState(messageId,'sent');this.remember(c,messageId,'out',result.reply);this.lastSent.set(id,Date.now());this.store.log('info',`「${zone.name}」已回复一条 ${c.channel_id==='qq'?'QQ':'微信'}消息。`);return {sent:true,...result};}
  catch(error){this.store.messageState(messageId,'failed');this.store.handoff(id,'发送失败，请人工核查');this.store.log('error',`「${zone.name}」发送失败，请检查接入端。`);return {error:'send',detail:error.message};}
  finally{this.onChange();}
 }
 async humanReply(id,text){const c=this.store.rawConversation(id);if(!c)throw new Error('会话不存在');if(!this.isChannelReady(c.channel_id))throw new Error('接入端尚未连接');this.store.handoff(id,'人工已接管');const msg=this.store.message(id,'out',text,'sending');try{await this.send(c,text);this.store.messageState(msg,'sent');this.remember(c,msg,'out',text)}catch(e){this.store.messageState(msg,'failed');throw e}finally{this.onChange()}}
}
