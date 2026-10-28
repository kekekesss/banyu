import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';
import {QQStore,defaults} from '../src/qq-chat/store.mjs';

function writeNew(file,value){
 if(fs.existsSync(file))throw Error('已有本机设置，未覆盖：'+path.basename(file));
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
}
export function initializeShare(root,{owner='',bot='',quark='',qq='',dsh='',modelSource='dsh'}={}){
 root=path.resolve(root);
 const file=(value,name,required=true)=>{if(!value&&!required)return '';if(!path.isAbsolute(value)||!fs.existsSync(value)||path.basename(value).toLowerCase()!==name)throw Error('请选择已安装的 '+name);return path.resolve(value)};
 const machine={quarkExecutable:file(quark,'quark.exe'),qqExecutable:file(qq,'qq.exe',!!bot),dshExecutable:file(dsh,'deepseek harness.exe',!!bot&&modelSource!=='deepseek')};
 const data=path.join(root,'data'),machineFile=path.join(data,'machine-settings.json');
 const old=fs.existsSync(machineFile)?JSON.parse(fs.readFileSync(machineFile,'utf8').replace(/^\uFEFF/,'')):{};
 if(bot&&(!/^\d{5,12}$/.test(bot)||!/^\d{5,12}$/.test(owner)||owner===bot))throw Error('请填写不同的主人QQ与机器人小号');
 if(bot){
  for(const f of [path.join(data,'local-qq','settings.json'),path.join(data,'local-qq','credentials.json')])if(fs.existsSync(f))throw Error('QQ 已有配置，未重置任何账号或密钥；请在工作台管理');
  const qqStore=new QQStore(path.join(data,'qq-chat'));try{
   const previous=qqStore.settings();if(previous.account||previous.owner)throw Error('QQ 已有配置，未重置任何账号或密钥');
   qqStore.saveSettings({...defaults(),owner,account:bot,privateAllow:[owner]});
  }finally{qqStore.close();}
  const credentials={web:randomBytes(32).toString('hex'),onebot:randomBytes(32).toString('hex')};
  writeNew(path.join(data,'local-qq','credentials.json'),credentials);
  writeNew(path.join(data,'local-qq','settings.json'),{account:bot,owner,mode:'pmhq',consented:false,cdn:'cf',proxyUrl:''});
 }
 if(modelSource==='deepseek'){const store=new Store(data);try{store.setting('deepseek-api',{model:'deepseek-flash',effort:'none',useForQQ:!!bot,useForWeixin:true,revision:1});}finally{store.close();}writeNew(path.join(data,'launcher-settings.json'),{provider:'deepseek',qqNeedsDsh:false});}
 fs.mkdirSync(data,{recursive:true});fs.writeFileSync(machineFile,JSON.stringify({...old,...machine},null,2)+'\n',{mode:0o600});
 fs.mkdirSync(path.join(data,'qq-chat'),{recursive:true});fs.writeFileSync(path.join(data,'qq-chat/enabled'),'banyu-native\n',{mode:0o600});
 return {qqConfigured:!!bot,machineConfigured:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),values=args[0]==='--input'?JSON.parse(fs.readFileSync(args[1],'utf8').replace(/^\uFEFF/,'')):{};if(args[0]!=='--input')for(let i=0;i<args.length;i+=2)values[args[i].replace(/^--/,'')]=args[i+1]||'';
 try{const {root,...settings}=values;console.log(JSON.stringify(initializeShare(root,settings)))}catch(error){console.error(error.message);process.exitCode=1}
}
