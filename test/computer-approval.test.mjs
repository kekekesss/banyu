import test from 'node:test';
import assert from 'node:assert/strict';
import {ComputerApproval,validateComputerAction} from '../src/qq-chat/computer-approval.mjs';
import {executeComputerAction} from '../src/qq-chat/computer-executor.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

const account='1990000002',owner='1990000001',code='abcdef0123456789abcdef01';
const settings={account,owner}, turn=()=>({key:'private:'+owner,abort:new AbortController()});
const event=(body,extra={})=>({kind:'private',id:owner,sender:owner,body,...extra});
const action={kind:'command',cwd:'D:\\gpt',command:'Write-Output "hello"'};
const target={screen:{x:0,y:0,width:1920,height:1080},window:{handle:'123456',pid:42,process:'notepad',title:'文档',started:'638982310000000000',left:0,top:0,right:900,bottom:700}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}) {
 let prompt,ran=0,authorized=true;
 const broker=new ComputerApproval({codeFactory:()=>code,checkAccess:async()=>authorized,requestApproval:async x=>{prompt=x;return true;},execute:async a=>{ran++;return {action:a};},...options});
 return {broker,get prompt(){return prompt;},get ran(){return ran;},set authorized(v){authorized=v;}};
}
test('exact owner confirmation approves a frozen, complete action once',async()=>{
 const f=fixture(),t=turn(),mutable={...action},request=f.broker.request({turn:t,action:mutable});await tick();
 mutable.command='different';assert.match(f.prompt.prompt,/Write-Output/);assert.match(f.prompt.prompt,/回复“确认”/);
 assert.equal(await f.broker.answer({event:event('确认 '+code,{kind:'group'}),settings,selfId:account}),false);
 assert.equal(await f.broker.answer({event:event('确认 '+code,{sender:'123456'}),settings,selfId:account}),false);
 assert.equal(await f.broker.answer({event:event('确认 '+code),settings,selfId:'123456'}),false);
 assert.equal(await f.broker.answer({event:event('确认 '+code.replace(/^a/,'b')),settings,selfId:account}),false);
 assert.equal(f.ran,0);assert.equal(await f.broker.answer({event:event('确认 '+code),settings,selfId:account}),true);
 assert.equal(await f.broker.answer({event:event('确认 '+code),settings,selfId:account}),false);
 assert.equal((await request).action.command,action.command);assert.equal(f.ran,1);
});
test('reject, disconnect, changed access and non-owner each fail closed',async()=>{
 for(const mode of ['reject','disconnect','changed','nonowner']){
  let checks=0;const f=fixture(mode==='changed'?{checkAccess:async()=>++checks<3}:{}),t=turn();if(mode==='nonowner')f.authorized=false;
  const request=f.broker.request({turn:t,action});const rejected=assert.rejects(request);await tick();
  if(mode==='reject')assert.equal(await f.broker.answer({event:event('拒绝 '+code),settings,selfId:account}),true);
  if(mode==='disconnect')t.abort.abort();
  if(mode==='changed')assert.equal(await f.broker.answer({event:event('确认 '+code),settings,selfId:account}),true);
  await rejected;assert.equal(f.ran,0);
 }
});
test('one global pending action; failure to deliver confirmation never executes',async()=>{
 const f=fixture(),t=turn(),request=f.broker.request({turn:t,action});await tick();
 await assert.rejects(f.broker.request({turn:turn(),action}),/已有电脑操作/);t.abort.abort();await assert.rejects(request);assert.equal(f.ran,0);
 const noDelivery=fixture({requestApproval:async()=>false});await assert.rejects(noDelivery.broker.request({turn:turn(),action}),/未可靠送达/);assert.equal(noDelivery.ran,0);
});
test('expired approvals and stale confirmation codes cannot authorize an action',async()=>{
 let now=100;const f=fixture({now:()=>now}),t=turn(),request=f.broker.request({turn:t,action});const rejected=assert.rejects(request);await tick();
 now+=90001;assert.equal(await f.broker.answer({event:event('确认 '+code),settings,selfId:account}),false);assert.equal(f.ran,0);t.abort.abort();await rejected;
});
test('malformed actions cannot hide extra parameters or spoof visual controls',()=>{
 for(const x of [{kind:'screenshot',command:'bad'},{kind:'click',x:1,y:2,button:'left',extra:true},{kind:'type',text:'ok\u202eabc'},{kind:'type',text:'\u061c'},{kind:'type',text:'\u{e0001}'},{kind:'command',command:'ok',cwd:'a\0b'},{kind:'key',key:'CTRL+A'}])assert.throws(()=>validateComputerAction(x));
 for(const x of [{kind:'screenshot'},{kind:'click',x:-42,y:19,button:'right'},{kind:'type',text:'你好'}, {kind:'key',key:'ENTER'}])assert.doesNotThrow(()=>validateComputerAction(x));
});
test('executor refuses unsupported OS before spawning',async()=>{let spawned=false;await assert.rejects(executeComputerAction({kind:'screenshot'},{target,captureTarget:async()=>target,platform:'linux',spawnProcess:()=>{spawned=true;}}),/Windows/);assert.equal(spawned,false);});
test('executor sends Unicode as literal encoded input using no shell',async()=>{
 let invocation;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 const result=executeComputerAction({kind:'type',text:"鲸鱼 +^%{} '文字'"},{target,captureTarget:async()=>target,platform:'win32',systemRoot:'C:\\Windows',spawnProcess:(exe,args,opts)=>{invocation={exe,args,opts};setImmediate(()=>{child.stdout.end();child.stderr.end();child.emit('close',0);});return child;}});
 assert.equal((await result).kind,'type');assert.equal(invocation.opts.shell,false);assert.equal(invocation.opts.windowsHide,true);
 const script=Buffer.from(invocation.args.at(-1),'base64').toString('utf16le');assert.match(script,/SendInput/);assert.match(script,/鲸鱼 \+\^%\{\} ''文字''/);assert.doesNotMatch(script,/SendKeys/);
});
test('desktop executor generates guarded double click, signed wheel and fixed hotkeys',async()=>{
 for(const [action,pattern] of [[{kind:'double_click',x:15,y:20,button:'left'},/\$i -lt 2/],[{kind:'scroll',direction:'down',steps:3},/\[uint32\]4294966936/],[{kind:'hotkey',key:'CTRL+A'},/SendWait\('\^a'\)/]]){
  let script;const result=await executeComputerAction(action,{target,captureTarget:async()=>target,platform:'win32',systemRoot:'C:\\Windows',spawnProcess:(exe,args,opts)=>{
   script=Buffer.from(args.at(-1),'base64').toString('utf16le');assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);
   const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
   setImmediate(()=>{child.stdout.end();child.stderr.end();child.emit('close',0);});return child;
  }});
  assert.equal(result.kind,action.kind);assert.match(script,pattern);assert.match(script,/Assert-BanyuTarget/);assert.match(script,/SetProcessDPIAware/);
 }
});

test('screenshot response retains virtual screen origin and valid PNG',async()=>{
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 const png=Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
 const screenshotTarget={...target,screen:{x:-1920,y:0,width:3840,height:1080}};
 const result=executeComputerAction({kind:'screenshot'},{target:screenshotTarget,captureTarget:async()=>screenshotTarget,platform:'win32',systemRoot:'C:\\Windows',spawnProcess:()=>{setImmediate(()=>{child.stdout.write('-1920,0,3840,1080\r\n'+png+'\r\n');child.stdout.end();child.stderr.end();child.emit('close',0);});return child;}});
 assert.deepEqual((await result).screen,{x:-1920,y:0,width:3840,height:1080});
});
test('window or screen changes after confirmation prevent GUI execution',async()=>{
 for(const changed of [{...target,window:{...target.window,title:'另一窗口'}},{...target,window:{...target.window,pid:43}},{...target,screen:{...target.screen,width:1280}}]){
  let spawned=false;await assert.rejects(executeComputerAction({kind:'click',x:10,y:10,button:'left'},{target,captureTarget:async()=>changed,platform:'win32',systemRoot:'C:\\Windows',spawnProcess:()=>{spawned=true;}}),/已改变/);assert.equal(spawned,false);
 }
});
test('approval displays the bound window and command authorization scope',async()=>{
 const f=fixture({prepare:async()=>target}),t=turn(),request=f.broker.request({turn:t,action:{kind:'key',key:'ENTER'}});await tick();
 assert.match(f.prompt.prompt,/notepad/);assert.match(f.prompt.prompt,/文档/);assert.match(f.prompt.prompt,/123456/);assert.match(f.prompt.prompt,/屏幕/);
 assert.equal(await f.broker.answer({event:event('确认 '+code),settings,selfId:account}),true);await request;
 const g=fixture(),t2=turn(),command=g.broker.request({turn:t2,action});await tick();assert.match(g.prompt.prompt,/整条命令及其启动的子进程/);t2.abort.abort();await assert.rejects(command);
});
test('authorization expiry during final asynchronous check fails closed',async()=>{
 let now=100,checks=0,release;const f=fixture({now:()=>now,checkAccess:async()=>{if(++checks===3)await new Promise(r=>{release=r;});return true;}}),t=turn(),request=f.broker.request({turn:t,action});const rejected=assert.rejects(request);await tick();
 assert.equal(await f.broker.answer({event:event('确认 '+code),settings,selfId:account}),true);await tick();now+=90001;release();await rejected;assert.equal(f.ran,0);
});
