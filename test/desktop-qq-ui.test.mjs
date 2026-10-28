// Run only the shipped browser module with inert DOM/network/process peers.
// No server, saved credentials, QQ client, real account or model is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/local-qq.js',import.meta.url),'utf8');
const desktop=(extra={})=>({
 mode:'pmhq',observedAt:10,installed:true,running:true,online:false,accountMatches:false,
 active:true,state:'awaiting-client-login',detail:'请在电脑 QQ 客户端登录指定小号。',
 account:'123456789',version:'fixture',desktop:{running:true},hasAuthorization:true,
 authorization:{valid:true},savedLogin:{available:true},...extra
});
function fixture(initial=desktop()){
 const requests=[],intervals=[],confirmations=[],listeners=new Map();
 let requestReply;
 const panel={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};
 const state={localQQ:initial,channels:{qq:{state:'disconnected',detail:initial.detail}}};
 const context=vm.createContext({
  data:{state},qqWorkspace:()=>'',handlers:{},view:'qq',AbortController,
  document:{hidden:false,addEventListener:(kind,callback)=>listeners.set(kind,callback)},
  setInterval:callback=>intervals.push(callback),
  esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  badge:(label,color)=>`<span class="${color}">${label}</span>`,
  button:(label,action)=>`<button data-action="${action}">${label}</button>`,
  api:async(route,options)=>{requests.push({route,options});return requestReply?requestReply(route,options):context.data.state.localQQ;},
  post:async(route,body)=>{requests.push({route,body,method:'POST'});return context.data.state.localQQ;},
  $:selector=>selector==='#local-qq-panel'?panel:selector==='#modal'?{classList:{contains:()=>true}}:null,
  confirm:question=>{confirmations.push(question);return true;},toast:()=>{},refresh:async()=>{}
 });
 vm.runInContext(source+`
 globalThis.testUI={card:localQQCard,update:localQQUpdate,handlers,
  setState(value){data.state.localQQ=value;},
  setQR(value){localQr=value;localQrExpired=true;localQrError='旧二维码错误';},
  qrState:()=>({qr:localQr,expired:localQrExpired,error:localQrError}),
  data:()=>data
 };`,context);
 return {ui:context.testUI,requests,intervals,listeners,panel,confirmations,respondWith(callback){requestReply=callback;}};
}

test('desktop mode has no direct-protocol restore, QR, logout or rollback controls in any state',()=>{
 const {ui}=fixture();
 ui.setQR({image:'data:image/png;base64,STALE-FIXTURE',expiresAt:9999999999999});
 for(const state of ['stopped','starting','checking','awaiting-scan','saved-login','restore-pending','login-required','wrong-account','online']){
  const html=ui.card(desktop({state,online:state==='online',accountMatches:state==='online'}));
  assert.match(html,/电脑 QQ/);
  for(const unwanted of ['local-qq-qr"','local-qq-recover"','local-qq-restore"','local-qq-logout"','local-qq-rollback"','STALE-FIXTURE','显示 / 刷新二维码','二维码已过期']){
   assert.ok(!html.includes(unwanted),`${state}: ${unwanted}`);
  }
 }
});

test('desktop polling never requests a QR even if a stale direct-mode scan state remains',async()=>{
 const {ui,requests,intervals,panel}=fixture(desktop({state:'awaiting-scan'}));
 ui.setQR({image:'data:image/png;base64,STALE-FIXTURE',expiresAt:1});
 for(let i=0;i<3;i++){
  ui.update(ui.data().state.localQQ);
  for(const callback of intervals)await callback();
  await Promise.resolve();
 }
 assert.ok(requests.length>0,'normal state polling is still active');
 assert.ok(requests.every(({route})=>route==='local-qq/state'));
 assert.equal(ui.qrState().qr,null);
 assert.equal(ui.qrState().expired,false);
 assert.equal(ui.qrState().error,'');
 assert.ok(!panel.innerHTML.includes('STALE-FIXTURE'));
});

test('start and open-client actions use only their desktop backend routes',async()=>{
 const {ui,requests}=fixture();
 await ui.handlers['local-qq-start']();
 await ui.handlers['local-qq-open-client']();
 assert.deepEqual(requests.map(({route,method})=>[route,method]),[
  ['local-qq/start','POST'],['local-qq/open-client','POST']
 ]);
});

test('a stale QR action is inert after switching to desktop mode',async()=>{
 const {ui,requests}=fixture();
 await ui.handlers['local-qq-qr']();
 assert.deepEqual(requests,[]);
});

test('switching to desktop mode cancels and discards an in-flight direct-mode QR result',async()=>{
 const {ui,requests,respondWith}=fixture(desktop({mode:'direct',state:'checking'}));
 let resolveQR;respondWith(()=>new Promise(resolve=>resolveQR=resolve));
 const pending=ui.handlers['local-qq-qr']();
 assert.equal(requests.length,1);assert.equal(requests[0].route,'local-qq/qr');
 const current=desktop();ui.setState(current);ui.update(current);
 assert.equal(requests[0].options.signal.aborted,true);
 resolveQR({image:'data:image/png;base64,STALE-RESPONSE',expiresAt:Date.now()+60000});
 await pending;
 assert.equal(ui.qrState().qr,null);
 assert.equal(ui.qrState().error,'');
 assert.ok(!ui.card(current).includes('STALE-RESPONSE'));
});

test('online target account can be activated, while another QQ account cannot',()=>{
 const {ui}=fixture();
 const correct=ui.card(desktop({online:true,accountMatches:true,active:false,state:'online',detail:'测试小号已登录。'}));
 assert.match(correct,/小号已登录/);
 assert.match(correct,/机器人 QQ 123456789/);
 assert.match(correct,/data-action="local-qq-activate"/);
 const wrong=ui.card(desktop({online:true,accountMatches:false,active:false,state:'wrong-account',detail:'当前登录账号不是指定小号，请切换。'}));
 assert.match(wrong,/账号不符/);
 assert.match(wrong,/当前登录账号不是指定小号/);
 assert.ok(!wrong.includes('data-action="local-qq-activate"'));
 assert.ok(!wrong.includes('小号已登录'));
});

test('desktop page requests authorization only and never accepts a QQ password',()=>{
 const {ui}=fixture(),withToken=ui.card(desktop()),withoutToken=ui.card(desktop({hasAuthorization:false}));
 assert.ok(!withToken.includes('type="password"'));
 assert.match(withoutToken,/接入服务授权令牌/);
 assert.match(withoutToken,/name="authorization" type="password"/);
 assert.ok(!/name="(?:password|qqPassword|qq_password|uin|qqAccount)"/.test(withoutToken));
 assert.match(withoutToken,/QQ 密码只在 QQ 客户端输入/);
});

test('module startup, idle polls and page lifecycle do not stop or log out the desktop client',async()=>{
 const {requests,intervals,listeners}=fixture();
 for(const type of ['beforeunload','unload','pagehide','visibilitychange']){
  const listener=listeners.get(type);if(listener)await listener({type});
 }
 for(const callback of intervals)await callback();
 await Promise.resolve();
 assert.ok(requests.every(({route})=>route==='local-qq/state'));
});

test('explicit stop asks confirmation that the QQ client stays running',async()=>{
 const {ui,requests,confirmations}=fixture();
 await ui.handlers['local-qq-stop']();
 assert.equal(confirmations.length,1);assert.match(confirmations[0],/电脑 QQ 仍保留运行/);
 assert.deepEqual(requests.map(({route})=>route),['local-qq/stop']);
 assert.ok(!requests.some(({route})=>route.endsWith('/logout')));
});
test('连接已登录小号需要确认，页面只在外部窗口冲突时提供此动作',async()=>{
 const {ui,requests,confirmations}=fixture(desktop({state:'client-conflict'}));
 assert.match(ui.card(desktop({state:'client-conflict'})),/data-action="local-qq-attach"/);
 assert.ok(!ui.card(desktop({state:'online'})).includes('data-action="local-qq-attach"'));
 await ui.handlers['local-qq-attach']();assert.equal(confirmations.length,1);assert.match(confirmations[0],/123456789/);
 const call=requests.find(x=>x.route==='local-qq/attach-desktop');assert.equal(call.body.confirmed,true);assert.equal(call.body.account,'123456789');
 assert.ok(!requests.some(x=>/stop|logout/.test(x.route)));
});
