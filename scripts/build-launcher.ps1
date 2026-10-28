param([string]$OutputFile='', [switch]$TestBuild)
$ErrorActionPreference='Stop'
$deskRoot=Split-Path -Parent $PSScriptRoot
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(!(Test-Path -LiteralPath $compiler)){throw 'Windows .NET Framework compiler is unavailable'}
if(!$OutputFile){$OutputFile=Join-Path $deskRoot 'Banyu.exe'}
$compilerArgs=@('/nologo','/target:winexe','/optimize+',('/out:'+$OutputFile),('/win32icon:'+(Join-Path $deskRoot 'public\icon-banyu.ico')),'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll')
if($TestBuild){$compilerArgs+='/define:BANYU_TEST'}
& $compiler @compilerArgs (Join-Path $deskRoot 'sharing\BanyuLauncher.cs')
if($LASTEXITCODE -ne 0){throw 'Banyu launcher compilation failed'}
Write-Output 'Banyu.exe built from sharing/BanyuLauncher.cs'
