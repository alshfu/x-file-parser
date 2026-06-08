import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('./downloads');
const PORT = 3000;
const LOG_LIMIT = 4000;

let currentJob = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function pageNum(name) {
  const m = name.match(/page\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : -1;
}

function volumeNum(name) {
  const m = name.match(/том\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

async function listSeries() {
  const items = await fs.readdir(ROOT, { withFileTypes: true });
  const series = [];
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const dir = path.join(ROOT, it.name);
    const subs = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    let pages = 0;
    let vols = 0;
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      vols++;
      const files = await fs.readdir(path.join(dir, s.name)).catch(() => []);
      pages += files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
    }
    series.push({ name: it.name, volumes: vols, pages });
  }
  series.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return series;
}

async function listVolumes(seriesName) {
  const dir = path.join(ROOT, seriesName);
  const subs = await fs.readdir(dir, { withFileTypes: true });
  const vols = [];
  for (const s of subs) {
    if (!s.isDirectory()) continue;
    const files = await fs.readdir(path.join(dir, s.name)).catch(() => []);
    const pages = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
    vols.push({ name: s.name, volume: volumeNum(s.name), pages });
  }
  vols.sort((a, b) => a.volume - b.volume);
  return vols;
}

async function listPages(seriesName, volName) {
  const dir = path.join(ROOT, seriesName, volName);
  const files = await fs.readdir(dir);
  return files
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort((a, b) => pageNum(a) - pageNum(b));
}

function safeJoin(parts) {
  const joined = path.join(ROOT, ...parts);
  if (!joined.startsWith(ROOT)) throw new Error('path escape');
  return joined;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function pushLog(text) {
  if (!currentJob) return;
  currentJob.log.push(text);
  if (currentJob.log.length > LOG_LIMIT) currentJob.log.splice(0, currentJob.log.length - LOG_LIMIT);
  for (const l of currentJob.listeners) l({ type: 'log', text });
}

function startParse(targetUrl) {
  const child = spawn(process.execPath, ['index.js', targetUrl], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  currentJob = {
    url: targetUrl,
    status: 'running',
    startedAt: Date.now(),
    log: [],
    listeners: new Set(),
    child,
    exitCode: null,
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (t) => pushLog(t));
  child.stderr.on('data', (t) => pushLog(t));
  child.on('exit', (code, sig) => {
    if (!currentJob) return;
    currentJob.status = code === 0 ? 'done' : 'error';
    currentJob.exitCode = code ?? -1;
    currentJob.finishedAt = Date.now();
    const tail = `\n[процесс завершён: code=${code} signal=${sig ?? '-'}]\n`;
    currentJob.log.push(tail);
    for (const l of currentJob.listeners) {
      l({ type: 'log', text: tail });
      l({ type: 'done', code: currentJob.exitCode });
    }
    currentJob.listeners.clear();
    currentJob.child = null;
  });
  child.on('error', (e) => {
    pushLog(`\n[ошибка запуска: ${e.message}]\n`);
  });
}

function jobSnapshot() {
  if (!currentJob) return { status: 'idle' };
  return {
    status: currentJob.status,
    url: currentJob.url,
    startedAt: currentJob.startedAt,
    finishedAt: currentJob.finishedAt || null,
    exitCode: currentJob.exitCode,
  };
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = decodeURIComponent(u.pathname);

  try {
    if (p === '/' || p === '/index.html') {
      const html = await fs.readFile(path.resolve('./reader.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
      return;
    }

    if (p === '/api/series') {
      const data = await listSeries();
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(data));
      return;
    }

    const apiMatch = p.match(/^\/api\/series\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (apiMatch) {
      const [, series, vol] = apiMatch;
      if (vol) {
        const pages = await listPages(series, vol);
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ pages }));
      } else {
        const volumes = await listVolumes(series);
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ volumes }));
      }
      return;
    }

    if (p === '/api/parse' && req.method === 'POST') {
      const raw = await readBody(req);
      let targetUrl = '';
      try { targetUrl = (JSON.parse(raw || '{}').url || '').trim(); } catch {}
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ error: 'нужен валидный http(s) URL' }));
        return;
      }
      if (currentJob && currentJob.status === 'running') {
        res.writeHead(409, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ error: 'парсер уже работает', current: jobSnapshot() }));
        return;
      }
      startParse(targetUrl);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ ok: true, job: jobSnapshot() }));
      return;
    }

    if (p === '/api/parse/status') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(jobSnapshot()));
      return;
    }

    if (p === '/api/parse/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (!currentJob) { send({ type: 'idle' }); res.end(); return; }
      send({ type: 'meta', url: currentJob.url, status: currentJob.status, startedAt: currentJob.startedAt });
      if (currentJob.log.length) send({ type: 'log', text: currentJob.log.join('') });
      if (currentJob.status !== 'running') { send({ type: 'done', code: currentJob.exitCode }); res.end(); return; }
      const listener = (ev) => send(ev);
      currentJob.listeners.add(listener);
      const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        if (currentJob) currentJob.listeners.delete(listener);
      });
      return;
    }

    if (p === '/api/parse/stop' && req.method === 'POST') {
      if (currentJob && currentJob.status === 'running' && currentJob.child) {
        currentJob.child.kill('SIGTERM');
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(409, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ error: 'нечего останавливать' }));
      }
      return;
    }

    if (p.startsWith('/files/')) {
      const rel = p.slice('/files/'.length).split('/');
      const file = safeJoin(rel);
      const buf = await fs.readFile(file);
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
      return;
    }

    res.writeHead(404);
    res.end('404');
  } catch (e) {
    res.writeHead(500);
    res.end(`error: ${e.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`reader at http://localhost:${PORT}`);
});
