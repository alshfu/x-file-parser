import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'https://com-x.life';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const H = {
  'User-Agent': UA,
  Accept: 'text/html',
  'Accept-Language': 'ru,en;q=0.9',
};

const cookies = new Map();
function apply(r) { const a = r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const c of a) { const [n, ...v] = c.split(';')[0].split('='); cookies.set(n.trim(), v.join('=').trim()); } }
function ch() { return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }

function solve(t) { let n = 0; while (true) { const h = crypto.createHash('sha256').update(t + ':' + n).digest('hex'); if (h.startsWith('00')) return { n, h }; n++; } }

async function passChallenge(loc, orig) {
  const u = new URL(loc, BASE).toString();
  const r = await fetch(u, { headers: { ...H, Cookie: ch(), Referer: orig }, redirect: 'manual' });
  apply(r);
  const html = await r.text();
  const t = html.match(/token:\s*"([^"]+)"/)[1];
  const { n: nonce, h: hash } = solve(t);
  await sleep(550);
  const body = new URLSearchParams({ token: t, mode: 'modern', workTime: '562.4', iterations: String(nonce + 1), hasCrypto: '1', pow_nonce: String(nonce), pow_hash: hash, webdriver: '0', touch: '0', screen_w: '1920', screen_h: '1080', screen_cd: '24', wgv: 'Apple Inc.', wgr: 'Apple M1 Pro', tz: '-180', dpr: '2', cdp: '0', cdpf: '' }).toString();
  const v = await fetch(BASE + '/_v', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: ch(), Referer: u, Origin: BASE }, body });
  apply(v);
}

async function getHtml(url) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { ...H, Cookie: ch() }, redirect: 'manual' });
    apply(r);
    if (r.status === 302) {
      const loc = r.headers.get('location') || '';
      if (loc.startsWith('/_c?')) { await passChallenge(loc, url); continue; }
      return getHtml(/^https?:/.test(loc) ? loc : new URL(loc, BASE).toString());
    }
    if (r.status === 200) return await r.text();
    if (r.status === 404 && i < 2) { await sleep(300); continue; }
    throw new Error(`${url} -> ${r.status}`);
  }
  throw new Error(`too many retries: ${url}`);
}

const OPM_URL = 'https://com-x.life/reader/3038/81053';
const html = await getHtml(OPM_URL);
const dataMatch = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
const data = JSON.parse(dataMatch[1]);

const SERIES_DIR = path.resolve('./downloads/Ванпанчмен');
const seriesName = html.match(/<title>([^<]+)<\/title>/)[1].match(/Читать\s+(.+?)\s+—/)[1].trim();
console.log('series:', seriesName);
console.log('chapters total:', data.chapters.length);

const completed = {};
let n = 0;
for (const c of data.chapters) {
  const m = c.title.match(/Том\s+(\d+)/i);
  if (!m) continue;
  const vol = parseInt(m[1], 10);
  if (vol >= 1 && vol <= 16) {
    completed[c.id] = { volume: vol, title: c.title, pages: -1 };
    n++;
  }
}
console.log('marking completed (vol 1-16):', n);

const counters = {};
for (let v = 1; v <= 16; v++) {
  const folder = path.join(SERIES_DIR, `том ${v}`);
  let max = 0;
  try {
    for (const f of await fs.readdir(folder)) {
      const mm = f.match(/^page\s+(\d+)/i);
      if (mm) max = Math.max(max, parseInt(mm[1], 10));
    }
  } catch {}
  counters[String(v)] = max;
  console.log(`  том ${v}: ${max} страниц`);
}

const manifest = { title: seriesName, news_id: data.news_id, completed, counters };
await fs.mkdir(SERIES_DIR, { recursive: true });
await fs.writeFile(path.join(SERIES_DIR, '.manifest.json'), JSON.stringify(manifest, null, 2));
console.log('manifest written');
