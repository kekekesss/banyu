import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundledMcp} from '../scripts/dsh-bundled-mcp.mjs';
test('安装器选择所选 DSH 自带的匹配组件，缺失或版本不符时不绕过校验',()=>{
 const base=path.resolve('qa/bundled-mcp-tests');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'中文 空格-')),exe=path.join(dir,'DeepSeek Harness.exe');fs.writeFileSync(exe,'fixture');fs.mkdirSync(path.join(dir,'resources'));
 function archive(version){const tree={files:{}},chunks=[];let offset=0;for(const [p,body] of Object.entries({'dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json':JSON.stringify({version:'1.0.0'}),'dsh/node_modules/@deepseek-ai/dsh-mcp-client/package.json':JSON.stringify({version}),'dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js':'export {}'})){let node=tree;const parts=p.split('/');for(const k of parts.slice(0,-1))node=node.files[k]??={files:{}};const bytes=Buffer.from(body);node.files[parts.at(-1)]={size:bytes.length,offset:String(offset)};offset+=bytes.length;chunks.push(bytes);}const json=Buffer.from(JSON.stringify(tree)),head=Buffer.alloc(16);head.writeUInt32LE(json.length+8,4);head.writeUInt32LE(json.length,12);fs.writeFileSync(path.join(dir,'resources/app.asar'),Buffer.concat([head,json,...chunks]));}
 archive('1.0.0');assert.equal(fileURLToPath(bundledMcp(exe)),path.join(dir,'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js'));archive('0.9.0');assert.equal(bundledMcp(exe),null);assert.equal(bundledMcp(path.join(dir,'missing.exe')),null);fs.writeFileSync(path.join(dir,'resources/app.asar'),'invalid');assert.equal(bundledMcp(exe),null);
});
