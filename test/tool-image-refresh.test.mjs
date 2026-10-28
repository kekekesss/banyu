import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {reloadBanyuMcp} from '../src/qq-chat/connection-repair.mjs';
import {banyuToolHealth} from '../src/qq-chat/tool-health.mjs';
test('工具更新确实先停再启自己的 MCP，忙时不重启',async()=>{
 const calls=[],api={call:async(...args)=>calls.push(args)};
 await assert.rejects(reloadBanyuMcp(api,{busy:()=>true}),/正在处理/);assert.equal(calls.length,0);
 await reloadBanyuMcp(api);assert.deepEqual(calls,[['pluginManager/setPluginEnabled',{id:'include:mcp-banyu',enabled:false}],['pluginManager/setPluginEnabled',{id:'include:mcp-banyu',enabled:true}]]);
});
test('插件 active 不能掩盖旧进程；实际加载源码指纹一致才显示就绪',async()=>{
 fs.mkdirSync('qa/tool-freshness-tests',{recursive:true});const root=fs.mkdtempSync(path.resolve('qa/tool-freshness-tests/case-')),dataDir=path.join(root,'data');fs.mkdirSync(path.join(root,'src/qq-chat'),{recursive:true});fs.mkdirSync(path.join(dataDir,'qq-chat'),{recursive:true});
 const file=path.join(root,'src/qq-chat/agent.mjs'),runtime=path.join(dataDir,'qq-chat/agent-runtime.json');fs.writeFileSync(file,'version1');
 const api={call:async()=>({entries:[{entryId:'include:mcp-banyu',enabled:true,fiberPhase:'active'}]})};
 assert.equal((await banyuToolHealth(api,{root,dataDir})).stale,true);
 fs.writeFileSync(runtime,JSON.stringify({sourceHash:createHash('sha256').update('version1').digest('hex')}));assert.equal((await banyuToolHealth(api,{root,dataDir})).ready,true);
 fs.writeFileSync(file,'version2');assert.equal((await banyuToolHealth(api,{root,dataDir})).stale,true);
});
