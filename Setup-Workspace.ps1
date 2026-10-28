param([string]$DesktopDirectory='')
$ErrorActionPreference='Stop'
$deskRoot=$PSScriptRoot
$taskTemp=Join-Path $deskRoot 'temp'
New-Item -ItemType Directory -Path $taskTemp -Force | Out-Null
$env:TEMP=$taskTemp;$env:TMP=$taskTemp
function Read-ApplicationPath {
 param([string]$Label,[string]$ExpectedName,[string]$Suggested='', [switch]$AllowApi)
 while($true){
  $value=(Read-Host ($Label+$(if($Suggested){' ['+$Suggested+']'}else{''}))).Trim().Trim('"')
  if($AllowApi -and $value -ieq 'api'){return ''}
  if(!$value){$value=$Suggested}
  if($value -and [IO.Path]::IsPathRooted($value) -and (Test-Path -LiteralPath $value -PathType Leaf) -and (Split-Path -Leaf $value) -ieq $ExpectedName){return $value}
  Write-Host ('请选择已安装的 '+$ExpectedName+' 完整路径。')
 }
}
Write-Host '伴屿双端工作台 · 首次设置'
Write-Host '账号与密钥各自保存在本机；分享包不带原使用者的数据。'
$quarkSuggested=''
foreach($candidate in @('D:\Quark\quark.exe',(Join-Path $env:LOCALAPPDATA 'Quark\Application\quark.exe'),'C:\Program Files\Quark\quark.exe')){if(Test-Path -LiteralPath $candidate){$quarkSuggested=$candidate;break}}
$quarkPath=Read-ApplicationPath '夸克浏览器路径' 'quark.exe' $quarkSuggested
$ownerQQ='';$botQQ='';$qqPath='';$dshPath='';$modelSource='dsh'
$qqChoice=Read-Host '现在配置普通 QQ 小号接入？[Y/n]'
if($qqChoice -notmatch '^[nN]$'){
 do{$ownerQQ=(Read-Host '你的主人 QQ 号（唯一默认私聊白名单）').Trim()}while($ownerQQ -notmatch '^\d{5,12}$')
 do{$botQQ=(Read-Host '机器人 QQ 小号（必须与主人号不同）').Trim()}while($botQQ -notmatch '^\d{5,12}$' -or $botQQ -eq $ownerQQ)
 $qqSuggested='';foreach($candidate in @('C:\Program Files\Tencent\QQNT\QQ.exe','D:\下载\QQ.exe')){if(Test-Path -LiteralPath $candidate){$qqSuggested=$candidate;break}}
 $qqPath=Read-ApplicationPath '电脑 QQ 路径' 'QQ.exe' $qqSuggested
 $dshSuggested='';if(Test-Path -LiteralPath 'D:\ds harness\DeepSeek Harness.exe'){$dshSuggested='D:\ds harness\DeepSeek Harness.exe'}
 $dshPath=Read-ApplicationPath 'DeepSeek Harness 路径（只用官方 API 可输入 api）' 'DeepSeek Harness.exe' $dshSuggested -AllowApi
 if(!$dshPath){$modelSource='deepseek'}
}
$nodePath=Join-Path $deskRoot 'runtime\node.exe'
$setupValues=Join-Path $taskTemp ('first-setup-'+[Guid]::NewGuid().ToString('N')+'.json')
@{root=$deskRoot;owner=$ownerQQ;bot=$botQQ;quark=$quarkPath;qq=$qqPath;dsh=$dshPath;modelSource=$modelSource} | ConvertTo-Json | Set-Content -LiteralPath $setupValues -Encoding UTF8
try{& $nodePath (Join-Path $deskRoot 'sharing\initialize.mjs') --input $setupValues;$setupExitCode=$LASTEXITCODE}finally{Remove-Item -LiteralPath $setupValues -ErrorAction SilentlyContinue}
if($setupExitCode -ne 0){throw '设置没有完成；已有账号配置不会被覆盖。'}
if($botQQ -and $modelSource -eq 'dsh'){
 $dshHomePath=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'}
 $dshProfileName='web'
 if(Test-Path -LiteralPath (Join-Path $dshHomePath 'profiles\desktop\package.json')){$dshProfileName='desktop'}
 if(Test-Path -LiteralPath (Join-Path $dshHomePath ('profiles\'+$dshProfileName+'\package.json'))){
  & $nodePath (Join-Path $deskRoot 'scripts\setup-native-qq.mjs')
  if($LASTEXITCODE -ne 0){throw 'QQ 模型预设未安装完成，请启动过 DSH 后重试预设安装。'}
  & $nodePath (Join-Path $deskRoot 'scripts\setup-dsh.mjs')
 }else{Write-Host '请先打开一次 DSH，再运行“安装模型预设.cmd”。'}
}
& (Join-Path $deskRoot 'Install-Desktop.ps1') -DesktopDirectory $DesktopDirectory
Write-Host '设置完成。QQ 接入组件请运行“安装新QQ核心.cmd”，再从工作台填写授权。'
if($modelSource -eq 'deepseek'){Write-Host '请在“接入与模型”分别打开“QQ模型设置”和“微信模型设置”，选择 DeepSeek 官方 API 并填写自己的 Key。'}else{Write-Host '已经打开的 DSH 需要正常退出后再打开一次，以加载新预设。'}
