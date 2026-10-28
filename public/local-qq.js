// Local QQ login belongs to the dual workbench, not to the embedded legacy UI.
let localQr=null,localBusy=false,localStateSignature='',localLoadPending=false;
let localQrError='',localQrRetryAt=0,localQrAttempts=0,localQrExpired=false,localQrGeneration=0,localQrAbort=null;
const LOCAL_QR_RETRY_LIMIT=3;
let localRefreshPending=null,localStateEpoch=0;
const legacyQQWorkspace=qqWorkspace;
const qqAuthorizationLink=()=>'<a class="button" href="https://auth.luckylillia.com" data-action="qq-open-authorization" target="_blank" rel="noopener noreferrer">申请 / 查看授权 ↗</a>';
const qqAuthorizationHelp=()=>`<div class="authorization-guide"><p>这是电脑 QQ 接入组件的 <strong>LLBot／PMHQ 授权</strong>，用你自己的 GitHub 账号办理。</p><ol class="authorization-steps"><li><strong>打开授权站</strong><p>点下方“申请 / 查看授权”，工作台会用夸克打开 auth.luckylillia.com。</p></li><li><strong>使用 GitHub 登录并完成申请</strong><p>按站点提示登录、确认授权并提交所需信息。已有申请时，使用原来的 GitHub 账号查看状态；如需审核，等待站点通知。</p></li><li><strong>取得接入服务的 Auth Token</strong><p>在授权站取得你的 LLBot／PMHQ 令牌。填写的是该站提供的令牌，不是 GitHub Personal Access Token，也不是 DeepSeek API Key 或 QQ 密码。</p></li><li><strong>回到伴屿填写并检查</strong><p>在“QQ 工作台 → 管理授权”粘贴令牌，阅读说明后保存。首次使用再启动后台，在 QQ 客户端登录小号，最后点“检查连接”。</p></li></ol><div class="actions">${qqAuthorizationLink()}${button('官方说明','qq-open-docs','','small')}</div><details class="inline-help"><summary>申请或验证没有通过？</summary><p>显示账号条件不满足或待审核：按授权站的当前提示处理，审核条件和时间以站点为准。</p><p>授权站打不开：在夸克检查 GitHub 和授权站能否访问，网络或站点暂时异常时稍后重试。已有令牌不需要因此清除。</p><p>已保存新令牌但仍显示“待应用”：当前 QQ 在线时不会强制断开，工作台会按页面提示在下次接管时应用。</p></details><p class="small">每位使用者使用自己的授权；令牌只填写在本机。申请授权不代表 QQ 已登录，模型来源和 Key 仍在“接入与模型”分别设置。</p></div>`;
handlers['qq-authorization-guide']=()=>showModal('用 GitHub 申请 QQ 接入授权',qqAuthorizationHelp()+`<div class="actions section">${button('填写接入授权','local-qq-credentials','','primary')}${button('关闭','close')}</div>`);
handlers['qq-open-docs']=async()=>{await post('links/qq-docs');toast('官方说明已在夸克打开');};
const localStatus=s=>({missing:'待安装',stopped:'未启动',starting:'启动中',checking:'检查连接',authorization:'连接授权服务','connection-error':'连接需检查','saved-login':'可恢复登录',restoring:'正在恢复','restore-pending':'恢复待确认',reconnecting:'等待重连','login-required':'需重新登录','awaiting-scan':'等待扫码','awaiting-client':'等待小号登录','client-conflict':'请检查 QQ 窗口','mode-mismatch':'接入切换中',online:'已登录','wrong-account':'账号不符'}[s]||'待检查');
function localQQPollEpoch(){return localStateEpoch;}
function localQQMergeState(next,epoch){
 const current=data.state;
 if(!current?.localQQ||!next.localQQ)return next;
 const stale=epoch!==localStateEpoch||localBusy||localLoadPending||Number(current.localQQ.observedAt||0)>Number(next.localQQ.observedAt||0);
 return stale?{...next,localQQ:current.localQQ,channels:{...next.channels,qq:current.channels.qq}}:next;
}
function desktopQQCard(g){
 const good=g.online&&g.accountMatches;
 const authForm=!g.hasAuthorization?`<form id="local-qq-auth" class="local-qq-auth"><div class="field"><label for="local-qq-authorization">接入服务授权令牌</label><input id="local-qq-authorization" name="authorization" type="password" autocomplete="new-password" required minlength="8"></div><label class="local-qq-consent"><input type="checkbox" name="consented" required>我已了解接入组件会联系其开发者授权服务。</label><div class="actions"><button type="submit" class="button primary">保存并启动</button>${qqAuthorizationLink()}</div></form>`:'';
 return `<section class="card local-qq-card"><div class="card-head"><div class="entity-heading"><div class="avatar blue">Q</div><div><div class="eyebrow">伴屿 · 电脑 QQ</div><h3>电脑 QQ 接入</h3></div></div>${badge(good?'小号已登录':localStatus(g.state),good?'green':'amber')}</div><div class="local-qq-stages"><span class="${g.desktop?.running?'done':''}">1 · 启动电脑 QQ</span><span class="${good?'done':''}">2 · 小号登录</span><span class="${good&&g.active?'done':''}">3 · 工作台接管</span></div><div class="local-qq-summary"><div><strong>${esc(g.detail)}</strong><p class="meta">使用电脑 QQ 保存的登录状态，后续桌面入口会沿用此方式。</p></div>${badge('机器人 QQ '+g.account,good?'green':'blue')}</div>${authForm}<p class="small local-qq-login-help">首次使用时，在 QQ 客户端登录鲸鲸小号，并按需开启记住密码或自动登录。登录后可将 QQ 最小化；关闭本工作台窗口不会退出后台。退出 QQ、关机或休眠会暂停收发；QQ 要求重新验证时仍需你确认。</p><div class="actions">${g.hasAuthorization?button(g.running?'检查后台连接':'启动后台服务','local-qq-start','','primary'):''}${g.hasAuthorization?button('打开 QQ 登录','local-qq-open-client'):''}${g.hasAuthorization&&g.state==='client-conflict'?button('连接已登录的小号','local-qq-attach'):''}${good&&!g.active?button('接管聊天','local-qq-activate','','primary'):''}${g.running?button('停止聊天接管','local-qq-stop'):''}${button('连接设置','local-qq-network')}${button('更换接入授权','local-qq-credentials')}</div>${g.failure&&g.failure!==g.detail?`<div class="note">${esc(g.failure)}</div>`:''}<details class="local-qq-about"><summary>接入说明与来源</summary><p>由电脑 QQ 客户端保持登录，LLBot ${esc(g.version)} 的客户端接入组件连接伴屿聊天引擎。只接管指定小号，主号不接入。</p><p>人设、群白名单、主动聊天、模型与会话记录继续沿用。QQ 密码只在 QQ 客户端输入，本工作台不收集密码。</p><a href="https://github.com/LLOneBot/LuckyLilliaBot" target="_blank" rel="noreferrer">查看接入组件官方项目 ↗</a></details></section>`;
}
function localQQCard(g){
 if(!g.installed)return `<section class="card local-qq-card"><div class="card-head"><h3>电脑 QQ 接入</h3>${badge('待安装','amber')}</div><p>先运行“首次设置”填写自己的主人号、小号和程序路径，再安装 QQ 接入组件。组件从 LLBot 官方发布下载并校验，不会替你登录 QQ。</p><div class="actions">${button('安装 QQ 接入组件','local-qq-install','','primary')}${qqAuthorizationLink()}</div><p class="small section">安装完成后返回这里，填写自己的授权令牌，再在电脑 QQ 登录小号。</p></section>`;
 if(g.mode==='pmhq')return desktopQQCard(g);
 const good=g.online&&g.accountMatches,active=g.active,canScan=g.running&&!g.online&&g.authorization?.valid&&['awaiting-scan','saved-login','login-required','restore-pending'].includes(g.state);
 const authForm=!g.hasAuthorization?`<form id="local-qq-auth" class="local-qq-auth"><div class="field"><label for="local-qq-authorization">新核心授权令牌</label><input id="local-qq-authorization" name="authorization" type="password" autocomplete="new-password" placeholder="仅在此电脑填写，不用发给我" required minlength="8"></div><label class="local-qq-consent"><input type="checkbox" name="consented" required>我已了解：LLBot 的授权与签名会联系其开发者服务；它独立于 DSH 模型服务。</label><div class="actions"><button type="submit" class="button primary">保存并启动</button><a class="button" href="https://auth.luckylillia.com" data-action="qq-open-authorization" target="_blank" rel="noreferrer">前往官方获取授权令牌 ↗</a></div><p class="small">令牌只保存在本机受保护的数据目录，不回显、不写入导出文件。QQ 核心为 LuckyLilliaBot ${esc(g.version)}，管理界面与接入逻辑由伴屿双端工作台提供。</p></form>`:'';
 const actions=g.hasAuthorization?`<div class="actions">${!g.running?button('启动新核心','local-qq-start','','primary'):''}${!g.online&&g.state!=='restoring'&&g.savedLogin?.available?button('恢复上次登录','local-qq-restore','',g.state==='saved-login'?'primary':''):''}${canScan?button('显示 / 刷新二维码','local-qq-qr','',g.state==='saved-login'?'':'primary'):''}${g.running&&!g.online&&g.state!=='restoring'?button('重新连接扫码','local-qq-recover'):''}${good&&!active?button('启用新接入','local-qq-activate','','primary'):''}${active?button('切回旧接入','local-qq-rollback'):''}${g.running?button('停止新核心','local-qq-stop'):''}${g.online&&!active?button('退出此账号','local-qq-logout'):''}${button('连接设置','local-qq-network')}${button('更换授权令牌','local-qq-credentials')}</div>`:'';
 const image=localQr&&canScan?`<div class="local-qq-qr"><img src="${esc(localQr.image)}" alt="鲸鲸小号 QQ 登录二维码"><div><strong>请用 QQ 小号扫码</strong><p>指定账号：${esc(g.account)}</p><p class="small">扫码后在手机上确认登录。若误扫主号，工作台会阻止启用。</p><span id="local-qq-expiry" class="badge blue"></span></div></div>`:'';
 const qrNotice=canScan&&(localLoadPending||localQrError||localQrExpired)?`<div class="note local-qq-qr-notice" role="status">${localLoadPending?'正在获取二维码，请稍候…':localQrExpired?'二维码已过期，请点击“显示 / 刷新二维码”重新获取。':esc(localQrError)+(localQrAttempts<LOCAL_QR_RETRY_LIMIT?'，正在等待后自动重试。':'。请点击“显示 / 刷新二维码”重试。')}</div>`:'';
 return `<section class="card local-qq-card"><div class="card-head"><div class="entity-heading"><div class="avatar blue">Q</div><div><div class="eyebrow">伴屿 · QQ 接入</div><h3>QQ 接入</h3></div></div>${badge(localStatus(g.state),good?'green':'amber')}</div><div class="local-qq-stages"><span class="${g.hasAuthorization?'done':''}">1 · 核心授权</span><span class="${good?'done':''}">2 · 小号登录</span><span class="${active?'done':''}">3 · 接管聊天</span></div><div class="local-qq-summary"><div><strong>${esc(g.detail)}</strong><p class="meta">${active?'当前使用新 QQ 核心，不需要挂着 SnowLuma 或 QQ 客户端。':'新接入尚未启用，现有 QQ 接入和聊天设置继续保留。'}</p></div>${good?badge('小号已核对','green'):badge('机器人 QQ '+g.account,'blue')}</div>${authForm}<p class="small local-qq-login-help">已保存的登录状态可尝试免扫码恢复。当前核心不支持 QQ 账号密码登录；网络短暂中断时核心会自动尝试重连；QQ 拒绝恢复登录时仍需扫码。</p>${image}${qrNotice}${actions}${g.failure&&g.failure!==g.detail?`<div class="note">${esc(g.failure)}</div>`:''}<details class="local-qq-about"><summary>接入说明与来源</summary><p>QQ 核心：LuckyLilliaBot ${esc(g.version)}，使用其纯协议模式，经本机 OneBot 接口连接原有聊天逻辑。核心有开发者授权与远程签名依赖，不能视为完全离线、自研 QQ 协议。</p><p>原人设、群白名单、主动聊天和记录继续使用原桥接。登录正确的小号并通过接口检查后，才允许启用；需要时可切回旧接入。</p><a href="https://github.com/LLOneBot/LuckyLilliaBot" target="_blank" rel="noreferrer">查看核心官方项目 ↗</a></details></section>`;
}
qqWorkspace=function(){
 if(data.state.qqNative&&typeof qqNativeWorkspace==='function')return qqNativeWorkspace();
 const q=data.state.channels.qq,g=data.state.localQQ;
 return pageHead('QQ 工作台','登录、连接与聊天设置，都在伴屿管理。',button('检查连接','qq-connect'),'BANYU / QQ')+`<div class="qq-status-strip"><span>${badge(stateLabel(q.state),online(q.state)?'green':'amber')} ${esc(q.detail)}</span><span class="small">电脑 QQ 后台常驻</span></div><div id="local-qq-panel">${localQQCard(g)}</div>`;
};
function localQQUpdate(g){
 if(!g||view!=='qq')return;
 if(g.mode==='pmhq'&&localQrAbort){localQrGeneration++;localQrAbort.abort();localQrAbort=null;localLoadPending=false;}
 if(g.mode==='pmhq'||g.online||!g.running||g.authorization?.valid===false){localQr=null;localQrError='';localQrExpired=false;}
 const signature=JSON.stringify([g,localQr?.expiresAt,localLoadPending,localQrError,localQrExpired]);const panel=$('#local-qq-panel');if(!panel)return;
 const editing=panel.querySelector('input:focus')||panel.querySelector('#local-qq-authorization')?.value;
 if(signature!==localStateSignature&&!editing&&!localBusy){panel.innerHTML=localQQCard(g);localStateSignature=signature;}
 panel.querySelectorAll('button').forEach(b=>{b.disabled=localBusy||localLoadPending;});
 const expiry=$('#local-qq-expiry');if(expiry&&localQr){const seconds=Math.ceil((localQr.expiresAt-Date.now())/1000);expiry.textContent=seconds>0?'二维码预计 '+seconds+' 秒内有效':'二维码已过期，请点击刷新';if(seconds<=0){localQr=null;localQrExpired=true;const img=$('.local-qq-qr img');if(img)img.remove();}}
 if(g.mode!=='pmhq'&&g.state==='awaiting-scan'&&!localQr&&!localQrExpired&&!localLoadPending&&!localBusy&&localQrAttempts<LOCAL_QR_RETRY_LIMIT&&Date.now()>=localQrRetryAt)localQQGetQr({automatic:true}).catch(()=>{});
 if(!g.running){localQrAttempts=0;localQrRetryAt=0;localQrExpired=false;}
}
async function localQQRefresh(){
 if(localRefreshPending)return localRefreshPending;
 const epoch=localStateEpoch;localRefreshPending=api('local-qq/state').then(g=>{if(epoch===localStateEpoch&&!localBusy&&!localLoadPending&&Number(g.observedAt||0)>=Number(data.state.localQQ?.observedAt||0)){data.state.localQQ=g;localQQUpdate(g);}return g;}).finally(()=>{localRefreshPending=null});return localRefreshPending;
}
async function localQQGetQr({automatic=false}={}){
 if(data.state?.localQQ?.mode==='pmhq')return;
 if(localLoadPending||localBusy)return;if(!automatic){localStateEpoch++;localQr=null;localQrAttempts=0;localQrRetryAt=0;localQrExpired=false;}localLoadPending=true;localQrError='';localQQUpdate(data.state.localQQ);
 const generation=localQrGeneration,abort=new AbortController();localQrAbort=abort;
 try{const qr=await api('local-qq/qr',{method:'POST',body:{renew:!automatic},signal:abort.signal});if(generation!==localQrGeneration)return;localQr=qr;localQrAttempts=0;localQrRetryAt=0;localQrExpired=false;}
 catch(error){if(generation!==localQrGeneration)return;localQrError=error.message;localQrAttempts++;localQrRetryAt=Date.now()+Math.min(30000,2000*2**(localQrAttempts-1));throw error;}
 finally{if(localQrAbort===abort){localQrAbort=null;localLoadPending=false;localStateSignature='';localQQUpdate(data.state.localQQ);}}
}
async function localQQAction(action,question){if(localBusy||localLoadPending)return;if(question&&!confirm(question))return;localBusy=true;localStateEpoch++;localQrGeneration++;localQrAbort?.abort();localQrAbort=null;localLoadPending=false;localQr=null;localQrError='';localQrAttempts=0;localQrRetryAt=0;localQrExpired=false;localQQUpdate(data.state.localQQ);if(action==='restore'){const summary=$('.local-qq-summary strong');if(summary)summary.textContent='正在恢复上次登录，请稍候…';}try{const result=await post('local-qq/'+action);if(['activate','rollback'].includes(action)){data.state.localQQ=await api('local-qq/state');toast('接入配置已保存，聊天服务正在重新连接');await refresh();}else{data.state.localQQ=result;}localStateSignature='';}finally{localBusy=false;localQQUpdate(data.state.localQQ);}}
handlers['local-qq-start']=()=>localQQAction('start');handlers['local-qq-qr']=()=>localQQGetQr();
handlers['local-qq-install']=async()=>{await post('local-qq/install');toast('安装窗口已打开，完成后返回工作台即可。');};
handlers['local-qq-open-client']=()=>localQQAction('open-client');
handlers['local-qq-recover']=()=>localQQAction('recover');
handlers['local-qq-restore']=()=>localQQAction('restore');
handlers['local-qq-stop']=()=>localQQAction('stop',data.state.localQQ.mode==='pmhq'?'停止工作台聊天接管？电脑 QQ 仍保留运行。':data.state.localQQ.active?'停止新核心会让 QQ 暂时无法收发，确定停止吗？':'确定停止新 QQ 核心吗？');
handlers['local-qq-logout']=()=>localQQAction('logout','确定退出新核心中的 QQ 账号吗？');
handlers['local-qq-activate']=()=>localQQAction('activate');handlers['local-qq-rollback']=()=>localQQAction('rollback','切回原 SnowLuma 接入？原接入需要已启动并登录小号。');
handlers['local-qq-network']=()=>form('QQ 核心连接设置',`<div class="note">仅用于 QQ 核心的授权与签名连接。保存后在下次启动核心时生效；当前登录会保留。</div>${qqAuthorizationHelp()}${field('连接线路',`<select name="cdn"><option value="cf" ${data.state.localQQ.cdn!=='china'?'selected':''}>默认线路</option><option value="china" ${data.state.localQQ.cdn==='china'?'selected':''}>官方备用线路</option></select>`)}${field('本机 HTTP 代理（可留空）',input('proxyUrl',data.state.localQQ.proxyUrl||'','例如 http://127.0.0.1:7897'))}<p class="small">代理软件需要保持运行。留空使用默认网络，不改变电脑的全局代理设置。</p>`,async b=>{await post('local-qq/settings',{proxyUrl:b.proxyUrl||'',cdn:b.cdn});await localQQRefresh();toast('连接设置已保存，下次启动核心时生效');});
handlers['local-qq-credentials']=()=>form('更换 QQ 核心授权',`<div class="note">此令牌用于 QQ 接入服务，与 DSH 模型账号分开管理。当前在线时保存新令牌，重启电脑后应用；不会为了校验而退出 QQ。</div>${qqAuthorizationHelp()}${field('新授权令牌',input('authorization','','填写新令牌','password'))}<label class="local-qq-consent"><input type="checkbox" name="consented" required>我了解并同意使用核心的开发者授权与签名服务。</label>`,async b=>{await post('local-qq/settings',{authorization:b.authorization,consented:b.consented==='on'});const current=await localQQRefresh();return {notice:current.authorization?.pending?'新授权已保存，重启电脑后应用':'授权已保存，连接后可在连接与授权中检查'};});
document.addEventListener('submit',async e=>{
 if(e.target.id!=='local-qq-auth')return;e.preventDefault();if(localBusy)return;const formElement=e.target,submit=formElement.querySelector('button[type=submit]'),values=new FormData(formElement);localBusy=true;submit.disabled=true;
 try{await post('local-qq/settings',{authorization:values.get('authorization'),consented:values.get('consented')==='on'});formElement.reset();await post('local-qq/start');toast(data.state.localQQ?.mode==='pmhq'?'正在启动电脑 QQ，请在客户端完成小号登录':'已启动新 QQ 核心，正在准备扫码登录');localStateSignature='';}catch(err){toast(err.message,true)}finally{localBusy=false;submit.disabled=false;await localQQRefresh();}
});
setInterval(()=>{if(view==='qq'&&data.state&&!document.hidden&&!localBusy&&$('#modal').classList.contains('hidden'))localQQRefresh().catch(()=>{})},4000);
setInterval(()=>{if(view==='qq'&&data.state?.localQQ)localQQUpdate(data.state.localQQ)},1000);

handlers['local-qq-attach']=async()=>{const g=data.state.localQQ;if(g?.mode!=='pmhq')return;if(!confirm('请确认当前电脑只打开了机器人小号 QQ '+g.account+'，并已完成登录。连接后会核对实际账号，主号不会接入。'))return;await post('local-qq/attach-desktop',{account:g.account,confirmed:true});await localQQRefresh();toast('正在连接已登录的小号，请稍候核对在线状态。');};
