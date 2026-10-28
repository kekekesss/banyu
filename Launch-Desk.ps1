param([ValidateSet('','overview','qq','weixin')][string]$Page='')
$ErrorActionPreference = 'Stop'
$deskRoot = $PSScriptRoot
$deskMutex = New-Object System.Threading.Mutex($false, ('Global\BanyuDeskLaunch-' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
$held = $false
try {
    try { $held = $deskMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (!$held) { exit 0 }
    $nodePath = Join-Path $deskRoot 'runtime\node.exe'
    if (!(Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
    function Get-DeskHealth {
        try { return Invoke-RestMethod -Uri 'http://127.0.0.1:3200/api/health' -TimeoutSec 2 -UseBasicParsing -Proxy $null } catch { return $null }
    }
    function Test-DeskServerOwner {
        param([string]$Workspace, [string]$NodePath)
        try {
            $recordFile=Join-Path $Workspace 'data\server-process.json'
            if(!(Test-Path -LiteralPath $recordFile)){return $false}
            $proof=Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $worker=Get-Process -Id ([int]$proof.pid) -ErrorAction Stop
            $listener=Get-NetTCPConnection -State Listen -LocalPort 3200 -ErrorAction Stop | Select-Object -First 1
            return $worker.Path -eq $NodePath -and $worker.StartTime.ToUniversalTime().Ticks.ToString() -eq $proof.started -and $listener.OwningProcess -eq $worker.Id
        } catch { return $false }
    }
    function Signal-RunningDesk {
        $hash=[System.Security.Cryptography.SHA256]::Create()
        try {$id=[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value))).Replace('-','').Substring(0,24)}finally{$hash.Dispose()}
        try {$signal=[Threading.EventWaitHandle]::OpenExisting('Global\BanyuDeskOpen-'+$id);try{$signal.Set()|Out-Null;return $true}finally{$signal.Dispose()}}catch{return $false}
    }
    $deskHealth = Get-DeskHealth
    if($deskHealth){
        if($deskHealth.app -ne 'whale-service-desk'){throw '3200 端口被其他应用占用。'}
        if(!(Test-DeskServerOwner -Workspace $deskRoot -NodePath $nodePath)){
            if(Signal-RunningDesk){exit 0}
            throw '已有另一份伴屿工作台在线。请回到已运行的工作台，从它的托盘退出后才能切换目录。'
        }
    }
    $machineFile=Join-Path $deskRoot 'data\machine-settings.json'
    if(!(Test-Path -LiteralPath $machineFile)){
        $setupProcess=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $deskRoot 'Setup-Workspace.ps1')+'"')) -WindowStyle Normal -Wait -PassThru
        if($setupProcess.ExitCode -ne 0){throw '请先完成首次设置。'}
    }
    $machine=@{}
    if(Test-Path -LiteralPath $machineFile){$machine=Get-Content -LiteralPath $machineFile -Raw -Encoding UTF8 | ConvertFrom-Json}
    $quarkPath = 'D:\Quark\quark.exe'
    if($machine.quarkExecutable){$quarkPath=[string]$machine.quarkExecutable}
    if (!(Test-Path -LiteralPath $quarkPath)) { throw '未找到夸克浏览器，请运行首次设置选择安装路径。' }
    $dataPath = Join-Path $deskRoot 'data'
    $logPath = Join-Path $deskRoot 'logs'
    New-Item -ItemType Directory -Path $dataPath,$logPath -Force | Out-Null
    # Only the current user, SYSTEM and Administrators can read login material.
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $dataPath /inheritance:r /grant:r ('*' + $currentSid + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '无法保护本机登录数据目录。' }
    $dshPath = 'D:\ds harness\DeepSeek Harness.exe'
    if($machine.dshExecutable){$dshPath=[string]$machine.dshExecutable}
    $modelUsesDsh = $true
    if (Test-Path -LiteralPath (Join-Path $dataPath 'launcher-settings.json')) {
        try { $modelLaunch = Get-Content -LiteralPath (Join-Path $dataPath 'launcher-settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json; $modelUsesDsh = $modelLaunch.provider -eq 'dsh' -or $modelLaunch.qqNeedsDsh -eq $true } catch {}
    }
    if ($modelUsesDsh -and (Test-Path -LiteralPath $dshPath) -and !(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $dshPath -WorkingDirectory (Split-Path -Parent $dshPath) -WindowStyle Hidden
    }
    $nativeQq=$true
    function Ensure-DeskDesktopQQ {
        param([string]$AdminKey,[string]$LogDirectory)
        # Reopening the desktop entry also repairs an exited LLBot worker when
        # the management server is still healthy. Never start direct QR mode.
        try {
            $qqHeaders = @{ 'x-admin-token' = $AdminKey }
            $qqState = Invoke-RestMethod -Uri 'http://127.0.0.1:3200/api/local-qq/state' -Headers $qqHeaders -TimeoutSec 20 -UseBasicParsing -Proxy $null
            if ($qqState.mode -ne 'pmhq' -or $qqState.hasAuthorization -ne $true -or $qqState.consented -ne $true) { return }
            if ($qqState.running -eq $true -and $qqState.online -eq $true -and $qqState.accountMatches -eq $true -and $qqState.desktop.running -eq $true) { return }
            Invoke-RestMethod -Uri 'http://127.0.0.1:3200/api/local-qq/start' -Method Post -Headers $qqHeaders -ContentType 'application/json' -Body '{}' -TimeoutSec 45 -UseBasicParsing -Proxy $null | Out-Null
        } catch {
            # Exception bodies may contain credentials or upstream URLs. Keep
            # a generic local note and still open the management page.
            try { ('电脑 QQ 后台未能自动连接，请在 QQ 工作台查看状态。 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) | Add-Content -LiteralPath (Join-Path $LogDirectory 'qq-launch.log') -Encoding UTF8 } catch {}
        }
    }
    $deskHealth = Get-DeskHealth
    if ($deskHealth -and $deskHealth.app -ne 'whale-service-desk') { throw '3200 端口被其他应用占用。' }
    $requiredBuild = Get-Content -LiteralPath (Join-Path $deskRoot 'build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($deskHealth -and $deskHealth.revision -ne $requiredBuild.revision) {
        $processRecord = Get-Content -LiteralPath (Join-Path $dataPath 'server-process.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $existingProcess = Get-Process -Id ([int]$processRecord.pid) -ErrorAction Stop
        $listener = Get-NetTCPConnection -State Listen -LocalPort 3200 -ErrorAction Stop | Select-Object -First 1
        if ($existingProcess.Path -ne $nodePath -or $existingProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $processRecord.started -or $listener.OwningProcess -ne $existingProcess.Id) { throw '无法确认旧工作台后台身份，未停止任何进程。' }
        $guardFile=Join-Path $dataPath 'desk-runtime\supervisor.json'
        $guardProcess=$null
        if(Test-Path -LiteralPath $guardFile){
            $guard=Get-Content -LiteralPath $guardFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $guardProcess=Get-Process -Id ([int]$guard.pid) -ErrorAction SilentlyContinue
            if($guardProcess){
                $guardDetails=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$guard.pid)
                if($guardProcess.Path -ne $nodePath -or $guardProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $guard.started -or $guardDetails.CommandLine -ne $guard.command -or $guard.script -ne (Join-Path $deskRoot 'sharing\desk-runtime.mjs')){throw '无法确认旧守护进程身份，未停止任何程序。'}
            }
        }
        if($guardProcess){Stop-Process -Id $guardProcess.Id}
        Stop-Process -Id $existingProcess.Id
        for ($stopWait=0; $stopWait -lt 20; $stopWait++) { if (!(Get-DeskHealth)) { break }; Start-Sleep -Milliseconds 100 }
        $deskHealth=$null
    }
    if (!$deskHealth) {
        $env:WHALE_PORT = '3200'
        $env:WHALE_DATA_DIR = $dataPath
        Start-Process -FilePath $nodePath -ArgumentList @('sharing/desk-runtime.mjs') -WorkingDirectory $deskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logPath 'supervisor.out.log') -RedirectStandardError (Join-Path $logPath 'supervisor.err.log') | Out-Null
        for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 300; $deskHealth = Get-DeskHealth; if ($deskHealth) { break } }
        if (!$deskHealth -or $deskHealth.app -ne 'whale-service-desk') { throw '工作台未能启动，请查看 logs 文件夹。' }
    }
    $adminKey = [IO.File]::ReadAllText((Join-Path $dataPath 'admin-token')).Trim()
    Ensure-DeskDesktopQQ -AdminKey $adminKey -LogDirectory $logPath
    $deskUrl = 'http://127.0.0.1:3200/?token=' + [Uri]::EscapeDataString($adminKey)
    if ($Page) { $deskUrl += '#' + $Page } else { $deskUrl += '#qq' }
    . (Join-Path $deskRoot 'scripts\focus-workbench.ps1')
    if(Focus-DeskWindow -QuarkPath $quarkPath){exit 0}
    Start-Process -FilePath $quarkPath -ArgumentList @(('--app=' + $deskUrl), '--window-size=1400,980')
    $windowShell=New-Object -ComObject WScript.Shell
    for($windowWait=0;$windowWait -lt 10;$windowWait++){
        Start-Sleep -Milliseconds 300
        if($windowShell.AppActivate('伴屿双端工作台')){break}
    }
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(('工作台暂时未能打开：' + $_.Exception.Message), '伴屿双端工作台', 'OK', 'Warning') | Out-Null
    exit 1
} finally {
    if ($held) { $deskMutex.ReleaseMutex() }
    $deskMutex.Dispose()
}
