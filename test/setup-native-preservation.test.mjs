import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import yaml from 'js-yaml';

test('安装 QQ 预设只更新伴屿工具，保留其他 DSH 插件和预设',()=>{
 const base=path.resolve('qa/setup-native-preservation');fs.mkdirSync(base,{recursive:true});const home=fs.mkdtempSync(path.join(base,'case-')),profile=path.join(home,'profiles','desktop');fs.mkdirSync(path.join(profile,'node_modules'),{recursive:true});
 fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({dependencies:{'qq-agent-presets':'existing','qq-mode-console':'existing'},dsh:{profile:{bundles:['qq-agent-presets','qq-mode-console']}}}));
 fs.writeFileSync(path.join(profile,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'mcp-snowluma',name:'fixture-snow'},{id:'mcp-web-search-safe',name:'fixture-search'},{id:'mcp-banyu',name:'old-banyu'}]}]));
 execFileSync(process.execPath,['scripts/setup-native-qq.mjs','--offline'],{env:{...process.env,DSH_HOME:home},encoding:'utf8',timeout:30000});
 const manifest=JSON.parse(fs.readFileSync(path.join(profile,'package.json'),'utf8')),patch=yaml.load(fs.readFileSync(path.join(profile,'cordis.patch.yml'),'utf8'));
 assert.equal(manifest.dependencies['qq-agent-presets'],'existing');assert.equal(manifest.dependencies['qq-mode-console'],'existing');assert.deepEqual(manifest.dsh.profile.bundles.slice(0,2),['qq-agent-presets','qq-mode-console']);
 const rows=patch.flatMap(x=>x.insert||[]);assert.equal(rows.find(x=>x.id==='mcp-snowluma').name,'fixture-snow');assert.equal(rows.find(x=>x.id==='mcp-web-search-safe').name,'fixture-search');assert.equal(rows.filter(x=>x.id==='mcp-banyu').length,1);assert.equal(rows.find(x=>x.id==='mcp-banyu').config.toolCallTimeoutMs,240000);
});
