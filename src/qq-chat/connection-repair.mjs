// Repair only our enabled preset's known startup-order failure, while idle.
export async function reloadBanyuMcp(api,{busy=()=>false}={}){
 if(await busy())throw Error('QQ 会话正在处理，请稍后更新工具。');
 // Enabling an already enabled plugin does not restart its stdio child.
 await api.call('pluginManager/setPluginEnabled',{id:'include:mcp-banyu',enabled:false});
 await api.call('pluginManager/setPluginEnabled',{id:'include:mcp-banyu',enabled:true});
}
export async function repairBanyuPreset(api){
 const presets=await api.call('agentPresets/list');
 const preset=presets.presets?.find(p=>p.id==='banyu-qq');
 if(!preset?.broken?.includes('tools.restrict() names unknown global tool'))return false;
 const inventory=await api.call('pluginInventory/list');
 const own=inventory.entries?.find(e=>e.entryId==='include:banyu-qq');
 const mcp=inventory.entries?.find(e=>e.entryId==='include:mcp-banyu');
 if(!own?.enabled||!mcp?.enabled||mcp.fiberPhase!=='active')return false;
 await api.call('pluginManager/setPluginEnabled',{id:'include:banyu-qq',enabled:false});
 await api.call('pluginManager/setPluginEnabled',{id:'include:banyu-qq',enabled:true});
 const after=await api.call('agentPresets/list');
 return after.presets?.some(p=>p.id==='banyu-qq'&&!p.broken)===true;
}
export function dshIssue(error){
 if(error?.code==='PRESET_MISSING')return {code:'DSH_PRESET_NOT_READY',detail:'DSH 已启动，但伴屿预设未就绪。点击“检查并修复连接”，会尝试恢复工具加载顺序；若仍失败，请重新安装伴屿模型预设。'};
 if(error?.code==='DSH_NOT_FOUND')return {code:'DSH_OFFLINE',detail:'未连接本机 DSH。请先打开 DSH，等待启动完成后检查连接；无需重新登录 QQ。'};
 return {code:'DSH_MODEL_UNAVAILABLE',detail:'DSH 模型暂不可用，请检查连接，并确认所选模型仍在 DSH 中可用。'};
}
