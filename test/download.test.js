import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createQqDownloader, requestBytes, isPublicV4, validateQqFileUrl } from '../src/qq-download.js';

const url = 'https://download.ftn.qq.com/file?key=opaque';
function mockRequest(replies, calls = []) {
  return (options, callback) => {
    calls.push(options);
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => {
      const next = replies.shift();
      if (next.error) { req.emit('error', new Error('fixture-secret')); return; }
      const res = new EventEmitter(); res.statusCode = next.status ?? 200;
      res.headers = next.headers ?? {}; res.complete = false; res.destroy = () => {};
      callback(res);
      if (next.stall) return;
      for (const chunk of next.chunks ?? [Buffer.from(next.body ?? 'fixture')]) res.emit('data', chunk);
      res.complete = true; res.emit('end'); res.emit('close');
    }); return req;
  };
}
test('public IPv4 guard rejects private, special and invalid addresses', () => {
  for (const ip of ['0.1.2.3','10.1.2.3','127.0.0.1','100.64.1.2','169.254.1.1','172.16.1.1','192.168.0.1','192.0.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','invalid']) assert.equal(isPublicV4(ip), false, ip);
  assert.equal(isPublicV4('1.1.1.1'), true);
});
test('QQ download requires approved HTTPS domain before DNS or request', async () => {
  const download = createQqDownloader({ lookup: () => { throw new Error('must not resolve'); } });
  for (const candidate of ['http://ftn.qq.com/a','https://ftn.qq.com.evil.example/a','https://127.0.0.1/a','https://ftn.qq.com:444/a','https://user:secret@ftn.qq.com/a','https://ftn.qq.com/a#fragment']) {
    assert.throws(() => validateQqFileUrl(candidate)); await assert.rejects(download(candidate));
  }
});
test('DNS result is pinned while original TLS hostname and Host are preserved', async () => {
  const calls = [];
  const download = createQqDownloader({ lookup: async (host, opts) => { assert.equal(host,'download.ftn.qq.com'); assert.equal(opts.family,4); return [{address:'1.1.1.1'}]; }, request: mockRequest([{body:'fixture'}],calls) });
  assert.equal((await download(url)).buffer.toString(), 'fixture');
  assert.equal(calls.length,1); assert.equal(calls[0].hostname,'1.1.1.1'); assert.equal(calls[0].servername,'download.ftn.qq.com'); assert.equal(calls[0].headers.host,'download.ftn.qq.com'); assert.equal(calls[0].rejectUnauthorized,true); assert.equal(calls[0].path,'/file?key=opaque'); assert.equal(calls[0].agent,false);
});
test('mixed public/private DNS and absent answers never reach HTTP', async () => {
  for (const answers of [[],[{address:'1.1.1.1'},{address:'127.0.0.1'}],[{address:'::1'}]]) {
    let calls = 0;
    await assert.rejects(createQqDownloader({lookup:async()=>answers,request:()=>{calls++;}})(url)); assert.equal(calls,0);
  }
});
test('synthetic TUN DNS uses fixed public resolver and validates returned A records', async () => {
  const calls = [], request = mockRequest([{body:JSON.stringify({Status:0,Answer:[{type:1,data:'1.0.0.1'}]})},{body:'fixture'}],calls);
  assert.equal((await createQqDownloader({lookup:async()=>[{address:'198.18.0.1'}],request})(url)).buffer.toString(),'fixture');
  assert.equal(calls[0].hostname,'1.1.1.1'); assert.equal(calls[0].servername,'cloudflare-dns.com'); assert.equal(calls[1].hostname,'1.0.0.1');
  await assert.rejects(createQqDownloader({lookup:async()=>[{address:'198.18.0.1'}],request:mockRequest([{body:JSON.stringify({Status:0,Answer:[{type:1,data:'127.0.0.1'}]})}])})(url));
});
for (const [label, reply] of [
  ['redirect',{status:302,headers:{location:'https://example.com/'}}],
  ['HTTP failure',{status:500}], ['large content length',{headers:{'content-length':'100'}}],
  ['large stream',{body:'x'.repeat(20)}], ['truncated body',{headers:{'content-length':'8'},body:'short'}],
  ['unexpected compression',{headers:{'content-encoding':'gzip'}}], ['socket error',{error:true}],
]) test(label + ' is rejected and no URL or upstream error is returned', async () => {
  const download = createQqDownloader({lookup:async()=>[{address:'1.1.1.1'}],request:mockRequest([reply])});
  await assert.rejects(download(url,10),error=>!error.message.includes('opaque')&&!error.message.includes('fixture-secret'));
});
test('total response deadline stops a body that never finishes', async () => {
  await assert.rejects(requestBytes({hostname:'1.1.1.1'},10,20,mockRequest([{stall:true}])));
});
