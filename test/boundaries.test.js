import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {SecretaryFiles} from '../src/secretary-files.js';
import {safeError} from '../src/workflow.js';
const base=path.resolve('.test-tmp');fs.mkdirSync(base,{recursive:true});
async function use(fn) {
  const root=fs.mkdtempSync(path.join(base,'boundary-'));
  const source=path.join(root,'source');fs.mkdirSync(source);
  const file=path.join(source,'report.txt');fs.writeFileSync(file,'report');
  const cfg={enabled:true,recipientQQ:'123456789',sourceRoots:[source],gatewayUrl:'http://127.0.0.1:3000'};
  const update=change=>fs.writeFileSync(path.join(root,'secretary.json'),JSON.stringify({...cfg,...change}));update({});
  let calls=0;
  const service=new SecretaryFiles({root,env:{},fetchImpl:async()=>{calls++;return new Response('{"status":"ok","retcode":0}');}});
  try {await fn({root,source,file,cfg,update,service,calls:()=>calls});}
  finally {assert.ok(path.relative(base,root).startsWith('boundary-'));fs.rmSync(root,{recursive:true,force:true});}
}
test('changing recipient after preparation does not redirect an upload',()=>use(async({service,file,update,calls})=>{
  const p=service.prepare(file);update({recipientQQ:'987654321'});
  await assert.rejects(service.send(p.deliveryId),/differs/);assert.equal(calls(),0);
  assert.equal(service.status(p.deliveryId).recipientQQ,'123456789');
}));
test('changing gateway after preparation blocks upload',()=>use(async({service,file,update,calls})=>{
  const p=service.prepare(file);update({gatewayUrl:'http://127.0.0.1:4000'});
  await assert.rejects(service.send(p.deliveryId),/differs/);assert.equal(calls(),0);
}));
test('persisted acceptance prevents sending from a fresh service instance',()=>use(async({service,file,root})=>{
  const p=service.prepare(file);await service.send(p.deliveryId);
  const restarted=new SecretaryFiles({root,env:{},fetchImpl:()=>{throw Error('Must not call network');}});
  assert.equal((await restarted.send(p.deliveryId)).status,'gateway-accepted');
}));
test('durable sending lock is never automatically removed',()=>use(async({service,file,root,calls})=>{
  const p=service.prepare(file);const lock=path.join(root,'deliveries',p.deliveryId,'sending.lock');fs.writeFileSync(lock,'');
  const result=await service.send(p.deliveryId);assert.equal(result.busy,true);assert.equal(calls(),0);assert.ok(fs.existsSync(lock));
}));
test('prepare lock prevents a second preparation',()=>use(({service,file,root})=>{
  fs.mkdirSync(path.join(root,'deliveries'));fs.writeFileSync(path.join(root,'deliveries','prepare.lock'),'');
  assert.throws(()=>service.prepare(file),/准备锁/);
}));
test('metadata corruption is rejected before upload',()=>use(async({service,file,root,calls})=>{
  const p=service.prepare(file);const record=path.join(root,'deliveries',p.deliveryId,'delivery.json');
  const data=JSON.parse(fs.readFileSync(record));data.bytes=-1;fs.writeFileSync(record,JSON.stringify(data));
  await assert.rejects(service.send(p.deliveryId),/metadata/);assert.equal(calls(),0);
}));
test('linked state directory is rejected',()=>use(({service,file,root})=>{
  const other=path.join(root,'other');fs.mkdirSync(other);
  fs.symlinkSync(other,path.join(root,'deliveries'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>service.prepare(file),/暂存目录/);
}));
test('safe errors do not reveal internal paths or tokens',()=>{
  const text=safeError(new Error('/private/path fixture-secret'));assert.ok(!text.includes('fixture-secret'));assert.ok(!text.includes('/private/path'));
  assert.throws(()=>new SecretaryFiles({root:'relative'}),/FILE_SECRETARY_HOME/);
});
