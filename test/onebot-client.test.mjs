import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {OneBotClient,text} from '../sharing/onebot-client.mjs';
async function fixture(t,handler,options={}){
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');
 const connections=[];server.on('connection',(socket,req)=>{connections.push({socket,req});socket.on('message',b=>handler?.(socket,JSON.parse(b)))});
 const client=new OneBotClient({url:'ws://127.0.0.1:'+server.address().port,accessToken:'fixture-local-token',reconnectDelay:10,...options});
 t.after(async()=>{client.close();for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r))});
 await client.connect();return {server,client,connections};
}
test('独立OneBot连接鉴权、匹配并发echo，返回数据而非泄露服务错误正文',async t=>{
 const f=await fixture(t,(s,m)=>setTimeout(()=>s.send(JSON.stringify({echo:m.echo,status:m.action==='bad_action'?'failed':'ok',retcode:m.action==='bad_action'?1400:0,data:{action:m.action},message:'PRIVATE-SERVER-CONTENT'})),m.action==='get_login_info'?20:1));
 assert.equal(f.connections[0].req.headers.authorization,'Bearer fixture-local-token');
 const results=await Promise.all([f.client.getLoginInfo(),f.client.getGroupMemberList(123)]);
 assert.equal(results[0].action,'get_login_info');assert.equal(results[1].action,'get_group_member_list');
 await assert.rejects(f.client.raw('bad_action'),e=>!e.message.includes('PRIVATE-SERVER-CONTENT')&&e.message.includes('1400'));
 assert.deepEqual(text('hello'),{type:'text',data:{text:'hello'}});
});
test('私聊群聊通知和心跳事件分类，丢弃非事件与未知echo',async t=>{
 const f=await fixture(t),events=[],privateMessages=[],groups=[],notices=[];
 f.client.onEvent(e=>events.push(e));f.client.onPrivateMessage(e=>privateMessages.push(e));f.client.onGroupMessage(e=>groups.push(e));f.client.onNotice('notify',e=>notices.push(e));
 const s=f.connections[0].socket;s.send('invalid');s.send(JSON.stringify({echo:'unknown',status:'ok',retcode:0}));
 for(const e of [{post_type:'message',message_type:'private'},{post_type:'message',message_type:'group'},{post_type:'notice',notice_type:'notify'},{post_type:'meta_event',meta_event_type:'heartbeat'}])s.send(JSON.stringify(e));
 await new Promise(r=>setTimeout(r,30));assert.equal(events.length,4);assert.equal(privateMessages.length,1);assert.equal(groups.length,1);assert.equal(notices.length,1);
});
test('请求超时与断开均结清等待，断线能重连，主动关闭不再重连',async t=>{
 const f=await fixture(t,null,{requestTimeout:30});await assert.rejects(f.client.getLoginInfo(),/超时/);
 const pending=f.client.getLoginInfo();const rejected=assert.rejects(pending,/断开/);const opened=once(f.client,'open');f.connections[0].socket.terminate();await rejected;await opened;assert.equal(f.connections.length,2);
 f.client.close();await new Promise(r=>setTimeout(r,60));assert.equal(f.connections.length,2);assert.equal(f.client.pending.size,0);
});
test('默认不允许远程端点、凭据URL或查询令牌',()=>{
 for(const url of ['ws://example.com:3301','ws://192.168.1.1:3301','ws://u:p@localhost:3301','ws://localhost:3301?access_token=secret','http://localhost:3301'])assert.throws(()=>new OneBotClient({url}));
});
test('半开连接没有 pong 时自动断开并重新建立连接',async t=>{
 const f=await fixture(t,null,{heartbeatInterval:20});f.connections[0].socket._autoPong=false;
 await once(f.client,'open');assert.equal(f.connections.length,2);
});
