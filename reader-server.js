import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('./downloads');
const PORT = parseInt(process.env.PORT || '3000', 10);
const LOG_LIMIT = 4000;
const HISTORY_LIMIT = 20;

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

let nextJobId = 1;
const jobs = new Map();
const queue = [];
const history = [];
let activeJobId = null;
const globalListeners = new Set();

function emit(ev) {
  for (const l of globalListeners) l(ev);
}

function jobView(j) {
  if (!j) return null;
  return {
    id: j.id,
    url: j.url,
    status: j.status,
    queuedAt: j.queuedAt,
    startedAt: j.startedAt || null,
    finishedAt: j.finishedAt || null,
    exitCode: j.exitCode == null ? null : j.exitCode,
  };
}

function snapshot() {
  return {
    active: activeJobId != null ? jobView(jobs.get(activeJobId)) : null,
    queue: queue.map((id) => jobView(jobs.get(id))),
    history: history.map((id) => jobView(jobs.get(id))),
  };
}

function pushLog(job, text) {
  job.log.push(text);
  if (job.log.length > LOG_LIMIT) job.log.splice(0, job.log.length - LOG_LIMIT);
  emit({ type: 'log', jobId: job.id, text });
}

function createJob(targetUrl) {
  const id = nextJobId++;
  const job = {
    id,
    url: targetUrl,
    status: 'queued',
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    log: [],
    child: null,
  };
  jobs.set(id, job);
  queue.push(id);
  emit({ type: 'queued', job: jobView(job) });
  tryStartNext();
  return job;
}

function tryStartNext() {
  if (activeJobId != null) return;
  if (queue.length === 0) return;
  const id = queue.shift();
  startJob(id);
}

function startJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  activeJobId = id;
  job.status = 'running';
  job.startedAt = Date.now();
  const child = spawn(process.execPath, ['index.js', job.url], {
    cwd: path.resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.child = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (t) => pushLog(job, t));
  child.stderr.on('data', (t) => pushLog(job, t));
  child.on('exit', (code, sig) => {
    job.status = code === 0 ? 'done' : 'error';
    job.exitCode = code == null ? -1 : code;
    job.finishedAt = Date.now();
    const tail = `\n[процесс завершён: code=${code} signal=${sig == null ? '-' : sig}]\n`;
    pushLog(job, tail);
    job.child = null;
    activeJobId = null;
    history.unshift(id);
    while (history.length > HISTORY_LIMIT) {
      const oldId = history.pop();
      jobs.delete(oldId);
    }
    emit({ type: 'done', job: jobView(job) });
    tryStartNext();
  });
  child.on('error', (e) => {
    pushLog(job, `\n[ошибка запуска: ${e.message}]\n`);
  });
  emit({ type: 'started', job: jobView(job) });
}

function stopActive() {
  if (activeJobId == null) return false;
  const job = jobs.get(activeJobId);
  if (job && job.child) {
    job.child.kill('SIGTERM');
    return true;
  }
  return false;
}

function cancelQueued(id) {
  const i = queue.indexOf(id);
  if (i < 0) return false;
  queue.splice(i, 1);
  const job = jobs.get(id);
  if (job) {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
  }
  emit({ type: 'cancelled', jobId: id });
  jobs.delete(id);
  return true;
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
      const job = createJob(targetUrl);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ ok: true, job: jobView(job) }));
      return;
    }

    if (p === '/api/parse/status') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(snapshot()));
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
      send({ type: 'snapshot', ...snapshot() });
      if (activeJobId != null) {
        const j = jobs.get(activeJobId);
        if (j && j.log.length) send({ type: 'log', jobId: j.id, text: j.log.join('') });
      }
      const listener = (ev) => send(ev);
      globalListeners.add(listener);
      const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        globalListeners.delete(listener);
      });
      return;
    }

    if (p === '/api/parse/stop' && req.method === 'POST') {
      if (stopActive()) {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(409, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ error: 'нечего останавливать' }));
      }
      return;
    }

    const cancelMatch = p.match(/^\/api\/parse\/queue\/(\d+)$/);
    if (cancelMatch && (req.method === 'DELETE' || req.method === 'POST')) {
      const id = parseInt(cancelMatch[1], 10);
      if (cancelQueued(id)) {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ error: 'нет такого задания в очереди' }));
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
