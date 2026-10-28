import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {OwnerToolJournal} from '../src/qq-chat/owner-tool-journal.mjs';

const scope='a'.repeat(64),account='1990000002',owner='1990000001',sessionId='session-1',turnId='turn-1';
const request={scope,account,owner,sessionId,turnId,action:{kind:'command',cwd:'D:\\gpt',command:'Write-Output "hello"'}};
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE owner_work_session(slot INTEGER,scope TEXT,session_id TEXT,turn_id TEXT,status TEXT); INSERT INTO owner_work_session VALUES(1,'"+scope+"','"+sessionId+"','"+turnId+"','running')");
 let currentScope=scope,settings={account,owner},at=1_750_000_000_000;
 const j=new OwnerToolJournal({db},{scopeNow:()=>currentScope,settingsNow:()=>settings,now:()=>at++});
 return {db,j,setScope:s=>currentScope=s,setSettings:s=>settings=s};
}
test('records a completed action durably with account, scope, bounded output and no confirmation code',()=>{
 const f=fixture(),id=f.j.begin({...request,code:'abcdef0123456789abcdef01'});assert.ok(id);
 assert.equal(f.j.finish({...request,id},{status:'success',result:{kind:'command',exitCode:0,output:'x'.repeat(1200)+' 确认 abcdef0123456789abcdef01',stderr:'token=secret-value'}}),true);
 const row=f.j.records({scope,account,owner})[0];assert.equal(row.status,'success');assert.match(row.source,/^qq-tool:/);assert.ok(row.time);
 const parsed=JSON.parse(row.text);assert.equal(parsed.request.command,request.action.command);assert.equal(parsed.result.output.length,250);assert.equal(parsed.result.outputTruncated,true);assert.match(parsed.result.stderr,/已隐藏/);assert.doesNotMatch(JSON.stringify(row),/abcdef0123456789abcdef01|secret-value/);assert.match(parsed.result.summary,/实际效果需另行核实/);
 f.db.close();
});
test('foreign owner, changed scope and non-running turn cannot start an operation record',()=>{
 const f=fixture();assert.equal(f.j.begin({...request,owner:'123456789'}),null);f.setScope('b'.repeat(64));assert.equal(f.j.begin(request),null);f.setScope(scope);
 f.db.prepare("UPDATE owner_work_session SET status='idle'").run();assert.equal(f.j.begin(request),null);assert.throws(()=>f.j.records({scope,account,owner:'123456789'}));f.db.close();
});
test('crash and identity changes are uncertain, no replay or false success',()=>{
 const f=fixture(),id=f.j.begin(request);assert.equal(f.j.markInterrupted(),1);const [row]=f.j.records({scope,account,owner});assert.equal(row.status,'uncertain');assert.match(row.text,/禁止自动重试/);
 assert.equal(f.j.unresolved({scope,account,owner}),1);
 assert.equal(f.j.finish({...request,id},{status:'success',result:{kind:'command',exitCode:0}}),false);
 const next=f.j.begin(request);f.setSettings({account,owner:'123456789'});assert.equal(f.j.finish({...request,id:next},{status:'success',result:{kind:'command',exitCode:0}}),true);
 f.setSettings({account,owner});assert.equal(f.j.records({scope,account,owner}).at(-1).status,'uncertain');f.db.close();
});
test('screenshots do not persist image data and false-success outcomes are rejected',()=>{
 const f=fixture(),target={screen:{x:0,y:0,width:1920,height:1080},window:{handle:'123',pid:42,process:'app',title:'文档',started:'12345',left:0,top:0,right:900,bottom:700}};
 const entry={...request,action:{kind:'screenshot'},target};let id=f.j.begin(entry);
 assert.throws(()=>f.j.finish({...entry,id},{status:'success',result:{kind:'command',exitCode:0}}),/不符/);
 assert.equal(f.j.finish({...entry,id},{status:'success',result:{kind:'screenshot',imageBase64:'image-secret-data'}}),true);assert.doesNotMatch(JSON.stringify(f.j.records({scope,account,owner})),/image-secret-data/);
 id=f.j.begin(request);assert.throws(()=>f.j.finish({...request,id},{status:'success',result:{kind:'command',exitCode:1}}));assert.throws(()=>f.j.finish({...request,id},{status:'failure',result:{error:'not proven'}}));
 assert.equal(f.j.finish({...request,id},{status:'uncertain',result:{error:'timeout'}}),true);f.db.close();
});
