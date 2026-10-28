$ErrorActionPreference='Stop'
$deskRoot=Split-Path -Parent $PSScriptRoot
try{& (Join-Path $deskRoot 'Install-QQCore.ps1');Write-Host '安装已完成，可以返回工作台填写授权并登录。'}catch{Write-Host ('安装尚未完成：'+$_.Exception.Message)}
[void](Read-Host '按回车关闭此窗口')
