// Execute the shipped browser module with inert DOM/timer/network peers.
// These tests never start a server, load local credentials or contact QQ/Weixin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/local-qq.js',import.meta.url),'utf8');
const login=(observedAt=200,online=true)=>({
 observedAt,installed:true,running:true,online,accountMatches:online,active:true,
 state:online?'online':'reconnecting',detail:online?'小号已连接':'网络中断，等待重连',
 hasAuthorization:true,authorization:{valid:true},savedLogin:{available:true},
 account:'123456789',version:'fixture'
});
const state=(localQQ=login(),weixin='old-weixin')=>({
 localQQ,channels:{qq:{state:localQQ.online?'online':'offline',detail:localQQ.detail},weixin:{state:weixin}},
 model:{id:'fixture-model'},zones:[{id:'fixture-zone'}]
});
function fixture(current=state()){
 const requests=[];
 const context=vm.createContext({
  data:{state:current},qqWorkspace:()=>'',handlers:{},view:'test',
  document:{addEventListener(){}},setInterval(){},
  esc:v=>String(v??''),badge:(s,c)=>`<span class="${c}">${s}</span>`,
  button:(label,action)=>`<button data-action="${action}">${label}</button>`,
  api:(route,options)=>new Promise((resolve,reject)=>requests.push({route,options,resolve,reject})),
  post:()=>{throw Error('unexpected action in offline state test')},
  $:()=>null,AbortController
 });
 vm.runInContext(source+`
 globalThis.testUI={
  epoch:localQQPollEpoch,merge:localQQMergeState,refresh:localQQRefresh,card:localQQCard,
  data:()=>data,
  setState(value){data.state=value;},
  advanceEpoch(){localStateEpoch++;},
  setBusy(value){localBusy=value;},
  setLoading(value){localLoadPending=value;},
  setQR(qr,expired=false){localQr=qr;localQrExpired=expired;}
 };`,context);
 return {ui:context.testUI,requests};
}

test('older QQ observations cannot replace a newer login while fresh Weixin/model data still lands',()=>{
 const current=state(),{ui}=fixture(current),next=state(login(100,false),'new-weixin');
 next.model={id:'new-model'};
 const result=ui.merge(next,ui.epoch());
 assert.equal(result.localQQ,current.localQQ);
 assert.equal(result.channels.qq,current.channels.qq);
 assert.equal(result.channels.weixin,next.channels.weixin);
 assert.equal(result.model,next.model);
 assert.equal(result.zones,next.zones);
 assert.equal(next.localQQ.online,false,'the incoming object must not be mutated');
 assert.equal(current.channels.weixin.state,'old-weixin','the current object must not be mutated');
});

test('poll from before an operation cannot replace its result even with a newer observation timestamp',()=>{
 const current=state(),{ui}=fixture(current),oldEpoch=ui.epoch();
 ui.advanceEpoch();
 const next=state(login(999,false),'new-weixin'),result=ui.merge(next,oldEpoch);
 assert.equal(result.localQQ,current.localQQ);
 assert.equal(result.channels.qq,current.channels.qq);
 assert.equal(result.channels.weixin,next.channels.weixin);
});

test('busy actions and QR requests preserve QQ independently without blocking another channel',()=>{
 for(const flag of ['setBusy','setLoading']){
  const current=state(),{ui}=fixture(current),next=state(login(300,false),'new-weixin');
  ui[flag](true);
  const result=ui.merge(next,ui.epoch());
  assert.equal(result.localQQ,current.localQQ,flag);
  assert.equal(result.channels.qq,current.channels.qq,flag);
  assert.equal(result.channels.weixin,next.channels.weixin,flag);
  ui[flag](false);
  assert.equal(ui.merge(next,ui.epoch()),next,`${flag}: later real state should be accepted`);
 }
});

test('a newer genuine offline observation is accepted; online is not permanently sticky',()=>{
 const {ui}=fixture(),next=state(login(300,false),'offline-weixin');
 const result=ui.merge(next,ui.epoch());
 assert.equal(result,next);
 assert.equal(result.localQQ.online,false);
 assert.equal(result.channels.qq.state,'offline');
 assert.equal(result.channels.weixin.state,'offline-weixin');
});

test('initial/no-local-core views retain their complete incoming state',()=>{
 for(const current of [undefined,{channels:{weixin:{state:'old'}}}]){
  const {ui}=fixture(current),next=state();
  // Explicit undefined selects the default argument, so set it after creation.
  ui.setState(current);
  assert.equal(ui.merge(next,ui.epoch()),next);
 }
 const {ui}=fixture(),legacy={channels:{qq:{state:'offline'},weixin:{state:'online'}}};
 assert.equal(ui.merge(legacy,ui.epoch()),legacy);
});

test('real refresh helper rejects an old response after a newer action and coalesces concurrent reads',async()=>{
 const current=state(),{ui,requests}=fixture(current),a=ui.refresh(),b=ui.refresh();
 assert.equal(requests.length,1);
 assert.equal(requests[0].route,'local-qq/state');
 ui.advanceEpoch();
 const restored=state(login(500));ui.setState(restored);
 requests[0].resolve(login(900,false));
 await Promise.all([a,b]);
 assert.equal(ui.data().state.localQQ,restored.localQQ);
 const fresh=ui.refresh();
 assert.equal(requests.length,2,'pending request must be released after the old response');
 const offline=login(1000,false);requests[1].resolve(offline);await fresh;
 assert.equal(ui.data().state.localQQ,offline);
});

test('real refresh helper rejects old timestamps and responses arriving during busy work',async()=>{
 for(const flag of ['timestamp','setBusy','setLoading']){
  const current=state(),{ui,requests}=fixture(current),read=ui.refresh();
  if(flag!=='timestamp')ui[flag](true);
  requests[0].resolve(login(flag==='timestamp'?100:300,false));
  await read;
  assert.equal(ui.data().state.localQQ,current.localQQ,flag);
 }
});

test('a failed refresh releases its request slot for the next health check',async()=>{
 const {ui,requests}=fixture(),read=ui.refresh();
 requests[0].reject(Error('fixture connection failure'));
 await assert.rejects(read,/fixture connection failure/);
 const retry=ui.refresh();assert.equal(requests.length,2);
 requests[1].resolve(login(300));await retry;
 assert.equal(ui.data().state.localQQ.observedAt,300);
});

test('restoring card hides stale QR/expiry and duplicate restore or reconnect controls',()=>{
 const {ui}=fixture();
 ui.setQR({image:'data:image/png;base64,fixture',expiresAt:1},true);
 const restoring={...login(300,false),state:'restoring',detail:'正在恢复上次登录，请稍候'};
 const html=ui.card(restoring);
 assert.match(html,/正在恢复上次登录/);
 for(const unwanted of ['二维码已过期','data:image/png','data-action="local-qq-qr"',
  'data-action="local-qq-restore"','data-action="local-qq-recover"','需重新登录']){
  assert.ok(!html.includes(unwanted),unwanted);
 }
 const checking=ui.card({...restoring,state:'checking',detail:'正在检查连接'});
 assert.match(checking,/正在检查连接/);
 assert.ok(!checking.includes('二维码已过期'));
 const pending=ui.card({...restoring,state:'restore-pending',detail:'恢复请求已提交，等待确认'});
 assert.match(pending,/恢复待确认/);
 assert.ok(!pending.includes('需重新登录'),'pending confirmation is not an expired-session assertion');
});
