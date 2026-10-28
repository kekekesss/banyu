import { QQBot } from '@tencent-connect/qqbot-nodejs';
export function normalizeQQ(msg){
 if(!msg.replyTarget||!['group','c2c'].includes(msg.replyTarget.scope))return null;
 return {channelId:'qq',messageId:String(msg.messageId||''),conversationId:String(msg.replyTarget.targetId),kind:msg.replyTarget.scope==='group'?'group':'private',name:msg.senderName||'',text:String(msg.content||'').replace(/<@!?\d+>/g,'').trim(),mentioned:true,context:{replyTarget:msg.replyTarget}};
}
export class QQChannel{
 constructor(store,onMessage,{Bot=QQBot}={}){this.store=store;this.onMessage=onMessage;this.Bot=Bot;this.bot=null;this.state={state:'unconfigured',detail:'等待填写 AppID 与 AppSecret'};}
 status(){const c=this.store.secret('qq')||{};return {...this.state,configured:!!c.appId&&!!c.appSecret,appId:c.appId||'',capabilities:['private','group'],requires:'QQ 开放平台官方机器人，不使用普通 QQ 小号登录'};}
 async connect(){
  if(this.bot)return this.status();const c=this.store.secret('qq');if(!c?.appId||!c?.appSecret)throw new Error('请先填写 QQ 官方机器人的 AppID 和 AppSecret');
  this.state={state:'connecting',detail:'正在连接 QQ 官方平台'};
  const quiet={debug(){},info(){},warn:()=>this.store.log('warn','QQ 接入正在重试。'),error:()=>this.store.log('error','QQ 接入发生错误，请检查凭据和平台权限。')};
  const bot=new this.Bot({appId:c.appId,appSecret:c.appSecret,accountId:'whale-service-qq',logger:quiet,transport:'websocket',markdownSupport:false,reconnect:{maxAttempts:10}});this.bot=bot;
  bot.on('ready',()=>{if(this.bot===bot){this.state={state:'connected',detail:'已连接 QQ 官方机器人'};this.store.log('info','QQ 官方机器人已连接。')}});
  bot.on('disconnected',()=>{if(this.bot===bot)this.state={state:'reconnecting',detail:'QQ 连接已断开，正在重连'}});
  bot.on('error',()=>{if(this.bot===bot){this.state={state:'error',detail:'QQ 接入失败，请检查凭据、权限和网络'};this.store.log('error',this.state.detail)}});
  bot.on('message',async(ctx,msg)=>{if(this.bot!==bot)return;const event=normalizeQQ(msg);if(event)try{await this.onMessage(event)}catch{this.store.log('error','QQ 消息处理失败，未自动重发。')}});
  Promise.resolve(bot.start()).catch(()=>{if(this.bot===bot){this.state={state:'error',detail:'QQ 无法连接，请核对 AppID、AppSecret 及机器人发布权限'};this.bot=null;}});
  return this.status();
 }
 async disconnect(){const bot=this.bot;this.bot=null;this.state={state:'disconnected',detail:'已断开 QQ'};if(bot)await bot.stop();}
 async send(conversation,body){if(!this.bot||this.state.state!=='connected')throw new Error('QQ 尚未连接');const target=JSON.parse(conversation.context||'{}').replyTarget;if(!target?.msgId)throw new Error('缺少有效的 QQ 被动回复上下文，请等待客户再次发言');await this.bot.sendText(target,body);}
}
