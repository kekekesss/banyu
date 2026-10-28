param([string]$DesktopDirectory='')
$ErrorActionPreference = 'Stop'
$deskRoot = $PSScriptRoot
$shellObject = New-Object -ComObject WScript.Shell
$desktopFolder = if($DesktopDirectory){$DesktopDirectory}else{[Environment]::GetFolderPath('Desktop')}
if(![IO.Path]::IsPathRooted($desktopFolder)){throw '桌面入口目录必须是完整路径。'}
New-Item -ItemType Directory -Path $desktopFolder -Force | Out-Null
$shortcut = $shellObject.CreateShortcut((Join-Path $desktopFolder '伴屿双端工作台.lnk'))
if(Test-Path -LiteralPath (Join-Path $deskRoot 'Banyu.exe')){
    $shortcut.TargetPath=Join-Path $deskRoot 'Banyu.exe'
    $shortcut.Arguments=''
}else{
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $deskRoot 'Launch-Desk.ps1') + '"'
}
$shortcut.WorkingDirectory = $deskRoot
$shortcut.IconLocation = (Join-Path $deskRoot 'public\icon-banyu.ico')
$shortcut.Description = '伴屿：一键启动 QQ、微信、模型与聊天服务，统一管理角色与资料'
$shortcut.Save()
foreach($previousName in @('鲸鲸双端工作台.lnk','鲸鲸工作台.lnk')) {
    $previousEntry = Join-Path $desktopFolder $previousName
    if (!(Test-Path -LiteralPath $previousEntry -PathType Leaf)) { continue }
    $previous = $shellObject.CreateShortcut($previousEntry)
    if ($previous.TargetPath -eq $shortcut.TargetPath -and $previous.Arguments -eq $shortcut.Arguments -and $previous.WorkingDirectory -eq $deskRoot) {
        $backupFolder = Join-Path $deskRoot 'backups\shortcuts'
        New-Item -ItemType Directory -Path $backupFolder -Force | Out-Null
        Copy-Item -LiteralPath $previousEntry -Destination (Join-Path $backupFolder ($previousName + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak'))
        Remove-Item -LiteralPath $previousEntry -ErrorAction Stop
    }
}
Write-Output '已创建桌面入口：伴屿双端工作台。'
