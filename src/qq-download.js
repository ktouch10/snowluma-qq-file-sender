// Only backend-issued QQ file URLs enter this downloader. No generic URL fetch tool.
import dns from 'node:dns';
import net from 'node:net';
import https from 'node:https';

export function validateQqFileUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid QQ file URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port || !/(?:^|\.)ftn\.qq\.com$/i.test(u.hostname)) throw new Error('Unsupported QQ file server');
  return u.toString();
}
export function isPublicV4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
const bounded = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS timeout')), ms);
  })]).finally(() => clearTimeout(timer));
};

// A total deadline covers headers and streaming body. IP is pinned; TLS still
// verifies the original hostname through SNI. Neither redirects nor cookies are used.
export function requestBytes(options, limit, timeoutMs, request = https.request) {
  return new Promise((resolve, reject) => {
    let req, res, settled = false;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { reject(new Error('QQ download failed')); req?.destroy(); res?.destroy(); }
      else resolve(bytes);
    };
    const timer = setTimeout(() => finish(new Error('deadline')), timeoutMs);
    try {
      req = request({ ...options, method: 'GET', port: 443, rejectUnauthorized: true, agent: false }, response => {
        res = response;
        res.on('error', finish);
        res.on('aborted', () => finish(new Error('aborted')));
        res.on('close', () => { if (!res.complete) finish(new Error('incomplete')); });
        if (settled) { res.destroy(); return; }
        const length = res.headers['content-length'];
        if (res.statusCode !== 200 || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) || !['', 'identity'].includes(String(res.headers['content-encoding'] ?? '').toLowerCase())) { finish(new Error('response')); return; }
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > limit) { finish(new Error('limit')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (length !== undefined && Number(length) !== size) { finish(new Error('length')); return; }
          finish(null, Buffer.concat(chunks));
        });
      });
      req.on('error', finish); req.end();
    } catch { finish(new Error('request')); }
  });
}

// TUN fake-IP answers remain prohibited. Optionally ask a fixed public resolver
// for this already allowlisted QQ hostname, then validate and pin its real A record.
export function createQqDownloader({ lookup = dns.promises.lookup, request = https.request } = {}) {
  return async (raw, limit = 32 * 1024 * 1024, { timeoutMs = 60000 } = {}) => {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 32 * 1024 * 1024 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Invalid download limits');
    const u = new URL(validateQqFileUrl(raw));
    const started = Date.now(), remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
    let addresses = await bounded(lookup(u.hostname, { all: true, family: 4, verbatim: true }), Math.min(5000, remaining()));
    if (addresses.length && addresses.every(a => /^198\.(18|19)\./.test(a.address))) {
      const bytes = await requestBytes({ hostname: '1.1.1.1', servername: 'cloudflare-dns.com', path: '/dns-query?name=' + encodeURIComponent(u.hostname) + '&type=A', headers: { host: 'cloudflare-dns.com', accept: 'application/dns-json', 'accept-encoding': 'identity' } }, 65536, Math.min(6000, remaining()), request);
      const result = JSON.parse(bytes.toString('utf8'));
      if (result.Status !== 0 || !Array.isArray(result.Answer)) throw new Error('Public DNS failed');
      addresses = result.Answer.filter(a => a.type === 1).map(a => ({ address: a.data }));
    }
    if (!addresses.length || addresses.some(a => !isPublicV4(a.address)) || Date.now() - started >= timeoutMs) throw new Error('Unsafe or unavailable QQ DNS');
    const buffer = await requestBytes({ hostname: addresses[0].address, servername: u.hostname, path: u.pathname + u.search, headers: { host: u.hostname, accept: '*/*', 'accept-encoding': 'identity' } }, limit, remaining(), request);
    return { buffer };
  };
}
export const downloadQqFile = createQqDownloader();
