param(
 [ValidateSet('inspect','capture','list','validate','secure','show')][string]$Action,
 [string]$StateDirectory,[string]$EngineDirectory,[string]$QQExecutable,
 [ValidateSet('pmhq','qq')][string]$Kind='pmhq',[int]$ProcessId=0,
 [string]$ExpectedStarted,[long]$NotBefore=0
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
# Node may inherit PSModulePath from PowerShell 7. Windows PowerShell 5.1
# cannot load its Security/CimCmdlets assemblies, so use this host's modules.
function Import-HostModule {
 param([string]$ModuleName)
 Import-Module (Join-Path $PSHOME ('Modules\'+$ModuleName+'\'+$ModuleName+'.psd1')) -ErrorAction Stop
}
function Get-OwnedProcess {
 param([int]$TargetId,[string]$TargetKind,[string]$Ticks,[long]$After)
 $expected=[IO.Path]::GetFullPath($(if($TargetKind -eq 'qq'){$QQExecutable}else{Join-Path $EngineDirectory 'pmhq.exe'}))
 $candidate=Get-Process -Id $TargetId -ErrorAction Stop
 if(!$candidate.Path -or [IO.Path]::GetFullPath($candidate.Path) -ne $expected){throw 'Executable mismatch'}
 $started=$candidate.StartTime.ToUniversalTime()
 if($Ticks -and $started.Ticks.ToString() -ne $Ticks){throw 'Process identity changed'}
 if($After -gt 0 -and ([DateTimeOffset]$started).ToUnixTimeMilliseconds() -lt ($After-2000)){throw 'Existing process is not ours'}
 Import-HostModule 'CimCmdlets'
 $details=Get-CimInstance Win32_Process -Filter ('ProcessId='+$TargetId)
 if($TargetKind -eq 'pmhq'){
  $config=[IO.Path]::GetFullPath((Join-Path $StateDirectory 'pmhq_config.json'))
  if(!$details.CommandLine -or !$details.CommandLine.Contains($config) -or !$details.CommandLine.Contains('--mode=inline')){throw 'Process arguments mismatch'}
 }elseif($details.CommandLine -match '--type(?:=|\s)'){throw 'QQ subprocess is not a main window'}
 return @{pid=$TargetId;started=$started.Ticks.ToString();executable=$expected}
}
try {
 Import-HostModule 'Microsoft.PowerShell.Management'
 Import-HostModule 'Microsoft.PowerShell.Utility'
 if($Action -eq 'secure'){
  $root=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')+'\'
  $target=[IO.Path]::GetFullPath($StateDirectory)
  if(!$target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $target -PathType Container)){throw 'Unexpected state directory'}
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $target '/inheritance:r' '/grant:r' ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Cannot protect configuration'}
  'true';exit
 }
 if($Action -eq 'validate'){
  Import-HostModule 'Microsoft.PowerShell.Security'
  $file=Get-Item -LiteralPath $QQExecutable -ErrorAction Stop
  $signature=Get-AuthenticodeSignature -LiteralPath $QQExecutable
  if($file.Name -ine 'QQ.exe' -or $file.VersionInfo.ProductName -ne 'QQ' -or $signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent'){throw 'Not verified QQ'}
  'true';exit
 }
 if($Action -eq 'list'){
  Import-HostModule 'CimCmdlets'
  $found=@(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | Where-Object {$_.CommandLine -notmatch '--type(?:=|\s)'} | ForEach-Object {
   try {$p=Get-Process -Id $_.ProcessId -ErrorAction Stop;@{pid=[int]$_.ProcessId;started=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.Path}}
   catch {@{pid=[int]$_.ProcessId;unverified=$true}}
  })
  ConvertTo-Json -InputObject $found -Compress;exit
 }
 $record=Get-OwnedProcess -TargetId $ProcessId -TargetKind $Kind -Ticks $ExpectedStarted -After $NotBefore
 if($Action -eq 'show'){
  $p=Get-Process -Id $ProcessId -ErrorAction Stop
  if($p.MainWindowHandle -eq [IntPtr]::Zero){throw 'QQ is in the tray'}
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WhaleQQWindow { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle); }'
  [void][WhaleQQWindow]::ShowWindowAsync($p.MainWindowHandle,9)
  [void][WhaleQQWindow]::SetForegroundWindow($p.MainWindowHandle)
  'true';exit
 }
 $record | ConvertTo-Json -Compress
} catch {
 if($Action -eq 'list'){'[{"unverified":true}]'}else{'false'}
}
