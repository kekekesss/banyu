// Owner-only, one-shot approval boundary for computer tools. No authorization
// decision is delegated to the model or inferred from a tool's description.
import {randomBytes} from 'node:crypto';
import {validateComputerTarget,sameComputerTarget} from './computer-target.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const number = n => Number.isInteger(n) && n >= -32768 && n <= 32767;
const safeText = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u.test(s);
const visibleJSON = value => JSON.stringify(value).replace(/[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu, c=>'\\u{'+c.codePointAt(0).toString(16)+'}');

export function validateComputerAction(value, {defaultCwd}={}) {
 if (!plain(value)) throw Error('电脑操作格式无效');
 // Default only omitted directories; explicit invalid values still fail.
 if (value.kind==='command' && !Object.hasOwn(value,'cwd') && safeText(defaultCwd,500)) value={...value,cwd:defaultCwd};
 const keys = Object.keys(value).sort().join(',');
 if (value.kind === 'command' && keys === 'command,cwd,kind' && safeText(value.command, 1000) && safeText(value.cwd, 500))
  return Object.freeze({kind:'command', command:value.command, cwd:value.cwd});
 if (value.kind === 'screenshot' && keys === 'kind') return Object.freeze({kind:'screenshot'});
 if (['click','double_click'].includes(value.kind) && keys === 'button,kind,x,y' && number(value.x) && number(value.y) && ['left','right'].includes(value.button))
  return Object.freeze({kind:value.kind, x:value.x, y:value.y, button:value.button});
 if(value.kind==='scroll'&&keys==='direction,kind,steps'&&['up','down'].includes(value.direction)&&Number.isInteger(value.steps)&&value.steps>=1&&value.steps<=10)return Object.freeze({kind:'scroll',direction:value.direction,steps:value.steps});
 if(value.kind==='hotkey'&&keys==='key,kind'&&['CTRL+A','CTRL+L','CTRL+C','CTRL+V','CTRL+S','ALT+TAB'].includes(value.key))return Object.freeze({kind:'hotkey',key:value.key});
 if (value.kind === 'type' && keys === 'kind,text' && safeText(value.text, 500) && !/[\r\n\t]/u.test(value.text))
  return Object.freeze({kind:'type', text:value.text});
 if (value.kind === 'key' && keys === 'key,kind' && ['ENTER','TAB','ESC','BACKSPACE','DELETE','UP','DOWN','LEFT','RIGHT'].includes(value.key))
  return Object.freeze({kind:'key', key:value.key});
 throw Error('电脑操作内容无效或超出支持范围');
}

export class ComputerApproval {
 constructor({checkAccess, requestApproval, execute, prepare, confirmationRequired=()=>true, now=Date.now, timeoutMs=90000, codeFactory=()=>randomBytes(12).toString('hex')}={}) {
  if (![checkAccess,requestApproval,execute].every(x=>typeof x==='function')) throw Error('电脑操作审批未配置');
  this.checkAccess=checkAccess; this.requestApproval=requestApproval; this.execute=execute; this.prepare=prepare; this.now=now;this.confirmationRequired=confirmationRequired;
  this.timeoutMs=Math.min(120000,Math.max(1000,timeoutMs)); this.codeFactory=codeFactory; this.current=null;
 }
 async request({turn,action,expectedTarget}) {
  // Claim the lock before awaiting anything so two simultaneous tools cannot
  // share a confirmation or change what a confirmation refers to.
  if (this.current) throw Error('已有电脑操作等待确认或正在执行');
  const fixed=validateComputerAction(action), code=this.codeFactory();
  if (!/^[a-f0-9]{24}$/.test(code)) throw Error('无法创建电脑操作确认码');
  const pending={turn,action:fixed,code,status:'checking',expires:this.now()+this.timeoutMs,settle:null};
  this.current=pending;
  let timer, abort;
  try {
   if (!turn || turn.abort?.signal?.aborted || !await this.checkAccess(turn)) throw Error('只有已验证的主人 QQ 私聊可以操作电脑');
   let target;
   if(fixed.kind!=='command'){
    if(typeof this.prepare!=='function')throw Error('电脑窗口校验未配置，操作未执行');
    target=validateComputerTarget(await this.prepare(fixed,{signal:turn.abort.signal}));
    if(expectedTarget&&!sameComputerTarget(expectedTarget,target))throw Error('截图后的目标窗口已改变，请重新截图；本次未执行');
    if(turn.abort.signal.aborted||!await this.checkAccess(turn))throw Error('会话或授权状态已改变，电脑操作未执行');
   }
   if(this.confirmationRequired(turn)===false){
    if(turn.abort.signal.aborted||!await this.checkAccess(turn))throw Error('会话或授权状态已改变，电脑操作未执行');
    pending.status='executing';return await this.execute(fixed,{signal:turn.abort.signal,target,turn});
   }
   pending.expires=this.now()+this.timeoutMs;
   pending.issuedAt=Math.floor(this.now()/1000)*1000;pending.delivered=false;
   const answer=new Promise(resolve=>{pending.settle=resolve;});
   const settle=ok=>{if(pending.status!=='waiting')return false; pending.status=ok?'approved':'rejected'; pending.settle(ok); return true;};
   pending.status='waiting';
   timer=setTimeout(()=>settle(false),this.timeoutMs); timer.unref?.();
   abort=()=>settle(false); turn.abort.signal.addEventListener('abort',abort,{once:true});
   if (turn.abort.signal.aborted) settle(false);
   // JSON quoting preserves the complete payload and makes line breaks and
   // control characters visible; no command text is evaluated here.
   const scope=fixed.kind==='command'?'本次确认授权整条命令及其启动的子进程。中断后子进程仍可能运行，结果需人工核查。':fixed.kind==='screenshot'?'本次将截取桌面，发送给当前模型查看，并将图片发回主人 QQ。':'本次授权下列窗口的一个动作，以及操作后桌面截图发送给当前模型核对；执行前窗口或屏幕变化会拒绝。';
   const prompt=`电脑操作请求\n${scope}\n${visibleJSON(target?{action:fixed,target}:fixed)}\n核对后直接回复“确认”执行，回复“拒绝”取消。${Math.ceil(this.timeoutMs/1000)} 秒内有效，仅适用于当前这一个请求。`;
   if (await this.requestApproval({turn,code,action:fixed,target,prompt,expiresAt:pending.expires}) !== true) { settle(false); throw Error('确认请求未可靠送达，电脑操作未执行'); }
   pending.delivered=true;
   if (!await answer) throw Error('电脑操作未获确认或确认已过期');
   if (turn.abort.signal.aborted || this.now() >= pending.expires || !await this.checkAccess(turn)) throw Error('会话或授权状态已改变，电脑操作未执行');
   if (turn.abort.signal.aborted || this.now() >= pending.expires || this.current!==pending || pending.status!=='approved') throw Error('会话或授权状态已改变，电脑操作未执行');
   pending.status='executing';
   return await this.execute(fixed,{signal:turn.abort.signal,target,turn});
  } finally {
   clearTimeout(timer); if(abort)turn?.abort?.signal?.removeEventListener('abort',abort);
   if(this.current===pending)this.current=null;
  }
 }
 cancel(turn){const p=this.current;if(!p||p.turn!==turn)return false;if(p.status==='waiting'){p.status='rejected';p.settle(false);}else if(p.status==='executing')turn.abort.abort();return true;}
 async answer({event,settings,selfId}) {
  const p=this.current;
  if (!p || p.status!=='waiting' || !p.delivered || this.now()>=p.expires || !event || !settings) return false;
  // Only a genuine incoming private message from the configured owner to the
  // configured bot account can authorize the exact pending action.
  if (event.kind!=='private' || event.id!==String(settings.owner) || event.sender!==String(settings.owner) || String(selfId)!==String(settings.account) || p.turn.key!=='private:'+String(settings.owner)) return false;
  const match=/^(确认|拒绝)(?: ([a-f0-9]{24}))?$/.exec(String(event.body||'').trim());
  if (!match || match[2]&&match[2]!==p.code || Number.isFinite(event.at)&&event.at<p.issuedAt) return false;
  if (!await this.checkAccess(p.turn) || this.current!==p || p.status!=='waiting' || this.now()>=p.expires) return false;
  p.status=match[1]==='确认'?'approved':'rejected'; p.settle(match[1]==='确认');
  return true;
 }
}
