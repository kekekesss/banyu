// Parse the actual Windows launcher, then run only its resume helper with
// in-memory PowerShell peers. Never run the launcher or use real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),launcher=fileURLToPath(new URL('../Launch-Desk.ps1',import.meta.url));

test('启动器始终核对后台归属，外目录或复用PID不能接管现有实例',{skip:process.platform!=='win32'},async()=>{
 const script=String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${launcher.replace(/'/g,"''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PowerShell syntax error'}
$helper=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-DeskServerOwner'},$true)
Invoke-Expression $helper.Extent.Text
$script:stamp=[DateTime]::UtcNow
function Test-Path {param($LiteralPath) return $script:case -ne 'missing'}
function Get-Content {param($LiteralPath,[switch]$Raw,$Encoding) return (@{pid=123;started=$script:stamp.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress)}
function Get-Process {param($Id,$ErrorAction) return @{Id=123;Path=$(if($script:case -eq 'foreign'){'D:\other\node.exe'}else{'D:\desk\node.exe'});StartTime=$(if($script:case -eq 'reused'){$script:stamp.AddSeconds(1)}else{$script:stamp})}}
function Get-NetTCPConnection {param([switch]$State,$LocalPort,$ErrorAction) return @{OwningProcess=$(if($script:case -eq 'wrong-listener'){456}else{123})}}
$result=@{}
foreach($script:case in @('owned','missing','foreign','reused','wrong-listener')){$result[$script:case]=Test-DeskServerOwner -Workspace 'D:\desk' -NodePath 'D:\desk\node.exe'}
$result|ConvertTo-Json -Compress
`;
 const {stdout}=await exec('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000});
 assert.deepEqual(JSON.parse(stdout.trim()),{owned:true,missing:false,foreign:false,reused:false,'wrong-listener':false});
 const source=fs.readFileSync(launcher,'utf8');assert.ok(source.indexOf('if(!(Test-DeskServerOwner')<source.indexOf('$machineFile='));assert.ok(source.indexOf('if(Focus-DeskWindow')<source.indexOf('Start-Process -FilePath $quarkPath'));
});

test('Windows desktop entry resumes only authorized desktop QQ and survives failures without leaking credentials',{skip:process.platform!=='win32'},async()=>{
 const script=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$tokens=$null;$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${launcher.replace(/'/g,"''")}',[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count -gt 0){throw 'Launcher syntax is not valid Windows PowerShell'}
$helper=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Ensure-DeskDesktopQQ'},$true)
if(!$helper){throw 'Desktop resume helper missing'}
Invoke-Expression $helper.Extent.Text
function Invoke-RestMethod {
 param($Uri,$Headers,$Method='Get',$ContentType,$Body,$TimeoutSec,[switch]$UseBasicParsing,$Proxy)
 if($Headers['x-admin-token'] -ne 'ISOLATED-ADMIN-SECRET'){throw 'Fixture token absent'}
 if(!$UseBasicParsing -or $Proxy -ne $null){throw 'Local request must bypass proxy'}
 if($TimeoutSec -le 0 -or $TimeoutSec -gt 45){throw 'Local request must have a bounded timeout'}
 $script:Calls.Add([string]$Method+' '+[string]$Uri)
 if($Uri.EndsWith('/state')){
  if($script:FailRead){throw 'ISOLATED-ADMIN-SECRET PRIVATE-UPSTREAM'}
  return $script:Fixture
 }
 if($Uri.EndsWith('/start') -and $Method -eq 'Post' -and $ContentType -eq 'application/json' -and $Body -eq '{}'){
  if($script:FailStart){throw 'ISOLATED-ADMIN-SECRET PRIVATE-UPSTREAM'}
  return @{ok=$true}
 }
 throw 'Unexpected fixture endpoint'
}
function Add-Content {
 param([Parameter(ValueFromPipeline=$true)]$Value,$LiteralPath,$Encoding)
 process {
  if($script:FailLog){throw 'Fixture log unavailable'}
  if($LiteralPath -notlike '*qq-launch.log'){throw 'Unexpected log path'}
  $script:Logs.Add([string]$Value)
 }
}
$results=@()
foreach($case in @('stopped','online','running-offline','direct','missing-token','unconsented','unknown-mode','read-fails','start-fails','log-fails')){
 $script:Calls=New-Object 'System.Collections.Generic.List[string]'
 $script:Logs=New-Object 'System.Collections.Generic.List[string]'
 $script:Fixture=@{mode='pmhq';hasAuthorization=$true;consented=$true;running=$false;online=$false;accountMatches=$false;desktop=@{running=$true}}
 $script:FailRead=$case -eq 'read-fails';$script:FailStart=$case -in @('start-fails','log-fails');$script:FailLog=$case -eq 'log-fails'
 switch($case){
  'online' {$script:Fixture.running=$true;$script:Fixture.online=$true;$script:Fixture.accountMatches=$true}
  'running-offline' {$script:Fixture.running=$true}
  'direct' {$script:Fixture.mode='direct'}
  'missing-token' {$script:Fixture.hasAuthorization=$false}
  'unconsented' {$script:Fixture.consented=$false}
  'unknown-mode' {$script:Fixture.mode='other'}
 }
 $returned=@(Ensure-DeskDesktopQQ -AdminKey 'ISOLATED-ADMIN-SECRET' -LogDirectory 'D:\isolated-launch-fixture')
 $results+=@{name=$case;calls=@($script:Calls.ToArray());logs=@($script:Logs.ToArray());returned=$returned.Count}
}
ConvertTo-Json -InputObject $results -Depth 6 -Compress
`;
 const {stdout,stderr}=await exec('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});
 assert.equal(stderr,'');
 const results=JSON.parse(stdout.trim()),byName=Object.fromEntries(results.map(result=>[result.name,result]));
 assert.equal(results.length,10);
 for(const result of results){
  assert.equal(result.returned,0,`${result.name}: no credential-bearing API response escapes`);
  assert.ok(!JSON.stringify(result).includes('ISOLATED-ADMIN-SECRET'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE-UPSTREAM'));
  assert.equal(result.calls[0],'Get http://127.0.0.1:3200/api/local-qq/state');
  assert.ok(!result.calls.some(call=>/qr|restore|recover|logout/.test(call)));
 }
 for(const name of ['stopped','running-offline','start-fails','log-fails'])assert.equal(byName[name].calls[1],'Post http://127.0.0.1:3200/api/local-qq/start',name);
 for(const name of ['online','direct','missing-token','unconsented','unknown-mode','read-fails'])assert.equal(byName[name].calls.length,1,name);
 for(const name of ['read-fails','start-fails'])assert.equal(byName[name].logs.length,1,name);
 assert.equal(byName['log-fails'].logs.length,0,'even a log write failure must allow the browser to open');
 const raw=fs.readFileSync(launcher);assert.deepEqual([...raw.subarray(0,3)],[0xef,0xbb,0xbf],'Windows PowerShell must read Chinese source as UTF-8');
 const source=raw.toString('utf8');
 assert.ok(source.indexOf('Ensure-DeskDesktopQQ -AdminKey $adminKey')>source.indexOf('$adminKey = [IO.File]::ReadAllText'));
 assert.ok(source.indexOf('Ensure-DeskDesktopQQ -AdminKey $adminKey')<source.indexOf("$deskUrl = 'http://127.0.0.1:3200/?token='"));
});
