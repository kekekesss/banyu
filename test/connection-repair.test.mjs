import test from 'node:test';
import assert from 'node:assert/strict';
import {repairBanyuPreset,dshIssue} from '../src/qq-chat/connection-repair.mjs';
test('only repair our enabled startup-order failure; preserve deliberate disable and unrelated errors',async()=>{
 for(const mode of ['startup','disabled','mcp-disabled','mcp-starting','other','missing','healthy']){
  const writes=[];let reads=0;
  const api={call:async(method,args)=>{
   if(method==='agentPresets/list')return {presets:mode==='missing'?[]:[{id:'banyu-qq',...reads++===0&&mode!=='healthy'?{broken:mode==='other'?'unrelated error':'tools.restrict() names unknown global tools'}:{}}]};
   if(method==='pluginInventory/list')return {entries:[{entryId:'include:banyu-qq',enabled:mode!=='disabled'},{entryId:'include:mcp-banyu',enabled:mode!=='mcp-disabled',fiberPhase:mode==='mcp-starting'?'starting':'active'}]};
   writes.push(args);
  }};
  assert.equal(await repairBanyuPreset(api),mode==='startup');
  assert.deepEqual(writes,mode==='startup'?[{id:'include:banyu-qq',enabled:false},{id:'include:banyu-qq',enabled:true}]:[]);
 }
});
test('diagnostics distinguish DSH offline, preset unavailable, and model error',()=>{
 assert.equal(dshIssue({code:'PRESET_MISSING'}).code,'DSH_PRESET_NOT_READY');
 assert.equal(dshIssue({code:'DSH_NOT_FOUND'}).code,'DSH_OFFLINE');
 assert.equal(dshIssue(Error('private credential')).code,'DSH_MODEL_UNAVAILABLE');
 assert.ok(!JSON.stringify(dshIssue(Error('private credential'))).includes('private credential'));
});
