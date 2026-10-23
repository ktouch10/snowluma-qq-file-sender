import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretarySearch, parseFileRequest, filenameScore, validateQqFileUrl } from '../src/secretary-search.js';
import { SecretaryFiles } from '../src/secretary-files.js';

const BASE = path.resolve('test-tmp/search');
fs.mkdirSync(BASE, { recursive: true });
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v));
const event = (text, messageId = '1', extra = {}) => ({ kind: 'private', peerId: '123456789', senderId: '123456789', messageId, text, ...extra });
function fixture(options = {}) {
  const root = path.join(BASE, randomUUID()), source = path.join(root, 'source'); fs.mkdirSync(source, { recursive: true });
  const cfg = { allow: { private: [123456789], groups: [11111] }, deny: { private: [], groups: [] }, snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'fixture-private-token' } };
  const settings = { enabled: true, recipientQQ: '123456789', gatewayUrl: 'http://127.0.0.1:3000', sourceRoots: [path.join(root, 'outbox')], search: { enabled: true, allowedGroups: ['11111'], localRoots: [{ path: source, label: '桌面', kind: 'desktop' }] } };
  write(path.join(root, 'config.json'), cfg); write(path.join(root, 'secretary.json'), settings);
  let uploads = 0, calls = [], clock = Date.now();
  const fetchImpl = options.fetchImpl ?? (async (url, request) => {
    const action = new URL(url).pathname.slice(1), params = JSON.parse(request.body); calls.push({ action, params });
    if (action === 'upload_private_file') {
      uploads++; assert.equal(params.user_id, 123456789); assert.ok(params.file.startsWith(path.join(root, 'deliveries')));
      if (options.uploadUnknown) throw Error('fixture-private-token');
      return Response.json({ status: 'ok', retcode: 0 });
    }
    const data = action === 'get_group_file_url' ? { url: 'https://gzc-download.ftn.qq.com/fixture' } : (options.groups ?? { files: [], folders: [] });
    return Response.json({ status: 'ok', retcode: 0, data });
  });
  const now = () => clock;
  const sender = new SecretaryFiles({ root, fetchImpl, now, env: { ONEBOT_ACCESS_TOKEN: 'fixture-private-token' } });
  const make = () => new SecretarySearch({ root, sender, fetchImpl, now, download: options.download ?? (async () => ({ buffer: Buffer.from('fixture') })), sessionAllowed: options.sessionAllowed ?? (() => true) });
  let service = make(); const replies = [];
  return { root, source, cfg, settings, calls, sender, replies, get service() { return service; }, get uploads() { return uploads; },
    file(name, text = 'fixture') { const p = path.join(source, name); fs.writeFileSync(p, text); return p; },
    config() { write(path.join(root, 'config.json'), cfg); write(path.join(root, 'secretary.json'), settings); },
    advance(ms) { clock += ms; }, restart() { service = make(); },
    run(text, id = '1', extra) { return service.handle(event(text, id, extra), async s => { replies.push(s); }); },
    dispose() { assert.ok(root.startsWith(BASE + path.sep)); assert.equal(fs.realpathSync(root), root); fs.rmSync(root, { recursive: true }); }
  };
}
async function use(fn, options) { const f = fixture(options); try { await fn(f); } finally { f.dispose(); } }

test('natural requests retain useful filename words and select source', () => {
  assert.deepEqual(parseFileRequest('帮我把桌面上的项目报告PDF发给我'), { type: 'search', query: '项目报告 pdf', source: 'local', location: 'desktop', autoSend: true });
  assert.equal(parseFileRequest('找群文件 高数 复习').source, 'group');
  assert.equal(parseFileRequest('帮我把群里的高数复习资料发给我').query, '高数复习资料');
  assert.equal(parseFileRequest('我需要线性代数课件文件').query, '线性代数课件');
  assert.equal(parseFileRequest('我需要休息'), null);
  assert.equal(parseFileRequest('帮我找群文件 高数 复习').query, '高数 复习');
  assert.equal(parseFileRequest('给我发桌面上的简历pdf').query, '简历 pdf');
  assert.equal(parseFileRequest('找一下桌面上的简历pdf').query, '简历 pdf');
  assert.equal(parseFileRequest('发送第2个').index, 1);
});
test('filename matching requires all keywords and supports full filename', () => {
  assert.ok(filenameScore('项目报告_2026.pdf', '报告 pdf'));
  assert.equal(filenameScore('项目报告.docx', '报告 pdf'), 0);
  assert.ok(filenameScore('高数_复习资料.pdf', '高数 复习') > 0);
});
test('group, stranger private and forged owner peer cannot access local search', () => use(async f => {
  f.file('简历.pdf');
  for (const extra of [{ kind: 'group' }, { senderId: '123' }, { peerId: '123' }]) assert.equal(await f.run('找文件 简历', '1', extra), false);
  assert.equal(f.replies.length, 0); assert.equal(fs.existsSync(path.join(f.root, 'search-data')), false);
}));
test('only search shows candidates without uploading or reading file contents into replies', () => use(async f => {
  f.file('简历.pdf', 'PRIVATE_CONTENT'); await f.run('找文件 简历');
  assert.match(f.replies[0], /简历.pdf/); assert.ok(!f.replies[0].includes('PRIVATE_CONTENT')); assert.ok(!f.replies[0].includes(f.source)); assert.equal(f.uploads, 0);
}));
test('explicit unique request stages under the configured runtime and sends to fixed owner', () => use(async f => {
  f.file('简历.pdf'); await f.run('帮我把桌面上的简历pdf发给我');
  assert.equal(f.uploads, 1); assert.match(f.replies[0], /交给QQ/);
  assert.equal(fs.readdirSync(path.join(f.root, 'outbox', 'found-files')).length, 0);
}));
test('ambiguous results require selection, repeated choice and websocket replay never resend', () => use(async f => {
  f.file('简历一.pdf'); f.file('简历二.pdf');
  await f.run('帮我把桌面上的简历pdf发给我'); assert.equal(f.uploads, 0);
  await f.run('发送第2个', '2'); assert.equal(f.uploads, 1);
  f.restart(); await f.run('发送第2个', '2'); assert.equal(f.uploads, 1);
  await f.run('发送第2个', '3'); assert.equal(f.uploads, 1);
}));
test('expired selections cannot send', () => use(async f => {
  f.file('简历.pdf'); await f.run('找文件 简历'); f.advance(600001); await f.run('发送第1个', '2');
  assert.equal(f.uploads, 0); assert.match(f.replies.at(-1), /10分钟/);
}));
test('cancel drops selection', () => use(async f => {
  f.file('简历.pdf'); await f.run('找文件 简历'); await f.run('取消找文件', '2'); await f.run('发送第1个', '3'); assert.equal(f.uploads, 0);
}));
test('new failed or empty search cannot leave an old numbered selection active', () => use(async f => {
  f.file('简历.pdf'); await f.run('找文件 简历'); await f.run('找文件 不存在的课件', '2'); await f.run('发送第1个', '3'); assert.equal(f.uploads, 0);
}));
test('changed local file is rejected before upload', () => use(async f => {
  const p = f.file('简历.pdf'); await f.run('找文件 简历'); fs.writeFileSync(p, 'changed-size'); await f.run('发送第1个', '2');
  assert.equal(f.uploads, 0); assert.match(f.replies.at(-1), /变化/);
}));
test('removed local root and revoked owner permission stop prepared selection', () => use(async f => {
  f.file('简历.pdf'); await f.run('找文件 简历'); f.settings.search.localRoots = []; f.config(); await f.run('发送第1个', '2'); assert.equal(f.uploads, 0);
  f.settings.search.enabled = false; f.config(); await f.run('文件状态', '3'); assert.match(f.replies.at(-1), /未启用/);
}));
test('private names, unsupported files, oversized files and nested credentials do not appear', () => use(async f => {
  f.file('简历.pdf'); f.file('password.txt'); f.file('config.json'); f.file('run.exe');
  const p = f.file('超大资料.pdf'); fs.truncateSync(p, 33 * 1024 * 1024);
  fs.mkdirSync(path.join(f.source, 'state')); fs.writeFileSync(path.join(f.source, 'state', '简历隐藏.pdf'), 'hidden');
  await f.run('找文件 简历'); assert.match(f.replies[0], /1个候选/); assert.ok(!f.replies[0].includes('隐藏'));
  await f.run('找文件 password', '2'); assert.ok(!f.replies.at(-1).includes('password.txt'));
  await f.run('找文件 超大资料', '3'); assert.match(f.replies.at(-1), /32MiB/);
}));
test('directory junction cannot escape authorized search root', () => use(async f => {
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, '简历外部.pdf'), 'hidden');
  fs.symlinkSync(outside, path.join(f.source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.run('找文件 简历'); assert.ok(!f.replies[0].includes('简历外部'));
}));
test('missing message id never executes and missing local root prevents automatic unique send', () => use(async f => {
  f.file('简历.pdf'); await f.run('找文件 简历', '', { messageId: '' }); assert.equal(f.uploads, 0);
  f.settings.search.localRoots.push({ path: path.join(f.root, 'missing'), label: '下载', kind: 'downloads' }); f.config();
  await f.run('帮我把电脑上的简历pdf发给我', '2'); assert.equal(f.uploads, 0); assert.match(f.replies.at(-1), /未搜完/);
}));
test('group traversal includes folder files and download is server generated', () => use(async f => {
  await f.run('找群文件 高数'); assert.match(f.replies[0], /高数.pdf/); assert.equal(f.uploads, 0);
  await f.run('发送第1个', '2'); assert.equal(f.uploads, 1);
  assert.equal(f.calls.filter(c => c.action === 'get_group_file_url').length, 1);
}, { groups: { files: [{ file_name: '高数.pdf', file_id: 'file-1', file_size: 7, busid: 102 }], folders: [{ folder_id: 'folder-1' }] }, download: async (url, max, opts) => { assert.equal(new URL(url).hostname, 'gzc-download.ftn.qq.com'); assert.equal(max, 32 * 1024 * 1024); assert.equal(opts.timeoutMs, 60000); return { buffer: Buffer.from('fixture') }; } }));
test('denied group is not queried and cached group results are revoked', () => use(async f => {
  await f.run('找群文件 高数'); f.settings.search.allowedGroups = []; f.config(); await f.run('发送第1个', '2'); assert.equal(f.uploads, 0);
  const count = f.calls.length; await f.run('找群文件 高数', '3'); assert.equal(f.calls.length, count); assert.ok(!f.replies.at(-1).includes('高数.pdf'));
}, { groups: { files: [{ file_name: '高数.pdf', file_id: 'file-1', file_size: 7 }], folders: [] } }));
test('explicitly expired or missing-identifier group entries are not offered', () => use(async f => {
  await f.run('找群文件 高数'); assert.ok(!f.replies[0].includes('高数.pdf')); assert.equal(f.uploads, 0);
}, { groups: { files: [{ file_name: '高数.pdf', file_id: 'expired', file_size: 7, dead_time: 1 }, { file_name: '高数.pdf', file_id: '', file_size: 7 }], folders: [] } }));
test('group permission removed during download prevents snapshot and upload', () => {
  let f;
  return use(async v => { f = v; await f.run('找群文件 高数'); await f.run('发送第1个', '2'); assert.equal(f.uploads, 0); }, { groups: { files: [{ file_name: '高数.pdf', file_id: 'file-1', file_size: 7 }], folders: [] }, download: async () => { f.settings.search.allowedGroups = []; f.config(); return { buffer: Buffer.from('fixture') }; } });
});
test('QQ download URL guard rejects IP, credentials, deceptive domains and ports', () => {
  assert.ok(validateQqFileUrl('https://gzc-download.ftn.qq.com/file?key=opaque'));
  for (const u of ['http://127.0.0.1/x', 'https://ftn.qq.com.evil.example/x', 'https://evilftn.qq.com/x', 'file:///D:/x', 'https://user:pass@gzc-download.ftn.qq.com/x', 'https://ftn.qq.com:444/x']) assert.throws(() => validateQqFileUrl(u));
});
test('wrong download length does not reach QQ upload', () => use(async f => {
  await f.run('找群文件 高数'); await f.run('发送第1个', '2'); assert.equal(f.uploads, 0); assert.match(f.replies.at(-1), /长度不符/);
}, { groups: { files: [{ file_name: '高数.pdf', file_id: 'file-1', file_size: 99 }], folders: [] } }));
test('unknown upload blocks re-preparing the same source even after a fresh search and restart', () => use(async f => {
  f.file('简历.pdf'); await f.run('找文件 简历'); await f.run('发送第1个', '2'); assert.equal(f.uploads, 1); assert.match(f.replies.at(-1), /不会自动重发/);
  f.restart(); await f.run('找文件 简历', '3'); await f.run('发送第1个', '4'); assert.equal(f.uploads, 1);
  await f.run('文件状态', '5'); assert.match(f.replies.at(-1), /尚未确认/);
}, { uploadUnknown: true }));
test('partial group failure is not reported as an exhaustive absence', () => use(async f => {
  await f.run('找群文件 高数'); assert.match(f.replies[0], /未搜完/); assert.equal(f.uploads, 0);
}, { fetchImpl: async () => { throw Error('fixture-private-token'); } }));
test('in-flight task is single and second request is not executed', async () => {
  let release;
  const pending = new Promise(r => { release = r; });
  await use(async f => {
    const first = f.run('找群文件 高数'); await new Promise(r => setTimeout(r, 20));
    await f.run('找群文件 语文', '2'); assert.match(f.replies.at(-1), /还在处理/); release(); await first;
  }, { fetchImpl: async () => { await pending; return Response.json({ status: 'ok', retcode: 0, data: { files: [], folders: [] } }); } });
});
test('disabled session prevents search and raw errors never expose paths or gateway tokens', () => use(async f => {
  await f.run('找文件 简历'); assert.ok(!f.replies[0].includes(f.root)); assert.ok(!f.replies[0].includes('fixture-private-token')); assert.match(f.replies[0], /未启用/);
}, { sessionAllowed: () => false }));

test('persisted selection is bound to recipient and gateway configuration', () => use(async f => {
  f.file('报告.pdf'); await f.run('找文件 报告');
  f.settings.recipientQQ = '555555555'; f.config();
  await f.run('发送第1个', '2', { peerId: '555555555', senderId: '555555555' });
  assert.equal(f.uploads, 0); assert.match(f.replies.at(-1), /不同收件人或网关/);
}));
test('persisted request lock prevents another service instance from modifying state', () => use(async f => {
  f.service.ensureDir(f.service.dir); const lock = path.join(f.service.dir, 'request.lock'); fs.writeFileSync(lock, '');
  f.file('报告.pdf'); await f.run('找文件 报告'); assert.equal(f.uploads, 0); assert.match(f.replies.at(-1), /异常退出锁/);
  assert.ok(fs.existsSync(lock));
}));
test('configuration change during group download prevents upload', () => {
  let fixture;
  return use(async f => { fixture = f; await f.run('找群文件 高数'); await f.run('发送第1个', '2'); assert.equal(f.uploads, 0); }, { groups: { files: [{ file_name: '高数.pdf', file_id: 'file-1', file_size: 7 }], folders: [] }, download: async () => { fixture.settings.gatewayUrl = 'http://127.0.0.1:3999'; fixture.config(); return { buffer: Buffer.from('fixture') }; } });
});
