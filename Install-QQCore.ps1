param()
$ErrorActionPreference='Stop'
$deskRoot=$PSScriptRoot
$version='8.3.2'
$expected='3b29f2bdaafbbb1e0e494e42d81da7566aeb16114e9eb42a5d168c59dbcadcb7'
$url='https://github.com/LLOneBot/LuckyLilliaBot/releases/download/v8.3.2/LuckyLillia-CLI-win-x64.zip'
$downloads=Join-Path $deskRoot 'downloads'
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
$zip=Join-Path $downloads ('LuckyLillia-CLI-'+$version+'-win-x64.zip')
if(!(Test-Path -LiteralPath $zip)){Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing}
if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw '安装包与官方发布摘要不匹配，未安装或运行。'}
$component=Join-Path $deskRoot ('components\llbot-'+$version)
$manifestFile=Join-Path $component 'installation.json'
$desktopFiles=@{
 'bin\pmhq\pmhq.exe'='945edd552a31f7e6e9b21620a8f50729965956d062df5fe12fb7de4276d510e7'
 'bin\pmhq\pmhq.dll'='ebeae2141cf6b95551a6bf47ad656dfc522dd5691361cc899b6c208c70d1f800'
}
if(Test-Path -LiteralPath $manifestFile){
    $installed=Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $intact=$installed.sha256 -eq $expected
    foreach($entry in $installed.files.PSObject.Properties){$target=Join-Path $component $entry.Name;if(!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value){$intact=$false}}
    foreach($name in $desktopFiles.Keys){$target=Join-Path $component $name;if(!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $desktopFiles[$name]){$intact=$false}}
    if($intact){Write-Output '新 QQ 核心已经安装并通过校验。';exit 0}
    throw '现有核心文件校验失败，请先停止核心并保留该目录，再重新安装。'
}
New-Item -ItemType Directory -Path $component -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($zip)
try{
    $boundary=[IO.Path]::GetFullPath($component).TrimEnd('\')+'\'
    foreach($entry in $archive.Entries){
        $dest=[IO.Path]::GetFullPath((Join-Path $component $entry.FullName))
        if(!$dest.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase)){throw '压缩包含越界路径，已停止。'}
    }
}finally{$archive.Dispose()}
Expand-Archive -LiteralPath $zip -DestinationPath $component -Force
$hashes=@{}
foreach($item in @('bin\llbot\node.exe','bin\llbot\llbot.js','bin\llbot\sign-proxy.win-x64.node','bin\pmhq\pmhq.exe','bin\pmhq\pmhq.dll')){$hashes[$item]=(Get-FileHash -LiteralPath (Join-Path $component $item) -Algorithm SHA256).Hash.ToLowerInvariant()}
@{version=$version;sha256=$expected;source=$url;files=$hashes;installedAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestFile -Encoding UTF8
Write-Output '新 QQ 核心安装完成。请在双端工作台的 QQ 页填写授权令牌并登录小号。'
