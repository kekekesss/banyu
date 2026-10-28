import { randomBytes,randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
const ORIGIN='https://ilinkai.weixin.qq.com';
export function trustedOrigin(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!(u.hostname==='weixin.qq.com'||u.hostname.endsWith('.weixin.qq.com')))throw new Error('微信返回了非受信地址，已停止连接');return u.origin;}
export function normalizeWeixin(msg){
 if(msg.message_type!==1||msg.group_id||!msg.from_user_id||msg.message_id===undefined)return null;
 const text=(msg.item_list||[]).map(x=>x.type===1?x.text_item?.text:x.type===3?x.voice_item?.text||'[语音]':x.type===2?'[图片]':x.type===4?'[文件]':x.type===5?'[视频]':'').filter(Boolean).join('\n');
 return {channelId:'weixin',messageId:String(msg.message_id),conversationId:msg.from_user_id,kind:'private',name:msg.from_user_id,text,mentioned:false,context:{contextToken:msg.context_token||'',peer:msg.from_user_id}};
}
export class WeixinChannel{
 constructor(store,onMessage,{fetcher=fetch,watchLogin=true}={}){this.store=store;this.onMessage=onMessage;this.fetcher=fetcher;this.autoWatch=watchLogin;this.state=store.secret('weixin')?.token?{state:'disconnected',detail:'微信授权已保留，可恢复连接'}:{state:'unconfigured',detail:'扫码连接微信私聊'};this.login=null;this.abort=null;this.run=null;}
 status(){const c=this.store.secret('weixin');return {...this.state,configured:!!c?.token,accountId:c?.accountId||'',capabilities:['private'],requires:'微信扫码授权；普通微信群暂不支持',login:this.login?{status:this.login.status,image:this.login.image,expiresAt:this.login.expiresAt}:null};}
 headers(auth=true){const c=this.store.secret('weixin');return {'content-type':'application/json','iLink-App-Id':'bot','iLink-App-ClientVersion':String(0x02040a),...(auth?{AuthorizationType:'ilink_bot_token','X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),...(auth===true&&c?.token?{authorization:'Bearer '+c.token}:{})}:{})};}
 async request(route,body,{base,auth=true,signal,timeout=20000}={}){
  const c=this.store.secret('weixin');const origin=trustedOrigin(base||c?.baseUrl||ORIGIN);const r=await this.fetcher(origin+route,{method:body===undefined?'GET':'POST',redirect:'error',headers:this.headers(auth),body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});
  if(!r.ok)throw new Error('微信接口返回 HTTP '+r.status);const data=await r.json();if((data.ret!==undefined&&data.ret!==0)||(data.errcode!==undefined&&data.errcode!==0)){const error=new Error('微信接口暂不可用（'+(data.ret||data.errcode)+'）');error.sessionExpired=data.ret===-14||data.errcode===-14;throw error;}return data;
 }
 async startLogin(){
  const data=await this.request('/ilink/bot/get_bot_qrcode?bot_type=3',{local_token_list:[]},{base:ORIGIN,auth:'bootstrap'});if(!data.qrcode||!data.qrcode_img_content)throw new Error('微信没有返回有效二维码');
  const content=String(data.qrcode_img_content);if(content.length>12000)throw new Error('微信二维码内容异常');
  const image=content.startsWith('data:image/png;base64,')?content:await QRCode.toDataURL(content,{width:260,margin:2,errorCorrectionLevel:'M'});
  this.login?.controller?.abort();this.login={controller:new AbortController(),qrcode:data.qrcode,base:ORIGIN,status:'wait',image,expiresAt:Date.now()+240000};const current=this.login;
  if(this.autoWatch)this.loginTask=this.watchLogin(current).catch(()=>{if(this.login===current)this.store.log('warn','微信扫码确认暂时中断，请刷新二维码。')});return this.status().login;
 }
 async watchLogin(current){while(this.login===current&&!['confirmed','expired','verify_code_blocked'].includes(current.status)){if(Date.now()>current.expiresAt+660000){current.status='expired';break}if(current.status==='need_verifycode'){await new Promise(r=>setTimeout(r,1000));continue}try{await this.pollLogin()}catch{}if(this.login===current&&!['confirmed','expired','verify_code_blocked'].includes(current.status))await new Promise(r=>setTimeout(r,1200));}}
 async pollLogin(verifyCode){if(this.polling)return this.polling;this.polling=this.doPollLogin(verifyCode).finally(()=>{this.polling=null});return this.polling;}
 async doPollLogin(verifyCode){
  const current=this.login;if(!current)throw new Error('请先生成二维码');if(['confirmed','expired','verify_code_blocked'].includes(current.status))return this.status().login;
  const query=new URLSearchParams({qrcode:current.qrcode});if(verifyCode){if(!/^\d{4,8}$/.test(verifyCode))throw new Error('请输入手机上显示的数字验证码');query.set('verify_code',verifyCode)}
  const data=await this.request('/ilink/bot/get_qrcode_status?'+query,undefined,{base:current.base,auth:false,signal:current.controller?.signal,timeout:35000});
  if(this.login!==current)return this.status().login;
  if(data.status!=='confirmed')current.status=data.status||'wait';
  if(data.status==='scaned_but_redirect'&&data.redirect_host){current.base=trustedOrigin(data.redirect_host.startsWith('https://')?data.redirect_host:'https://'+data.redirect_host);current.status='scaned';}
  if(data.status==='confirmed'){
   if(!data.bot_token||!data.ilink_bot_id)throw new Error('微信登录结果缺少凭据');const baseUrl=trustedOrigin(data.baseurl||current.base);
   await this.disconnect({keepLogin:true});if(this.login!==current||current.controller?.signal.aborted)return this.status().login;this.store.secret('weixin',{token:data.bot_token,accountId:data.ilink_bot_id,userId:data.ilink_user_id||'',baseUrl,cursor:''});this.store.put('channels','weixin',{...this.store.get('channels','weixin'),autoConnect:true});current.status='confirmed';this.login=current;await this.connect();
  }
  return this.status().login;
 }
 async connect(){if(this.run)return this.status();const c=this.store.secret('weixin');if(!c?.token)throw new Error('请先用微信扫码授权');this.abort=new AbortController();const controller=this.abort;this.state={state:'connecting',detail:'正在连接微信私聊'};this.run=this.monitor(controller).finally(()=>{if(this.abort===controller){this.run=null;this.abort=null;}});return this.status();}
 async monitor(controller){
  let failures=0;try{await this.request('/ilink/bot/msg/notifystart',{base_info:this.baseInfo()},{signal:controller.signal,timeout:10000})}catch{}
  while(!controller.signal.aborted){try{
   const c=this.store.secret('weixin');const data=await this.request('/ilink/bot/getupdates',{get_updates_buf:c.cursor||'',base_info:this.baseInfo()},{signal:controller.signal,timeout:45000});if(controller.signal.aborted)break;
   failures=0;this.state={state:'connected',detail:'微信私聊已连接'};
   for(const raw of data.msgs||[]){const event=normalizeWeixin(raw);if(event)try{await this.onMessage(event)}catch{this.store.log('error','微信消息处理失败，已保留原会话。')}}
   if(data.get_updates_buf)this.store.secret('weixin',{...this.store.secret('weixin'),cursor:data.get_updates_buf});
   if(!(data.msgs||[]).length)await this.sleep(800,controller.signal);
  }catch(e){if(controller.signal.aborted)break;if(e.sessionExpired){this.state={state:'expired',detail:'微信授权已失效，请重新扫码'};this.store.log('warn',this.state.detail);break}failures++;this.state={state:'reconnecting',detail:'微信连接暂时中断，正在重试'};await this.sleep(Math.min(30000,1000*2**Math.min(failures,5)),controller.signal)}}
 }
 baseInfo(){return {channel_version:'2.4.10',bot_agent:'WhaleServiceDesk/1.0.0'};}
 async sleep(ms,signal){if(signal.aborted)return;await new Promise(r=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);r()};const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});});}
 async disconnect({keepLogin=false}={}){this.state={state:'disconnected',detail:'微信连接已断开'};if(!keepLogin){this.login?.controller?.abort();this.login=null;}const controller=this.abort;controller?.abort();if(this.run)await this.run;this.run=null;this.abort=null;}
 async send(conversation,body){if(!['connected','connecting'].includes(this.state.state))throw new Error('微信尚未连接');const c=JSON.parse(conversation.context||'{}');if(!c.contextToken||!c.peer||c.peer!==conversation.external_id)throw new Error('缺少本会话有效的微信回复上下文，请等待客户再次发言');await this.request('/ilink/bot/sendmessage',{msg:{from_user_id:'',to_user_id:c.peer,client_id:randomUUID(),message_type:2,message_state:2,context_token:c.contextToken,item_list:[{type:1,text_item:{text:body}}]},base_info:this.baseInfo()});}
}
