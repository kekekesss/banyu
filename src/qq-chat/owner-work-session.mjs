// MIT. Durable, single-owner DSH work session; all state changes are CAS.
// This module never executes or resends a tool operation.
import path from 'node:path';
import {createHash} from 'node:crypto';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const scopeId=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const number=value=>Number.isSafeInteger(value)&&value>=0;
const canonical=value=>{
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'&&Number.isFinite(value))return value;
 if(Array.isArray(value))return value.map(canonical);
 if(value&&Object.getPrototypeOf(value)===Object.prototype){const out={};for(const k of Object.keys(value).sort())out[k]=canonical(value[k]);return out;}
 throw Error('会话身份字段无效');
};
const normalizeCwd=value=>{if(typeof value!=='string'||!path.isAbsolute(value))throw Error('DSH 工作目录无效');const normalized=path.resolve(value);return process.platform==='win32'?normalized.toLowerCase():normalized;};

/** Include every authority which changes what this session may do. Scope is a
 * one-way digest, not credentials; model/policy objects may not contain functions.
 */
export function ownerWorkScope({serviceIdentity,account,owner,roleId,roleRevision,model,memoryEpoch=null,permissions,cwd}){
 if(!scopeId(serviceIdentity)||!/^\d{5,12}$/.test(account)||!/^\d{5,12}$/.test(owner)||account===owner||!id(roleId)||!number(roleRevision)||!model||!permissions)throw Error('主人会话身份不完整');
 const tuple=canonical({version:1,serviceIdentity,account,owner,roleId,roleRevision,model,memoryEpoch,permissions,cwd:normalizeCwd(cwd)});
 return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

export class OwnerWorkSession{
 constructor(store,{scopeNow,ownerNow,accountNow,isIdle,now=Date.now}={}){
  if(!store?.db||typeof scopeNow!=='function'||typeof ownerNow!=='function'||typeof accountNow!=='function'||typeof isIdle!=='function')throw Error('主人会话存储缺少安全回调');
  this.db=store.db;this.scopeNow=scopeNow;this.ownerNow=ownerNow;this.accountNow=accountNow;this.isIdle=isIdle;this.now=now;
  this.db.exec(`CREATE TABLE IF NOT EXISTS owner_work_session (
   slot INTEGER PRIMARY KEY CHECK(slot=1),scope TEXT NOT NULL,session_id TEXT NOT NULL,
   generation INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('idle','running','uncertain')),
   turn_id TEXT,pending_excerpt TEXT,updated_at INTEGER NOT NULL,completed_count INTEGER NOT NULL DEFAULT 0,turn_through INTEGER NOT NULL DEFAULT 0,recovery_mode INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS owner_work_previous(id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,session_id TEXT NOT NULL,generation INTEGER NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL,pending_excerpt TEXT,retirement TEXT NOT NULL DEFAULT 'manual');`);
  if(!this.db.prepare('PRAGMA table_info(owner_work_session)').all().some(x=>x.name==='completed_count'))this.db.exec('ALTER TABLE owner_work_session ADD COLUMN completed_count INTEGER NOT NULL DEFAULT 0');
  if(!this.db.prepare('PRAGMA table_info(owner_work_session)').all().some(x=>x.name==='turn_through'))this.db.exec('ALTER TABLE owner_work_session ADD COLUMN turn_through INTEGER NOT NULL DEFAULT 0');
  if(!this.db.prepare('PRAGMA table_info(owner_work_session)').all().some(x=>x.name==='recovery_mode'))this.db.exec('ALTER TABLE owner_work_session ADD COLUMN recovery_mode INTEGER NOT NULL DEFAULT 0');
  if(!this.db.prepare('PRAGMA table_info(owner_work_previous)').all().some(x=>x.name==='pending_excerpt'))this.db.exec('ALTER TABLE owner_work_previous ADD COLUMN pending_excerpt TEXT');
  if(!this.db.prepare('PRAGMA table_info(owner_work_previous)').all().some(x=>x.name==='retirement'))this.db.exec("ALTER TABLE owner_work_previous ADD COLUMN retirement TEXT NOT NULL DEFAULT 'manual'");
 }
 row(){return this.db.prepare('SELECT scope,session_id AS sessionId,generation,status,turn_id AS turnId,pending_excerpt AS pendingExcerpt,updated_at AS updatedAt,completed_count AS completedCount,turn_through AS turnThrough,recovery_mode AS recoveryMode FROM owner_work_session WHERE slot=1').get()||null;}
 state(){const row=this.row();return row?{...row,pendingExcerpt:row.pendingExcerpt===null?null:JSON.parse(row.pendingExcerpt)}:null;}
 matches(scope){return scopeId(scope)&&this.scopeNow()===scope;}
 transact(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 /** Initial bind only. A different scope cannot replace an existing mapping. */
 install(scope,sessionId){
  if(!scopeId(scope)||!id(sessionId))throw Error('主人会话身份无效');
  return this.transact(()=>{if(!this.matches(scope)||this.isIdle()!==true||this.row())return false;return this.db.prepare("INSERT OR IGNORE INTO owner_work_session(slot,scope,session_id,generation,status,turn_id,pending_excerpt,updated_at,completed_count) VALUES(1,?,?,1,'idle',NULL,NULL,?,0)").run(scope,sessionId,this.now()).changes===1;});
 }
 /** Commit only after candidate creation, checking the authoritative QQ message
  * watermark in the same SQLite transaction. No await may occur inside it. */
 rotate(scope,{expected,sourceVersion,newSessionId,excerpt,chatKey}){
  if(!scopeId(scope)||!expected||!id(expected.sessionId)||!number(expected.generation)||!number(sourceVersion)||!id(newSessionId)||expected.sessionId===newSessionId||typeof chatKey!=='string'||!/^private:\d{5,12}$/.test(chatKey))throw Error('交接参数无效');
  const encoded=JSON.stringify(excerpt);if(!encoded||encoded.length>30000)throw Error('交接摘录无效');
  return this.transact(()=>{
   if(!this.matches(scope)||chatKey!=='private:'+this.ownerNow()||this.isIdle()!==true)return false;
   const current=this.row();if(!current||current.scope!==scope||current.sessionId!==expected.sessionId||current.generation!==expected.generation||current.status!=='idle'||current.pendingExcerpt!==null)return false;
   const row=this.db.prepare('SELECT doc FROM chats WHERE key=?').get(chatKey);let chat;try{chat=row?JSON.parse(row.doc):null}catch{return false;}
   if(!chat||Number(chat.latestSeq||0)!==sourceVersion||Number(chat.readThrough||0)<Number(chat.latestSeq||0))return false;
   this.db.prepare("INSERT INTO owner_work_previous(scope,session_id,generation,reason,at,retirement) VALUES(?,?,?,?,?,'pending')").run(scope,expected.sessionId,expected.generation,'handoff',this.now());
   return this.db.prepare("UPDATE owner_work_session SET session_id=?,generation=generation+1,pending_excerpt=?,completed_count=0,updated_at=? WHERE slot=1 AND scope=? AND session_id=? AND generation=? AND status='idle' AND pending_excerpt IS NULL").run(newSessionId,encoded,this.now(),scope,expected.sessionId,expected.generation).changes===1;
  });
 }
 pendingRetirements(scope){if(!scopeId(scope))return [];return this.db.prepare("SELECT id,session_id AS sessionId FROM owner_work_previous WHERE scope=? AND retirement='pending' ORDER BY id LIMIT 20").all(scope);}
 pendingRetirementCount(){return Number(this.db.prepare("SELECT COUNT(*) AS n FROM owner_work_previous WHERE retirement='pending'").get().n);}
 queuedRetirement(scope,previousId){if(!scopeId(scope)||!number(previousId))return false;return this.db.prepare("UPDATE owner_work_previous SET retirement='queued' WHERE id=? AND scope=? AND retirement='pending'").run(previousId,scope).changes===1;}
 /** Identity/persona/model changed: record the old mapping locally, but never
  * access or archive the old DSH session under a new identity. */
 replaceScope(scope,{expected,newSessionId,sourceVersion,chatKey}){
  if(!scopeId(scope)||!expected||!scopeId(expected.scope)||!id(expected.sessionId)||!number(expected.generation)||!number(sourceVersion)||!id(newSessionId)||newSessionId===expected.sessionId||typeof chatKey!=='string')throw Error('更换会话参数无效');
  return this.transact(()=>{
   if(!this.matches(scope)||chatKey!=='private:'+this.ownerNow()||this.isIdle()!==true)return false;
   const row=this.row(),chatRow=this.db.prepare('SELECT doc FROM chats WHERE key=?').get(chatKey);let chat;try{chat=chatRow?JSON.parse(chatRow.doc):null}catch{return false;}
   if(!row||row.scope!==expected.scope||row.sessionId!==expected.sessionId||row.generation!==expected.generation||row.status!=='idle'||!chat||Number(chat.latestSeq||0)!==sourceVersion)return false;
   this.db.prepare('INSERT INTO owner_work_previous(scope,session_id,generation,reason,at,pending_excerpt) VALUES(?,?,?,?,?,?)').run(row.scope,row.sessionId,row.generation,'scope-changed',this.now(),row.pendingExcerpt);
   return this.db.prepare("UPDATE owner_work_session SET scope=?,session_id=?,generation=generation+1,pending_excerpt=NULL,completed_count=0,updated_at=? WHERE slot=1 AND scope=? AND session_id=? AND generation=? AND status='idle'").run(scope,newSessionId,this.now(),row.scope,row.sessionId,row.generation).changes===1;
  });
 }
 begin(scope,{sessionId,generation,turnId,chatKey,reason,sender,through=0}){
  if(!scopeId(scope)||!id(sessionId)||!number(generation)||!id(turnId)||!number(through))throw Error('回合参数无效');
  return this.transact(()=>{const owner=this.ownerNow();if(!this.matches(scope)||!/^\d{5,12}$/.test(owner)||chatKey!=='private:'+owner||sender!==owner||reason!=='message'||this.isIdle()!==true)return false;return this.db.prepare("UPDATE owner_work_session SET status='running',turn_id=?,turn_through=?,updated_at=? WHERE slot=1 AND scope=? AND session_id=? AND generation=? AND status='idle'").run(turnId,through,this.now(),scope,sessionId,generation).changes===1;});
 }
 /** Before exposing additional incoming messages to a running model, persist
  * their watermark so crash recovery cannot later replay those messages. */
 checkpoint(scope,{sessionId,generation,turnId,through}){
  if(!scopeId(scope)||!id(sessionId)||!number(generation)||!id(turnId)||!number(through))return false;
  return this.db.prepare("UPDATE owner_work_session SET turn_through=MAX(turn_through,?),updated_at=? WHERE slot=1 AND scope=? AND session_id=? AND generation=? AND status='running' AND turn_id=?").run(through,this.now(),scope,sessionId,generation,turnId).changes===1;
 }
 /** completed means the DSH turn/end was actually observed; not-started means
  * prompt was definitively never accepted. Any ambiguous result is uncertain. */
 finish(scope,{sessionId,generation,turnId,outcome}){
  if(!scopeId(scope)||!id(sessionId)||!number(generation)||!id(turnId)||!['completed','not-started','uncertain'].includes(outcome))throw Error('回合结果无效');
  const status=outcome==='uncertain'?'uncertain':'idle';
  return this.db.prepare("UPDATE owner_work_session SET status=?,turn_id=NULL,pending_excerpt=CASE WHEN ?='completed' THEN NULL ELSE pending_excerpt END,recovery_mode=CASE WHEN ?='completed' THEN 0 ELSE recovery_mode END,completed_count=completed_count+CASE WHEN ?='completed' THEN 1 ELSE 0 END,updated_at=? WHERE slot=1 AND scope=? AND session_id=? AND generation=? AND status='running' AND turn_id=?").run(status,outcome,outcome,outcome,this.now(),scope,sessionId,generation,turnId).changes===1;
 }
 /** Called once after the app has acquired its single-instance lock. A process
  * crash cannot prove a prior tool failed; leave it uncertain and block replay. */
 markInterrupted(){return this.db.prepare("UPDATE owner_work_session SET status='uncertain',turn_id=NULL,updated_at=? WHERE slot=1 AND status='running'").run(this.now()).changes===1;}
 /** After manual review, resume in a fresh session only. Keeping the old DSH
  * transcript active could cause it to replay a partly executed operation. */
 reconcileAndReplace(scope,{sessionId,generation,newSessionId,confirmedIdle,chatKey}){
  if(!scopeId(scope)||!id(sessionId)||!id(newSessionId)||sessionId===newSessionId||!number(generation)||confirmedIdle!==true)return false;
  return this.transact(()=>{const owner=this.ownerNow(),account=this.accountNow();if(!this.matches(scope)||!/^\d{5,12}$/.test(owner)||!/^\d{5,12}$/.test(account)||owner===account||chatKey!=='private:'+owner||this.isIdle()!==true)return false;const row=this.row();if(!row||row.scope!==scope||row.sessionId!==sessionId||row.generation!==generation||row.status!=='uncertain')return false;
   const record=this.db.prepare('SELECT doc FROM chats WHERE key=?').get(chatKey);if(!record)return false;let chat;try{chat=JSON.parse(record.doc)}catch{return false;}
   if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_tool_journal'").get()){
    const running=this.db.prepare("SELECT COUNT(*) AS n FROM owner_tool_journal WHERE scope=? AND account=? AND owner=? AND session_id=? AND status='running' AND reviewed_at IS NULL").get(scope,account,owner,sessionId).n;if(running)return false;
    this.db.prepare("UPDATE owner_tool_journal SET reviewed_at=? WHERE scope=? AND account=? AND owner=? AND session_id=? AND status='uncertain' AND reviewed_at IS NULL").run(this.now(),scope,account,owner,sessionId);
   }
   chat.readThrough=Math.max(Number(chat.readThrough)||0,Number(row.turnThrough)||0);this.db.prepare('UPDATE chats SET doc=? WHERE key=?').run(JSON.stringify(chat),chatKey);
   this.db.prepare('INSERT INTO owner_work_previous(scope,session_id,generation,reason,at,pending_excerpt) VALUES(?,?,?,?,?,?)').run(scope,sessionId,generation,'uncertain-recovery',this.now(),row.pendingExcerpt);
   return this.db.prepare("UPDATE owner_work_session SET session_id=?,generation=generation+1,status='idle',turn_id=NULL,pending_excerpt=NULL,completed_count=0,recovery_mode=1,updated_at=? WHERE slot=1 AND scope=? AND session_id=? AND generation=? AND status='uncertain'").run(newSessionId,this.now(),scope,sessionId,generation).changes===1;});
 }
 /** Read-only recovery. probe must check the exact DSH session, ownership/cwd,
  * active work, queues and approvals. A missing/offline session is never replaced. */
 async recover(scope,{cwd,probe}={}){
  if(!scopeId(scope)||typeof probe!=='function')throw Error('恢复参数无效');
  const expectedCwd=normalizeCwd(cwd),state=this.state();if(!state)return {status:'missing-mapping'};
  if(state.scope!==scope||!this.matches(scope))return {status:'scope-changed'};
  if(state.status==='running'||state.status==='uncertain')return {status:'needs-review'};
  try{
   const observed=await probe(state.sessionId);
   if(!this.matches(scope))return {status:'scope-changed'};
   const current=this.row();if(!current||current.scope!==scope||current.sessionId!==state.sessionId||current.generation!==state.generation||current.status!=='idle')return {status:'changed'};
   if(!observed||observed.found!==true)return {status:'not-found'};
   if(observed.owned!==true||normalizeCwd(observed.cwd)!==expectedCwd)return {status:'ownership-unverified'};
   if(observed.running!==false||observed.pending!==false)return {status:'busy-or-unverified'};
   return {status:'ready',state};
  }catch{return {status:'unavailable'};}
 }
}
