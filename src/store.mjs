import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const platforms = ['qq','weixin'];
export function fail(message,status=400){throw Object.assign(new Error(message),{status});}
export function text(v,max=1000){if(typeof v!=='string')fail('请填写文字内容');if(v.length>max)fail(`内容不能超过 ${max} 字符`);return v.trim();}
export function name(v){const s=text(v,60);if(!s)fail('名称不能为空');return s;}
const now=()=>new Date().toISOString();

export class Store{
 constructor(dir){
  this.dir=dir;fs.mkdirSync(dir,{recursive:true});this.db=new DatabaseSync(path.join(dir,'workspace.sqlite'));
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS entities(kind TEXT,id TEXT,doc TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS bindings(channel_id TEXT,kind TEXT,external_id TEXT,zone_id TEXT NOT NULL,PRIMARY KEY(channel_id,kind,external_id));
   CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,channel_id TEXT,kind TEXT,external_id TEXT,name TEXT,zone_id TEXT,context TEXT NOT NULL DEFAULT '{}',human INTEGER NOT NULL DEFAULT 0,last_at TEXT,UNIQUE(channel_id,kind,external_id));
   CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT,direction TEXT,body TEXT,status TEXT,created_at TEXT);
   CREATE TABLE IF NOT EXISTS receipts(channel_id TEXT,message_id TEXT,created_at TEXT,PRIMARY KEY(channel_id,message_id));
   CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,conversation_id TEXT,reason TEXT,status TEXT,created_at TEXT);
   CREATE UNIQUE INDEX IF NOT EXISTS one_open_ticket ON tickets(conversation_id) WHERE status='open';
   CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,level TEXT,message TEXT,created_at TEXT);
   CREATE TABLE IF NOT EXISTS counters(zone_id TEXT,day TEXT,amount INTEGER NOT NULL,PRIMARY KEY(zone_id,day));
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,doc TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id,id);`);
  if(!this.db.prepare('PRAGMA table_info(conversations)').all().some(x=>x.name==='history_start'))this.db.exec('ALTER TABLE conversations ADD COLUMN history_start INTEGER NOT NULL DEFAULT 0');
  this.secretsFile=path.join(dir,'secrets.json');this.secrets=fs.existsSync(this.secretsFile)?JSON.parse(fs.readFileSync(this.secretsFile,'utf8')):{};
  if(!this.list('roles').length)this.seed();
 }
 seed(){
  for(const r of [
   {id:'role-service',name:'温柔客服',tag:'客户服务',color:'blue',prompt:'你是耐心、清晰的中文客服。先直接回答问题，少用套话。不确定就说明需要人工确认，不编造价格、库存、订单结果，也不擅自承诺退款。'},
   {id:'role-tech',name:'技术答疑',tag:'技术支持',color:'violet',prompt:'你是中文技术支持。先根据已有资料定位问题，再给出简短、可操作的步骤。资料不足时提出一个关键问题或转人工，不假装执行了操作。'},
   {id:'role-whale',name:'鲸鱼娘',tag:'日常陪伴',color:'green',prompt:'你自称鲸鱼娘或本鲸，说中文。聪明却慵懒，嘴上傲娇、内心温柔，喜欢米饭。保持自然、简短的对话，不编造自己执行了现实中的操作。'},
  ])this.put('roles',r.id,{...r,createdAt:now()});
  for(const z of [
   {id:'zone-service',name:'客户咨询',description:'解答常见问题，遇到复杂情况交给人工。',roleId:'role-service',color:'blue',type:'service'},
   {id:'zone-tech',name:'产品答疑',description:'为产品与使用问题提供清晰的操作指引。',roleId:'role-tech',color:'violet',type:'service'},
   {id:'zone-whale',name:'鲸鲸陪伴',description:'把日常闲聊与客服业务分开。',roleId:'role-whale',color:'green',type:'companion'},
  ])this.put('zones',z.id,{...z,enabled:true,trigger:'mention',keywords:[],instructions:'',fallback:'这个问题需要人工进一步确认，我先帮你记录下来。',cooldownSeconds:5,dailyLimit:300,createdAt:now()});
  this.put('channels','qq',{id:'qq',platform:'qq',name:'QQ 官方机器人',autoConnect:false});
  this.put('channels','weixin',{id:'weixin',platform:'weixin',name:'微信私聊',autoConnect:false});
  this.setting('model',{provider:'dsh',baseUrl:'',providerId:'workbuddy-ai',model:'deepseek-v4.1-flash',temperature:.4});
 }
 list(kind){return this.db.prepare('SELECT doc FROM entities WHERE kind=? ORDER BY updated_at DESC').all(kind).map(x=>JSON.parse(x.doc));}
 get(kind,id){const row=this.db.prepare('SELECT doc FROM entities WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(row.doc):null;}
 put(kind,id,doc){const value={...doc,id,updatedAt:now()};this.db.prepare('INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET doc=excluded.doc,updated_at=excluded.updated_at').run(kind,id,JSON.stringify(value),value.updatedAt);return value;}
 remove(kind,id){this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind,id);}
 setting(key,value){if(value!==undefined){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET doc=excluded.doc').run(key,JSON.stringify(value));return value;}const r=this.db.prepare('SELECT doc FROM settings WHERE key=?').get(key);return r?JSON.parse(r.doc):null;}
 secret(key,value){if(value!==undefined){if(value===null)delete this.secrets[key];else this.secrets[key]=value;const tmp=this.secretsFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.secrets,null,2),{mode:0o600});fs.renameSync(tmp,this.secretsFile);}return this.secrets[key]??null;}
 log(level,message){const clean=String(message).replace(/(Bearer|token|secret|api[_-]?key)[=: ]+[^\s,;]+/gi,'$1=[hidden]').slice(0,500);this.db.prepare('INSERT INTO logs(level,message,created_at) VALUES(?,?,?)').run(level,clean,now());this.db.prepare('DELETE FROM logs WHERE id < (SELECT COALESCE(MAX(id),0)-2000 FROM logs)').run();}
 logs(limit=80){return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(Math.min(limit,200));}
 bindings(zoneId){return this.db.prepare('SELECT channel_id AS channelId,kind,external_id AS externalId,zone_id AS zoneId FROM bindings'+(zoneId?' WHERE zone_id=?':'')).all(...(zoneId?[zoneId]:[]));}
 route(channelId,kind,externalId){return this.db.prepare('SELECT zone_id FROM bindings WHERE channel_id=? AND kind=? AND external_id=?').get(channelId,kind,externalId)?.zone_id??null;}
 bind(zoneId,binding){
  if(!this.get('zones',zoneId)||this.get('zones',zoneId).archived)fail('分区不存在');
  const channel=this.get('channels',binding.channelId);if(!channel)fail('接入端不存在');
  if(!['group','private'].includes(binding.kind))fail('请选择群聊或私聊');
  if(channel.platform==='weixin'&&binding.kind!=='private')fail('当前微信接入只支持私聊，不能绑定普通微信群');
  const externalId=text(binding.externalId,256);if(!externalId)fail('请填写会话标识，或从待分配会话选择');
  if(channel.platform==='qq'&&/^\d{5,12}$/.test(externalId))fail('官方机器人需要会话 OpenID，不能直接填写 QQ 号或群号。请先发消息，再从待分配会话绑定。');
  const old=this.route(binding.channelId,binding.kind,externalId);if(old&&old!==zoneId)fail('这个会话已绑定其它分区，请先解除原绑定',409);
  this.db.prepare('INSERT OR IGNORE INTO bindings VALUES(?,?,?,?)').run(binding.channelId,binding.kind,externalId,zoneId);
  if(old!==zoneId)this.db.prepare('UPDATE conversations SET zone_id=?,history_start=(SELECT COALESCE(MAX(id),0)+1 FROM messages) WHERE channel_id=? AND kind=? AND external_id=?').run(zoneId,binding.channelId,binding.kind,externalId);
 }
 unbind(zoneId,b){this.db.prepare('DELETE FROM bindings WHERE zone_id=? AND channel_id=? AND kind=? AND external_id=?').run(zoneId,b.channelId,b.kind,b.externalId);this.db.prepare('UPDATE conversations SET zone_id=NULL,history_start=(SELECT COALESCE(MAX(id),0)+1 FROM messages) WHERE zone_id=? AND channel_id=? AND kind=? AND external_id=?').run(zoneId,b.channelId,b.kind,b.externalId);}
 receipt(channelId,messageId){return this.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?)').run(channelId,messageId,now()).changes>0;}
 conversation(event){
  let c=this.db.prepare('SELECT * FROM conversations WHERE channel_id=? AND kind=? AND external_id=?').get(event.channelId,event.kind,event.conversationId);
  const zoneId=this.route(event.channelId,event.kind,event.conversationId);const id=c?.id||randomUUID();
  if(!c)this.db.prepare('INSERT INTO conversations(id,channel_id,kind,external_id,name,zone_id,context,last_at) VALUES(?,?,?,?,?,?,?,?)').run(id,event.channelId,event.kind,event.conversationId,String(event.name||event.conversationId).slice(0,100),zoneId,JSON.stringify(event.context||{}),now());
  else this.db.prepare('UPDATE conversations SET context=?,last_at=?,zone_id=?,name=? WHERE id=?').run(JSON.stringify(event.context||{}),now(),zoneId,String(event.name||c.name).slice(0,100),id);
  return this.rawConversation(id);
 }
 rawConversation(id){return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id)||null;}
 conversations(){return this.db.prepare(`SELECT c.id,c.channel_id AS channelId,c.kind,c.external_id AS externalId,c.name,c.zone_id AS zoneId,c.human,c.last_at AS lastAt,(SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) AS preview FROM conversations c ORDER BY last_at DESC LIMIT 250`).all();}
 messages(id,limit=40){return this.db.prepare('SELECT id,direction,body,status,created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?').all(id,limit).reverse();}
 message(id,direction,body,status='received'){const r=this.db.prepare('INSERT INTO messages(conversation_id,direction,body,status,created_at) VALUES(?,?,?,?,?)').run(id,direction,body,status,now());return Number(r.lastInsertRowid);}
 messageState(id,status){this.db.prepare('UPDATE messages SET status=? WHERE id=?').run(status,id);}
 handoff(id,reason){const existing=this.db.prepare("SELECT id FROM tickets WHERE conversation_id=? AND status='open'").get(id);this.db.prepare('UPDATE conversations SET human=1 WHERE id=?').run(id);if(!existing)this.db.prepare('INSERT INTO tickets VALUES(?,?,?,?,?)').run(randomUUID(),id,reason.slice(0,300),'open',now());return !existing;}
 resume(id){this.db.prepare('UPDATE conversations SET human=0 WHERE id=?').run(id);this.db.prepare("UPDATE tickets SET status='closed' WHERE conversation_id=? AND status='open'").run(id);}
 tickets(){return this.db.prepare("SELECT t.id,t.conversation_id AS conversationId,t.reason,t.created_at AS createdAt,c.name,c.zone_id AS zoneId,c.channel_id AS channelId FROM tickets t JOIN conversations c ON c.id=t.conversation_id WHERE t.status='open' ORDER BY t.created_at DESC").all();}
 usage(zoneId){const day=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});return this.db.prepare('SELECT amount FROM counters WHERE zone_id=? AND day=?').get(zoneId,day)?.amount||0;}
 increment(zoneId){const day=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});this.db.prepare('INSERT INTO counters VALUES(?,?,1) ON CONFLICT(zone_id,day) DO UPDATE SET amount=amount+1').run(zoneId,day);}
 stats(){return {zones:this.list('zones').filter(x=>!x.archived).length,roles:this.list('roles').length,knowledge:this.list('knowledge').length,conversations:this.db.prepare('SELECT count(*) AS n FROM conversations').get().n,tickets:this.tickets().length,repliesToday:this.db.prepare("SELECT count(*) AS n FROM messages WHERE direction='out' AND status='sent' AND date(created_at,'+8 hours')=?").get(new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})).n};}
 close(){this.db.close();}
}

export function validateRole(body,previous={}){return {...previous,name:name(body.name),prompt:text(body.prompt,16000),tag:text(body.tag||'自定义角色',30),color:['blue','green','violet','amber'].includes(body.color)?body.color:'blue'};}
export function validateZone(body,store,previous={}){
 const role=store.get('roles',body.roleId);if(!role)fail('请选择已有角色');
 if(!['service','companion'].includes(body.type))fail('请选择客服或陪伴分区');
 if(!['mention','all','keywords'].includes(body.trigger))fail('回复触发方式无效');
 const limit=Number(body.dailyLimit),cooldown=Number(body.cooldownSeconds);if(!Number.isInteger(limit)||limit<1||limit>10000||!Number.isInteger(cooldown)||cooldown<0||cooldown>600)fail('回复上限需为 1–10000，冷却时间需为 0–600 秒');
 return {...previous,name:name(body.name),description:text(body.description||'',500),roleId:role.id,type:body.type,enabled:body.enabled===true,color:['blue','green','violet','amber'].includes(body.color)?body.color:'blue',instructions:text(body.instructions||'',10000),fallback:text(body.fallback||'这个问题需要人工进一步确认。',1000),trigger:body.trigger,keywords:Array.isArray(body.keywords)?body.keywords.map(x=>text(x,80)).filter(Boolean).slice(0,30):[],dailyLimit:limit,cooldownSeconds:cooldown};
}
