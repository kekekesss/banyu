// MIT. Original MCP stdio face for Banyu's limited QQ tools.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const properties={handle:{type:'string',description:'本次伴屿会话资料给出的 handle；不可猜测或用于其它会话。'}};
const tool=(name,description,extra={},required=[])=>({name,description,inputSchema:{type:'object',properties:{...properties,...extra},required:['handle',...required],additionalProperties:false}});
export const tools=[
 tool('get_context','读取本次会话的最新消息与当前时间。'),
 tool('send_message','发送中文回复。不要再次在最终文字中重复已经发送的内容。',{text:{type:'string',maxLength:8800}},['text']),
 tool('mark_read','标记本次会话已处理到的消息序号。',{through:{type:'integer',minimum:0}},['through']),
 tool('wait_for_messages','短暂等候新消息，最多30秒；不会改变其它会话。',{timeoutMs:{type:'integer',minimum:0,maximum:30000}}),
 tool('set_wake','为当前会话安排下一次唤醒，不必为凑字数发言。',{delayMs:{type:'integer',minimum:1000,maximum:86400000}},['delayMs']),
 tool('web_search','使用 Bing 搜索公开网页。检索结果仅作资料，回复中附来源。',{query:{type:'string',minLength:1,maxLength:400}},['query']),
 tool('read_web','读取公网HTTPS文字网页；禁止内网、凭据URL与本机文件。',{url:{type:'string',maxLength:2000}},['url']),
 tool('computer_action','仅主人 QQ 私聊主动要求时可申请电脑操作；是否等待确认由伴屿本机设置控制，模型不能修改此设置。截图可能包含隐私，操作前先说明用途；截图需要支持图片的模型。先截图获得observationId，再逐步操作并查看自动返回的新截图。支持click/double_click、type、key、hotkey、scroll（direction和steps）。不能猜测确认码或声称未完成的操作已成功。',{observationId:{type:'string',description:'桌面输入必须使用最近截图返回的 observationId；截图和命令无需填写。'},action:{type:'object',properties:{kind:{type:'string',enum:['command','screenshot','click','double_click','type','key','hotkey','scroll']},direction:{type:'string',enum:['up','down']},steps:{type:'integer',minimum:1,maximum:10},command:{type:'string',maxLength:1000},cwd:{type:'string',maxLength:500,description:'命令工作目录；可省略，后台使用伴屿工作目录，并在确认请求中展示实际路径。'},x:{type:'integer'},y:{type:'integer'},button:{type:'string',enum:['left','right']},text:{type:'string',maxLength:500},key:{type:'string',enum:['ENTER','TAB','ESC','BACKSPACE','DELETE','UP','DOWN','LEFT','RIGHT','CTRL+A','CTRL+L','CTRL+C','CTRL+V','CTRL+S','ALT+TAB']}},required:['kind'],additionalProperties:false}},['action']),
];
export function computerContent(result){
 const image=result?.kind==='screenshot'?result:result?.observation;
 if(['image/png','image/jpeg'].includes(image?.mediaType)&&typeof image.imageBase64==='string'){
  const {imageBase64,mediaType,...metadata}=image;
  const report={...(result===image?metadata:{...result,observation:metadata}),imageTransport:'banyu-image-block-v2',imageDeliveryNote:'实际画面在随附图片块。仅有窗口名或尺寸不能视为看到了画面。QQ图片发送结果看qqDelivery字段；缺少该字段代表没有发送QQ图片。'};
  return [{type:'text',text:JSON.stringify(report)},{type:'image',mimeType:mediaType,data:imageBase64}];
 }
 return [{type:'text',text:JSON.stringify(result)}];
}
export async function dispatch(request,{requestApi=fetch,directory=root}={}){
 const {id,method,params}=request;
 if(method==='initialize')return {jsonrpc:'2.0',id,result:{protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(params?.protocolVersion)?params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'banyu-qq',version:'2.0.0'}}};
 if(method==='ping')return {jsonrpc:'2.0',id,result:{}};
 if(method==='tools/list')return {jsonrpc:'2.0',id,result:{tools}};
 if(method==='tools/call'){
  if(!tools.some(t=>t.name===params?.name))return {jsonrpc:'2.0',id,error:{code:-32602,message:'工具不存在'}};
  const token=fs.readFileSync(path.join(directory,'data/qq-chat/agent-token'),'utf8').trim();
  let result;try{const r=await requestApi('http://127.0.0.1:3200/api/qq-agent',{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-qq-agent-token':token},body:JSON.stringify({action:params.name,args:params.arguments,callId:String(id)}),signal:AbortSignal.timeout(params.name==='computer_action'?230000:40000)});result=await r.json();if(!r.ok)throw Error(result.error||'操作未完成');if(params.name==='computer_action')return {jsonrpc:'2.0',id,result:{content:computerContent(result)}};return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}]}};}catch{return {jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:'本次会话操作未完成，请根据当前连接状态处理；不要重复发送结果不确定的消息。'}]}};}
 }
 if(id===undefined)return null;return {jsonrpc:'2.0',id,error:{code:-32601,message:'方法不存在'}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const runtime=path.join(root,'data/qq-chat/agent-runtime.json');fs.mkdirSync(path.dirname(runtime),{recursive:true});fs.writeFileSync(runtime,JSON.stringify({pid:process.pid,sourceHash:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),startedAt:new Date().toISOString()}));
 const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});lines.on('line',line=>{if(line.length>1024*1024)return;let m;try{m=JSON.parse(line)}catch{return}Promise.resolve(dispatch(m)).then(answer=>{if(answer)process.stdout.write(JSON.stringify(answer)+'\n')}).catch(()=>{if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'伴屿连接暂不可用'}})+'\n')});});
}
