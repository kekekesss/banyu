import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {NodeApiClient,unwrap} from '../vendor/dsh-client.js';
import {findDsh} from '../src/dsh-connection.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const profiles=path.join(process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),'profiles');
const profile=path.join(profiles,fs.existsSync(path.join(profiles,'desktop','package.json'))?'desktop':'web');
const manifest=path.join(profile,'package.json');
if(!fs.existsSync(manifest)){console.log('尚未安装 DSH 桌面版；可在工作台填写兼容 API。');process.exit(0)}
const source=path.join(root,'plugins','whale-service-preset'),key='whale-service-preset';
const value=JSON.parse(fs.readFileSync(manifest,'utf8'));value.dependencies||={};value.dsh||={};value.dsh.profile||={};value.dsh.profile.bundles||=[];
const link='link:'+source.replaceAll('\\','/');let changed=false;
if(value.dependencies[key]!==link){value.dependencies[key]=link;changed=true}
if(!value.dsh.profile.bundles.includes(key)){value.dsh.profile.bundles.push(key);changed=true}
if(changed){const backup=path.join(root,'backups','dsh-desktop-package-'+Date.now()+'.json');fs.mkdirSync(path.dirname(backup),{recursive:true});fs.copyFileSync(manifest,backup);fs.writeFileSync(manifest,JSON.stringify(value,null,2)+'\n');}
const target=path.join(profile,'node_modules',key);if(!fs.existsSync(target))fs.symlinkSync(source,target,process.platform==='win32'?'junction':'dir');
let base=process.argv[2];if(!base)try{base=(await findDsh()).base}catch{}
if(base){try{const api=new NodeApiClient(base,30000);const result=await api.callUnary('pluginManager/setBundleEnabled',{name:key,enabled:true});if(result.result?.kind==='error')throw new Error('not loaded');const presets=unwrap(await api.agentPresets.list({}),'presets');console.log('客服预设：'+(presets.presets?.some(p=>p.id==='whale-service-chat')?'已加载':'已安装，等待 DSH 下次启动加载'));}catch{console.log('客服预设已安装；如 DSH 尚未加载，请下次重启 DSH 后使用。')}}
else console.log('客服预设已安装，将在 DSH 下次启动时加载。');
