// Optional trusted OneBot event connection. Incoming text is never sent to a model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretaryFiles } from './secretary-files.js';
import { SecretarySearch } from './secretary-search.js';
import { safeError } from './workflow.js';

export function privateEvent(raw, owner) {
  if (!raw || raw.post_type !== 'message' || raw.message_type !== 'private' || String(raw.user_id) !== owner || String(raw.sender?.user_id) !== owner || String(raw.self_id) === owner || !/^-?\d+$/.test(String(raw.message_id))) return null;
  // Ignore quoted/forwarded/media commands rather than executing their text.
  if (!Array.isArray(raw.message) || !raw.message.length || raw.message.length > 16 || raw.message.some(s => s?.type !== 'text' || typeof s.data?.text !== 'string')) return null;
  const text = raw.message.map(s => s.data.text).join('');
  if (text.length > 2000) return null;
  return { kind: 'private', peerId: owner, senderId: owner, messageId: String(raw.message_id), text };
}

export class QqFileListener {
  constructor({ root, fetchImpl = fetch, env = process.env, WebSocketImpl = WebSocket, reconnectMs = 3000, log = () => {} }) {
    this.sender = new SecretaryFiles({ root, fetchImpl, env });
    this.search = new SecretarySearch({ root, sender: this.sender, fetchImpl, env, sessionAllowed: () => !this.stopped });
    this.fetch = fetchImpl; this.WebSocket = WebSocketImpl; this.reconnectMs = reconnectMs; this.log = log;
    this.stopped = true; this.pending = new Set();
  }
  settings() {
    const s = this.search.settings();
    if (s.c.search.receivePrivateMessages !== true) throw new Error('Enable search.receivePrivateMessages first');
    const u = new URL(s.c.search.wsUrl);
    if (u.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || !['/', '/event'].includes(u.pathname)) throw new Error('Use a loopback OneBot WebSocket event URL');
    return { ...s, ws: u };
  }
  start() {
    if (!this.stopped) throw new Error('Listener already started');
    this.stopped = false;
    try {
      const s = this.settings(); this.binding = s.binding;
      this.search.ensureDir(this.search.dir);
      this.lock = path.join(this.search.dir, 'listener.lock');
      this.lockFd = fs.openSync(this.lock, 'wx', 0o600);
      this.connect();
    } catch (e) { this.stopped = true; this.release(); throw e; }
  }
  release() {
    if (this.lockFd !== undefined) { fs.closeSync(this.lockFd); fs.rmSync(this.lock, { force: true }); this.lockFd = undefined; }
  }
  connect() {
    if (this.stopped) return;
    try {
      const s = this.settings();
      if (s.binding !== this.binding) throw new Error('Recipient or gateway changed');
      if (s.gateway.token) s.ws.searchParams.set('access_token', s.gateway.token);
      const socket = this.socket = new this.WebSocket(s.ws.toString());
      socket.addEventListener('open', () => this.log('QQ file listener connected'));
      socket.addEventListener('error', () => this.log('QQ event connection error; check local gateway'));
      socket.addEventListener('close', () => {
        if (!this.stopped && this.socket === socket) this.timer = setTimeout(() => this.connect(), this.reconnectMs);
      });
      socket.addEventListener('message', event => {
        if (this.stopped || this.socket !== socket) return;
        const job = this.consume(event.data).catch(() => this.log('QQ file task failed; check local state'));
        this.pending.add(job); job.finally(() => this.pending.delete(job));
      });
    } catch { this.log('QQ listener configuration changed or unavailable; stopped'); this.stopped = true; this.release(); }
  }
  async consume(data) {
    if (this.stopped || typeof data !== 'string' || Buffer.byteLength(data) > 65536) return;
    const s = this.settings();
    if (s.binding !== this.binding) return;
    let raw; try { raw = JSON.parse(data); } catch { return; }
    const event = privateEvent(raw, String(s.c.recipientQQ));
    if (!event) return;
    await this.search.handle(event, text => this.reply(text));
  }
  async reply(text) {
    if (this.stopped) return;
    const s = this.settings(); if (s.binding !== this.binding) return;
    const url = new URL(s.gateway.url).origin + '/send_private_msg';
    const res = await this.fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', ...(s.gateway.token ? { Authorization: 'Bearer ' + s.gateway.token } : {}) }, body: JSON.stringify({ user_id: Number(s.c.recipientQQ), message: [{ type: 'text', data: { text } }] }) });
    let size = 0; const parts = [];
    for await (const chunk of res.body) { size += chunk.length; if (size > 16384) throw new Error('Reply response too large'); parts.push(chunk); }
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) throw new Error('Reply not accepted');
  }
  async stop() {
    this.stopped = true; clearTimeout(this.timer); this.socket?.close();
    await Promise.allSettled([...this.pending]); this.release();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let listener;
  try {
    listener = new QqFileListener({ root: process.env.FILE_SECRETARY_HOME, log: message => console.error(message) });
    listener.start();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await listener.stop(); process.exitCode = 0; });
  } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
}
