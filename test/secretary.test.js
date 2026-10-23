import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretaryFiles } from '../src/secretary-files.js';
import { registerTools } from '../src/mcp.js';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.test-tmp');
fs.mkdirSync(base, { recursive: true });
function fixture(fetchImpl = async () => response({ status: 'ok', retcode: 0, data: null })) {
  const root = fs.mkdtempSync(path.join(base, 'secretary-'));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const file = path.join(source, '测试报告.txt'); fs.writeFileSync(file, '只发送指定产物\n');
  const cfg = { enabled: true, recipientQQ: '123456789', gatewayUrl:'http://127.0.0.1:3000', sourceRoots: [source] };
  fs.writeFileSync(path.join(root, 'secretary.json'), JSON.stringify(cfg));
  const service = new SecretaryFiles({ root, fetchImpl, env:{ONEBOT_ACCESS_TOKEN:'fixture-secret'} });
  return { root, source, file, service, cfg, cleanup: () => { assert.ok(path.relative(base, root).startsWith('secretary-')); fs.rmSync(root, { recursive: true, force: true }); } };
}
const response = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
async function use(fn, fetchImpl) { const f = fixture(fetchImpl); try { await fn(f); } finally { f.cleanup(); } }

test('prepare creates immutable snapshot and exposes only metadata', () => use(({ service, file, root }) => {
  const r = service.prepare(file); assert.equal(r.status, 'prepared');
  assert.equal(fs.readFileSync(path.join(root, 'deliveries', r.deliveryId, r.name), 'utf8'), '只发送指定产物\n');
  fs.writeFileSync(file, 'changed'); assert.equal(service.status(r.deliveryId).sha256, r.sha256);
  assert.ok(!JSON.stringify(r).includes('source')); assert.ok(!JSON.stringify(r).includes('fixture-secret'));
}));
test('fixed private endpoint, bearer auth, same-machine snapshot; repeat send is idempotent', () => {
  let calls = 0, payload;
  return use(async ({ service, file, root }) => {
    const r = service.prepare(file); const sent = await service.send(r.deliveryId);
    assert.equal(sent.status, 'gateway-accepted'); assert.equal(calls, 1);
    assert.equal(payload.user_id, 123456789); assert.equal(payload.upload_file, true);
    assert.ok(payload.file.startsWith(path.join(root, 'deliveries')));
    assert.equal((await service.send(r.deliveryId)).status, 'gateway-accepted'); assert.equal(calls, 1);
  }, async (url, options) => { calls++; assert.equal(url, 'http://127.0.0.1:3000/upload_private_file'); assert.equal(options.headers.Authorization, 'Bearer fixture-secret'); assert.equal(options.redirect, 'error'); payload = JSON.parse(options.body); return response({ status: 'ok', retcode: 0, data: null }); });
});
test('concurrent calls acquire one durable send lock', () => {
  let release, calls = 0;
  return use(async ({ service, file }) => {
    const r = service.prepare(file); const pending = service.send(r.deliveryId);
    const second = await service.send(r.deliveryId); assert.equal(second.busy, true);
    release(); assert.equal((await pending).status, 'gateway-accepted'); assert.equal(calls, 1);
  }, async () => { calls++; await new Promise(r => { release = r; }); return response({ status: 'ok', retcode: 0 }); });
});
test('network interruption becomes unknown and never retries', () => {
  let calls = 0;
  return use(async ({ service, file }) => { const r = service.prepare(file); assert.equal((await service.send(r.deliveryId)).status, 'unknown'); assert.equal((await service.send(r.deliveryId)).status, 'unknown'); assert.equal(calls, 1); }, async () => { calls++; throw new Error('fixture-secret'); });
});
for (const [label, res, expected] of [
  ['gateway rejection', () => response({ status: 'failed', retcode: 1200, wording: 'fixture-secret' }), 'unknown'],
  ['HTTP error', () => response({ status: 'failed', retcode: 1200 }, 500), 'unknown'],
  ['malformed response', () => new Response('invalid'), 'unknown'],
  ['ambiguous envelope', () => response({ retcode: 0 }), 'unknown'],
  ['oversized response', () => new Response('x'.repeat(70000)), 'unknown'],
]) test(label + ' is sanitized', () => use(async ({ service, file }) => { const r = service.prepare(file); const result = await service.send(r.deliveryId); assert.equal(result.status, expected); assert.ok(!JSON.stringify(result).includes('fixture-secret')); }, async () => res()));
test('snapshot tamper fails before upload', () => use(async ({ service, file, root }) => {
  const r = service.prepare(file); fs.writeFileSync(path.join(root, 'deliveries', r.deliveryId, r.name), 'tamper');
  await assert.rejects(service.send(r.deliveryId), /校验失败/);
}));
test('outside root, URL, UNC, directory, credentials and reserved names rejected', () => use(({ service, source, root }) => {
  const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'x');
  for (const p of [outside, 'https://example.com/a', '\\\\server\\a', source]) assert.throws(() => service.prepare(p));
  for (const name of ['.env', 'config.json', 'test.pem', 'delivery.json', 'sending.lock']) { const p = path.join(source, name); fs.writeFileSync(p, 'x'); assert.throws(() => service.prepare(p)); }
}));
test('32MiB cap rejects sparse oversized file', () => use(({ service, source }) => {
  const file = path.join(source, 'large.bin'); const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1); fs.closeSync(fd); assert.throws(() => service.prepare(file), /32MiB/);
}));
test('junction cannot escape source roots', () => use(({ service, source, root }) => {
  const other = path.join(root, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'leak.txt'), 'private');
  fs.symlinkSync(other, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => service.prepare(path.join(source, 'link/leak.txt')), /允许来源/);
}));
test('disabled or invalid recipient fails closed', () => use(({ service, cfg, root, file }) => {
  for (const change of [{ enabled: false }, { recipientQQ: '123' }]) { fs.writeFileSync(path.join(root, 'secretary.json'), JSON.stringify({ ...cfg, ...change })); assert.throws(() => service.prepare(file)); }
}));
test('non-local, credentialed or non-root gateway is rejected before prepare', () => use(({ service, root, file, cfg }) => {
  for(const gatewayUrl of ['http://example.com','http://localhost:3000','http://127.0.0.1/a','https://127.0.0.1','http://name:secret@127.0.0.1','http://127.0.0.1?token=secret']) {
    fs.writeFileSync(path.join(root,'secretary.json'),JSON.stringify({...cfg,gatewayUrl}));
    assert.throws(()=>service.prepare(file));
  }
}));
test('expired preparation is not sent; unknown records retained during cleanup', () => use(async ({ service, file, root }) => {
  const r = service.prepare(file); const record = path.join(root, 'deliveries', r.deliveryId, 'delivery.json');
  const old = JSON.parse(fs.readFileSync(record)); old.createdAt = new Date(Date.now() - 9 * 86400000).toISOString(); fs.writeFileSync(record, JSON.stringify(old));
  assert.equal((await service.send(r.deliveryId)).status, 'expired');
  old.status = 'unknown'; fs.writeFileSync(record, JSON.stringify(old)); service.prepare(file); assert.equal(service.status(r.deliveryId).status, 'unknown');
}));
test('64-record limit and invalid IDs', () => use(({ service, file }) => {
  for (let i = 0; i < 64; i++) service.prepare(file);
  assert.throws(() => service.prepare(file), /上限/); assert.throws(() => service.status('../a'), /无效/);
}));
test('MCP registration maps fixed schemas and does not expose raw errors', async () => {
  const tools = new Map(); const fakeServer = { registerTool: (name, config, call) => tools.set(name, { ...config, call }) };
  const fakeService = { prepare: file => ({ status: 'prepared', file }), send: async () => { throw new Error('fixture-secret'); }, status: id => ({ deliveryId: id }) };
  registerTools(fakeServer, fakeService); assert.equal(tools.size, 4);
  assert.deepEqual(Object.keys(tools.get('send_file').inputSchema), ['deliveryId']);
  assert.ok((await tools.get('file_secretary_help').call({})).content[0].text.includes('禁止自动重发'));
  const failed = await tools.get('send_file').call({ deliveryId: 'x' }); assert.equal(failed.isError, true); assert.ok(!JSON.stringify(failed).includes('fixture-secret'));
});
test('generic SnowLuma internal failure cannot authorize a retry', () => {
  let calls=0;
  return use(async ({service,file}) => {const p=service.prepare(file);assert.equal((await service.send(p.deliveryId)).status,'unknown');assert.equal((await service.send(p.deliveryId)).status,'unknown');assert.equal(calls,1);},async()=>{calls++;return response({status:'failed',retcode:100,wording:'send reply 30 timed out after 15000 ms fixture-secret'});});
});
test('confirmation timeout in any failure wording is sanitized and retained as unknown', async () => {
  for(const wording of ['request timeout fixture-secret','send reply timed out fixture-secret','发送确认超时 fixture-secret','upload unconfirmed fixture-secret']) await use(async ({service,file}) => {const p=service.prepare(file);const r=await service.send(p.deliveryId);assert.equal(r.status,'unknown');assert.ok(!JSON.stringify(r).includes('fixture-secret'));},async()=>response({status:'failed',retcode:1200,wording}));
});
