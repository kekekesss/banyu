import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initializeShare} from '../sharing/initialize.mjs';
import {QQStore} from '../src/qq-chat/store.mjs';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-share-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const apps=path.join(root,'应用 path');fs.mkdirSync(apps);const values={owner:'123456789',bot:'987654321'};
 for(const [key,name]of [['quark','quark.exe'],['qq','QQ.exe'],['dsh','DeepSeek Harness.exe']]){values[key]=path.join(apps,name);fs.writeFileSync(values[key],'fixture')}
 const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
 return {root,values,read};
}
test('分享版首次设置生成自己的随机密钥、白名单和可迁移路径',t=>{
 const f=fixture(t);initializeShare(f.root,f.values);assert.equal(fs.existsSync(path.join(f.root,'companion')),false);
 const db=new QQStore(path.join(f.root,'data/qq-chat')),cfg=db.settings();db.close();const local=f.read('data/local-qq/settings.json'),credentials=f.read('data/local-qq/credentials.json');
 assert.deepEqual(cfg.privateAllow,['123456789']);assert.deepEqual(cfg.groupAllow,[]);assert.equal(cfg.account,'987654321');assert.equal(local.mode,'pmhq');assert.equal(local.consented,false);assert.equal(local.account,cfg.account);assert.equal(local.owner,cfg.owner);assert.equal(cfg.proactive.enabled,false);
 assert.ok(fs.existsSync(path.join(f.root,'data/qq-chat/enabled')));
 assert.ok(credentials.onebot.length>=32);assert.notEqual(credentials.web,credentials.onebot);
 assert.equal(f.read('data/machine-settings.json').qqExecutable,f.values.qq);
});
test('已有配置不被首次设置覆盖，主人和机器人必须不同',t=>{
 const f=fixture(t);assert.throws(()=>initializeShare(f.root,{...f.values,bot:f.values.owner}),/不同/);
 initializeShare(f.root,f.values);const before=f.read('data/local-qq/credentials.json');assert.throws(()=>initializeShare(f.root,f.values),/未重置/);assert.deepEqual(f.read('data/local-qq/credentials.json'),before);
});
test('仅微信模式无需QQ或DSH，未配置普通QQ时不生成账号密钥',t=>{
 const f=fixture(t);initializeShare(f.root,{quark:f.values.quark});assert.equal(fs.existsSync(path.join(f.root,'companion')),false);assert.equal(fs.existsSync(path.join(f.root,'data/local-qq/credentials.json')),false);assert.ok(fs.existsSync(path.join(f.root,'data/qq-chat/enabled')));
});
