// Persist only sessions created by Banyu. Never enumerate arbitrary DSH sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import yaml from 'js-yaml';

// The credential stays in memory and only its fingerprint is stored. A DSH
// restart can change its loopback port without changing the local profile.
// The caller must still establish that the endpoint authenticates using this
// profile; a copied profile is not cryptographic proof of one storage instance.
export function dshServiceIdentity({directory=process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),instanceId=''}={}){
 try{
  if(typeof instanceId!=='string'||instanceId.length>256)return null;
  const real=fs.realpathSync(directory),location=process.platform==='win32'?real.toLowerCase():real;
  const record=yaml.load(fs.readFileSync(path.join(real,'.credentials.yaml'),'utf8'))?.records?.['client-connection/browser-session'];
  if(record?.kind!=='grant'||record.payload?.version!==1||typeof record.payload.secret!=='string'||!/^[A-Za-z0-9_-]+$/.test(record.payload.secret))return null;
  const key=Buffer.from(record.payload.secret,'base64url');if(key.length!==32)return null;
  return createHash('sha256').update('banyu-dsh-session-owner-v1\0').update(location).update('\0').update(instanceId).update('\0').update(key).digest('hex');
 }catch{return null;}
}

const validChannel=channel=>channel==='qq'||channel==='weixin';
const validIdentity=identity=>typeof identity==='string'&&/^[a-f0-9]{64}$/.test(identity);
const validSession=id=>typeof id==='string'&&id.length>0&&id.length<=256&&!/[\x00-\x1f\x7f]/.test(id);
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error?.code!=='ESRCH';}}
function checked({channel,identity,sessionId}){if(!validChannel(channel)||identity!=null&&!validIdentity(identity)||!validSession(sessionId))throw Error('DSH 会话登记信息无效');return identity||'';}
function checkedCwd(value){if(value==null||value==='')return '';if(typeof value!=='string'||value.length>32768||!path.isAbsolute(value)||value.includes('\0'))throw Error('DSH 会话工作区路径无效');return path.resolve(value);}
const delay=attempt=>Math.min(3600000,30000*2**Math.min(Math.max(0,attempt-1),7));

export class DshSessionCleanup{
 constructor(dataDir,{now=Date.now,isProcessAlive=alive,ownerPid=process.pid,runId=randomUUID(),requestTimeoutMs=8000}={}){
  if(!Number.isInteger(ownerPid)||ownerPid<1||typeof runId!=='string'||!runId||runId.length>100||!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1)throw Error('DSH 会话清理配置无效');
  fs.mkdirSync(dataDir,{recursive:true});this.db=new DatabaseSync(path.join(dataDir,'dsh-session-cleanup.sqlite'));this.now=now;this.isProcessAlive=isProcessAlive;this.ownerPid=ownerPid;this.runId=runId;this.requestTimeoutMs=requestTimeoutMs;this.draining=null;this.closed=false;this.shutdown=new AbortController();this.closeTask=null;
  this.db.exec(`PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS dsh_sessions(id INTEGER PRIMARY KEY,channel TEXT NOT NULL,identity TEXT NOT NULL,session_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','pending','cancel_pending')),owner_pid INTEGER NOT NULL,run_id TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,expected_cwd TEXT NOT NULL DEFAULT '',UNIQUE(identity,session_id));
   CREATE INDEX IF NOT EXISTS dsh_sessions_retry ON dsh_sessions(identity,state,next_attempt,id);`);
  if(!this.db.prepare('PRAGMA table_info(dsh_sessions)').all().some(c=>c.name==='expected_cwd'))this.db.exec("ALTER TABLE dsh_sessions ADD COLUMN expected_cwd TEXT NOT NULL DEFAULT ''");
 }
 ensureOpen(){if(this.closed)throw Error('DSH 会话清理已关闭');}
 register(input){
  this.ensureOpen();const identity=checked(input),expectedCwd=checkedCwd(input.expectedCwd),{channel,sessionId}=input;
  const previous=this.db.prepare('SELECT channel,state,owner_pid,run_id,expected_cwd FROM dsh_sessions WHERE identity=? AND session_id=?').get(identity,sessionId);
  if(previous){if(previous.channel!==channel||previous.state!=='active'||previous.owner_pid!==this.ownerPid||previous.run_id!==this.runId||previous.expected_cwd!==expectedCwd)throw Error('这个 DSH 会话已被登记');return false;}
  this.db.prepare("INSERT INTO dsh_sessions(channel,identity,session_id,state,owner_pid,run_id,created_at,expected_cwd) VALUES(?,?,?,'active',?,?,?,?)").run(channel,identity,sessionId,this.ownerPid,this.runId,this.now(),expectedCwd);return true;
 }
 has(input){
  this.ensureOpen();const identity=checked(input),{channel,sessionId}=input;
  if(Object.hasOwn(input,'expectedCwd')){const cwd=checkedCwd(input.expectedCwd);if(!cwd)return false;return !!this.db.prepare('SELECT 1 FROM dsh_sessions WHERE channel=? AND identity=? AND session_id=? AND expected_cwd=?').get(channel,identity,sessionId,cwd);}
  return !!this.db.prepare('SELECT 1 FROM dsh_sessions WHERE channel=? AND identity=? AND session_id=?').get(channel,identity,sessionId);
 }
 finish(input,{cancelRequired=false}={}){
  this.ensureOpen();const identity=checked(input),{channel,sessionId}=input;
  if(typeof cancelRequired!=='boolean')throw Error('DSH 取消状态无效');
  return this.db.prepare("UPDATE dsh_sessions SET state=?,next_attempt=0 WHERE channel=? AND identity=? AND session_id=? AND state='active' AND owner_pid=? AND run_id=?").run(cancelRequired?'cancel_pending':'pending',channel,identity,sessionId,this.ownerPid,this.runId).changes>0;
 }
 confirmArchived(input,confirmed){
  this.ensureOpen();const identity=checked(input),{channel,sessionId}=input;if(confirmed!==true)throw Error('DSH 尚未确认归档成功');
  return this.db.prepare("DELETE FROM dsh_sessions WHERE channel=? AND identity=? AND session_id=? AND state IN ('active','pending') AND owner_pid=? AND run_id=?").run(channel,identity,sessionId,this.ownerPid,this.runId).changes>0;
 }
 stats(){this.ensureOpen();const rows=this.db.prepare('SELECT state,COUNT(*) AS count FROM dsh_sessions GROUP BY state').all(),unbound=this.db.prepare("SELECT COUNT(*) AS count FROM dsh_sessions WHERE identity='' OR expected_cwd=''").get();return {active:Number(rows.find(r=>r.state==='active')?.count||0),pending:Number(rows.find(r=>r.state==='pending')?.count||0),cancelPending:Number(rows.find(r=>r.state==='cancel_pending')?.count||0),unbound:Number(unbound.count)};}
 listUnbound(limit=100){this.ensureOpen();if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('DSH 会话数量无效');return this.db.prepare("SELECT id,channel,session_id AS sessionId,state,created_at AS createdAt FROM dsh_sessions WHERE identity='' OR expected_cwd='' ORDER BY id LIMIT ?").all(limit);}
 async invoke(callback,context){
  const signal=AbortSignal.any([AbortSignal.timeout(this.requestTimeoutMs),this.shutdown.signal]);let abort;
  const expired=new Promise((_,reject)=>{abort=()=>reject(Error('DSH 清理已取消或超时'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  try{const confirmed=await Promise.race([Promise.resolve().then(()=>callback({...context,signal})),expired]);if(confirmed!==true)throw Error('DSH 未确认操作完成');}
  finally{signal.removeEventListener('abort',abort);}
 }
 async retry({identity,channel,verify,cancel,archive,limit=3}={}){
  this.ensureOpen();if(identity!=null&&!validIdentity(identity)||channel!==undefined&&!validChannel(channel)||verify!==undefined&&typeof verify!=='function'||typeof archive!=='function'||cancel!==undefined&&typeof cancel!=='function'||!Number.isInteger(limit)||limit<1||limit>20)throw Error('DSH 清理请求无效');
  if(identity==null)return {unavailable:true,busy:false,attempted:0,completed:0,failed:0};
  if(this.draining)return {busy:true,attempted:0,completed:0,failed:0};
  const task=(async()=>{
   const now=this.now(),rows=this.db.prepare('SELECT * FROM dsh_sessions WHERE identity=? AND next_attempt<=? ORDER BY id').all(identity,now),result={busy:false,attempted:0,completed:0,failed:0};
   for(const row of rows){
    if(this.closed||result.attempted>=limit)break;if(channel&&row.channel!==channel)continue;
    if(row.state==='active'){
     if(row.owner_pid===this.ownerPid&&row.run_id===this.runId)continue;
     let ownerStillAlive=true;try{ownerStillAlive=this.isProcessAlive(row.owner_pid)!==false;}catch{}
     if(ownerStillAlive||!cancel)continue;
    }
    if(row.state==='cancel_pending'&&!cancel)continue;
    result.attempted++;const attempt=row.attempts+1;
    this.db.prepare('UPDATE dsh_sessions SET attempts=?,next_attempt=? WHERE id=?').run(attempt,this.now()+delay(attempt),row.id);
    try{
     if(!row.expected_cwd||!verify)throw Error('DSH 工作区无法核对');
     const context={sessionId:row.session_id,channel:row.channel,expectedCwd:row.expected_cwd};await this.invoke(verify,context);
     if(row.state==='active'||row.state==='cancel_pending'){await this.invoke(cancel,context);this.db.prepare("UPDATE dsh_sessions SET state='pending' WHERE id=?").run(row.id);}
     await this.invoke(archive,context);
     this.db.prepare('DELETE FROM dsh_sessions WHERE id=? AND identity=? AND session_id=?').run(row.id,identity,row.session_id);result.completed++;
    }catch{result.failed++;} // Includes not-found: the matching DSH store may be offline.
   }
   return result;
  })();this.draining=task;
  try{return await task;}finally{if(this.draining===task)this.draining=null;}
 }
 async close(){if(this.closeTask)return this.closeTask;this.closed=true;this.shutdown.abort();this.closeTask=(async()=>{if(this.draining)await this.draining;this.db.close();})();return this.closeTask;}
}
