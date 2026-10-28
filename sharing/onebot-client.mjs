// MIT. Independent client for the public OneBot 11 forward WebSocket protocol.
// Compatibility export names let the shared bridge use this transport without
// distributing the SnowLuma SDK. No QQ login protocol or native hook lives here.
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

function localUrl(value){
 const u=new URL(value);
 if(!['ws:','wss:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search)throw Error('OneBot 仅允许不含凭据的本机 WebSocket 地址');
 return u.href;
}
export const text=value=>({type:'text',data:{text:String(value)}});
const messagePayload=value=>Array.isArray(value)||typeof value==='string'?value:[value];
export class OneBotClient extends EventEmitter{
 constructor({url,accessToken='',reconnect=true,requestTimeout=15000,reconnectDelay=1000,heartbeatInterval=20000}={}){
  super();this.url=localUrl(url);this.accessToken=accessToken;this.reconnect=reconnect;this.requestTimeout=requestTimeout;this.reconnectDelay=reconnectDelay;this.heartbeatInterval=heartbeatInterval;this.pending=new Map();this.socket=null;this.connecting=null;this.timer=null;this.heartbeat=null;this.stopped=false;this.attempt=0;
  this.on('error',()=>{});
 }
 connect(){
  if(this.socket?.readyState===WebSocket.OPEN)return Promise.resolve();
  if(this.connecting)return this.connecting;
  this.stopped=false;clearTimeout(this.timer);this.url=localUrl(this.url);
  let socket;
  const promise=new Promise((resolve,reject)=>{
   socket=new WebSocket(this.url,{headers:this.accessToken?{Authorization:'Bearer '+this.accessToken}:{},handshakeTimeout:10000,maxPayload:8*1024*1024,perMessageDeflate:false});
   this.socket=socket;let opened=false;
   socket.once('open',()=>{if(this.socket!==socket){socket.close();return}opened=true;this.attempt=0;
    let alive=true;socket.on('pong',()=>{alive=true});clearInterval(this.heartbeat);
    this.heartbeat=setInterval(()=>{if(this.socket!==socket)return;if(!alive){socket.terminate();return}alive=false;socket.ping()},this.heartbeatInterval);this.heartbeat.unref?.();
    this.emit('open');resolve()});
   socket.on('message',data=>{if(this.socket===socket)this.receive(data)});
   socket.on('error',()=>{const error=Error('OneBot 本机连接失败');if(!opened)reject(error);this.emit('error',error)});
   socket.once('close',(code)=>{
    if(!opened)reject(Error('OneBot 连接在就绪前关闭'));
    if(this.socket!==socket)return;
    clearInterval(this.heartbeat);this.socket=null;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('OneBot 连接已断开'))}this.pending.clear();
    this.emit('close',{code});
    if(this.reconnect&&!this.stopped){const delay=Math.min(30000,this.reconnectDelay*2**Math.min(this.attempt++,5));this.timer=setTimeout(()=>this.connect().catch(()=>{}),delay);this.timer.unref?.()}
   });
  });
  this.connecting=promise.finally(()=>{this.connecting=null});return this.connecting;
 }
 receive(data){
  let value;try{value=JSON.parse(data.toString())}catch{return}
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  if(Object.hasOwn(value,'echo')){
   const item=this.pending.get(String(value.echo));if(!item)return;this.pending.delete(String(value.echo));clearTimeout(item.timer);
   if(value.retcode!==0||value.status==='failed')item.reject(Error(`OneBot API ${item.action} 返回错误 ${Number(value.retcode)}`));else item.resolve(value.data);
   return;
  }
  if(typeof value.post_type!=='string')return;
  this.dispatch('event',value);
  if(value.post_type==='message'&&['private','group'].includes(value.message_type))this.dispatch(value.message_type,value);
  if(value.post_type==='notice')this.dispatch('notice:'+value.notice_type,value);
 }
 dispatch(name,value){for(const callback of this.listeners(name)){try{Promise.resolve(callback(value)).catch(()=>this.emit('error',Error('OneBot 事件处理失败')))}catch{this.emit('error',Error('OneBot 事件处理失败'))}}}
 onEvent(fn){this.on('event',fn);return this}
 onPrivateMessage(fn){this.on('private',fn);return this}
 onGroupMessage(fn){this.on('group',fn);return this}
 onNotice(type,fn){this.on('notice:'+type,fn);return this}
 onBotStatus(fn){return this.onNotice('bot_status',fn)}
 request(action,params={}){
  if(!/^[a-z][a-z0-9_]{0,79}$/.test(action))return Promise.reject(Error('OneBot 动作名无效'));
  if(!this.socket||this.socket.readyState!==WebSocket.OPEN)return Promise.reject(Error('OneBot 尚未连接'));
  const echo=randomUUID();return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(echo);reject(Error('OneBot API 请求超时'))},this.requestTimeout);
   this.pending.set(echo,{resolve,reject,timer,action});
   try{this.socket.send(JSON.stringify({action,params,echo}),error=>{if(error){const item=this.pending.get(echo);if(item){clearTimeout(timer);this.pending.delete(echo);reject(Error('OneBot 请求未能发送'))}}})}catch{clearTimeout(timer);this.pending.delete(echo);reject(Error('OneBot 请求未能发送'))}
  });
 }
 raw(action,params){return this.request(action,params)}
 getLoginInfo(){return this.request('get_login_info')}
 getImage(params){return this.request('get_image',typeof params==='string'?{file:params}:params)}
 getMessage(id){return this.request('get_msg',{message_id:id})}
 getGroupMemberList(id){return this.request('get_group_member_list',{group_id:id})}
 getGroupMemberInfo(group,user){return this.request('get_group_member_info',{group_id:group,user_id:user})}
 fetchFaceEntity(id){return this.request('fetch_face_entity',{face_id:id})}
 sendPrivateMessage(id,message){return this.request('send_private_msg',{user_id:id,message:messagePayload(message)})}
 sendGroupMessage(id,message){return this.request('send_group_msg',{group_id:id,message:messagePayload(message)})}
 close(){this.stopped=true;clearTimeout(this.timer);clearInterval(this.heartbeat);const socket=this.socket;this.socket=null;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('OneBot 已停止'))}this.pending.clear();socket?.terminate();}
}
export {OneBotClient as SnowLumaWebSocketClient};
