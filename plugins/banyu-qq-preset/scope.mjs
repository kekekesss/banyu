// MIT. Native tool presentation and a fixed QQ-only execution boundary.
export const name='banyu-qq-scope';
export const inject=['tools'];
import {tools as banyuTools} from '../../src/qq-chat/agent.mjs';
export function apply(ctx){
 ctx.tools.presentAs('native');
 // Fixed explicit names remain valid when MCP reconnects after preset mounting.
 // A one-time snapshot of schemas would permanently allow nothing at startup.
 const allow=banyuTools.map(tool=>'mcp__banyu__'+tool.name);
 ctx.tools.restrict({allow});
 ctx.tools.guard(call=>allow.includes(call.name)?undefined:'伴屿 QQ 只允许当前会话工具；电脑操作必须由主人私聊确认。');
}
