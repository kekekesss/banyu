$ErrorActionPreference='Stop'
$deskRoot=Split-Path -Parent $PSScriptRoot
$nodePath=Join-Path $deskRoot 'runtime\node.exe'
$dshHomePath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
$dshProfileName='web'
if(Test-Path -LiteralPath (Join-Path $dshHomePath 'profiles\desktop\package.json')){$dshProfileName='desktop'}
& $nodePath (Join-Path $deskRoot 'scripts\setup-native-qq.mjs') $dshProfileName
if($LASTEXITCODE -ne 0){throw 'QQ 预设安装失败。'}
& $nodePath (Join-Path $deskRoot 'scripts\setup-dsh.mjs')
if($LASTEXITCODE -ne 0){throw '客服预设安装失败。'}
Write-Host '预设已安装，请正常重启 DSH。'
