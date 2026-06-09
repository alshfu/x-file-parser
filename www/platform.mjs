// Платформенный слой: одинаковый API для веб-режима (HTTP к reader-server.js)
// и для native (Capacitor Filesystem + локальный runner парсера).

import { isNative, makeNativeEnv, nativeFileUrl } from './native-env.mjs';
import { runParser } from './parser.mjs';

export const NATIVE = isNative();
const ROOT = 'comix';

// ───────── listing ─────────

async function fetchJSON(u) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`GET ${u} -> ${r.status}`);
  return r.json();
}

function pageNum(name) {
  const m = name.match(/page\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : -1;
}
function volumeNum(name) {
  const m = name.match(/том\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

export async function listSeries() {
  if (!NATIVE) return await fetchJSON('/api/series');
  const env = makeNativeEnv();
  await env.fs.mkdir(ROOT);
  let names = [];
  try { names = await env.fs.readdir(ROOT); } catch { names = []; }
  const series = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = env.fs.join(ROOT, name);
    let volNames = [];
    try { volNames = await env.fs.readdir(dir); } catch {}
    let pages = 0;
    let volumes = 0;
    for (const v of volNames) {
      if (v.startsWith('.')) continue;
      volumes++;
      try {
        const files = await env.fs.readdir(env.fs.join(dir, v));
        pages += files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
      } catch {}
    }
    series.push({ name, volumes, pages });
  }
  series.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return series;
}

export async function listVolumes(seriesName) {
  if (!NATIVE) {
    const d = await fetchJSON(`/api/series/${encodeURIComponent(seriesName)}`);
    return d.volumes;
  }
  const env = makeNativeEnv();
  const dir = env.fs.join(ROOT, seriesName);
  let names = [];
  try { names = await env.fs.readdir(dir); } catch {}
  const vols = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let pages = 0;
    try {
      const files = await env.fs.readdir(env.fs.join(dir, name));
      pages = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
    } catch {}
    vols.push({ name, volume: volumeNum(name), pages });
  }
  vols.sort((a, b) => a.volume - b.volume);
  return vols;
}

export async function listPages(seriesName, volName) {
  if (!NATIVE) {
    const d = await fetchJSON(`/api/series/${encodeURIComponent(seriesName)}/${encodeURIComponent(volName)}`);
    return d.pages;
  }
  const env = makeNativeEnv();
  const dir = env.fs.join(ROOT, seriesName, volName);
  let files = [];
  try { files = await env.fs.readdir(dir); } catch {}
  return files
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort((a, b) => pageNum(a) - pageNum(b));
}

export async function imageUrl(seriesName, volName, fileName) {
  if (!NATIVE) {
    return `/files/${encodeURIComponent(seriesName)}/${encodeURIComponent(volName)}/${encodeURIComponent(fileName)}`;
  }
  const rel = `${ROOT}/${seriesName}/${volName}/${fileName}`;
  return await nativeFileUrl(rel);
}

// ───────── parse queue ─────────

function createNativeManager() {
  let nextId = 1;
  const jobs = new Map();
  const queue = [];
  const history = [];
  let activeId = null;
  const listeners = new Set();
  const LOG_LIMIT = 4000;
  const HISTORY_LIMIT = 20;

  const emit = (ev) => { for (const l of listeners) l(ev); };
  const view = (j) => j ? ({
    id: j.id, url: j.url, status: j.status,
    queuedAt: j.queuedAt, startedAt: j.startedAt || null,
    finishedAt: j.finishedAt || null, exitCode: j.exitCode == null ? null : j.exitCode,
  }) : null;

  function snapshot() {
    return {
      active: activeId != null ? view(jobs.get(activeId)) : null,
      queue: queue.map((id) => view(jobs.get(id))),
      history: history.map((id) => view(jobs.get(id))),
    };
  }

  function tryStartNext() {
    if (activeId != null) return;
    if (queue.length === 0) return;
    const id = queue.shift();
    runJob(id);
  }

  async function runJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    activeId = id;
    job.status = 'running';
    job.startedAt = Date.now();
    emit({ type: 'started', job: view(job) });

    const env = makeNativeEnv();
    const pushLog = (text) => {
      const t = String(text) + '\n';
      job.log.push(t);
      if (job.log.length > LOG_LIMIT) job.log.splice(0, job.log.length - LOG_LIMIT);
      emit({ type: 'log', jobId: job.id, text: t });
    };
    env.log = pushLog;
    env.warn = pushLog;
    env.isCancelled = () => job.cancelled === true;

    try {
      await runParser(job.url, env);
      job.status = job.cancelled ? 'cancelled' : 'done';
      job.exitCode = job.cancelled ? -1 : 0;
    } catch (e) {
      pushLog(`[ошибка] ${e.message}`);
      job.status = 'error';
      job.exitCode = -1;
    }
    job.finishedAt = Date.now();
    pushLog(`[завершено: ${job.status}]`);

    activeId = null;
    history.unshift(id);
    while (history.length > HISTORY_LIMIT) {
      const oldId = history.pop();
      jobs.delete(oldId);
    }
    emit({ type: 'done', job: view(job) });
    tryStartNext();
  }

  return {
    snapshot,
    subscribe(fn) {
      listeners.add(fn);
      fn({ type: 'snapshot', ...snapshot() });
      if (activeId != null) {
        const j = jobs.get(activeId);
        if (j && j.log.length) fn({ type: 'log', jobId: j.id, text: j.log.join('') });
      }
      return () => listeners.delete(fn);
    },
    add(url) {
      const id = nextId++;
      const job = {
        id, url, status: 'queued',
        queuedAt: Date.now(), startedAt: null, finishedAt: null,
        exitCode: null, log: [], cancelled: false,
      };
      jobs.set(id, job);
      queue.push(id);
      emit({ type: 'queued', job: view(job) });
      tryStartNext();
      return view(job);
    },
    stopActive() {
      if (activeId == null) return false;
      const j = jobs.get(activeId);
      if (!j) return false;
      j.cancelled = true;
      return true;
    },
    cancelQueued(id) {
      const i = queue.indexOf(id);
      if (i < 0) return false;
      queue.splice(i, 1);
      const job = jobs.get(id);
      if (job) { job.status = 'cancelled'; job.finishedAt = Date.now(); }
      emit({ type: 'cancelled', jobId: id });
      jobs.delete(id);
      return true;
    },
  };
}

const nativeMgr = NATIVE ? createNativeManager() : null;

export function parseSubscribe(handler) {
  if (NATIVE) return nativeMgr.subscribe(handler);
  const es = new EventSource('/api/parse/events');
  es.onmessage = (ev) => {
    try { handler(JSON.parse(ev.data)); } catch {}
  };
  return () => { try { es.close(); } catch {} };
}

export async function parseAdd(url) {
  if (NATIVE) return nativeMgr.add(url);
  const r = await fetch('/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data.job;
}

export async function parseStop() {
  if (NATIVE) return nativeMgr.stopActive();
  await fetch('/api/parse/stop', { method: 'POST' });
}

export async function parseCancel(id) {
  if (NATIVE) return nativeMgr.cancelQueued(id);
  await fetch(`/api/parse/queue/${id}`, { method: 'DELETE' });
}
