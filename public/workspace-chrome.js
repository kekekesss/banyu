// Keep navigation preference and connection controls together across renders.
const chromeSidebar=document.querySelector('.sidebar'),chromeHeader=document.querySelector('main>header');
chromeSidebar.id='workspace-sidebar';
const chromeToggle=document.createElement('button');chromeToggle.id='sidebar-toggle';chromeToggle.className='icon-button';chromeToggle.type='button';chromeToggle.setAttribute('aria-controls','workspace-sidebar');chromeToggle.innerHTML='<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 4v16" stroke="currentColor" stroke-width="1.5"/></svg>';chromeHeader.prepend(chromeToggle);
const chromeControls=document.querySelector('.header-right');chromeControls.id='workspace-controls';
function chromeSetSidebar(hidden){document.body.classList.toggle('sidebar-collapsed',hidden);chromeSidebar.inert=hidden;chromeToggle.setAttribute('aria-expanded',String(!hidden));chromeToggle.setAttribute('aria-label',hidden?'显示侧边栏':'隐藏侧边栏');chromeToggle.title=hidden?'显示侧边栏':'隐藏侧边栏';try{localStorage.setItem('banyuSidebarHidden',String(hidden))}catch{}}
let chromeHidden=false;try{chromeHidden=localStorage.getItem('banyuSidebarHidden')==='true'}catch{}chromeSetSidebar(chromeHidden);
chromeToggle.onclick=()=>chromeSetSidebar(!document.body.classList.contains('sidebar-collapsed'));
function chromeSync(){
 if(!data.state)return;const channels=data.state.channels,chosen=view==='qq'?'qq':view==='weixin'?'weixin':null;
 const connected=chosen?channels[chosen]?.state==='connected':Object.values(channels).some(c=>c.state==='connected');
 const description=chosen?(chosen==='qq'?'QQ':'微信')+(connected?'已连接':'未连接'):'QQ '+(channels.qq?.state==='connected'?'已连接':'未连接')+' · 微信 '+(channels.weixin?.state==='connected'?'已连接':'未连接');
 const dot=document.querySelector('.sidebar-bottom .live-dot');if(dot){dot.classList.toggle('is-connected',connected);dot.setAttribute('aria-label',description);dot.title=description;}
 const badge=document.getElementById('pause-badge');if(badge){badge.textContent=description;badge.className='badge '+(connected?'green':'');}
 const actions=document.querySelector('#content .page-head>.actions');if(actions&&chromeControls.parentElement!==actions)actions.prepend(chromeControls);
}
const chromePreviousRender=render;
render=function(){chromeHeader.append(chromeControls);chromePreviousRender();chromeSync();};
setInterval(chromeSync,1000);chromeSync();
