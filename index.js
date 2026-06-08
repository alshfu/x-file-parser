import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const URLS = process.argv.slice(2);
if (URLS.length === 0) {
  console.error('usage: node index.js <url1> [url2] ...');
  process.exit(1);
}

const OUT_DIR = path.resolve('./downloads');
const BASE = 'https://com-x.life';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ru,en;q=0.9',
};

const cookies = new Map();
function applySetCookie(res) {
  const arr = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of arr) {
    const [n, ...v] = c.split(';')[0].split('=');
    cookies.set(n.trim(), v.join('=').trim());
  }
}
function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function solvePow(token) {
  let nonce = 0;
  while (true) {
    const h = crypto.createHash('sha256').update(token + ':' + nonce).digest('hex');
    if (h.startsWith('00')) return { nonce, hash: h };
    nonce++;
    if (nonce > 1e7) throw new Error('PoW exhausted');
  }
}

async function passChallenge(challengePath, originalUrl) {
  const challengeUrl = new URL(challengePath, BASE).toString();
  const r = await fetch(challengeUrl, {
    headers: { ...BASE_HEADERS, Cookie: cookieHeader(), Referer: originalUrl },
    redirect: 'manual',
  });
  applySetCookie(r);
  const html = await r.text();
  const tokenMatch = html.match(/token:\s*"([^"]+)"/);
  if (!tokenMatch) throw new Error('challenge token not found');
  const token = tokenMatch[1];

  const t0 = Date.now();
  const { nonce, hash } = solvePow(token);
  const realTime = Date.now() - t0;
  const padTo = 450 + Math.floor(Math.random() * 250);
  if (realTime < padTo) await sleep(padTo - realTime);
  const workTime = (padTo + Math.random() * 50).toFixed(1);

  const body = new URLSearchParams({
    token,
    mode: 'modern',
    workTime,
    iterations: String(nonce + 1),
    hasCrypto: '1',
    pow_nonce: String(nonce),
    pow_hash: hash,
    webdriver: '0',
    touch: '0',
    screen_w: '1920',
    screen_h: '1080',
    screen_cd: '24',
    wgv: 'Apple Inc.',
    wgr: 'Apple M1 Pro',
    tz: '-180',
    dpr: '2',
    cdp: '0',
    cdpf: '',
  }).toString();

  const v = await fetch(BASE + '/_v', {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(),
      Referer: challengeUrl,
      Origin: BASE,
      Accept: '*/*',
    },
    body,
  });
  applySetCookie(v);
  if (v.status !== 200) throw new Error(`/_v -> ${v.status}`);
}

async function guardedFetch(url, extraHeaders = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { ...BASE_HEADERS, Cookie: cookieHeader(), ...extraHeaders },
        redirect: 'manual',
      });
      applySetCookie(r);

      if (r.status === 302) {
        const loc = r.headers.get('location') || '';
        if (loc.startsWith('/_c?')) {
          await passChallenge(loc, url);
          continue;
        }
        const target = /^https?:/.test(loc) ? loc : new URL(loc, BASE).toString();
        return guardedFetch(target, extraHeaders);
      }
      if (r.status === 200) return r;
      if (r.status === 403 || r.status === 429) {
        const wait = 2000 * Math.pow(2, attempt);
        console.warn(`  ${r.status} on ${url} — wait ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (r.status === 404 && attempt < 2) {
        await sleep(500);
        continue;
      }
      throw new Error(`GET ${url} -> ${r.status}`);
    } catch (e) {
      lastErr = e;
      const wait = 1500 * Math.pow(2, attempt);
      console.warn(`  network error on ${url}: ${e.message} — wait ${wait}ms (attempt ${attempt + 1}/5)`);
      if (attempt >= 2) cookies.delete('__guard_trust');
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`GET ${url}: too many retries`);
}

async function fetchHtml(url) {
  return await (await guardedFetch(url)).text();
}

async function fetchBuffer(url, referer) {
  const r = await guardedFetch(url, { Referer: referer, Accept: 'image/avif,image/webp,*/*' });
  return Buffer.from(await r.arrayBuffer());
}

function parseData(html) {
  const m = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extractSeriesName(html) {
  const t = html.match(/<title>([^<]+)<\/title>/);
  if (!t) return null;
  const m = t[1].match(/Читать\s+(.+?)\s+—/);
  return m ? m[1].trim() : t[1].trim();
}

function volumeFromTitle(title) {
  if (!title) return null;
  const m = title.match(/Том\s+(\d+)/i);
  if (m) return parseInt(m[1], 10);
  const m2 = title.match(/^\s*(\d+)\s*-\s*\d/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

function isAltTranslation(title) {
  return /альт|alt\b/i.test(title || '');
}

function safeFilename(s) {
  return s.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function extFromUrl(u) {
  try {
    const ext = path.extname(new URL(u).pathname);
    return ext || '.jpg';
  } catch {
    return '.jpg';
  }
}

async function loadManifest(dir) {
  try {
    const txt = await fs.readFile(path.join(dir, '.manifest.json'), 'utf8');
    const m = JSON.parse(txt);
    if (!m.completed) m.completed = {};
    if (!m.counters) m.counters = {};
    return m;
  } catch {
    return { completed: {}, counters: {} };
  }
}

async function saveManifest(dir, manifest) {
  await fs.writeFile(
    path.join(dir, '.manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
}

async function resolveStartUrl(url) {
  if (/\/reader\/\d+\/\d+/.test(url)) return url;
  console.log(`  страница серии: ${url} → ищу главу`);
  const html = await fetchHtml(url);
  const m = html.match(/\/reader\/(\d+)\/(\d+)/);
  if (!m) throw new Error(`не найдена ссылка на главу в ${url}`);
  const resolved = BASE + m[0];
  console.log(`  → ${resolved}`);
  return { url: resolved, fromSeriesPage: true };
}

async function processSeries(inputUrl) {
  const resolved = await resolveStartUrl(inputUrl);
  const startUrl = typeof resolved === 'string' ? resolved : resolved.url;
  const fromSeriesPage = typeof resolved === 'string' ? false : resolved.fromSeriesPage;

  const startHtml = await fetchHtml(startUrl);
  const startData = parseData(startHtml);
  if (!startData) throw new Error(`__DATA__ не найден: ${startUrl}`);

  const series = extractSeriesName(startHtml) || `series-${startData.news_id}`;
  const seriesDir = path.join(OUT_DIR, safeFilename(series));
  await fs.mkdir(seriesDir, { recursive: true });
  console.log(`\n=== «${series}» → ${seriesDir} ===`);

  const manifest = await loadManifest(seriesDir);
  manifest.title = series;
  manifest.news_id = startData.news_id;

  const newsId = startData.news_id;
  const startChapterId = startData.chapter_id;
  const allChapters = (startData.chapters || []).slice().reverse();
  let queue;
  if (fromSeriesPage) {
    queue = allChapters;
  } else {
    const idx = allChapters.findIndex((c) => c.id === startChapterId);
    queue = idx >= 0 ? allChapters.slice(idx) : allChapters;
  }
  console.log(`  всего глав в каталоге: ${allChapters.length}, в очереди: ${queue.length}`);
  const alreadyDone = queue.filter((c) => manifest.completed[c.id]).length;
  if (alreadyDone) console.log(`  уже скачано: ${alreadyDone}`);

  let processed = 0;
  for (const ch of queue) {
    processed++;
    if (manifest.completed[ch.id]) continue;
    if (isAltTranslation(ch.title)) {
      manifest.completed[ch.id] = { skipped: 'alt-translation', title: ch.title };
      await saveManifest(seriesDir, manifest);
      continue;
    }

    const chapterUrl = `${BASE}/reader/${newsId}/${ch.id}`;
    console.log(`\n[${processed}/${queue.length}] ${chapterUrl}`);
    console.log(`  ${ch.title}`);

    let data;
    if (ch.id === startChapterId) {
      data = startData;
    } else {
      try {
        const html = await fetchHtml(chapterUrl);
        data = parseData(html);
      } catch (e) {
        console.error(`  fetch failed: ${e.message}`);
        continue;
      }
    }
    if (!data || !data.images?.length) {
      console.warn('  пропуск: нет изображений');
      continue;
    }

    const volume = volumeFromTitle(ch.title) ?? 1;
    const volKey = String(volume);
    const folder = path.join(seriesDir, `том ${volume}`);
    await fs.mkdir(folder, { recursive: true });

    if (manifest.counters[volKey] == null) {
      let max = 0;
      for (const f of await fs.readdir(folder).catch(() => [])) {
        const mm = f.match(/^page\s+(\d+)/i);
        if (mm) max = Math.max(max, parseInt(mm[1], 10));
      }
      manifest.counters[volKey] = max;
    }

    const host = data.host || 'img.com-x.life';
    let n = manifest.counters[volKey];
    const startN = n;
    let saved = 0;
    for (const rel of data.images) {
      n++;
      const imgUrl = `https://${host}/comix/${rel}`;
      const filename = `page ${n}${extFromUrl(imgUrl)}`;
      const out = path.join(folder, filename);
      try {
        const buf = await fetchBuffer(imgUrl, chapterUrl);
        await fs.writeFile(out, buf);
        saved++;
      } catch (e) {
        console.error(`    fail ${imgUrl}: ${e.message}`);
        n--;
      }
      await sleep(150);
    }
    manifest.counters[volKey] = n;
    manifest.completed[ch.id] = { volume, pages: saved, title: ch.title };
    await saveManifest(seriesDir, manifest);
    console.log(`  том ${volume}: страницы ${startN + 1}–${n} (новых ${saved}/${data.images.length})`);

    await sleep(800);
  }

  console.log(`\n— готово «${series}» —`);
  for (const [v, n] of Object.entries(manifest.counters).sort((a, b) => +a[0] - +b[0])) {
    console.log(`  том ${v}: ${n} страниц`);
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const url of URLS) {
    try {
      await processSeries(url);
    } catch (e) {
      console.error(`\n[!] ${url}: ${e.message}`);
    }
  }
  console.log('\nвсё готово');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
