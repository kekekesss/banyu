param([ValidateSet('inspect','stop')][string]$Action,[string]$StateDirectory,[string]$EngineDirectory)
$ErrorActionPreference='Stop'
try {
    $record=Get-Content -LiteralPath (Join-Path $StateDirectory 'process.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected=[IO.Path]::GetFullPath((Join-Path $EngineDirectory 'node.exe'))
    $entry=[IO.Path]::GetFullPath((Join-Path $EngineDirectory 'llbot.js'))
    $process=Get-Process -Id ([int]$record.pid) -ErrorAction Stop
    $details=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$record.pid)
    if($process.Path -ne $expected -or $record.executable -ne $expected -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.started -or !$details.CommandLine.Contains($entry)){throw 'Identity mismatch'}
    if($Action -eq 'stop') { Stop-Process -Id $process.Id -ErrorAction Stop; Remove-Item -LiteralPath (Join-Path $StateDirectory 'process.json') -ErrorAction SilentlyContinue }
    'true'
} catch { 'false' }
