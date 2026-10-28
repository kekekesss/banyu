// Prefer the MCP client shipped with the chosen DSH executable. An unrelated
// profile dependency can otherwise shadow it with an incompatible DSH version.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function bundledMcp(executable){
 if(!executable||!fs.existsSync(executable))return null;
 const archive=path.join(path.dirname(executable),'resources','app.asar');let fd;
 try{
  fd=fs.openSync(archive,'r');const head=Buffer.alloc(16);fs.readSync(fd,head,0,16,0);
  const size=head.readUInt32LE(12);if(size<2||size>32*1024*1024)return null;
  const bytes=Buffer.alloc(size);fs.readSync(fd,bytes,0,size,16);const tree=JSON.parse(bytes.toString());
  const prefix='dsh/node_modules/@deepseek-ai/';
  const entry=p=>p.split('/').reduce((v,k)=>v?.files?.[k],tree);
  const manifest=name=>{const row=entry(prefix+name+'/package.json');if(!row||row.unpacked||row.size>100000)return null;const b=Buffer.alloc(row.size);fs.readSync(fd,b,0,b.length,8+head.readUInt32LE(4)+Number(row.offset));return JSON.parse(b.toString());};
  const mcp=manifest('dsh-mcp-client'),runtime=manifest('dsh-app-boot');
  if(!mcp||mcp.version!==runtime?.version||!entry(prefix+'dsh-mcp-client/lib/index.js'))return null;
  return pathToFileURL(path.join(archive,prefix,'dsh-mcp-client/lib/index.js')).href;
 }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
