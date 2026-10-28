// Executes an already approved action. Never call this directly from a model
// tool; the ComputerApproval boundary must authorize the exact payload first.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {validateComputerAction} from './computer-approval.mjs';
import {validateComputerTarget,sameComputerTarget,targetCaptureScript,targetGuardScript} from './computer-target.mjs';

const psString=s=>"'"+s.replaceAll("'","''")+"'";
function scriptFor(a) {
 if(a.kind==='command') return "$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new();\n"+a.command;
 if(a.kind==='screenshot') return `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
$r=[System.Windows.Forms.SystemInformation]::VirtualScreen
if ($r.Width -le 0 -or $r.Height -le 0 -or ($r.Width * $r.Height) -gt 24000000) { throw '屏幕尺寸不可用或过大' }
$b=[System.Drawing.Bitmap]::new($r.Width,$r.Height)
try {
 $g=[System.Drawing.Graphics]::FromImage($b); try { Assert-BanyuTarget; $g.CopyFromScreen($r.X,$r.Y,0,0,$r.Size) } finally { $g.Dispose() }
 $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
 $bytes=$null
 foreach($quality in @(80,60,40,25)) {
  $m=[IO.MemoryStream]::new(); $parameters=[System.Drawing.Imaging.EncoderParameters]::new(1)
  try { $parameters.Param[0]=[System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality,[long]$quality); $b.Save($m,$codec,$parameters); if($m.Length -le 4000000){ $bytes=$m.ToArray(); break } } finally { $parameters.Dispose(); $m.Dispose() }
 }
 if($null -eq $bytes){ throw '截图超过传输上限，请减少屏幕显示范围后重试' }
 Write-Output ("$($r.X),$($r.Y),$($r.Width),$($r.Height)"); Write-Output ([Convert]::ToBase64String($bytes))
} finally { $b.Dispose() }`;
 if(['click','double_click'].includes(a.kind)) {
  const flags=a.button==='left'?'2,4':'8,16';
  return `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BanyuMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra); }'
$r=[System.Windows.Forms.SystemInformation]::VirtualScreen
if (${a.x} -lt $r.Left -or ${a.x} -ge $r.Right -or ${a.y} -lt $r.Top -or ${a.y} -ge $r.Bottom) { throw '点击位置不在屏幕内' }
if (-not [BanyuMouse]::SetCursorPos(${a.x},${a.y})) { throw '无法移动鼠标' }
Assert-BanyuTarget; $flags=@(${flags}); for($i=0;$i -lt ${a.kind==='double_click'?2:1};$i++){ Assert-BanyuTarget; [BanyuMouse]::mouse_event($flags[0],0,0,0,[UIntPtr]::Zero); [BanyuMouse]::mouse_event($flags[1],0,0,0,[UIntPtr]::Zero) }`;
 }
 if(a.kind==='scroll')return `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BanyuScroll { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra); }'
$x=[int](($expected.window.left+$expected.window.right)/2); $y=[int](($expected.window.top+$expected.window.bottom)/2)
if (-not [BanyuScroll]::SetCursorPos($x,$y)) { throw '无法定位滚动窗口' }
Assert-BanyuTarget; if([BanyuWindow]::At($x,$y).ToInt64().ToString() -ne $expected.window.handle) { throw '滚动位置不属于目标窗口' }
[BanyuScroll]::mouse_event(2048,0,0,[uint32]${((a.direction==='up'?1:-1)*a.steps*120)>>>0},[UIntPtr]::Zero)`;
 if(a.kind==='hotkey'){const key={'CTRL+A':'^a','CTRL+L':'^l','CTRL+C':'^c','CTRL+V':'^v','CTRL+S':'^s','ALT+TAB':'%{TAB}'}[a.key];return `Add-Type -AssemblyName System.Windows.Forms; Assert-BanyuTarget; [System.Windows.Forms.SendKeys]::SendWait('${key}')`;}
 if(a.kind==='type') {
  // SendInput's Unicode mode sends literal UTF-16 code units, without treating
  // +, ^, %, braces, or Chinese text as SendKeys commands or altering clipboard.
  // Some elevated or special desktop applications may reject injected input.
  return `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BanyuUnicodeInput {
 [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
 [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
 public static void Text(string text) {
  INPUT[] inputs = new INPUT[text.Length * 2];
  for(int i=0;i<text.Length;i++) { inputs[i*2].type=1; inputs[i*2].data.ki.scan=text[i]; inputs[i*2].data.ki.flags=4; inputs[i*2+1].type=1; inputs[i*2+1].data.ki.scan=text[i]; inputs[i*2+1].data.ki.flags=6; }
  if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new InvalidOperationException("系统未接受全部输入，实际输入可能不完整，请人工核查");
 }
}
'@
Assert-BanyuTarget; [BanyuUnicodeInput]::Text(${psString(a.text)})`;
 }
 const key={ENTER:'ENTER',TAB:'TAB',ESC:'ESC',BACKSPACE:'BACKSPACE',DELETE:'DELETE',UP:'UP',DOWN:'DOWN',LEFT:'LEFT',RIGHT:'RIGHT'}[a.key];
 return `Add-Type -AssemblyName System.Windows.Forms; Assert-BanyuTarget; [System.Windows.Forms.SendKeys]::SendWait('{${key}}')`;
}

async function runScript(script,{signal,spawnProcess=spawn,platform=process.platform,systemRoot=process.env.SystemRoot,timeoutMs=30000,cwd,cap=30000,strictCap=false}={}) {
 if(platform!=='win32' || !systemRoot) throw Error('电脑操作需要 Windows 桌面环境');
 if(signal?.aborted) throw Error('电脑操作已取消');
 const executable=path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const encoded=Buffer.from("$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new();\n"+script,'utf16le').toString('base64');
 const args=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded];
 return await new Promise((resolve,reject)=>{
  let child,done=false,timer,stdout='',stderr='',overflow=false;
  const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);err?reject(err):resolve(result);};
  const stop=reason=>{try{child?.kill();}catch{} finish(Error(reason));};
  const aborted=()=>stop('操作已中断，子进程可能仍在运行，结果不确定，请人工核查');
  try{child=spawnProcess(executable,args,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});}catch{finish(Error('无法启动电脑操作'));return;}
  signal?.addEventListener('abort',aborted,{once:true});
  if(signal?.aborted){aborted();return;}
  timer=setTimeout(()=>stop('电脑操作超时，子进程可能仍在运行，结果不确定，请人工核查'),Math.min(60000,Math.max(1000,timeoutMs)));timer.unref?.();
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',s=>{if(stdout.length+s.length>cap){overflow=true;if(strictCap)stop('操作结果过大，未发送');else stdout+=(s.slice(0,Math.max(0,cap-stdout.length)));}else stdout+=s;});
  child.stderr.on('data',s=>{stderr+=(s.slice(0,Math.max(0,4000-stderr.length)));});
  child.on('error',()=>finish(Error('电脑操作启动失败')));
  child.on('close',code=>{
   if(code!==0)return finish(Error('电脑操作未成功完成'+(stderr.trim()?'：'+stderr.trim().slice(0,1000):'')));
   finish(null,{exitCode:code,output:stdout,outputTruncated:overflow,stderr:stderr.slice(0,4000)});
  });
 });
}

export async function prepareComputerTarget(action,options={}) {
 const a=validateComputerAction(action);if(a.kind==='command')throw Error('命令不需要窗口目标');
 const result=await runScript(targetCaptureScript(a),{...options,cap:10000,strictCap:true});
 let parsed;try{parsed=JSON.parse(result.output.trim());}catch{throw Error('无法读取目标窗口');}
 return validateComputerTarget(parsed);
}

export async function executeComputerAction(value,options={}) {
 const a=validateComputerAction(value),{signal,target,captureTarget=prepareComputerTarget}=options;
 if(signal?.aborted)throw Error('电脑操作已取消');
 let cwd,script=scriptFor(a);
 if(a.kind==='command') {
  if(!path.win32.isAbsolute(a.cwd) || a.cwd.startsWith('\\\\')) throw Error('工作目录须为本机绝对路径');
  try {if(!fs.statSync(a.cwd).isDirectory())throw Error();} catch {throw Error('工作目录不存在');}
  cwd=a.cwd;
 } else {
  const expected=validateComputerTarget(target),actual=await captureTarget(a,options);
  if(!sameComputerTarget(expected,actual))throw Error('确认后的目标窗口或屏幕已改变，操作未执行');
  // A second check runs inside the same process immediately before the action.
  script=targetGuardScript(expected,a)+'\n'+script;
 }
 const result=await runScript(script,{...options,cwd,cap:a.kind==='screenshot'?14_000_000:30000,strictCap:a.kind==='screenshot'});
 if(a.kind==='screenshot'){
  const [size,base64]=result.output.trim().split(/\r?\n/),m=/^(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(size||'');
  if(!m||!base64||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)||base64.length>6000000||!(/^(iVBORw0KGgo|\/9j\/)/.test(base64)))throw Error('截图内容无效');
  if(+m[1]!==target.screen.x||+m[2]!==target.screen.y||+m[3]!==target.screen.width||+m[4]!==target.screen.height)throw Error('屏幕布局已改变，截图未发送');
  return {kind:'screenshot',mediaType:base64.startsWith('/9j/')?'image/jpeg':'image/png',imageBase64:base64,screen:{x:+m[1],y:+m[2],width:+m[3],height:+m[4]}};
 }
 return {kind:a.kind,...result};
}
