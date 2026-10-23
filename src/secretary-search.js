// Owner-private file requests are hard-routed here; no filesystem tool is exposed to the chat agent.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SecretaryFiles } from './secretary-files.js';
import { downloadQqFile, validateQqFileUrl } from './qq-download.js';
export { validateQqFileUrl } from './qq-download.js';

const MiB = 1024 * 1024;
const MAX_FILE = 32 * MiB;
const TTL = 10 * 60 * 1000;
const DAY = 86400000;
const EXT = new Set('.pdf .doc .docx .xls .xlsx .ppt .pptx .txt .md .csv .png .jpg .jpeg .gif .webp .mp4 .mkv .mov .mp3 .wav .zip .7z .rar'.split(' '));
const PRIVATE = /^(?:\..*|node_modules|harness-data|install-backup|memory-backup|secretary-data|search-data|state|deliveries|work|logs?|cache|config(?:\..*)?|secretary(?:\..*)?|credentials?(?:\..*)?|.*\.(?:pem|key|pfx|p12)|.*(?:password|access[_-]?token|api[_-]?key|密码|密钥).*)$/i;
const hash = s => createHash('sha256').update(s).digest('hex');
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const inside = (base, file) => { const r = path.relative(base, file); return r !== '' && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const safeName = s => typeof s === 'string' && s.length > 0 && s.length <= 160 && !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(s) && !/[. ]$/.test(s) && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(s) && !PRIVATE.test(s);
const ordinaryName = s => safeName(s) && EXT.has(path.extname(s).toLowerCase());
function fail(message) { const e = new Error(message); e.secretarySafe = true; throw e; }
function clean(s, max = 100) { return String(s).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max); }
function atomic(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
const normalize = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s_\-()[\]（）【】]/g, '');
export function filenameScore(name, query) {
  const terms = query.normalize('NFKC').toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  const n = normalize(name);
  if (!terms.length || !terms.every(t => n.includes(normalize(t)))) return 0;
  return normalize(query) === n ? 100 : normalize(query) === normalize(path.parse(name).name) ? 90 : 50;
}

export function parseFileRequest(input) {
  const s = String(input ?? '').trim();
  if (/^(?:\/?文件帮助|找文件帮助|文件秘书帮助)$/.test(s)) return { type: 'help' };
  if (/^(?:取消(?:找文件|文件搜索)|取消文件)$/.test(s)) return { type: 'cancel' };
  if (/^(?:文件状态|查文件状态)$/.test(s)) return { type: 'status' };
  let m = s.match(/^(?:发送|发|转发|传)(?:文件)?\s*(?:第\s*)?([1-6])(?:\s*(?:个|份))?(?:\s*(?:给我|吧))?[。！!]?$/);
  if (m) return { type: 'send', index: Number(m[1]) - 1 };
  const explicit = /^(?:\/?找(?:一下)?(?:群|电脑)?文件|搜索(?:群|电脑)?文件)\s*[:：]?\s*(.+)$/;
  m = s.replace(/^(?:请你|请|麻烦你|麻烦|帮我|给我|能不能|可以)+/, '').match(explicit);
  if (!m && !/^(?:请|麻烦|帮我|给我|请你|能不能|能帮我|可以|我需要|需要|我要|把|找|搜索|搜)/.test(s)) return null;
  if (!m && !/(?:文件|\.pdf\b|\.docx?\b|\.xlsx?\b|\.pptx?\b|\.zip\b|\.txt\b|简历|资料|课件|表格|文档|报告|视频|图片)/i.test(s)) return null;
  if (!m && !/(?:找|搜|发给我|传给我|转给我|给我发|我需要|需要|我要)/.test(s)) return null;
  const source = /(?:群里|群内|QQ群|群文件)/i.test(s) ? 'group' : /(?:电脑|本机|桌面|下载(?:目录|文件夹|里)|文档(?:目录|文件夹|里))/.test(s) ? 'local' : 'all';
  const location = source === 'local' ? (/桌面/.test(s) ? 'desktop' : /下载/.test(s) ? 'downloads' : /文档(?:目录|文件夹|里)/.test(s) ? 'documents' : null) : null;
  const autoSend = /发给我|传给我|转给我|给我发/.test(s);
  let q = m ? m[1] : s;
  q = q.replace(/^(?:请你|请|麻烦你|麻烦|能不能|能帮我|可以|帮我|给我发|给我|我需要|需要|我要|把|再|找一下|找找|找|搜索|搜一下|搜|一下|一份|一个|的|在)+/g, '')
    .replace(/(?:电脑上?|本机|桌面上?|下载(?:目录|文件夹|里)|文档(?:目录|文件夹|里)|QQ群里?|群里的?|群内的?|群文件(?:里)?)(?:的)?/g, ' ')
    .replace(/(?:文件)?(?:发给我|传给我|转给我|给我发|找出来|找一下|搜一下|发一下|发我)(?:吧|一下)?[。！!\s]*$/g, '')
    .replace(/(?:这个|那个|一份|一个)/g, '').replace(/文件[。！!\s]*$/, '')
    .replace(/(?:PDF)(?:版|版本|格式)?/ig, ' pdf ').replace(/Word(?:版|版本|格式)?/ig, ' doc')
    .replace(/^[\s:：的“”「」"']+|[\s。！!吧“”「」"']+$/g, '').replace(/\s+/g, ' ').trim();
  if (!q || q.length < 2 || q.length > 100 || /[\\/\x00-\x1f]|https?:|^[A-Z]:|[*?]/i.test(q)) return { type: 'help' };
  return { type: 'search', query: q, source, location, autoSend };
}

export class SecretarySearch {
  constructor({ root, sender, fetchImpl = fetch, download = downloadQqFile, now = Date.now, sessionAllowed = () => true, env = process.env }) {
    this.root = fs.realpathSync(root);
    this.dir = path.join(this.root, 'search-data');
    this.staging = path.join(this.root, 'outbox', 'found-files');
    this.sender = sender ?? new SecretaryFiles({ root, fetchImpl, now, env });
    this.fetch = fetchImpl; this.download = download; this.now = now; this.sessionAllowed = sessionAllowed;
    this.busy = false; this.groupCache = new Map();
  }
  settings() {
    const c = this.sender.settings(), gateway = this.sender.gateway(c);
    if (c.search?.enabled !== true || !this.sessionAllowed()) fail('文件查找当前未启用。');
    if (!Array.isArray(c.search.localRoots) || c.search.localRoots.length > 12 || !Array.isArray(c.search.allowedGroups) || c.search.allowedGroups.length > 64 || c.search.allowedGroups.some(id => typeof id !== 'string' || !/^[1-9][0-9]{4,10}$/.test(id))) fail('搜索目录或群名单配置无效。');
    const binding = hash(String(c.recipientQQ) + ':' + gateway.url);
    if (this.activeBinding && this.activeBinding !== binding) fail('任务期间收件人或网关已变更，已停止；请使用新的运行目录。');
    return { c, groups: [...new Set(c.search.allowedGroups)], gateway, binding };
  }
  authorized(e) {
    try { const owner = String(this.sender.settings().recipientQQ); return e?.kind === 'private' && String(e.peerId) === owner && String(e.senderId) === owner; }
    catch { return false; }
  }
  ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
    if (fs.realpathSync(p).toLowerCase() !== p.toLowerCase()) fail('文件工作目录不能通过链接迁移。');
  }
  load() {
    this.ensureDir(this.dir);
    const file = path.join(this.dir, 'requests.json');
    if (!fs.existsSync(file)) return { version: 1, binding: this.settings().binding, search: null, events: [], deliveries: [] };
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 2 * MiB) fail('文件请求记录异常，请检查。');
    const s = readJSON(file);
    if (s.binding !== this.settings().binding) fail('运行记录属于不同收件人或网关；请配置新的运行目录。');
    if (s.version !== 1 || !Array.isArray(s.events) || !Array.isArray(s.deliveries)) fail('文件请求记录格式异常。');
    s.events = s.events.filter(e => e.at > this.now() - 7 * DAY);
    // Uncertain uploads retain their identity even after seven days.
    s.deliveries = s.deliveries.filter(d => {
      if (d.at > this.now() - 7 * DAY) return true;
      try { return !['gateway-accepted', 'expired'].includes(this.sender.status(d.id).status); }
      catch { return true; } // Missing records require manual review, never erase uncertainty.
    });
    if (s.search && s.search.at < this.now() - TTL) s.search = null;
    return s;
  }
  save(s) { atomic(path.join(this.dir, 'requests.json'), s); }
  rootEntries(settings = this.settings()) {
    return settings.c.search.localRoots.flatMap(r => {
      try {
        if (!r || !path.isAbsolute(r.path) || r.path.startsWith('\\\\') || /[\x00-\x1f]/.test(r.path) || (process.platform === 'win32' && (!/^[A-Z]:[\\/]/i.test(r.path) || r.path.slice(2).includes(':')))) return [];
        const lexical = path.resolve(r.path), actual = fs.realpathSync(lexical);
        if (lexical.split(/[\\/]/).some(p => PRIVATE.test(p)) || actual.split(/[\\/]/).some(p => PRIVATE.test(p)) || !fs.statSync(actual).isDirectory() || path.parse(actual).root === actual) return [];
        return [{ lexical, actual, label: clean(r.label ?? '产物目录', 30), kind: r.kind ?? 'outputs' }];
      } catch { return []; }
    });
  }
  verifyLocal(candidate) {
    if (!ordinaryName(candidate.name)) fail('不支持或受保护的文件类型。');
    const lexical = path.resolve(candidate.file);
    if (lexical.split(/[\\/]/).some(p => PRIVATE.test(p))) fail('不搜索私密状态或凭据。');
    const actual = fs.realpathSync(lexical);
    const r = this.rootEntries().find(r => inside(r.lexical, lexical) && inside(r.actual, actual));
    if (!r || actual.split(/[\\/]/).some(p => PRIVATE.test(p)) || path.basename(actual) !== candidate.name) fail('文件已离开允许的搜索目录。');
    // Do not follow a newly introduced junction/symlink below an authorized root.
    let cursor = r.lexical;
    for (const part of path.relative(r.lexical, lexical).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) fail('不发送链接指向的文件。');
    }
    const st = fs.lstatSync(lexical);
    if (!st.isFile() || st.size > MAX_FILE || st.size !== candidate.bytes || st.mtimeMs !== candidate.modified) fail('文件大小或修改时间已变化，请重新查找。');
    return { actual, st };
  }
  async localSearch(req, report) {
    const roots = this.rootEntries().filter(r => !req.location || r.kind === req.location);
    if (roots.length < this.settings().c.search.localRoots.filter(r => !req.location || r.kind === req.location).length) {
      report.partial = true; report.notes.add('部分本机目录不可访问');
    }
    if (!roots.length) report.notes.add('没有可访问的本机搜索目录');
    const queue = roots.map(r => ({ ...r, dir: r.lexical, depth: 0 }));
    const found = [], seen = new Set(); let entries = 0; const started = this.now();
    while (queue.length) {
      this.settings();
      if (entries >= 16000 || this.now() - started > 6000) { report.partial = true; break; }
      const r = queue.shift();
      let list; try { list = await fsp.readdir(r.dir, { withFileTypes: true }); } catch { report.partial = true; continue; }
      for (const e of list) {
        if (++entries > 16000) { report.partial = true; break; }
        if (PRIVATE.test(e.name) || e.isSymbolicLink()) continue;
        const file = path.join(r.dir, e.name);
        if (e.isDirectory()) { if (r.depth < 8) queue.push({ ...r, dir: file, depth: r.depth + 1 }); else report.partial = true; continue; }
        if (!e.isFile() || !ordinaryName(e.name)) continue;
        const score = filenameScore(e.name, req.query); if (!score) continue;
        try {
          const st = await fsp.lstat(file);
          if (st.size > MAX_FILE) { report.notes.add('有匹配文件超过32MiB，未列入可发送候选'); continue; }
          const c = { source: 'local', name: e.name, file, bytes: st.size, modified: st.mtimeMs, location: r.label, score };
          this.verifyLocal(c); const identity = fs.realpathSync(file).toLowerCase();
          if (!seen.has(identity)) { seen.add(identity); found.push(c); }
        } catch { report.partial = true; }
      }
      if (found.length > 200) { report.partial = true; break; }
    }
    return found;
  }
  assertGroup(id) { if (!this.settings().groups.includes(String(id))) fail('这个群的访问权限已撤销。'); }
  async api(action, params) {
    const { gateway } = this.settings();
    if (!['get_group_root_files', 'get_group_files_by_folder', 'get_group_file_url'].includes(action)) fail('不支持此群文件操作。');
    this.assertGroup(params.group_id);
    const u = new URL(gateway.url);
    const r = await this.fetch(u.origin + '/' + action, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', ...(gateway.token ? { Authorization: 'Bearer ' + gateway.token } : {}) }, body: JSON.stringify(params) });
    const chunks = []; let bytes = 0;
    for await (const part of r.body) { bytes += part.length; if (bytes > 4 * MiB) fail('群文件列表过大，已中止。'); chunks.push(part); }
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    this.assertGroup(params.group_id);
    if (!r.ok || b.status !== 'ok' || b.retcode !== 0) fail(action === 'get_group_file_url'
      ? 'QQ未提供这份文件的下载地址，文件可能已失效或无权下载；未发送。'
      : '群文件接口暂时不可用，请稍后重新查找。');
    return b.data;
  }
  async groupSearch(req, report) {
    const groups = this.settings().groups;
    for (const id of this.groupCache.keys()) if (!groups.includes(id)) this.groupCache.delete(id);
    if (!groups.length) report.notes.add('当前没有获准访问的群');
    const found = []; let calls = 0, files = 0; const started = this.now();
    for (const groupId of groups.slice(0, 8)) {
      if (groups.length > 8) report.partial = true;
      const cached = this.groupCache.get(groupId);
      if (cached && this.now() - cached.at < 90000) {
        this.assertGroup(groupId); if (cached.partial) report.partial = true;
        found.push(...cached.files.filter(f => filenameScore(f.name, req.query)).map(f => ({ ...f, score: filenameScore(f.name, req.query) }))); continue;
      }
      const queue = [{ folderId: null, depth: 0 }], seenFolders = new Set(), collected = [], seenFiles = new Set(); let partial = false;
      while (queue.length) {
        if (calls >= 16 || files >= 6000 || this.now() - started > 20000) { partial = true; break; }
        const folder = queue.shift(); calls++;
        let data;
        try { data = await this.api(folder.folderId ? 'get_group_files_by_folder' : 'get_group_root_files', { group_id: Number(groupId), ...(folder.folderId ? { folder_id: folder.folderId } : {}) }); }
        catch { partial = true; report.notes.add('部分群文件目录未能读取'); continue; }
        if (!data || !Array.isArray(data.files) || !Array.isArray(data.folders)) { partial = true; continue; }
        for (const f of data.files) {
          if (++files > 6000) { partial = true; break; }
          if (!ordinaryName(f.file_name) || typeof f.file_id !== 'string' || !f.file_id || f.file_id.length > 512 || !Number.isSafeInteger(f.file_size) || f.file_size < 0 || seenFiles.has(f.file_id)) continue;
          if (Number(f.dead_time) > 0 && Number(f.dead_time) * 1000 <= this.now()) continue;
          seenFiles.add(f.file_id);
          if (f.file_size > MAX_FILE) { if (filenameScore(f.file_name, req.query)) report.notes.add('有匹配群文件超过32MiB，未列入可发送候选'); continue; }
          collected.push({ source: 'group', groupId, fileId: f.file_id, busid: f.busid, name: f.file_name, bytes: f.file_size, modified: (Number(f.modify_time) || Number(f.upload_time) || 0) * 1000, location: '已允许的群 ' + groupId });
        }
        for (const f of data.folders) {
          if (typeof f.folder_id !== 'string' || f.folder_id.length > 512 || seenFolders.has(f.folder_id)) continue;
          seenFolders.add(f.folder_id);
          if (folder.depth >= 3 || seenFolders.size > 30) { partial = true; continue; }
          queue.push({ folderId: f.folder_id, depth: folder.depth + 1 });
        }
      }
      this.groupCache.set(groupId, { at: this.now(), partial, files: collected });
      if (partial) report.partial = true;
      found.push(...collected.filter(f => filenameScore(f.name, req.query)).map(f => ({ ...f, score: filenameScore(f.name, req.query) })));
    }
    return found;
  }
  sourceKey(c) { return hash(c.source === 'local' ? 'local:' + c.file.toLowerCase() : 'group:' + c.groupId + ':' + c.fileId); }
  async stage(candidate) {
    this.settings(); this.ensureDir(this.staging);
    // Stale pre-upload copies are safe to remove: all actual uploads use SecretaryFiles snapshots.
    for (const e of fs.readdirSync(this.staging, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink() || !/^[a-f0-9-]{36}$/.test(e.name)) continue;
      const p = path.join(this.staging, e.name);
      if (fs.realpathSync(p).toLowerCase() === p.toLowerCase() && this.now() - fs.statSync(p).mtimeMs > DAY) fs.rmSync(p, { recursive: true });
    }
    const activeBytes = fs.readdirSync(this.staging, { withFileTypes: true }).filter(e => e.isDirectory()).length * MAX_FILE;
    if (activeBytes >= 64 * MiB) fail('文件中转缓存待检查，请稍后重试。');
    const dir = path.join(this.staging, randomUUID()); fs.mkdirSync(dir);
    const file = path.join(dir, candidate.name);
    try {
      let buffer;
      if (candidate.source === 'local') {
        const { actual, st } = this.verifyLocal(candidate);
        const fd = await fsp.open(actual, 'r');
        try {
          const before = await fd.stat();
          if (!before.isFile() || before.size !== st.size || before.mtimeMs !== st.mtimeMs || before.ino !== st.ino) fail('文件读取前发生变化，请重新查找。');
          buffer = Buffer.alloc(before.size); let pos = 0;
          while (pos < buffer.length) { const { bytesRead } = await fd.read(buffer, pos, buffer.length - pos, pos); if (!bytesRead) fail('读取期间文件发生变化。'); pos += bytesRead; }
          const after = await fd.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('读取期间文件发生变化。');
          this.verifyLocal(candidate);
        } finally { await fd.close(); }
      } else {
        this.assertGroup(candidate.groupId);
        const data = await this.api('get_group_file_url', { group_id: Number(candidate.groupId), file_id: candidate.fileId, busid: candidate.busid });
        const url = validateQqFileUrl(data.url);
        // Reuse DNS/IP pinning and bounded reads; do not follow CDN redirects to other hosts.
        const result = await this.download(url, MAX_FILE, { timeoutMs: 60000 });
        this.assertGroup(candidate.groupId); buffer = result.buffer;
      }
      this.settings();
      if (!Buffer.isBuffer(buffer) || buffer.length > MAX_FILE || buffer.length !== candidate.bytes) fail('文件下载或读取长度不符，未发送。');
      fs.writeFileSync(file, buffer, { flag: 'wx', mode: 0o600 });
      return { file, dispose: () => { if (fs.realpathSync(dir) === dir) fs.rmSync(dir, { recursive: true }); } };
    } catch (e) { if (fs.realpathSync(dir) === dir) fs.rmSync(dir, { recursive: true }); throw e; }
  }
  statusText(r) {
    if (r.status === 'gateway-accepted') return `「${clean(r.name)}」已交给QQ发送，请查看私聊附件。`;
    if (r.status === 'prepared') return '文件已准备，尚未发送。请回复“发送第几个”继续。';
    if (['unknown', 'sending'].includes(r.status) || r.busy) return '这份文件的发送结果尚未确认，请先查看QQ附件；我不会自动重发。';
    return '本次文件未能完成发送，请检查文件状态后再决定是否重试。';
  }
  async deliver(s, c) {
    this.settings();
    if (c.source === 'group') this.assertGroup(c.groupId); else this.verifyLocal(c);
    const key = this.sourceKey(c);
    const uncertain = s.deliveries.find(d => d.key === key && ['unknown', 'sending'].includes(this.sender.status(d.id).status));
    if (uncertain) return this.statusText(this.sender.status(uncertain.id));
    if (!c.deliveryId) {
      if (s.deliveries.length >= 64) fail('文件发送记录已到上限，请管理员检查。');
      const staged = await this.stage(c);
      try {
        this.settings(); if (c.source === 'group') this.assertGroup(c.groupId); else this.verifyLocal(c);
        const prepared = this.sender.prepare(staged.file);
        c.deliveryId = prepared.deliveryId;
        s.deliveries.push({ key, id: c.deliveryId, at: this.now() });
        this.save(s); // Durable association before the network upload; replay never creates a new delivery.
      } finally { staged.dispose(); }
    }
    this.settings(); if (c.source === 'group') this.assertGroup(c.groupId);
    return this.statusText(await this.sender.send(c.deliveryId));
  }
  help() { return '可以私聊我：\n找文件 项目报告 pdf\n找群文件 高数 复习\n帮我把桌面上的项目报告PDF发给我\n找到后回复“发送第2个”；也可说“文件状态”或“取消找文件”。只按文件名找，单个文件最多32MiB。'; }
  async handle(e, reply) {
    if (!this.authorized(e)) return false;
    const req = parseFileRequest(e.text); if (!req) return false;
    if (this.busy) { await reply('上一项找文件/发文件任务还在处理，稍后再试。'); return true; }
    this.busy = true;
    let lockFd, lock;
    try {
      this.activeBinding = this.settings().binding;
      this.ensureDir(this.dir); lock = path.join(this.dir, 'request.lock');
      try { lockFd = fs.openSync(lock, 'wx', 0o600); }
      catch { fail('另一项文件任务正在运行或留有异常退出锁，请管理员检查。'); }
      this.settings(); const s = this.load();
      if (!e.messageId || !/^-?\d+$/.test(String(e.messageId))) fail('这条消息缺少可靠的消息编号，未执行文件操作。');
      const eventKey = hash(String(e.peerId) + ':' + String(e.messageId));
      const old = s.events.find(x => x.id === eventKey);
      if (old) return true; // Gateway WS replay is consumed silently, without duplicate uploads or replies.
      if (s.events.length >= 256) fail('文件请求记录已到上限，请稍后或由管理员清理。');
      s.events.push({ id: eventKey, at: this.now() }); this.save(s);
      let response;
      if (req.type === 'help') response = this.help();
      else if (req.type === 'cancel') { s.search = null; this.save(s); response = '已取消本次文件选择；已经开始的上传不会因此撤回。'; }
      else if (req.type === 'status') {
        const last = s.deliveries.at(-1); response = last ? this.statusText(this.sender.status(last.id)) : '暂时没有通过找文件入口发出的文件。';
      } else if (req.type === 'send') {
        if (!s.search?.candidates?.[req.index]) response = '没有这个序号，或上次结果已超过10分钟。请先重新找文件。';
        else response = await this.deliver(s, s.search.candidates[req.index]);
      } else {
        // Retire stale selection before waiting on disk/network, including when search fails.
        s.search = null; this.save(s);
        const report = { partial: false, notes: new Set() }, matches = [];
        if (req.source !== 'group') matches.push(...await this.localSearch(req, report));
        if (req.source !== 'local') matches.push(...await this.groupSearch(req, report));
        this.settings();
        matches.sort((a, b) => b.score - a.score || b.modified - a.modified || a.name.localeCompare(b.name));
        const candidates = matches.slice(0, 6);
        s.search = { at: this.now(), candidates }; this.save(s);
        if (!candidates.length) response = report.partial ? '这次未找到可发送文件，部分目录未搜完；可以缩小关键词、指定桌面或群文件后重试。' : '没有找到文件名匹配的可发送文件。可以换短一些的关键词，例如“高数 复习”或“简历 pdf”。';
        else if (matches.length === 1 && req.autoSend && !report.partial) response = await this.deliver(s, candidates[0]);
        else response = `找到${matches.length > 6 ? '至少' : ''}${matches.length}个候选${matches.length > 6 ? '，先列前6个' : ''}：\n` + candidates.map((c, i) => `${i + 1}. ${clean(c.name)}｜${clean(c.location, 40)}｜${Math.ceil(c.bytes / 1024)}KB${c.modified > 0 ? '｜' + new Date(c.modified).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : ''}`).join('\n') + '\n回复“发送第2个”即可，结果10分钟内有效。';
        if (report.partial) response += '\n部分目录未搜完，以上结果可能不完整。';
        if (report.notes.size) response += '\n' + [...report.notes].join('；') + '。';
      }
      this.settings(); await reply(response); return true;
    } catch (error) {
      await reply(error?.secretarySafe ? error.message : '文件任务未完成，未自动重试。可以说“文件状态”检查；网络或本机文件不可用时请稍后再找。');
      return true;
    } finally { if (lockFd !== undefined) { fs.closeSync(lockFd); fs.rmSync(lock, { force: true }); } this.activeBinding = null; this.busy = false; }
  }
}
