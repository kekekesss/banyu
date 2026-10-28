// Native Weixin settings, using the existing roles/zones APIs. Drafts stay in
// memory across status refreshes; nothing is written until the user saves.
let wxPanel={tab:'persona',zoneId:'',roleId:'',roleDraft:null,habitDraft:null,busy:false};
const wxHabitKeys=['type','enabled','cooldownSeconds','dailyLimit','instructions','fallback'];
function wxRoleDirty(){return !!wxPanel.roleDraft&&(wxPanel.roleDraft.text!==wxPanel.roleDraft.base.prompt||wxPanel.roleDraft.name!==wxPanel.roleDraft.base.name);}
function wxHabitDirty(){const d=wxPanel.habitDraft;return !!d&&wxHabitKeys.some(k=>d.values[k]!==d.base[k]);}
function wxDirty(){return wxRoleDirty()||wxHabitDirty();}
function wxZone(){const z=data.zones.find(z=>z.id===wxPanel.zoneId)||data.zones.find(z=>z.type==='companion')||data.zones[0];if(z)wxPanel.zoneId=z.id;return z;}
function wxRole(z){return data.roles.find(r=>r.id===(wxPanel.roleId||z.roleId))||data.roles.find(r=>r.id===z.roleId)||data.roles[0];}
function wxRoleDraft(r){if(wxPanel.roleDraft?.base.id!==r.id||!wxRoleDirty())wxPanel.roleDraft={base:{...r},text:r.prompt,name:r.name};return wxPanel.roleDraft;}
function wxHabitDraft(z){if(wxPanel.habitDraft?.base.id!==z.id||!wxHabitDirty())wxPanel.habitDraft={base:{...z},values:Object.fromEntries(wxHabitKeys.map(k=>[k,z[k]]))};return wxPanel.habitDraft;}
function wxChoice(z){return `<label class="wx-config-picker">当前配置${select('wxZone',z.id,data.zones.map(v=>[v.id,v.name]))}</label>`;}
function wxTips(title,items){return `<aside class="card wx-tips"><div class="card-head"><h3>${title}</h3><span class="small">设置建议</span></div>${items.map(([h,p],i)=>`<div class="wx-tip"><span>${String(i+1).padStart(2,'0')}</span><div><h4>${h}</h4><p>${p}</p></div></div>`).join('')}</aside>`;}
function weixinSettings(){
 const focus=document.activeElement,restore=focus?.closest?.('#weixin-settings')&&focus.id?{id:focus.id,start:focus.selectionStart,end:focus.selectionEnd}:null;
 if(restore)queueMicrotask(()=>{const el=document.getElementById(restore.id);if(el){el.focus({preventScroll:true});if(typeof restore.start==='number')el.setSelectionRange(restore.start,restore.end);}});
 const z=wxZone(),tabs=[['contacts','♧','会话与权限'],['persona','◎','角色人设'],['behavior','☷','聊天习惯'],['library','◎','全部角色']];
 return `<section class="section wx-section" id="weixin-settings"><div class="section-title"><h3>角色与聊天设置</h3><p class="small">为不同私聊安排角色，设置回复方式与人工接手规则。</p></div><div class="wx-settings-shell"><div class="wx-settings-tabs" role="tablist" aria-label="微信聊天设置">${tabs.map(([id,icon,label])=>`<button type="button" role="tab" aria-selected="${wxPanel.tab===id}" aria-controls="wx-settings-panel" data-wx-tab="${id}" class="${wxPanel.tab===id?'active':''}"><span aria-hidden="true">${icon}</span>${label}</button>`).join('')}</div><div class="wx-settings-body" role="tabpanel" id="wx-settings-panel">${wxPanel.tab==='library'?wxRoleLibrary():z?({contacts:wxContacts,persona:wxPersona,behavior:wxBehavior}[wxPanel.tab]||wxPersona)(z):empty('先创建一个聊天配置','选择使用的角色和回复方式后，再分配微信会话。')+button('新建聊天配置','zone-new')}</div></div></section>`;
}
function wxPersona(z){
 const r=wxRole(z);if(!r)return empty('还没有角色')+`<button type="button" class="button primary" data-wx-action="new-role">新建角色</button>`;
 const d=wxRoleDraft(r),shared=data.zones.filter(v=>v.roleId===r.id).length;
 const toolbar=select('wxRole',r.id,data.roles.map(v=>[v.id,v.name+(v.id===z.roleId?' · 当前使用':'')]))+`<button type="submit" class="button primary" id="wx-role-save" ${wxRoleDirty()?'':'disabled'}>${wxRoleDirty()?'保存人设':'已保存'}</button>`;
 return personaHeading('<button type="button" class="button" data-wx-action="new-role">＋ 新建角色</button>')+`<div class="wx-config-bar">${wxChoice(z)}<span class="small">当前使用：${esc(roleName(z.roleId))}</span></div>`+personaEditor({formId:'wx-role-form',toolbar,nameInput:`<input id="wx-role-name" name="name" value="${esc(d.name??r.name)}" maxlength="60">`,promptId:'wx-role-prompt',prompt:d.text,status:`<span id="wx-role-status">${wxRoleDirty()?'尚未保存':'已保存'} · ${d.text.length} / 16000 字符</span><button type="button" class="wx-text-button" data-wx-action="reload-role">重新载入</button>`,footer:shared>1?`此角色由 ${shared} 个聊天配置共用，保存后一起生效。`:'保存后，后续回复使用新的人设。',actions:(r.id!==z.roleId?'<button type="button" class="button primary" data-wx-action="apply-role">使用这个角色</button>':'')+'<button type="button" class="button danger" data-wx-action="delete-role">删除角色</button>'});
}
function wxContacts(z){
 const list=data.conversations.filter(c=>c.channelId==='weixin'),bound=list.filter(c=>c.zoneId===z.id),pending=list.filter(c=>!c.zoneId);
 return `<div class="wx-settings-head"><div><h2>让每段私聊，都有合适的回应。</h2><p>收到新消息后分配到聊天配置，角色与回复规则便会开始生效。</p></div>${button('＋ 新建配置','zone-new')}</div><div class="wx-config-bar">${wxChoice(z)}${button('编辑配置','zone-edit',z.id,'small')}</div><div class="wx-settings-columns"><section class="card"><div class="card-head"><h3>当前会话</h3>${badge(bound.length+' 个','green')}</div>${bound.length?bound.map(c=>`<div class="row"><div><strong>${esc(c.name)}</strong><div class="small">${esc(c.human?'人工接管':'使用 '+roleName(z.roleId))}</div></div><div class="actions">${button('查看','conversation-open',c.id,'small')}${button('调整配置','conversation-assign',c.id,'small')}<button type="button" class="button small" data-wx-action="unbind" data-wx-id="${esc(c.id)}">移出</button></div></div>`).join(''):empty('还没有分配会话','用另一个微信给已接入账号发消息，再从右侧分配。')}</section><section class="card"><div class="card-head"><h3>待分配私聊</h3>${badge(pending.length+' 个')}</div>${pending.length?pending.map(c=>`<div class="row"><div><strong>${esc(c.name)}</strong><div class="small">尚未开启自动回复</div></div><button type="button" class="button small" data-wx-action="bind" data-wx-id="${esc(c.id)}">分配到这里</button></div>`).join(''):empty('暂无待分配私聊')}<p class="small section">移出配置后仍会收件，自动回复会停止。普通微信群暂不支持。</p></section></div>`;
}
function wxBehavior(z){
 const d=wxHabitDraft(z),v=d.values;
 return `<div class="wx-settings-head"><div><h2>把回应，调成舒服的节奏。</h2><p>选择陪伴或客服方式，设置回复间隔与业务边界。</p></div>${wxChoice(z)}</div><div class="wx-settings-columns"><form id="wx-behavior-form" class="card wx-editor"><div class="form-grid">${field('回复方式',select('type',v.type,[['companion','陪伴 · 自然对话'],['service','客服 · 依据资料回答']]),'',true)}${field('同一会话回复间隔（秒）',`<input id="wx-cooldown" name="cooldownSeconds" type="number" min="0" max="600" value="${v.cooldownSeconds}">`,'0–600 秒，间隔内的新消息仍会记录。')}${field('每日自动处理上限',`<input id="wx-daily-limit" name="dailyLimit" type="number" min="1" max="10000" value="${v.dailyLimit}">`,'按此配置累计，达到上限后转人工。')}${field('聊天与服务规则',`<textarea id="wx-instructions" name="instructions" rows="6" maxlength="10000">${esc(v.instructions)}</textarea>`,'补充回答范围、表达要求或人工交接条件。',true)}${field('资料不足时的回复',`<textarea id="wx-fallback" name="fallback" rows="3" maxlength="1000">${esc(v.fallback)}</textarea>`,'客服模式缺少资料时，回复此句并生成待办。',true)}<label class="checkbox wide"><input name="enabled" type="checkbox" ${v.enabled?'checked':''}>开启此配置的自动回复</label></div><div class="wx-save-row"><span class="small" id="wx-behavior-status">${wxHabitDirty()?'尚未保存':'已保存'}</span><button type="submit" class="button primary" id="wx-behavior-save" ${wxHabitDirty()?'':'disabled'}>${wxHabitDirty()?'保存聊天习惯':'已保存'}</button></div></form><div class="wx-settings-side">${wxTips('让聊天有边界',[
 ['陪伴与客服各有侧重','陪伴模式自然交流；客服模式会优先检索资料，没有依据就转人工。'],
 ['同一会话保持自己的上下文','不同会话与配置各自使用对应角色和资料。'],
 ['人工可以随时接手','在会话与待办里接管、回复，再按需要恢复自动回复。']
 ])}<aside class="card"><h3>试试现在的设置</h3><p class="small">先保存修改，再用试聊查看效果。试聊结果只显示在工作台内。</p>${button('试聊一下','preview',z.id,'small')}</aside></div></div>`;
}
function wxRender(){const el=document.getElementById('weixin-settings');if(el)el.outerHTML=weixinSettings();}
function wxUpdateDirty(){
 const save=document.getElementById('wx-role-save'),status=document.getElementById('wx-role-status');
 if(save){save.disabled=wxPanel.busy||!wxRoleDirty();save.textContent=wxRoleDirty()?'保存人设':'已保存';if(status)status.textContent=(wxRoleDirty()?'尚未保存':'已保存')+' · '+wxPanel.roleDraft.text.length+' / 16000 字符';}
 const behavior=document.getElementById('wx-behavior-save'),hint=document.getElementById('wx-behavior-status');
 if(behavior){behavior.disabled=wxPanel.busy||!wxHabitDirty();behavior.textContent=wxHabitDirty()?'保存聊天习惯':'已保存';if(hint)hint.textContent=wxHabitDirty()?'尚未保存':'已保存';}
}
document.addEventListener('input',e=>{
 if(e.target.id==='wx-role-name'){wxPanel.roleDraft.name=e.target.value;wxUpdateDirty();}
 if(e.target.id==='wx-role-prompt'){wxPanel.roleDraft.text=e.target.value;wxUpdateDirty();}
 if(e.target.closest('#wx-behavior-form')){const v=wxPanel.habitDraft.values,key=e.target.name;if(wxHabitKeys.includes(key))v[key]=key==='enabled'?e.target.checked:['dailyLimit','cooldownSeconds'].includes(key)?Number(e.target.value):e.target.value;wxUpdateDirty();}
});
document.addEventListener('change',e=>{
 if(e.target.name==='wxZone'){
  if(wxDirty()&&!confirm('切换配置会放弃尚未保存的修改，确定继续吗？')){e.target.value=wxPanel.zoneId;return;}
  wxPanel.zoneId=e.target.value;wxPanel.roleId='';wxPanel.roleDraft=null;wxPanel.habitDraft=null;wxRender();
 }
 if(e.target.name==='wxRole'){
  if(wxRoleDirty()&&!confirm('切换角色会放弃尚未保存的人设，确定继续吗？')){e.target.value=wxPanel.roleDraft.base.id;return;}
  wxPanel.roleId=e.target.value;wxPanel.roleDraft=null;wxRender();
 }
 if(e.target.closest('#wx-behavior-form'))e.target.dispatchEvent(new Event('input',{bubbles:true}));
});
async function wxSaveRole(){
 const d=wxPanel.roleDraft,latest=(await api('roles')).find(r=>r.id===d.base.id);
 if(!latest)throw Error('角色已被删除，请重新选择');
 if(latest.prompt!==d.base.prompt||latest.name!==d.base.name)throw Error('这个角色已在其他页面修改，请先重新载入，避免覆盖');
 const saved=await api('roles/'+encodeURIComponent(latest.id),{method:'PUT',body:{...latest,name:d.name,prompt:d.text}});wxPanel.roleDraft={base:saved,text:saved.prompt,name:saved.name};await refresh();toast('人设已保存，后续回复生效');
}
async function wxSaveBehavior(){
 const d=wxPanel.habitDraft,latest=(await api('zones')).find(z=>z.id===d.base.id);if(!latest)throw Error('聊天配置已被删除');
 const patch={};for(const k of wxHabitKeys)if(d.values[k]!==d.base[k]){if(latest[k]!==d.base[k])throw Error('聊天设置已在其他页面修改，请重新打开后再保存');patch[k]=d.values[k];}
 const saved=await api('zones/'+encodeURIComponent(latest.id),{method:'PUT',body:{...latest,...patch}});wxPanel.habitDraft=null;await refresh();toast('聊天习惯已保存');return saved;
}
document.addEventListener('submit',async e=>{
 if(!['wx-role-form','wx-behavior-form'].includes(e.target.id))return;e.preventDefault();if(wxPanel.busy)return;wxPanel.busy=true;wxUpdateDirty();
 try{await (e.target.id==='wx-role-form'?wxSaveRole():wxSaveBehavior());}catch(err){toast(err.message,true);}finally{wxPanel.busy=false;wxUpdateDirty();}
});
document.addEventListener('click',async e=>{
 const tab=e.target.closest('[data-wx-tab]');if(tab){wxPanel.tab=tab.dataset.wxTab;wxRender();return;}
 const action=e.target.closest('[data-wx-action]');if(!action||wxPanel.busy)return;
 try{
  const z=wxZone(),id=action.dataset.wxId,kind=action.dataset.wxAction;
  if(kind==='new-role'){
   if(wxRoleDirty()&&!confirm('新建角色会放弃尚未保存的人设，确定继续吗？'))return;
   form('新建微信角色',field('角色名称',input('name'))+field('角色设定',area('prompt','',8)),async b=>{const r=await api('roles',{method:'POST',body:{...b,tag:'微信角色',color:'green'}});wxPanel.roleId=r.id;wxPanel.roleDraft=null;wxPanel.tab='persona';});return;
  }
  if(kind==='delete-role'){const r=wxRole(z);if(data.zones.some(v=>v.roleId===r.id))throw Error('这个角色仍在使用，请先在聊天配置中切换角色');if(!confirm('删除角色「'+r.name+'」？聊天记录会保留。'))return;await api('roles/'+encodeURIComponent(r.id),{method:'DELETE'});wxPanel.roleId='';wxPanel.roleDraft=null;await refresh();toast('微信角色已删除');return;}
  if(kind==='reload-role'){if(wxRoleDirty()&&!confirm('放弃尚未保存的人设，重新载入吗？'))return;wxPanel.roleDraft=null;await refresh();return;}
  action.disabled=true;
  if(kind==='apply-role'){const latest=(await api('zones')).find(v=>v.id===z.id);await api('zones/'+z.id,{method:'PUT',body:{...latest,roleId:wxRole(z).id}});toast('当前配置已使用此角色');}
  if(['bind','unbind'].includes(kind)){
   const c=data.conversations.find(v=>v.id===id&&v.channelId==='weixin');if(!c)throw Error('微信会话不存在');
   if(kind==='unbind'&&!confirm('移出后，此会话将停止自动回复，确定继续吗？'))return;
   await post('zones/'+(kind==='unbind'?c.zoneId:z.id)+'/'+kind,{channelId:'weixin',kind:c.kind,externalId:c.externalId});
  }
  await refresh();
 }catch(err){toast(err.message,true);}finally{action.disabled=false;}
});
window.addEventListener('beforeunload',e=>{if(wxDirty()){e.preventDefault();e.returnValue='';}});
