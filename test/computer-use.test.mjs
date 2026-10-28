import test from 'node:test';
import assert from 'node:assert/strict';
import {ComputerUse} from '../src/qq-chat/computer-use.mjs';
import {computerContent} from '../src/qq-chat/agent.mjs';
import {validateComputerAction} from '../src/qq-chat/computer-approval.mjs';
const target={screen:{x:-100,y:0,width:1000,height:800},window:{handle:'1',pid:1,process:'fixture',title:'fixture',started:'1',left:0,top:0,right:900,bottom:700}};
const shot={kind:'screenshot',mediaType:'image/png',imageBase64:'fixture',screen:target.screen};
const turn=()=>({abort:new AbortController()});
test('desktop input is tied to a recent screenshot in this turn, one use only',()=>{
 let now=1;const loop=new ComputerUse({now:()=>now}),a=turn(),b=turn(),click={kind:'click',x:1,y:1,button:'left'};
 assert.throws(()=>loop.begin(a,click),/截图/);loop.begin(a,{kind:'screenshot'});const image=loop.observe(a,shot,target);
 assert.throws(()=>loop.begin(b,click,image.observationId),/截图/);assert.deepEqual(loop.begin(a,click,image.observationId),target);
 assert.throws(()=>loop.begin(a,click,image.observationId),/截图/);const next=loop.observe(a,shot,target);now+=120001;assert.throws(()=>loop.begin(a,click,next.observationId),/截图/);
 loop.halt(a);assert.throws(()=>loop.begin(a,{kind:'screenshot'}),/停止/);
});
test('desktop loop has bounded steps and rejects mismatched screenshot geometry',()=>{
 const loop=new ComputerUse({maxSteps:2}),t=turn();loop.begin(t,{kind:'screenshot'});loop.begin(t,{kind:'command'});assert.throws(()=>loop.begin(t,{kind:'screenshot'}),/上限/);
 const other=turn();assert.throws(()=>loop.observe(other,{...shot,screen:{...target.screen,x:0}},target),/范围/);
});
test('MCP carries follow-up screenshot as an image, not huge JSON text',()=>{
 const parts=computerContent({kind:'click',exitCode:0,observation:{...shot,observationId:'latest'}});
 assert.equal(parts[1].type,'image');assert.equal(parts[1].data,'fixture');assert.ok(!parts[0].text.includes('imageBase64'));assert.equal(JSON.parse(parts[0].text).observation.observationId,'latest');
});
test('scroll, double click and hotkeys validate exact bounded payloads',()=>{
 for(const a of [{kind:'scroll',direction:'down',steps:3},{kind:'double_click',x:10,y:20,button:'left'},{kind:'hotkey',key:'CTRL+L'}])assert.deepEqual(validateComputerAction(a),a);
 for(const a of [{kind:'scroll',direction:'down',steps:11},{kind:'scroll',direction:'down',steps:1,command:'hidden'},{kind:'hotkey',key:'^a{ENTER}'},{kind:'double_click',x:1,y:2,button:'middle'}])assert.throws(()=>validateComputerAction(a));
});

test('JPEG screenshots preserve original coordinates and become MCP image blocks',()=>{
 const loop=new ComputerUse(),t=turn(),jpeg={...shot,mediaType:'image/jpeg',imageBase64:'/9j/2Q=='};
 const observed=loop.observe(t,jpeg,target),parts=computerContent(observed);
 assert.deepEqual(observed.screen,target.screen);assert.equal(parts[1].mimeType,'image/jpeg');assert.equal(parts[1].data,jpeg.imageBase64);
 assert.deepEqual(loop.begin(t,{kind:'click',x:1,y:1,button:'left'},observed.observationId),target);
});
test('oversized screenshots are rejected before the MCP transport can disconnect',()=>{
 const loop=new ComputerUse();assert.throws(()=>loop.observe(turn(),{...shot,imageBase64:'a'.repeat(6000001)},target),/未取得/);
});
