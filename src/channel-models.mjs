// Independent model selection, credentials and policy revisions for QQ/Weixin.
import {DeepSeekAPI,DEEPSEEK_MODELS} from './deepseek-api.mjs';
import {fail,text} from './store.mjs';
const channels=['qq','weixin'];
const modelText=(v,max=150)=>text(v,max);
const apiKey=v=>{const s=text(v,4000);if(!/^[\x21-\x7e]{1,4000}$/.test(s))fail('API Key 格式无效，请不要包含空格或换行');return s;};
function apiBase(value){let u;try{u=new URL(value);}catch{fail('请填写有效的兼容 API 地址');}if(!['https:','http:'].includes(u.protocol)||u.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash)fail('请使用 HTTPS 接口地址；本机服务可用 HTTP');return u.href.replace(/\/$/,'');}
export class ChannelModels{
 constructor(store,{qqStore,legacyDeepseek,request=fetch}={}){
  this.store=store;this.qqStore=qqStore;this.direct={};this.compatible={};this.adapters={};
  const old=legacyDeepseek.config(),oldKey=store.secret('deepseek-api-key'),wx=store.setting('model')||{};
  for(const channel of channels){
   this.direct[channel]=new DeepSeekAPI(store,{channel,request});
   if(!store.setting('deepseek-api-'+channel)){store.setting('deepseek-api-'+channel,{model:old.model,effort:old.effort,useForQQ:false,useForWeixin:false,revision:1});if(oldKey&&old[channel==='qq'?'useForQQ':'useForWeixin'])store.secret('deepseek-api-key-'+channel,oldKey);}
   if(!store.setting(this.settingKey(channel))){store.setting(this.settingKey(channel),{source:old[channel==='qq'?'useForQQ':'useForWeixin']?'deepseek':channel==='qq'?'dsh':wx.provider||'dsh',revision:1,dsh:this.dsh(channel),openai:{baseUrl:channel==='weixin'&&wx.provider==='openai'?wx.baseUrl||'':'',model:channel==='weixin'&&wx.provider==='openai'?wx.model||'':''}});if(channel==='weixin'&&store.secret('model-api-key'))store.secret('compatible-model-key-weixin',store.secret('model-api-key'));}
   this.compatible[channel]=new CompatibleAPI(this,channel,{request});
   const manager=this;
   this.adapters[channel]={uses:id=>id===channel&&manager.source(channel)!=='dsh',config:()=>{const c=manager.read(channel);return {...(c.source==='openai'?c.openai:c.deepseek),source:c.source,revision:manager.revision(channel)};},health:force=>manager.client(channel).health(force),turn:options=>manager.client(channel).turn(options),generate:prompt=>manager.client(channel).generate(prompt),get checked(){return manager.client(channel).checked;},set checked(v){manager.client(channel).checked=v;}};
  }
 }
 validate(channel){if(!channels.includes(channel))fail('请选择 QQ 或微信',404);return channel;}
 settingKey(channel){return 'channel-model-'+this.validate(channel);}
 source(channel){return this.store.setting(this.settingKey(channel)).source;}
 dsh(channel){const saved=channel==='weixin'?this.store.setting(this.settingKey(channel))?.dsh:null;if(saved)return saved;const c=channel==='qq'?this.qqStore.settings().model:this.store.setting('model');return {baseUrl:c.baseUrl||'',providerId:c.providerId||c.provider||'',model:c.model||'',reasoningEffort:c.reasoningEffort||''};}
 read(channel){const c=this.store.setting(this.settingKey(channel)),d=this.direct[channel].config();return {channel,source:c.source,revision:c.revision,dsh:this.dsh(channel),deepseek:{model:d.model,effort:d.effort,hasKey:d.hasKey},openai:{...c.openai,hasKey:!!this.store.secret('compatible-model-key-'+channel)}};}
 summary(channel){const c=this.read(channel);return {source:c.source,model:c[c.source].model,hasKey:c.source==='dsh'?false:c[c.source].hasKey,revision:c.revision};}
 revision(channel){const c=this.read(channel);return JSON.stringify([c.revision,c.source,c.source==='dsh'?c.dsh:c.source==='deepseek'?this.direct[channel].config().revision:c.openai]);}
 client(channel){const source=this.source(channel);if(source==='dsh')throw Error('本平台当前使用 DSH');return source==='deepseek'?this.direct[channel]:this.compatible[channel];}
 adapter(channel){return this.adapters[this.validate(channel)];}
 save(channel,input){
  const prior=this.read(channel);if(input.revision!==prior.revision)fail('这个平台的模型设置已在其它窗口更改，请刷新后重试',409);
  if(!['dsh','deepseek','openai'].includes(input.source))fail('请选择模型来源');
  const next={...this.store.setting(this.settingKey(channel)),source:input.source,revision:prior.revision+1};
  if(input.source==='deepseek'){
   const data=input.deepseek||{},current=this.direct[channel].config();let key=this.store.secret('deepseek-api-key-'+channel)||'';if(data.clearKey===true)key='';if(data.apiKey)key=apiKey(data.apiKey);if(!key&&!data.clearKey)fail('请填写这个平台的 DeepSeek API Key');if(!DEEPSEEK_MODELS.includes(data.model))fail('请选择 DeepSeek 官方模型');if(!['none','low','high'].includes(data.effort))fail('思考等级无效');
   this.direct[channel].save({revision:current.revision,model:data.model,effort:data.effort,apiKey:data.apiKey,clearKey:data.clearKey});
  }
  if(input.source==='openai'){
   const data=input.openai||{},baseUrl=apiBase(modelText(data.baseUrl,500)),model=modelText(data.model);if(!model)fail('请填写模型 ID');const secret='compatible-model-key-'+channel;let key=this.store.secret(secret)||'';if(baseUrl!==prior.openai.baseUrl&&key&&!data.apiKey&&!data.clearKey)fail('更换接口地址时请重新填写这个平台的 Key');if(data.clearKey===true)key='';if(data.apiKey)key=apiKey(data.apiKey);if(!key&&!data.clearKey)fail('请填写这个平台的兼容 API Key');
   next.openai={baseUrl,model};this.store.secret(secret,key);if(channel==='weixin'){this.store.secret('model-api-key',key);this.store.setting('model',{provider:'openai',baseUrl,providerId:'',model,temperature:.4});}
  }
  if(input.source==='dsh'){
   const data=input.dsh||{},baseUrl=modelText(data.baseUrl||'',500);if(baseUrl){let u;try{u=new URL(baseUrl);}catch{fail('DSH 本机地址无效');}if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')fail('DSH 仅支持本机 HTTP 地址');}
   const providerId=modelText(data.providerId,100),model=modelText(data.model);if(!providerId||!model)fail('请填写 DSH 提供方和模型');const effort=data.reasoningEffort||'';if(!['','low','medium','high','xhigh'].includes(effort))fail('DSH 思考等级无效');
   next.dsh={baseUrl,providerId,model,reasoningEffort:effort};if(channel==='qq'){const settings=this.qqStore.settings();this.qqStore.saveSettings({...settings,model:{baseUrl,provider:providerId,model,reasoningEffort:effort}});}else this.store.setting('model',{provider:'dsh',baseUrl,providerId,model,reasoningEffort:effort,temperature:.4});
  }
  this.store.setting(this.settingKey(channel),next);this.compatible[channel].apiVerified=false;this.direct[channel].checked=null;return this.read(channel);
 }
 // Internal compatibility for the former common API object. Public writes to
 // that retired interface are rejected, so stale windows cannot change both.
 importLegacyDirect(config,input){for(const channel of channels){const flag=channel==='qq'?'useForQQ':'useForWeixin';if(input[flag]===undefined)continue;const row=this.store.setting(this.settingKey(channel));const key=this.store.secret('deepseek-api-key');if(key&&config[flag])this.store.secret('deepseek-api-key-'+channel,key);else if(input.clearKey)this.store.secret('deepseek-api-key-'+channel,null);const d=this.direct[channel].config();this.store.setting('deepseek-api-'+channel,{...d,hasKey:undefined,model:config.model,effort:config.effort,revision:d.revision+1});this.store.setting(this.settingKey(channel),{...row,source:config[flag]?'deepseek':channel==='qq'?'dsh':this.store.setting('model')?.provider||'dsh',revision:row.revision+1});}}
}

class CompatibleAPI extends DeepSeekAPI{
 constructor(manager,channel,options){super(manager.store,options);this.manager=manager;this.target=channel;this.apiVerified=false;}
 config(){const c=this.manager.read(this.target);return {...c.openai,effort:'none',revision:this.manager.revision(this.target)};}
 payload(c,messages,definitions){return {model:c.model,messages,stream:false,max_tokens:8192,...(definitions?{tools:definitions,tool_choice:'auto'}:{temperature:.4})};}
 async call(route,{body,signal}={}){if(route!=='chat/completions')throw Error('兼容 API 仅提供聊天接口');const c=this.config(),key=this.store.secret('compatible-model-key-'+this.target);if(!key)throw Error('尚未填写本平台的兼容 API Key');const r=await this.request(apiBase(c.baseUrl)+'/chat/completions',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});if(!r.ok){this.apiVerified=false;throw Error('兼容 API 返回 HTTP '+r.status);}const data=await r.json();if(this.manager.revision(this.target)===c.revision)this.apiVerified=!!data.choices?.[0]?.message;return data;}
 async health(){const c=this.config(),configured=!!(c.hasKey&&c.baseUrl&&c.model);return {ready:configured&&this.apiVerified,configured,provider:'兼容 API',model:c.model,note:this.apiVerified?'最近一次模型调用已成功':'请保存配置后测试本平台的实际回复'};}
}
