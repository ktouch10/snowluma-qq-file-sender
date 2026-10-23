import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { QqFileListener, privateEvent } from '../src/qq-listener.js';

const base = path.resolve('test-tmp/listener'); fs.mkdirSync(base,{recursive:true});
const event = (text, message_id=1, extra={}) => ({post_type:'message',message_type:'private',self_id:987654321,user_id:123456789,sender:{user_id:123456789},message_id,message:[{type:'text',data:{text}}],...extra});
class Socket extends EventTarget {
  static instances=[];
  constructor(url) { super(); this.url=url; Socket.instances.push(this); }
  close() { this.dispatchEvent(new Event('close')); }
}
async function use(fn) {
  const root=fs.mkdtempSync(path.join(base,'fixture-')), source=path.join(root,'source'); fs.mkdirSync(source);
  const cfg={enabled:true,recipientQQ:'123456789',gatewayUrl:'http://127.0.0.1:3000',sourceRoots:[path.join(root,'outbox')],search:{enabled:true,receivePrivateMessages:true,wsUrl:'ws://127.0.0.1:3001/event',localRoots:[{path:source,label:'产物',kind:'outputs'}],allowedGroups:[]}};
  const save=()=>fs.writeFileSync(path.join(root,'secretary.json'),JSON.stringify(cfg)); save();
  const calls=[], logs=[];
  const listener=new QqFileListener({root,env:{ONEBOT_ACCESS_TOKEN:'fixture-secret'},WebSocketImpl:Socket,reconnectMs:5,log:s=>logs.push(s),fetchImpl:async(url,opts)=>{calls.push({url,...JSON.parse(opts.body)});assert.equal(opts.headers.Authorization,'Bearer fixture-secret');return Response.json({status:'ok',retcode:0});}});
  try { await fn({root,source,cfg,save,listener,calls,logs}); }
  finally { await listener.stop(); assert.equal(fs.realpathSync(root),root); fs.rmSync(root,{recursive:true}); }
}
test('event adapter only accepts configured private sender and current text segments',()=>{
  assert.ok(privateEvent(event('找文件 报告'),'123456789'));
  for(const extra of [{message_type:'group'},{post_type:'message_sent'},{user_id:55555},{sender:{user_id:55555}},{self_id:123456789},{message_id:undefined},{message:'找文件 报告'},{message:[{type:'reply',data:{id:'1'}},{type:'text',data:{text:'找文件 报告'}}]}]) assert.equal(privateEvent(event('找文件 报告',1,extra),'123456789'),null);
});
test('owner message through optional WebSocket finds, selects, uploads and replies to fixed owner',()=>use(async f=>{
  fs.writeFileSync(path.join(f.source,'项目报告.pdf'),'fixture'); f.listener.start();
  const socket=f.listener.socket; assert.equal(new URL(socket.url).searchParams.get('access_token'),'fixture-secret');
  socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(event('找文件 项目报告'))}));
  await Promise.all([...f.listener.pending]); assert.equal(f.calls.length,1); assert.match(f.calls[0].message[0].data.text,/项目报告.pdf/);
  await f.listener.consume(JSON.stringify(event('发送第1个',2)));
  assert.equal(f.calls.filter(c=>c.url.endsWith('/upload_private_file')).length,1);
  assert.ok(f.calls.every(c=>c.user_id===123456789));
  await f.listener.consume(JSON.stringify(event('发送第1个',2)));
  await f.listener.consume(JSON.stringify(event('发送第1个',3)));
  assert.equal(f.calls.filter(c=>c.url.endsWith('/upload_private_file')).length,1);
  assert.ok(!f.logs.join('').includes('fixture-secret'));
}));
test('strangers, groups, quote segments, malformed JSON and oversized events do no work',()=>use(async f=>{
  f.listener.start();
  for(const raw of [event('找文件 报告',1,{message_type:'group'}),event('找文件 报告',2,{user_id:55555}),event('找文件 报告',3,{message:[{type:'forward',data:{id:'x'}}]})]) await f.listener.consume(JSON.stringify(raw));
  await f.listener.consume('{'); await f.listener.consume('x'.repeat(65537));
  assert.equal(f.calls.length,0); assert.equal(fs.existsSync(path.join(f.root,'search-data','requests.json')),false);
}));
test('listener is opt-in and rejects non-loopback or credentialed WebSocket URLs',()=>use(async f=>{
  f.cfg.search.receivePrivateMessages=false; f.save(); assert.throws(()=>f.listener.start());
  f.cfg.search.receivePrivateMessages=true;
  for(const url of ['wss://example.com/','ws://localhost:3001/','ws://user:secret@127.0.0.1/','ws://127.0.0.1/?access_token=secret','ws://127.0.0.1/api']) {f.cfg.search.wsUrl=url;f.save();assert.throws(()=>f.listener.start());}
}));
test('exclusive listener lock prevents a second controller and is released on stop',()=>use(async f=>{
  f.listener.start();
  const other=new QqFileListener({root:f.root,env:{},WebSocketImpl:Socket});
  assert.throws(()=>other.start()); assert.ok(fs.existsSync(path.join(f.root,'search-data','listener.lock')));
  await f.listener.stop(); assert.equal(fs.existsSync(path.join(f.root,'search-data','listener.lock')),false);
  other.start(); await other.stop();
}));
test('recipient change stops old listener replies and file commands',()=>use(async f=>{
  f.listener.start(); f.cfg.recipientQQ='555555555';f.save();
  await f.listener.consume(JSON.stringify(event('文件帮助',1,{user_id:555555555,sender:{user_id:555555555}})));
  await f.listener.reply('must not send'); assert.equal(f.calls.length,0);
}));
test('connection close reconnects but stop prevents further reconnection or work',()=>use(async f=>{
  f.listener.start(); const first=f.listener.socket; first.close();
  await new Promise(r=>setTimeout(r,15)); assert.notEqual(f.listener.socket,first);
  await f.listener.stop(); const last=f.listener.socket;last.close(); await new Promise(r=>setTimeout(r,15)); assert.equal(f.listener.socket,last);
  await f.listener.consume(JSON.stringify(event('文件帮助'))); assert.equal(f.calls.length,0);
}));
