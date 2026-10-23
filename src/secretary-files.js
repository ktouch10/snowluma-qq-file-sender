// Derived from qq-bridge secretary-files (MIT); see LICENSE and NOTICE.
// A local owner capability: never expose this server to untrusted chat participants.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const MiB = 1024 * 1024;
const DAY = 86400000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PRIVATE_PART = /^(?:\.git|\.codex|\.dsh|\.ssh|\.aws|\.agents|harness-data|install-backup|memory-backup|state|deliveries|secretary-data|node_modules|config\.json|secretary\.json|\.env(?:\..*)?|.*\.(?:pem|key|pfx|p12))$/i;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const digest = b => createHash('sha256').update(b).digest('hex');
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const within = (base, file) => { const r = path.relative(base, file); return r && !r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r); };
function fail(message) { const e = new Error(message); e.secretarySafe = true; throw e; }
function atomicJSON(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}

export class SecretaryFiles {
  constructor({ root, fetchImpl = fetch, now = Date.now, env = process.env }) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('Set FILE_SECRETARY_HOME to an existing absolute directory.');
    this.root = fs.realpathSync(root);
    this.env = env;
    this.store = path.join(this.root, 'deliveries');
    this.fetch = fetchImpl;
    this.now = now;
  }
  settings() {
    const c = readJSON(path.join(this.root, 'secretary.json'));
    if (c.enabled !== true || !/^[1-9][0-9]{4,10}$/.test(String(c.recipientQQ))) fail('Enable secretary.json and configure your own fixed recipientQQ.');
    c.recipientQQ = String(c.recipientQQ);
    if (!Array.isArray(c.sourceRoots) || !c.sourceRoots.length) fail('缺少文件来源目录。');
    return c;
  }
  ensureStore() {
    fs.mkdirSync(this.store, { recursive: true });
    if (!samePath(fs.realpathSync(this.store), this.store)) fail('发送暂存目录不能通过链接迁移。');
  }
  recordDir(id) {
    if (!UUID.test(id)) fail('无效 deliveryId。');
    this.ensureStore();
    const dir = path.join(this.store, id);
    if (fs.existsSync(dir) && !samePath(fs.realpathSync(dir), dir)) fail('发送记录目录不能是链接。');
    return dir;
  }
  read(id) {
    const dir = this.recordDir(id);
    const file = path.join(dir, 'delivery.json');
    if (fs.lstatSync(file).isSymbolicLink()) fail('无效发送记录。');
    const r = readJSON(file);
    if (r.deliveryId !== id || path.basename(r.name) !== r.name || /[:\\/\x00-\x1f]/.test(r.name)) fail('发送记录损坏。');
    if (!/^[1-9][0-9]{4,10}$/.test(r.recipientQQ) || !Number.isInteger(r.bytes) || r.bytes < 0 || r.bytes > 32 * MiB || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isFinite(Date.parse(r.createdAt)) || !['prepared', 'sending', 'gateway-accepted', 'unknown', 'expired'].includes(r.status)) fail('Invalid local delivery metadata.');
    return r;
  }
  save(r) { atomicJSON(path.join(this.recordDir(r.deliveryId), 'delivery.json'), r); }
  view(r) {
    return { deliveryId: r.deliveryId, name: r.name, bytes: r.bytes, sha256: r.sha256,
      recipientQQ: r.recipientQQ, status: r.status, createdAt: r.createdAt,
      ...(r.acceptedAt ? { acceptedAt: r.acceptedAt } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      hint: r.status === 'gateway-accepted' ? '网关已受理；是否在QQ收到/下载需要用户确认。'
        : ['unknown', 'sending'].includes(r.status) ? '结果不确定或仍在处理；先查看QQ，禁止自动重发或另建记录重发。'
        : r.status === 'prepared' ? '仅已准备，尚未发送。请按用户明确的发文件指令调用发送工具。' : '未受理；修复问题后由用户决定是否重新准备。' };
  }
  // Expire only completed/unstarted records. Never delete an uncertain in-flight upload.
  cleanup() {
    let count = 0, bytes = 0;
    for (const ent of fs.readdirSync(this.store, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.isSymbolicLink() || !UUID.test(ent.name)) continue;
      const r = this.read(ent.name);
      const age = this.now() - Date.parse(r.createdAt);
      if (!fs.existsSync(path.join(this.recordDir(ent.name), 'sending.lock')) && !['sending', 'unknown'].includes(r.status) && age > (r.status === 'prepared' ? DAY : 7 * DAY)) {
        // recordDir verifies the resolved directory before recursive removal.
        fs.rmSync(this.recordDir(ent.name), { recursive: true });
      } else { count++; bytes += r.bytes; }
    }
    return { count, bytes };
  }
  prepare(file) {
    const c = this.settings();
    this.gateway(c);
    this.ensureStore();
    const prepareLock = path.join(this.store, 'prepare.lock');
    let lockFd;
    try { lockFd = fs.openSync(prepareLock, 'wx', 0o600); }
    catch { fail('另一个准备操作正在运行或遗留准备锁；请稍后检查，未发送。'); }
    try { return this.prepareLocked(file, c); }
    finally { fs.closeSync(lockFd); fs.rmSync(prepareLock, { force: true }); }
  }
  prepareLocked(file, c) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.startsWith('\\\\') || /[\x00-\x1f]/.test(file)) fail('必须提供本机绝对文件路径，不能是URL或网络共享。');
    if (process.platform === 'win32' && (!/^[A-Z]:[\\/]/i.test(file) || file.slice(2).includes(':'))) fail('Windows paths must use a local drive, without device prefixes or alternate data streams.');
    const lexical = path.resolve(file);
    if (lexical.split(/[\\/]/).some(p => PRIVATE_PART.test(p))) fail('不能发送配置、私密状态、凭据或框架数据。请将明确要发的产物放入outbox。');
    const actual = fs.realpathSync(lexical);
    const permitted = c.sourceRoots.some(p => {
      try { return path.isAbsolute(p) && within(fs.realpathSync(p), actual) && within(path.resolve(p), lexical); } catch { return false; }
    });
    if (!permitted || actual.split(/[\\/]/).some(p => PRIVATE_PART.test(p))) fail('文件不在允许来源中；请将指定产物放到配置的 sourceRoots 目录中。');
    const name = path.basename(actual);
    if (!name || name.length > 160 || /^(?:delivery\.json|sending\.lock)$/i.test(name) || /[:\\/\x00-\x1f]/.test(name)) fail('文件名不适合发送。');
    const fd = fs.openSync(actual, 'r');
    let data;
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size > 32 * MiB) fail('只能发送不超过32MiB的普通文件。');
      data = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < data.length) { const n = fs.readSync(fd, data, offset, data.length - offset, offset); if (!n) fail('读取期间文件变化。'); offset += n; }
      const after = fs.fstatSync(fd);
      const current = fs.statSync(actual);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== after.ino || fs.realpathSync(lexical) !== actual) fail('读取期间文件变化，请重新准备。');
    } finally { fs.closeSync(fd); }
    const quota = this.cleanup();
    if (quota.count >= 64 || quota.bytes + data.length > 128 * MiB) fail('暂存达到64条或128MiB上限；请检查并人工清理旧记录。');
    const id = randomUUID(), dir = this.recordDir(id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, name), data, { flag: 'wx', mode: 0o600 });
    const r = { deliveryId: id, name, recipientQQ: c.recipientQQ, gatewayUrl: this.gateway(c).url, bytes: data.length, sha256: digest(data), status: 'prepared', createdAt: new Date(this.now()).toISOString() };
    this.save(r);
    return this.view(r);
  }
  status(id) { this.settings(); return this.view(this.read(id)); }
  gateway(c = this.settings()) {
    let u;
    try { u = new URL(c.gatewayUrl); } catch { fail('Configure gatewayUrl as a loopback HTTP root URL.'); }
    if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) fail('Gateway must be a loopback IP HTTP root URL.');
    const token = this.env.ONEBOT_ACCESS_TOKEN ?? '';
    if (typeof token !== 'string' || /[\r\n]/.test(token)) fail('Invalid ONEBOT_ACCESS_TOKEN.');
    return { url: u.origin + '/upload_private_file', token };
  }
  async send(id) {
    const c = this.settings();
    const dir = this.recordDir(id), lock = path.join(dir, 'sending.lock');
    let lockFd;
    try { lockFd = fs.openSync(lock, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') return { ...this.status(id), busy: true, hint: '存在发送锁；不要重发。进程异常退出时先人工查看QQ，再处理记录。' }; throw e; }
    try {
      const r = this.read(id);
      if (r.status !== 'prepared') return this.view(r);
      if (this.now() - Date.parse(r.createdAt) > DAY) { r.status = 'expired'; r.reason = '准备记录已超过24小时。'; this.save(r); return this.view(r); }
      const gateway = this.gateway(c);
      if (r.recipientQQ !== c.recipientQQ || r.gatewayUrl !== gateway.url) fail('Prepared recipient or gateway differs from current configuration; nothing was sent.');
      const payload = path.join(dir, r.name);
      const st = fs.lstatSync(payload);
      if (!st.isFile() || st.isSymbolicLink() || st.size !== r.bytes || st.size > 32 * MiB || fs.realpathSync(payload) !== payload || digest(fs.readFileSync(payload)) !== r.sha256) fail('待发副本校验失败；未发送。');
      r.status = 'sending'; this.save(r);
      try {
        const res = await this.fetch(gateway.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
          headers: { 'Content-Type': 'application/json', ...(gateway.token ? { Authorization: `Bearer ${gateway.token}` } : {}) },
          body: JSON.stringify({ user_id: Number(r.recipientQQ), file: payload, name: r.name, upload_file: true }) });
        // Never echo gateway wording: it may contain access tokens or private paths.
        const reader = res.body.getReader();
        let raw = '', total = 0;
        const chunks = [];
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > 65536) throw new Error('oversized response'); chunks.push(value); } raw = Buffer.concat(chunks).toString('utf8'); }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const body = JSON.parse(raw);
        if (!res.ok) { r.status = 'unknown'; r.reason = `HTTP ${res.status}，不能确定是否已发出。`; }
        else if (body?.status === 'ok' && body?.retcode === 0) { r.status = 'gateway-accepted'; r.acceptedAt = new Date(this.now()).toISOString(); delete r.reason; }
        else { r.status = 'unknown'; r.reason = '网关响应无法确认；请查看QQ，不要自动重发。'; }
      } catch { r.status = 'unknown'; r.reason = '请求中断、超时或响应异常；请查看QQ，不要自动重发。'; }
      this.save(r);
      return this.view(r);
    } finally { fs.closeSync(lockFd); fs.rmSync(lock, { force: true }); }
  }
}
