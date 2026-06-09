// Изоморфный парсер. Платформенные примитивы (http/fs/crypto/log/sleep)
// передаются параметром, поэтому модуль одинаково работает в Node
// (через index.js) и в WebView на iOS (через Capacitor-адаптер).

const BASE = 'https://com-x.life';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ru,en;q=0.9',
};

// ───────── вспомогательные ─────────

function safeFilename(s) {
  return s.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function extFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const i = p.lastIndexOf('.');
    if (i < 0) return '.jpg';
    const ext = p.slice(i);
    return /^\.[a-z0-9]+$/i.test(ext) ? ext : '.jpg';
  } catch {
    return '.jpg';
  }
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

function parseData(html) {
  const m = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function extractSeriesName(html) {
  const t = html.match(/<title>([^<]+)<\/title>/);
  if (!t) return null;
  const m = t[1].match(/Читать\s+(.+?)\s+—/);
  return m ? m[1].trim() : t[1].trim();
}

// ───────── cookie-jar (общий для всей сессии парсинга) ─────────

function makeCookieJar() {
  const cookies = new Map();
  return {
    apply(setCookieHeaders) {
      for (const c of setCookieHeaders || []) {
        const [n, ...v] = c.split(';')[0].split('=');
        cookies.set(n.trim(), v.join('=').trim());
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    delete(name) { cookies.delete(name); },
  };
}

// ───────── PoW + challenge ─────────

async function solvePow(crypto, token) {
  let nonce = 0;
  while (true) {
    const h = await crypto.sha256Hex(token + ':' + nonce);
    if (h.startsWith('00')) return { nonce, hash: h };
    nonce++;
    if (nonce > 1e7) throw new Error('PoW exhausted');
  }
}

async function passChallenge(env, jar, challengePath, originalUrl) {
  const { http, crypto, sleep, random } = env;
  const challengeUrl = new URL(challengePath, BASE).toString();
  const r = await http.request({
    url: challengeUrl,
    method: 'GET',
    headers: { ...BASE_HEADERS, Cookie: jar.header(), Referer: originalUrl },
    manualRedirect: true,
  });
  jar.apply(r.setCookie);
  const html = await r.text();
  const tokenMatch = html.match(/token:\s*"([^"]+)"/);
  if (!tokenMatch) throw new Error('challenge token not found');
  const token = tokenMatch[1];

  const t0 = env.now();
  const { nonce, hash } = await solvePow(crypto, token);
  const realTime = env.now() - t0;
  const padTo = 450 + Math.floor(random() * 250);
  if (realTime < padTo) await sleep(padTo - realTime);
  const workTime = (padTo + random() * 50).toFixed(1);

  const params = new URLSearchParams({
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
  });

  const v = await http.request({
    url: BASE + '/_v',
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.header(),
      Referer: challengeUrl,
      Origin: BASE,
      Accept: '*/*',
    },
    body: params.toString(),
    manualRedirect: true,
  });
  jar.apply(v.setCookie);
  if (v.status !== 200) throw new Error(`/_v -> ${v.status}`);
}

// ───────── HTTP с ретраями и решением challenge ─────────

async function guardedFetch(env, jar, url, extraHeaders = {}) {
  const { http, sleep, log } = env;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await http.request({
        url,
        method: 'GET',
        headers: { ...BASE_HEADERS, Cookie: jar.header(), ...extraHeaders },
        manualRedirect: true,
        responseType: extraHeaders.Accept && extraHeaders.Accept.startsWith('image/') ? 'arraybuffer' : 'text',
      });
      jar.apply(r.setCookie);

      if (r.status === 302) {
        const loc = r.location || '';
        if (loc.startsWith('/_c?')) {
          await passChallenge(env, jar, loc, url);
          continue;
        }
        const target = /^https?:/.test(loc) ? loc : new URL(loc, BASE).toString();
        return guardedFetch(env, jar, target, extraHeaders);
      }
      if (r.status === 200) return r;
      if (r.status === 403 || r.status === 429) {
        const wait = 2000 * Math.pow(2, attempt);
        log(`  ${r.status} on ${url} — wait ${wait}ms`);
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
      log(`  network error on ${url}: ${e.message} — wait ${wait}ms (attempt ${attempt + 1}/5)`);
      if (attempt >= 2) jar.delete('__guard_trust');
      await sleep(wait);
    }
  }
  throw lastErr || new Error(`GET ${url}: too many retries`);
}

// ───────── manifest ─────────

async function loadManifest(fs, dir) {
  try {
    const txt = await fs.readTextFile(fs.join(dir, '.manifest.json'));
    const m = JSON.parse(txt);
    if (!m.completed) m.completed = {};
    if (!m.counters) m.counters = {};
    return m;
  } catch {
    return { completed: {}, counters: {} };
  }
}

async function saveManifest(fs, dir, manifest) {
  await fs.writeTextFile(fs.join(dir, '.manifest.json'), JSON.stringify(manifest, null, 2));
}

// ───────── resolve URL → стартовый chapter URL ─────────

async function resolveStartUrl(env, jar, url) {
  if (/\/reader\/\d+\/\d+/.test(url)) return { url, fromSeriesPage: false };
  env.log(`  страница серии: ${url} → ищу главу`);
  const r = await guardedFetch(env, jar, url);
  const html = await r.text();
  const m = html.match(/\/reader\/(\d+)\/(\d+)/);
  if (!m) throw new Error(`не найдена ссылка на главу в ${url}`);
  const resolved = BASE + m[0];
  env.log(`  → ${resolved}`);
  return { url: resolved, fromSeriesPage: true };
}

// ───────── главная функция ─────────

export async function runParser(inputUrl, env) {
  const jar = makeCookieJar();
  const { fs, log, sleep, isCancelled } = env;
  const root = env.rootDir;

  await fs.mkdir(root);

  const { url: startUrl, fromSeriesPage } = await resolveStartUrl(env, jar, inputUrl);

  const startResp = await guardedFetch(env, jar, startUrl);
  const startHtml = await startResp.text();
  const startData = parseData(startHtml);
  if (!startData) throw new Error(`__DATA__ не найден: ${startUrl}`);

  const series = extractSeriesName(startHtml) || `series-${startData.news_id}`;
  const seriesDir = fs.join(root, safeFilename(series));
  await fs.mkdir(seriesDir);
  log(`\n=== «${series}» → ${seriesDir} ===`);

  const manifest = await loadManifest(fs, seriesDir);
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
  log(`  всего глав в каталоге: ${allChapters.length}, в очереди: ${queue.length}`);
  const alreadyDone = queue.filter((c) => manifest.completed[c.id]).length;
  if (alreadyDone) log(`  уже скачано: ${alreadyDone}`);

  let processed = 0;
  for (const ch of queue) {
    if (isCancelled && isCancelled()) { log('  [отменено]'); break; }
    processed++;
    if (manifest.completed[ch.id]) continue;
    if (isAltTranslation(ch.title)) {
      manifest.completed[ch.id] = { skipped: 'alt-translation', title: ch.title };
      await saveManifest(fs, seriesDir, manifest);
      continue;
    }

    const chapterUrl = `${BASE}/reader/${newsId}/${ch.id}`;
    log(`\n[${processed}/${queue.length}] ${chapterUrl}`);
    log(`  ${ch.title}`);

    let data;
    if (ch.id === startChapterId) {
      data = startData;
    } else {
      try {
        const r = await guardedFetch(env, jar, chapterUrl);
        data = parseData(await r.text());
      } catch (e) {
        env.warn(`  fetch failed: ${e.message}`);
        continue;
      }
    }
    if (!data || !data.images?.length) {
      env.warn('  пропуск: нет изображений');
      continue;
    }

    const volume = volumeFromTitle(ch.title) ?? 1;
    const volKey = String(volume);
    const folder = fs.join(seriesDir, `том ${volume}`);
    await fs.mkdir(folder);

    if (manifest.counters[volKey] == null) {
      let max = 0;
      const existing = await fs.readdir(folder).catch(() => []);
      for (const f of existing) {
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
      if (isCancelled && isCancelled()) break;
      n++;
      const imgUrl = `https://${host}/comix/${rel}`;
      const filename = `page ${n}${extFromUrl(imgUrl)}`;
      const out = fs.join(folder, filename);
      try {
        const r = await guardedFetch(env, jar, imgUrl, {
          Referer: chapterUrl,
          Accept: 'image/avif,image/webp,*/*',
        });
        await fs.writeBinaryFile(out, await r.bytes());
        saved++;
      } catch (e) {
        env.warn(`    fail ${imgUrl}: ${e.message}`);
        n--;
      }
      await sleep(150);
    }
    manifest.counters[volKey] = n;
    manifest.completed[ch.id] = { volume, pages: saved, title: ch.title };
    await saveManifest(fs, seriesDir, manifest);
    log(`  том ${volume}: страницы ${startN + 1}–${n} (новых ${saved}/${data.images.length})`);

    await sleep(800);
  }

  log(`\n— готово «${series}» —`);
  for (const [v, n] of Object.entries(manifest.counters).sort((a, b) => +a[0] - +b[0])) {
    log(`  том ${v}: ${n} страниц`);
  }
  return { series, dir: seriesDir };
}
