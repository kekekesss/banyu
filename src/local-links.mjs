// Fixed external links open in the configured Quark browser. No arbitrary URL API.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
export const links=Object.freeze({'qq-authorization':'https://auth.luckylillia.com','qq-source':'https://github.com/LLOneBot/LuckyLilliaBot','qq-docs':'https://luckylillia.com'});
export async function openLocalLink(id,{quark='',launch=spawn,exists=fs.existsSync}={}){
 const url=Object.hasOwn(links,id)?links[id]:null;if(!url)throw Object.assign(Error('没有这个链接入口'),{status:404});
 if(!path.isAbsolute(quark)||quark.startsWith('\\\\')||!quark.toLowerCase().endsWith(path.sep+'quark.exe')||!exists(quark))throw Object.assign(Error('请在首次设置中选择已安装的夸克浏览器'),{status:409});
 await new Promise((resolve,reject)=>{const child=launch(quark,[url],{cwd:path.dirname(quark),shell:false,windowsHide:true,detached:true,stdio:'ignore'});child.once('error',()=>reject(Object.assign(Error('夸克未能打开，请检查安装路径'),{status:503})));child.once('spawn',()=>{child.unref?.();resolve();});});return {ok:true};
}
