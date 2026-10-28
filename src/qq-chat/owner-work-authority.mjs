// Bind the authority of a managed owner session without storing credentials.
// This module never contacts DSH itself: callers supply the exact verified host
// probe and candidate creation callbacks. No old session is modified or removed.
import path from 'node:path';

const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const number=v=>typeof v==='string'&&/^\d{5,12}$/.test(v);
const session=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
const norm=v=>{if(typeof v!=='string'||!path.isAbsolute(v))throw Error('主人会话工作目录无效');const p=path.resolve(v);return process.platform==='win32'?p.toLowerCase():p;};
function authority(value){
 if(!value||!digest(value.serviceIdentity)||!digest(value.permissionDigest)||!number(value.owner)||!number(value.account)||value.owner===value.account)throw Error('DSH 身份、QQ 账号或权限尚未准备好');
 return {serviceIdentity:value.serviceIdentity,permissionDigest:value.permissionDigest,account:value.account,owner:value.owner,cwd:norm(value.cwd)};
}
const same=(a,b)=>a.serviceIdentity===b.serviceIdentity&&a.permissionDigest===b.permissionDigest&&a.owner===b.owner&&a.account===b.account&&a.cwd===b.cwd;
function validateProbe(observed,expected){
 if(!observed||observed.found!==true||observed.owned!==true||observed.running!==false||observed.pending!==false)throw Error('原 DSH 会话仍在运行、存在待处理事项或无法安全核验');
 if(norm(observed.cwd)!==expected.cwd)throw Error('原 DSH 会话工作目录不匹配');
}

export class OwnerWorkAuthority{
 constructor(store,{scopeNow,authorityNow,isIdle,now=Date.now}={}){
  if(!store?.db||![scopeNow,authorityNow,isIdle].every(f=>typeof f==='function'))throw Error('主人会话权限绑定未配置');
  Object.assign(this,{db:store.db,scopeNow,authorityNow,isIdle,now});this.running=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS owner_work_authority(
   session_id TEXT NOT NULL,generation INTEGER NOT NULL,scope TEXT NOT NULL,
   service_identity TEXT NOT NULL,account TEXT NOT NULL,owner TEXT NOT NULL,
   permission_digest TEXT NOT NULL,cwd TEXT NOT NULL,created_at INTEGER NOT NULL,
   PRIMARY KEY(session_id,generation));`);
 }
 transact(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 row(){return this.db.prepare('SELECT scope,session_id AS sessionId,generation,status,turn_through AS turnThrough,pending_excerpt AS pendingExcerpt FROM owner_work_session WHERE slot=1').get()||null;}
 binding(row){const b=this.db.prepare('SELECT scope,service_identity AS serviceIdentity,account,owner,permission_digest AS permissionDigest,cwd FROM owner_work_authority WHERE session_id=? AND generation=?').get(row.sessionId,row.generation);return b?{...b,cwd:norm(b.cwd)}:null;}
 /** Bind only a currently idle, already verified managed session BEFORE its
  * next turn. An old uncertain row may never be backfilled or guessed. */
 bind(scope,{sessionId,generation,observed}){
  if(!digest(scope)||!session(sessionId)||!Number.isSafeInteger(generation)||generation<1)throw Error('主人会话绑定参数无效');
  const before=authority(this.authorityNow());validateProbe(observed,before);
  return this.transact(()=>{
   const current=this.row(),now=authority(this.authorityNow());
   if(!same(before,now)||this.scopeNow()!==scope||this.isIdle()!==true||!current||current.scope!==scope||current.sessionId!==sessionId||current.generation!==generation||current.status!=='idle')throw Error('会话身份或状态已改变，无法绑定');
   const prior=this.binding(current);if(prior){if(prior.scope!==scope||!same(prior,now))throw Error('已有会话身份绑定不匹配');return false;}
   this.db.prepare('INSERT INTO owner_work_authority VALUES(?,?,?,?,?,?,?,?,?)').run(sessionId,generation,scope,now.serviceIdentity,now.account,now.owner,now.permissionDigest,now.cwd,this.now());return true;
  });
 }
 /** Explicit review only. Candidate creation/probing occur outside the SQLite
  * transaction; final comparisons and QQ watermark advancement are atomic. */
 async recoverChangedScope({acknowledged,probe,createCandidate,discardCandidate}={}){
  if(acknowledged!==true)throw Error('请先人工核查上次电脑操作结果');
  if(typeof probe!=='function'||typeof createCandidate!=='function')throw Error('DSH 会话恢复接口未配置');
  if(this.running)throw Error('已有主人会话恢复正在进行');this.running=true;
  let candidate,committed=false,initial,scope,old;
  try{
   if(this.isIdle()!==true)throw Error('当前仍有聊天或电脑操作，暂不能恢复');
   initial=authority(this.authorityNow());scope=this.scopeNow();if(!digest(scope))throw Error('当前主人会话身份尚未准备好');
   old=this.row();if(!old||old.status!=='uncertain')throw Error('当前没有需要核查的不确定回合');
   if(old.scope===scope)throw Error('设置未变，请使用原会话的人工核查恢复');
   const bound=this.binding(old);if(!bound||bound.scope!==old.scope)throw Error('旧会话缺少身份绑定，无法安全自动恢复；请在 DSH 手动核查旧会话');
   if(!same(bound,initial))throw Error('DSH 身份、QQ 账号或访问权限已变化，不能自动恢复旧会话');
   validateProbe(await probe(old.sessionId),initial);
   if(this.scopeNow()!==scope||!same(initial,authority(this.authorityNow()))||this.isIdle()!==true)throw Error('核查期间身份或会话状态已改变');
   candidate=await createCandidate();if(!session(candidate)||candidate===old.sessionId)throw Error('新 DSH 会话尚未准备好');
   validateProbe(await probe(old.sessionId),initial);
   this.transact(()=>{
    const current=this.row(),fresh=authority(this.authorityNow());
    if(!same(initial,fresh)||this.scopeNow()!==scope||this.isIdle()!==true||!current||current.scope!==old.scope||current.sessionId!==old.sessionId||current.generation!==old.generation||current.status!=='uncertain'||current.turnThrough!==old.turnThrough)throw Error('恢复期间会话或身份已改变');
    const binding=this.binding(current);if(!binding||binding.scope!==old.scope||!same(binding,fresh))throw Error('旧会话身份绑定已改变');
    // Review only records belonging to the previously bound identity. A
    // review does not assert success or change an uncertain outcome. An
    // absent journal is expected for installations predating this feature.
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_tool_journal'").get()){
     if(this.db.prepare("SELECT 1 FROM owner_tool_journal WHERE scope=? AND account=? AND owner=? AND status='running' LIMIT 1").get(current.scope,fresh.account,fresh.owner))throw Error('旧会话仍有执行中的电脑操作，不能恢复');
     const reviewedAt=this.now();if(!Number.isSafeInteger(reviewedAt)||reviewedAt<0)throw Error('人工核查时间无效');
     this.db.prepare("UPDATE owner_tool_journal SET reviewed_at=? WHERE scope=? AND account=? AND owner=? AND status='uncertain' AND reviewed_at IS NULL").run(reviewedAt,current.scope,fresh.account,fresh.owner);
    }
    const key='private:'+fresh.owner,record=this.db.prepare('SELECT doc FROM chats WHERE key=?').get(key);if(!record)throw Error('主人 QQ 会话记录不存在');
    let chat;try{chat=JSON.parse(record.doc);}catch{throw Error('主人 QQ 会话记录无法读取');}
    if(!Number.isSafeInteger(current.turnThrough)||current.turnThrough<0||current.turnThrough>Number(chat.latestSeq||0))throw Error('旧会话消息水位无法核验');
    chat.readThrough=Math.max(Number(chat.readThrough)||0,current.turnThrough);
    this.db.prepare('UPDATE chats SET doc=? WHERE key=?').run(JSON.stringify(chat),key);
    this.db.prepare('INSERT INTO owner_work_previous(scope,session_id,generation,reason,at,pending_excerpt) VALUES(?,?,?,?,?,?)').run(current.scope,current.sessionId,current.generation,'uncertain-scope-recovery',this.now(),current.pendingExcerpt);
    const updated=this.db.prepare("UPDATE owner_work_session SET scope=?,session_id=?,generation=generation+1,status='idle',turn_id=NULL,pending_excerpt=NULL,completed_count=0,recovery_mode=1,updated_at=? WHERE slot=1 AND scope=? AND session_id=? AND generation=? AND status='uncertain' AND turn_through=?").run(scope,candidate,this.now(),current.scope,current.sessionId,current.generation,current.turnThrough);
    if(updated.changes!==1)throw Error('旧会话状态已改变');
    this.db.prepare('INSERT INTO owner_work_authority VALUES(?,?,?,?,?,?,?,?,?)').run(candidate,current.generation+1,scope,fresh.serviceIdentity,fresh.account,fresh.owner,fresh.permissionDigest,fresh.cwd,this.now());
   });committed=true;return {status:'idle',sessionId:candidate,previousSessionPreserved:true};
  }finally{
   if(session(candidate)&&candidate!==old?.sessionId&&!committed&&typeof discardCandidate==='function')try{if(this.scopeNow()===scope&&same(initial,authority(this.authorityNow())))await discardCandidate(candidate);}catch{}
   this.running=false;
  }
 }
}
