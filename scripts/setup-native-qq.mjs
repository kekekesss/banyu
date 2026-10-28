// MIT. Register only Banyu's own QQ preset and tool server in the current profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import yaml from 'js-yaml';
import {findDsh} from '../src/dsh-connection.mjs';
import {reloadBanyuMcp} from '../src/qq-chat/connection-repair.mjs';
import {bundledMcp} from './dsh-bundled-mcp.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh');
const profile=path.join(home,'profiles',fs.existsSync(path.join(home,'profiles/desktop/package.json'))?'desktop':'web'),manifest=path.join(profile,'package.json');
if(!fs.existsSync(manifest))throw Error('请先打开一次 DSH，初始化本机配置');
class Expression{constructor(source){this.source=source}}
const schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:s=>new Expression(s),instanceOf:Expression,represent:v=>v.source})]);
const patchFile=path.join(profile,'cordis.patch.yml'),patchText=fs.existsSync(patchFile)?fs.readFileSync(patchFile,'utf8').replace(/^\uFEFF/,''):'[]';
const patch=yaml.load(patchText,{schema})||[];if(!Array.isArray(patch))throw Error('DSH配置格式不符，未覆盖');
// Only replace our own registration. Other integrations and presets may still
// belong to the user and must survive an install or upgrade.
const managed=new Set(['mcp-banyu']);
const rewritten=patch.flatMap(operation=>{if(!Array.isArray(operation?.insert))return [operation];const insert=operation.insert.filter(row=>!managed.has(row?.id));return insert.length||Object.keys(operation).length>1?[{...operation,insert}]:[];});
let machine={};try{machine=JSON.parse(fs.readFileSync(path.join(root,'data/machine-settings.json'),'utf8'));}catch{}
const shipped=process.argv.includes('--offline')?null:bundledMcp(machine.dshExecutable||'D:/ds harness/DeepSeek Harness.exe');
rewritten.push({insert:[{id:'mcp-banyu',name:shipped||'@deepseek-ai/dsh-mcp-client',config:{serverName:'banyu',transport:'stdio',command:process.execPath,args:[path.join(root,'src/qq-chat/agent.mjs')],toolCallTimeoutMs:240000}}]});
const value=JSON.parse(fs.readFileSync(manifest,'utf8'));value.dependencies||={};value.dsh||={};value.dsh.profile||={};value.dsh.profile.bundles||=[];
const key='banyu-qq-preset',source=path.join(root,'plugins',key),link=path.join(profile,'node_modules',key);
value.dependencies[key]='link:'+source.replaceAll('\\','/');if(!value.dsh.profile.bundles.includes(key))value.dsh.profile.bundles.push(key);
if(fs.existsSync(link)){const stat=fs.lstatSync(link);if(!stat.isSymbolicLink()||fs.realpathSync(link).toLowerCase()!==fs.realpathSync(source).toLowerCase())throw Error('伴屿预设路径已存在但目标不符，未覆盖');}
else fs.symlinkSync(source,link,process.platform==='win32'?'junction':'dir');
const backup=path.join(root,'backups','native-dsh-'+Date.now());fs.mkdirSync(backup,{recursive:true});fs.copyFileSync(manifest,path.join(backup,'package.json'));if(fs.existsSync(patchFile))fs.copyFileSync(patchFile,path.join(backup,'cordis.patch.yml'));
fs.writeFileSync(manifest,JSON.stringify(value,null,2)+'\n');fs.writeFileSync(patchFile,yaml.dump(rewritten,{schema,noRefs:true,lineWidth:-1}));
console.log('伴屿原生 QQ 预设与消息工具已注册，其它 DSH 插件和模型配置保留。');
if(!process.argv.includes('--offline'))try{const api=await findDsh();await api.call('pluginManager/setBundleEnabled',{name:key,enabled:true});await reloadBanyuMcp(api,{busy:async()=>{try{const token=fs.readFileSync(path.join(root,'data/admin-token'),'utf8').trim(),r=await fetch('http://127.0.0.1:3200/api/qq-chat',{headers:{'x-admin-token':token},signal:AbortSignal.timeout(3000)});if(!r.ok)return true;const q=await r.json();return q.chats?.some(c=>c.busy)===true;}catch(e){return e.cause?.code!=='ECONNREFUSED'&&e.code!=='ENOENT';}}});const inventory=await api.call('pluginInventory/list');const mcp=inventory.entries?.find(e=>e.entryId==='include:mcp-banyu');console.log(mcp?.enabled&&mcp.fiberPhase==='active'?'伴屿 QQ 模型预设与工具插件已加载。':'伴屿工具插件尚未激活，请检查 DSH 插件兼容性与启动日志。');}catch{console.log('请正常重新打开一次 DSH 以完成首次加载。');}
