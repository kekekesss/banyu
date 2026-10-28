// Durable, owner-scoped computer-action journal. Never stores approval codes or
// screenshots and never assumes that an interrupted action did not run.
import {randomUUID} from 'node:crypto';
import {validateComputerAction} from './computer-approval.mjs';
import {validateComputerTarget} from './computer-target.mjs';

const number=s=>typeof s==='string'&&/^\d{5,12}$/.test(s);
const identifier=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(s);
const scopeId=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const redact=s=>String(s).replace(/(确认|拒绝)\s+[a-f0-9]{24}/giu,'$1 [已隐藏]')
 .replace(/\b(Bearer\s+)[^\s"']+/gi,'$1[已隐藏]')
 .replace(/\b(api[_-]?key|secret|token|password|passwd)\s*([=:])\s*([^\s,"'}]+)/gi,'$1$2[已隐藏]');
function limit(value,max){const s=redact(value??'');return {text:s.slice(0,max),truncated:s.length>max};}
function actionRecord(value,target){
 const action=validateComputerAction(value),out={...action};
 if(out.command)out.command=redact(out.command);
 if(out.text)out.text=redact(out.text);
 if(action.kind!=='command'){const t=validateComputerTarget(target);out.target={screen:t.screen,window:{...t.window,title:redact(t.window.title)}};}
 return out;
}
function context(input){
 if(!input||!scopeId(input.scope)||!number(input.account)||!number(input.owner)||input.account===input.owner||!identifier(input.sessionId)||!identifier(input.turnId))throw Error('电脑操作日志的主人会话身份无效');
 return input;
}

export class OwnerToolJournal{
 constructor(store,{scopeNow,settingsNow,now=Date.now}={}){
  if(!store?.db||typeof scopeNow!=='function'||typeof settingsNow!=='function')throw Error('电脑操作日志缺少主人会话校验');
  this.db=store.db;this.scopeNow=scopeNow;this.settingsNow=settingsNow;this.now=now;
  this.db.exec(`CREATE TABLE IF NOT EXISTS owner_tool_journal(
   id TEXT PRIMARY KEY,scope TEXT NOT NULL,account TEXT NOT NULL,owner TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
   request TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('running','success','failure','uncertain')),
   result TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,reviewed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS owner_tool_journal_scope ON owner_tool_journal(scope,account,owner,started_at);`);
  if(!this.db.prepare('PRAGMA table_info(owner_tool_journal)').all().some(v=>v.name==='reviewed_at'))this.db.exec('ALTER TABLE owner_tool_journal ADD COLUMN reviewed_at INTEGER');
 }
 matches(c){const s=this.settingsNow();return scopeId(c?.scope)&&number(c?.account)&&number(c?.owner)&&c.account!==c.owner&&this.scopeNow()===c.scope&&s?.account===c.account&&s?.owner===c.owner;}
 /** Call after authorization and immediately before execution; a durable row is
  * mandatory. A crash after this write means the operation is uncertain. */
 begin(input){
  const c=context(input),request=JSON.stringify(actionRecord(c.action,c.target)),id=randomUUID(),at=this.now();
  if(!Number.isSafeInteger(at)||at<0)throw Error('电脑操作时间无效');
  this.db.exec('BEGIN IMMEDIATE');try{
   if(!this.matches(c)){this.db.exec('ROLLBACK');return null;}
   const active=this.db.prepare("SELECT 1 FROM owner_work_session WHERE slot=1 AND scope=? AND session_id=? AND turn_id=? AND status='running'").get(c.scope,c.sessionId,c.turnId);
   if(!active){this.db.exec('ROLLBACK');return null;}
   this.db.prepare("INSERT INTO owner_tool_journal(id,scope,account,owner,session_id,turn_id,request,status,result,started_at,finished_at,reviewed_at) VALUES(?,?,?,?,?,?,?,'running',NULL,?,NULL,NULL)").run(id,c.scope,c.account,c.owner,c.sessionId,c.turnId,request,at);
   this.db.exec('COMMIT');return id;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 /** success means the executor returned, not that a clicked application made
  * the intended change. An exception or ambiguous interruption is uncertain. */
 finish(input,{status,result}={}){
  const c=context(input);if(!identifier(input.id)||!['success','failure','uncertain'].includes(status))throw Error('电脑操作结果无效');
  if(!this.matches(c))status='uncertain';
  let detail;
  if(status==='success'){
   if(!result||!['command','screenshot','click','double_click','type','key','hotkey','scroll'].includes(result.kind)||result.kind==='command'&&result.exitCode!==0)throw Error('不能把未确认的结果记录为成功');
   const record=this.db.prepare("SELECT request FROM owner_tool_journal WHERE id=? AND scope=? AND account=? AND owner=? AND session_id=? AND turn_id=? AND status='running'").get(input.id,c.scope,c.account,c.owner,c.sessionId,c.turnId);
   if(!record)return false;
   if(JSON.parse(record.request).kind!==result.kind)throw Error('工具结果与已确认的操作不符');
   const output=limit(result.output,1000),stderr=limit(result.stderr,500);
   detail={kind:result.kind,summary:result.kind==='command'?'命令进程返回零退出码；子进程及实际效果需另行核实。':result.kind==='screenshot'?'截图已获取；内容未作为事实验证。':'系统调用返回；界面实际效果需另行核实。',output:output.text,stderr:stderr.text,outputTruncated:output.truncated||result.outputTruncated===true,stderrTruncated:stderr.truncated};
  }else if(status==='failure'){
   if(!result||result.completed!==true||!Number.isSafeInteger(result.exitCode)||result.exitCode===0)throw Error('缺少已完成的失败结果');
   const msg=limit(result.error,500);detail={summary:'操作报告失败，但可能已经产生部分效果。',exitCode:result.exitCode,error:msg.text,errorTruncated:msg.truncated};
  }else{const msg=limit(result?.error,500);detail={summary:'执行结果不确定，可能已产生效果或子进程仍在运行，禁止自动重试，需人工核查。',error:msg.text,errorTruncated:msg.truncated};}
  const now=this.now();if(!Number.isSafeInteger(now)||now<0)throw Error('电脑操作时间无效');
  return this.db.prepare("UPDATE owner_tool_journal SET status=?,result=?,finished_at=? WHERE id=? AND scope=? AND account=? AND owner=? AND session_id=? AND turn_id=? AND status='running'").run(status,JSON.stringify(detail),now,input.id,c.scope,c.account,c.owner,c.sessionId,c.turnId).changes===1;
 }
 /** Only call after the app has taken its single-instance lock. */
 markInterrupted(){const detail=JSON.stringify({summary:'程序中断，执行结果不确定，可能已产生效果或子进程仍在运行，禁止自动重试，需人工核查。'});return Number(this.db.prepare("UPDATE owner_tool_journal SET status='uncertain',result=?,finished_at=? WHERE status='running'").run(detail,this.now()).changes);}
 /** An unresolved operation must block handoff/reuse until the owner has
  * explicitly reviewed it. Acknowledgement never changes the outcome itself. */
 unresolved({scope,account,owner}={}){if(!this.matches({scope,account,owner}))throw Error('电脑操作日志范围无效');return Number(this.db.prepare("SELECT COUNT(*) AS n FROM owner_tool_journal WHERE scope=? AND account=? AND owner=? AND status IN ('running','uncertain') AND reviewed_at IS NULL").get(scope,account,owner).n);}
 /** Retrieve only explicitly matching owner/account/scope. No images or codes. */
 records({scope,account,owner,limit:count=40}={}){
  if(!scopeId(scope)||!number(account)||!number(owner)||account===owner||!Number.isInteger(count)||count<1||count>100||!this.matches({scope,account,owner}))throw Error('电脑操作日志范围无效');
  return this.db.prepare('SELECT id,request,status,result,started_at,finished_at FROM owner_tool_journal WHERE scope=? AND account=? AND owner=? ORDER BY started_at DESC,id DESC LIMIT ?').all(scope,account,owner,count).reverse().map(row=>{
   const request=JSON.parse(row.request),result=row.result?JSON.parse(row.result):{summary:'操作正在执行，结果尚未确认。'};
   // Keep the confirmed outcome ahead of the request within the bounded
   // handoff excerpt; the full redacted record remains in the local database.
   const clipped={...result};for(const [field,max] of [['output',250],['stderr',150],['error',150]])if(typeof clipped[field]==='string'&&clipped[field].length>max){clipped[field]=clipped[field].slice(0,max);clipped[field+'Truncated']=true;}
   const shortRequest={...request};for(const [field,max] of [['command',250],['text',150]])if(typeof shortRequest[field]==='string'&&shortRequest[field].length>max){shortRequest[field]=shortRequest[field].slice(0,max);shortRequest[field+'Truncated']=true;}
   if(shortRequest.target?.window){shortRequest.target={screen:shortRequest.target.screen,window:{...shortRequest.target.window,title:String(shortRequest.target.window.title).slice(0,80)}};}
   let text=JSON.stringify({result:clipped,request:shortRequest});
   if(text.length>1100)text=JSON.stringify({result:{summary:clipped.summary,output:String(clipped.output||'').slice(0,100),outputTruncated:true},request:{kind:request.kind,requestTruncated:true}});
   return {type:'tool-result',source:'qq-tool:'+row.id,status:row.status==='running'?'uncertain':row.status,time:new Date(row.finished_at||row.started_at).toISOString(),text};
  });
 }
}
