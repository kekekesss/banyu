// MIT. Reconcile an exact allowlist as MCP tools arrive or reconnect.
import {tools as banyuTools} from '../../src/qq-chat/agent.mjs';
export const name='banyu-qq-scope';
export const inject=['tools'];
export function apply(ctx){
 ctx.tools.presentAs('native');
 const allowed=banyuTools.map(tool=>'mcp__banyu__'+tool.name);
 ctx.tools.guard(call=>allowed.includes(call.name)?undefined:'伴屿 QQ 只允许当前会话工具；电脑操作仅主人私聊可用，并由伴屿检查权限与确认设置。');
 // DSH rejects names not registered yet. Start closed, then subscribe to its
 // registry updates. schemas() without a scope reads the GLOBAL registry.
 let release=ctx.tools.restrict({allow:[]}),current='',updating=false;
 const refresh=()=>{
  if(updating)return;updating=true;
  try{
   const known=new Set(ctx.tools.schemas().map(tool=>tool.name));
   const next=allowed.filter(name=>known.has(name)),key=next.join(',');
   if(key===current)return;
   // Install before disposing the old mask: never expose unrelated tools.
   const replacement=ctx.tools.restrict({allow:next}),previous=release;
   release=replacement;current=key;previous();
  }finally{updating=false;}
 };
 ctx.on('tools/change',refresh);
 refresh();
}
