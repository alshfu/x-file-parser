import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve('./downloads');
const PORT = 3000;

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
