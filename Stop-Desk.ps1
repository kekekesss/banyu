param()
$ErrorActionPreference='Stop'
$deskRoot=$PSScriptRoot
$leaseFile=Join-Path $deskRoot 'data\desk-runtime\supervisor.json'
Start-Sleep -Milliseconds 800
if(!(Test-Path -LiteralPath $leaseFile)){exit 0}
$lease=Get-Content -LiteralPath $leaseFile -Raw -Encoding UTF8 | ConvertFrom-Json
$ownerProcess=Get-Process -Id ([int]$lease.pid) -ErrorAction SilentlyContinue
if(!$ownerProcess){exit 0}
$details=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$lease.pid)
$runtimeScript=Join-Path $deskRoot 'sharing\desk-runtime.mjs'
$nodePath=Join-Path $deskRoot 'runtime\node.exe'
if(!(Test-Path -LiteralPath $nodePath)){$nodePath=(Get-Command node -ErrorAction Stop).Source}
if($ownerProcess.Path -ne $nodePath -or $ownerProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $lease.started -or $details.CommandLine -ne $lease.command -or $lease.script -ne $runtimeScript -or !$lease.nonce){throw '未能确认本工作台的后台身份，未停止其他程序。'}
$requestFile=Join-Path $deskRoot 'data\desk-runtime\stop-request.json'
@{nonce=$lease.nonce} | ConvertTo-Json -Compress | Set-Content -LiteralPath $requestFile -Encoding UTF8
for($waitStep=0;$waitStep -lt 120;$waitStep++){
    Start-Sleep -Milliseconds 200
    $remaining=Get-Process -Id ([int]$lease.pid) -ErrorAction SilentlyContinue
    if(!$remaining -or $remaining.StartTime.ToUniversalTime().Ticks.ToString() -ne $lease.started){exit 0}
}
throw '工作台仍在完成退出，请稍后重试。'
