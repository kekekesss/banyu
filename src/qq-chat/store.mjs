// MIT. Original Banyu QQ state and delivery journal.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
export const qqNumber=value=>typeof value==='string'&&/^\d{5,12}$/.test(value);
export const defaults=()=>({owner:'',account:'',enabled:true,computerEnabled:false,computerRequireConfirmation:true,paused:false,mode:'reserved2',roleId:'whale',privateAllow:[],groupAllow:[],privateDeny:[],groupDeny:[],groupTrigger:'mention',keywords:[],mergeMs:900,replyLimit:2200,memoryMessages:60,memoryChars:22000,imageEnabled:true,emojiEnabled:true,searchEnabled:true,proactive:{enabled:false,minMs:1800000,maxMs:5400000,idleMs:900000,probability:.3},quietFrom:'',quietTo:'',model:{baseUrl:'',provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'}});
const stamp=()=>Date.now();
export class QQStore{
 constructor(dir){
  this.dir=dir;fs.mkdirSync(dir,{recursive:true});this.db=new DatabaseSync(path.join(dir,'chat.sqlite'));
  this.db.exec(`PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1),doc TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY,name TEXT NOT NULL,prompt TEXT NOT NULL,revision INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS chats(key TEXT PRIMARY KEY,doc TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,chat TEXT NOT NULL,direction TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,meta TEXT NOT NULL,at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS message_chat ON messages(chat,seq);
   CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,chat TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,result TEXT,at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS glossary(term TEXT PRIMARY KEY,meaning TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,level TEXT NOT NULL,message TEXT NOT NULL,at INTEGER NOT NULL);`);
  if(!this.db.prepare('SELECT 1 FROM config WHERE id=1').get())this.saveSettings(defaults());
  if(!this.roles().length)this.saveRole({id:'whale',name:'鲸鱼娘',prompt:'你自称鲸鱼娘或本鲸，用简体中文自然交流。聪明、慵懒、嘴硬心软，喜欢米饭。不要编造过去发生的事或假装执行了现实中的操作。'});
  this.db.prepare("UPDATE deliveries SET status='uncertain' WHERE status='sending'").run();
  this.db.prepare("UPDATE messages SET status='uncertain' WHERE status='sending'").run();
 }
 settings(){return JSON.parse(this.db.prepare('SELECT doc FROM config WHERE id=1').get().doc);}
 saveSettings(value){this.db.prepare('INSERT INTO config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc').run(JSON.stringify(value));return value;}
 roles(){return this.db.prepare('SELECT id,name,prompt,revision FROM roles ORDER BY name').all();}
 role(id){return this.db.prepare('SELECT id,name,prompt,revision FROM roles WHERE id=?').get(id)||null;}
 deleteRole(id,revision){
  const role=this.role(id);if(!role)throw Object.assign(Error('角色不存在'),{status:404});
  if(id===this.settings().roleId)throw Object.assign(Error('这个角色正在使用，请先切换到另一个角色'),{status:409});
  if(this.roles().length<=1)throw Object.assign(Error('至少保留一个角色'),{status:409});
  if(revision!==undefined&&revision!==role.revision)throw Object.assign(Error('角色已在其它页面修改，请刷新后再删除'),{status:409});
  this.db.prepare('DELETE FROM roles WHERE id=?').run(id);return {ok:true};
 }
 saveRole({id=randomUUID(),name,prompt,revision}){
  if(typeof name!=='string'||!name.trim()||name.length>60||typeof prompt!=='string'||prompt.length>16000)throw Error('角色名称或人设内容无效');
  const previous=this.role(id);if(previous&&revision!==undefined&&revision!==previous.revision)throw Object.assign(Error('人设已被其它页面修改，请刷新后再保存'),{status:409});
  this.db.prepare('INSERT INTO roles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,prompt=excluded.prompt,revision=excluded.revision').run(id,name.trim(),prompt,(previous?.revision||0)+1);return this.role(id);
 }
 chat(key){const row=this.db.prepare('SELECT doc FROM chats WHERE key=?').get(key);return row?JSON.parse(row.doc):{key,sessionId:null,lastIncomingAt:0,lastReplyAt:0,readThrough:0,paused:false,wakeAt:0,processing:false};}
 saveChat(value){this.db.prepare('INSERT INTO chats VALUES(?,?) ON CONFLICT(key) DO UPDATE SET doc=excluded.doc').run(value.key,JSON.stringify(value));return value;}
 chats(){return this.db.prepare('SELECT doc FROM chats').all().map(r=>JSON.parse(r.doc));}
 receipt(id){const r=this.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?)').run(id,stamp());this.db.prepare('DELETE FROM receipts WHERE at<?').run(stamp()-7*86400000);return r.changes>0;}
 append(key,direction,body,{status='received',meta={},at=stamp()}={}){return Number(this.db.prepare('INSERT INTO messages(chat,direction,body,status,meta,at) VALUES(?,?,?,?,?,?)').run(key,direction,String(body).slice(0,30000),status,JSON.stringify(meta),at).lastInsertRowid);}
 messages(key,{limit=100,after=0}={}){return this.db.prepare('SELECT seq,direction,body,status,meta,at FROM messages WHERE chat=? AND seq>? ORDER BY seq DESC LIMIT ?').all(key,after,Math.min(1000,Math.max(1,limit))).reverse().map(m=>({...m,meta:JSON.parse(m.meta)}));}
 unreadMessages(key,{limit=100,after=0}={}){return this.db.prepare("SELECT seq,direction,body,status,meta,at FROM messages WHERE chat=? AND direction='in' AND seq>? ORDER BY seq ASC LIMIT ?").all(key,after,Math.min(1000,Math.max(1,limit))).map(m=>({...m,meta:JSON.parse(m.meta)}));}
 messageState(seq,status){this.db.prepare('UPDATE messages SET status=? WHERE seq=?').run(status,seq);}
 beginDelivery(id,key,body){return this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,?,'sending',NULL,?)").run(id,key,body,stamp()).changes>0;}
 delivery(id){return this.db.prepare('SELECT id,chat,status,result FROM deliveries WHERE id=?').get(id);}
 finishDelivery(id,status,result){this.db.prepare('UPDATE deliveries SET status=?,result=? WHERE id=?').run(status,JSON.stringify(result||{}),id);}
 log(level,message){this.db.prepare('INSERT INTO logs(level,message,at) VALUES(?,?,?)').run(level,String(message).replace(/(token|secret|Bearer)[=: ]+\S+/gi,'$1=[hidden]').slice(0,300),stamp());this.db.prepare('DELETE FROM logs WHERE id<(SELECT COALESCE(MAX(id),0)-1000 FROM logs)').run();}
 logs(){return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 80').all();}
 glossary(){return this.db.prepare('SELECT term,meaning FROM glossary ORDER BY term LIMIT 300').all();}
 saveTerm(term,meaning){if(typeof term!=='string'||!term.trim()||term.length>80||typeof meaning!=='string'||meaning.length>1000)throw Error('词条内容无效');this.db.prepare('INSERT INTO glossary VALUES(?,?) ON CONFLICT(term) DO UPDATE SET meaning=excluded.meaning').run(term.trim(),meaning.trim());}
 close(){this.db.close();}
}
export function validateSettings(input,prior){
 const c=structuredClone(prior),number=(name,min,max)=>{if(input[name]!==undefined){const v=Number(input[name]);if(!Number.isInteger(v)||v<min||v>max)throw Error('聊天参数超出允许范围');c[name]=v;}};
 for(const name of ['enabled','computerEnabled','computerRequireConfirmation','paused','imageEnabled','emojiEnabled','searchEnabled'])if(input[name]!==undefined){if(typeof input[name]!=='boolean')throw Error('开关参数无效');c[name]=input[name];}
 for(const name of ['privateAllow','groupAllow','privateDeny','groupDeny'])if(input[name]!==undefined){if(!Array.isArray(input[name])||input[name].length>500||!input[name].every(qqNumber))throw Error('白名单需填写有效 QQ 号或群号');c[name]=[...new Set(input[name])];}
 if(input.roleId!==undefined){if(typeof input.roleId!=='string')throw Error('请选择角色');c.roleId=input.roleId;}
 if(input.groupTrigger!==undefined){if(!['all','mention','keywords'].includes(input.groupTrigger))throw Error('群聊触发方式无效');c.groupTrigger=input.groupTrigger;}
 if(input.keywords!==undefined){if(!Array.isArray(input.keywords)||input.keywords.some(x=>typeof x!=='string'||x.length>60))throw Error('唤醒词无效');c.keywords=input.keywords.map(s=>s.trim()).filter(Boolean).slice(0,30);}
 number('mergeMs',0,10000);number('replyLimit',100,4000);number('memoryMessages',4,100);number('memoryChars',4000,50000);
 for(const field of ['quietFrom','quietTo'])if(input[field]!==undefined){if(typeof input[field]!=='string'||input[field]&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(input[field]))throw Error('免打扰时间格式无效');c[field]=input[field];}
 if(input.proactive!==undefined){const p=input.proactive;if(!p||typeof p.enabled!=='boolean')throw Error('主动聊天开关无效');const min=Number(p.minMs),max=Number(p.maxMs),idle=Number(p.idleMs),probability=Number(p.probability);if(![min,max,idle].every(Number.isInteger)||min<60000||max<min||max>86400000||idle<60000||idle>86400000||!Number.isFinite(probability)||probability<0||probability>1)throw Error('主动聊天间隔无效');c.proactive={enabled:p.enabled,minMs:min,maxMs:max,idleMs:idle,probability};}
 if(input.model!==undefined){const m=input.model;if(!m||typeof m.provider!=='string'||typeof m.model!=='string'||m.provider.length>100||m.model.length>150||!['low','medium','high','xhigh',''].includes(m.reasoningEffort||''))throw Error('QQ 模型参数无效');const baseUrl=String(m.baseUrl||'');if(baseUrl){let u;try{u=new URL(baseUrl)}catch{throw Error('DSH地址无效')}if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('DSH只允许本机地址');}c.model={baseUrl,provider:m.provider,model:m.model,reasoningEffort:m.reasoningEffort||''};}
 return c;
}
