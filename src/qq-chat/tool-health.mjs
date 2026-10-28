// Connection health is separate from the model's ability to generate text.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export async function banyuToolHealth(api,{root,dataDir}={}){
 try{const inventory=await api.call('pluginInventory/list');const row=inventory.entries?.find(e=>e.entryId==='include:mcp-banyu'||e.entryId==='mcp-banyu');
  if(!row)return {ready:false,detail:'DSH 未安装伴屿工具插件，请安装模型预设。'};
  if(!row.enabled)return {ready:false,detail:'伴屿工具插件未启用或版本不兼容，请重新安装模型预设。'};
  if(row.fiberPhase!=='active')return {ready:false,detail:'伴屿工具插件正在加载或连接失败，请检查 DSH。'};
  if(root&&dataDir){let runtime;try{runtime=JSON.parse(fs.readFileSync(path.join(dataDir,'qq-chat/agent-runtime.json'),'utf8'));}catch{}
   const expected=createHash('sha256').update(fs.readFileSync(path.join(root,'src/qq-chat/agent.mjs'))).digest('hex');
   if(runtime?.sourceHash!==expected)return {ready:false,stale:true,detail:'DSH 仍未加载当前版本工具。空闲时点击“检查并修复连接”更新；不需要重新登录QQ。'};
  }
  return {ready:true,detail:'伴屿工具插件已加载；确认要求按伴屿电脑操作设置执行。'};
 }catch{return {ready:false,detail:'暂时无法核对 DSH 工具插件状态。'};}
}
