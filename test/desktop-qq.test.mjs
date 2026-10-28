import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {DesktopQQ,DESKTOP_QQ_PORT,desktopQQEnvironment,verifyDesktopComponents} from '../src/desktop-qq.mjs';

const base=path.resolve('qa/desktop-qq-tests');fs.mkdirSync(base,{recursive:true});
function fixture(){
 const root=fs.mkdtempSync(path.join(base,'case-')),dataDir=path.join(root,'data'),qqExecutable=path.join(root,'QQ.exe'),componentDir=path.join(root,'components','llbot-8.3.2','bin','pmhq');
 fs.writeFileSync(qqExecutable,'official-client-fixture');fs.mkdirSync(componentDir,{recursive:true});for(const file of ['pmhq.exe','pmhq.dll'])fs.writeFileSync(path.join(componentDir,file),'official-component-fixture');
 const live=new Map(),launches=[],shown=[],calls=[];let existing=[];
 const processes={
  inspect:async(record,kind)=>{calls.push(['inspect',kind]);const actual=live.get(record.pid);return actual&&actual.started===record.started&&actual.executable===record.executable?actual:false},
  capture:async(pid,kind)=>{calls.push(['capture',kind,pid]);if(![200,201].includes(pid))return false;const record={pid,started:String(pid)+'-START',executable:kind==='qq'?qqExecutable:path.join(componentDir,'pmhq.exe')};live.set(pid,record);return record},
  listQQ:async()=>existing,
  validateQQ:async()=>true,
  secure:async()=>true,
  show:async record=>{shown.push(record.pid);return true},
 };
 const launch=(executable,args,options)=>{
  launches.push({executable,args,options});const child=new EventEmitter();child.pid=200;child.unref=()=>{};
  fs.writeSync(options.stdio[1],'QQ 进程 PID: 201\n');queueMicrotask(()=>child.emit('spawn'));return child;
 };
 const g=new DesktopQQ({root,dataDir,qqExecutable,account:'1990000002',owner:'1990000001',processes,launch});g.verify=()=>true;g.available=async()=>true;
 return {g,root,dataDir,qqExecutable,componentDir,processes,launch,live,launches,shown,calls,setExisting:v=>existing=v};
}
const authorization='PRIVATE-DESKTOP-QQ-AUTH';

test('桌面接管环境保留电脑QQ登录目录，只把临时文件和可选网络代理交给子进程',()=>{
 const parent={APPDATA:'C:/user/Roaming',LOCALAPPDATA:'C:/user/Local',TEMP:'C:/temp',HTTPS_PROXY:'old',NO_PROXY:'example.test'},before={...parent};
 const env=desktopQQEnvironment(parent,'D:/test-temp','http://127.0.0.1:7897');
 assert.deepEqual(parent,before);assert.equal(env.APPDATA,parent.APPDATA);assert.equal(env.LOCALAPPDATA,parent.LOCALAPPDATA);assert.equal(env.TEMP,'D:/test-temp');assert.equal(env.TMP,env.TEMP);assert.equal(env.HTTPS_PROXY,'http://127.0.0.1:7897');assert.ok(env.NO_PROXY.includes('127.0.0.1'));assert.equal(desktopQQEnvironment(parent,'D:/temp','').HTTPS_PROXY,'old');
 for(const proxy of ['http://remote.test:7897','http://user:pass@127.0.0.1:7897','http://127.0.0.1:7897/path','http://127.0.0.1:65536','http://localhost:0','https://localhost:7897'])assert.throws(()=>desktopQQEnvironment(parent,'D:/temp',proxy));
});
test('首次启动使用明确的电脑客户端模式和独占回环端口，凭据不进入命令行与状态',async()=>{
 const {g,launches}=fixture();const state=await g.start({authorization,cdn:'china',proxyUrl:'http://127.0.0.1:7897'});
 assert.equal(state.running,true);assert.equal(state.qqRunning,true);assert.equal(state.launching,false);assert.equal(state.port,3312);assert.equal(DESKTOP_QQ_PORT,3312);
 assert.equal(launches.length,1);const {args,options}=launches[0];
 for(const flag of ['--mode=inline','--launch-qq','--host=127.0.0.1','--port=3312','--qq=1990000002','--cdn=china'])assert.ok(args.includes(flag));
 assert.ok(!args.some(arg=>/attach-existing|--pid|headless|auth-token|proxy-global/.test(arg)));assert.ok(!args.join(' ').includes(authorization));assert.equal(options.windowsHide,true);assert.equal(options.detached,true);assert.equal(options.shell,false);assert.equal(typeof options.stdio[1],'number','日志直接写文件，不绑定工作台生命周期');
 assert.equal(options.env.LOCALAPPDATA,process.env.LOCALAPPDATA);assert.equal(options.env.APPDATA,process.env.APPDATA);
 const config=JSON.parse(fs.readFileSync(g.configFile,'utf8'));assert.equal(config.auth_token,authorization);assert.equal(config.default_host,'127.0.0.1');assert.equal(config.default_port,3312);assert.equal(config.headless,false);assert.equal(config.quick_login_qq,'1990000002');assert.equal(config.pmhq_api_token,'');
 assert.ok(!JSON.stringify(state).includes(authorization));assert.equal(typeof g.stop,'undefined');
});
test('同时点击和工作台重启均复用有身份证据的接管进程，不重开QQ',async()=>{
 const f=fixture();const [first,second]=await Promise.all([f.g.start({authorization}),f.g.start({authorization})]);assert.deepEqual(first,second);assert.equal(f.launches.length,1);
 const restarted=new DesktopQQ({root:f.root,dataDir:f.dataDir,qqExecutable:f.qqExecutable,account:'1990000002',owner:'1990000001',processes:f.processes,launch:f.launch});
 const current=await restarted.start({authorization});assert.equal(current.running,true);assert.equal(current.qqRunning,true);assert.equal(f.launches.length,1);
});
test('发现其他QQ或无法确认身份的进程时拒绝注入，不关闭任何用户窗口',async()=>{
 for(const existing of [[{pid:999,executable:'D:/QQ.exe'}],[{unverified:true}]]){
  const {g,setExisting,launches}=fixture();setExisting(existing);const state=await g.status();assert.equal(state.conflict,true);assert.equal(state.running,false);await assert.rejects(g.start({authorization}),e=>e.status===409&&/QQ 窗口/.test(e.message));assert.equal(launches.length,0);assert.equal(fs.existsSync(g.configFile),false);
 }
});
test('接管记录PID复用或启动时间不符时不能误认在线、展示或重新注入QQ',async()=>{
 const {g,live,setExisting,launches,shown}=fixture();await g.start({authorization});live.set(200,{...live.get(200),started:'REUSED'});live.set(201,{...live.get(201),started:'REUSED'});setExisting([{pid:201}]);
 const state=await g.status();assert.equal(state.running,false);assert.equal(state.qqRunning,false);assert.equal(state.conflict,true);await assert.rejects(g.open(),/尚未找到/);await assert.rejects(g.start({authorization}),/未由工作台管理/);assert.equal(launches.length,1);assert.deepEqual(shown,[]);
});
test('打开窗口只定位已验证的受管QQ，托盘窗口无法显示时不另开QQ',async()=>{
 const {g,shown,launches,processes}=fixture();await g.start({authorization});await g.open();assert.deepEqual(shown,[201]);assert.equal(launches.length,1);
 processes.show=async()=>false;await assert.rejects(g.open(),/托盘|右下角/);assert.equal(launches.length,1);
});
test('组件、官方QQ或端口检查失败时不写凭据也不启动程序',async()=>{
 for(const failure of ['hash','client','port','permissions']){
  const {g,launches,processes}=fixture();
  if(failure==='hash')g.verify=()=>false;
  if(failure==='client')processes.validateQQ=async()=>false;
  if(failure==='port')g.available=async()=>false;
  if(failure==='permissions')processes.secure=async()=>false;
  await assert.rejects(g.start({authorization}));assert.equal(launches.length,0);assert.equal(fs.existsSync(g.configFile),false);
 }
});
test('主号、非法可执行文件、代理和线路参数均无法触发启动',async()=>{
 for(const invalid of ['owner','executable','proxy','cdn','authorization']){
  const {g,launches}=fixture();const options={authorization};
  if(invalid==='owner')g.account=g.owner;
  if(invalid==='executable')g.qqExecutable='not-an-absolute-QQ.exe';
  if(invalid==='proxy')options.proxyUrl='http://other-host:7897';
  if(invalid==='cdn')options.cdn='other';
  if(invalid==='authorization')options.authorization='x\nsecret';
  await assert.rejects(g.start(options));assert.equal(launches.length,0);
 }
});
test('只从本次启动日志提取QQ PID，旧日志或不同程序不能成为受管窗口',async()=>{
 const {g,processes}=fixture();fs.mkdirSync(g.dir,{recursive:true});fs.writeFileSync(path.join(g.dir,'pmhq.stdout.log'),'QQ 进程 PID: 999\n');
 const original=processes.capture;const captured=[];processes.capture=async(pid,kind,after)=>{captured.push([pid,kind]);return original(pid,kind,after)};
 await g.start({authorization});assert.ok(captured.some(([pid,kind])=>pid===201&&kind==='qq'));assert.ok(!captured.some(([pid])=>pid===999));
});
test('组件指纹校验拒绝不存在或改动的原生文件',()=>{
 const {componentDir}=fixture();assert.equal(verifyDesktopComponents(componentDir),false);assert.equal(verifyDesktopComponents(path.join(componentDir,'missing')),false);
});
test('用户确认的小号可连接到唯一已登录QQ，不另开客户端或改变登录',async()=>{
 const f=fixture();f.setExisting([{pid:201,started:'201-START',executable:f.qqExecutable}]);
 const state=await f.g.attachExisting({authorization,confirmedAccount:f.g.account});
 assert.equal(state.running,true);assert.equal(state.qqRunning,true);assert.equal(f.launches.length,1);
 const args=f.launches[0].args;assert.ok(args.includes('--pid=201'));assert.ok(!args.includes('--launch-qq'));assert.ok(!args.some(a=>a.startsWith('--qq=')));
 assert.equal(JSON.parse(fs.readFileSync(f.g.qqFile,'utf8')).pid,201);
 await f.g.start({authorization});assert.equal(f.launches.length,1,'日后入口复用已连接的小号');
});
test('未确认、主号、多窗口、不同QQ路径及PID复用均不能连接现有窗口',async()=>{
 for(const reason of ['missing','owner','multiple','wrong-path','reused']){
  const f=fixture(),target={pid:201,started:reason==='reused'?'OLD':'201-START',executable:reason==='wrong-path'?path.join(f.root,'other/QQ.exe'):f.qqExecutable};
  f.setExisting(reason==='multiple'?[target,{...target,pid:202}]:[target]);
  await assert.rejects(f.g.attachExisting({authorization,confirmedAccount:reason==='missing'?undefined:reason==='owner'?f.g.owner:f.g.account}));
  assert.equal(f.launches.length,0);assert.equal(fs.existsSync(f.g.configFile),false);
 }
});
