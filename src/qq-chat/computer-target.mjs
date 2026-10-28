// Capture and bind the foreground application for confirmed GUI operations.
const int=n=>Number.isSafeInteger(n);
export function validateComputerTarget(value) {
 const s=value?.screen,w=value?.window;
 if(!s||!w||![s.x,s.y,s.width,s.height,w.pid,w.left,w.top,w.right,w.bottom].every(int)||s.width<1||s.height<1||s.width*s.height>24000000||w.pid<1||w.right<=w.left||w.bottom<=w.top||
    typeof w.handle!=='string'||!/^\d{1,20}$/.test(w.handle)||w.handle==='0'||typeof w.process!=='string'||!w.process||w.process.length>200||typeof w.title!=='string'||w.title.length>300||typeof w.started!=='string'||!/^\d{1,25}$/.test(w.started)) throw Error('无法可靠识别当前窗口或屏幕');
 return Object.freeze({screen:Object.freeze({x:s.x,y:s.y,width:s.width,height:s.height}),window:Object.freeze({handle:w.handle,pid:w.pid,process:w.process,title:w.title,started:w.started,left:w.left,top:w.top,right:w.right,bottom:w.bottom})});
}
export function sameComputerTarget(a,b){try{return JSON.stringify(validateComputerTarget(a))===JSON.stringify(validateComputerTarget(b));}catch{return false;}}
// This script is used both for the pre-approval snapshot and immediately before
// the action in the same PowerShell process. WindowAtPoint resolves child
// controls back to their top-level window.
export const targetDefinitions = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BanyuWindow {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flags);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window,StringBuilder text,int maximum);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out RECT rect);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 public static string Title(IntPtr window) { var b=new StringBuilder(301); int n=GetWindowText(window,b,b.Capacity); if(n>=300) throw new InvalidOperationException("窗口标题过长"); return b.ToString(); }
 public static IntPtr At(int x,int y) { return GetAncestor(WindowFromPoint(new POINT{x=x,y=y}),2); }
}
'@
[void][BanyuWindow]::SetProcessDPIAware()
function Get-BanyuTarget {
 $h=[BanyuWindow]::GetForegroundWindow(); if($h -eq [IntPtr]::Zero -or -not [BanyuWindow]::IsWindowVisible($h)) { throw '未找到可见的前台窗口' }
 $pidValue=[uint32]0; [void][BanyuWindow]::GetWindowThreadProcessId($h,[ref]$pidValue); if(!$pidValue) { throw '无法识别窗口进程' }
 $process=Get-Process -Id $pidValue -ErrorAction Stop; $rect=New-Object BanyuWindow+RECT
 if(-not [BanyuWindow]::GetWindowRect($h,[ref]$rect)) { throw '无法识别窗口位置' }
 $s=[System.Windows.Forms.SystemInformation]::VirtualScreen
 return @{screen=@{x=$s.X;y=$s.Y;width=$s.Width;height=$s.Height};window=@{handle=$h.ToInt64().ToString();pid=[int]$pidValue;process=$process.ProcessName;title=[BanyuWindow]::Title($h);started=$process.StartTime.ToUniversalTime().Ticks.ToString();left=$rect.left;top=$rect.top;right=$rect.right;bottom=$rect.bottom}}
}`;
export const targetSnapshotScript = `${targetDefinitions}\nGet-BanyuTarget | ConvertTo-Json -Depth 4 -Compress`;
export function targetCaptureScript(action) {
 if(!['click','double_click'].includes(action.kind))return targetSnapshotScript;
 if(!int(action.x)||!int(action.y))throw Error('点击坐标无效');
 return `${targetDefinitions}\n$target=Get-BanyuTarget; if ([BanyuWindow]::At(${action.x},${action.y}).ToInt64().ToString() -ne $target.window.handle) { throw '点击位置不属于当前前台窗口，操作未申请' }; $target | ConvertTo-Json -Depth 4 -Compress`;
}
export function targetGuardScript(expected,action) {
 const fixed=validateComputerTarget(expected),encoded=Buffer.from(JSON.stringify(fixed),'utf8').toString('base64');
 const point=['click','double_click'].includes(action.kind)?`$at=[BanyuWindow]::At(${action.x},${action.y}); if ($at.ToInt64().ToString() -ne $expected.window.handle) { throw '点击位置的目标窗口已改变，操作未执行' }`:'';
 return `${targetDefinitions}
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
function Assert-BanyuTarget {
 $actual=Get-BanyuTarget
 foreach($key in @('x','y','width','height')) { if($actual.screen[$key] -ne $expected.screen.$key) { throw '屏幕布局已改变，操作未执行' } }
 foreach($key in @('handle','pid','process','title','started','left','top','right','bottom')) { if($actual.window[$key] -cne $expected.window.$key) { throw '前台窗口已改变，操作未执行' } }
 ${point}
}
Assert-BanyuTarget`;
}
