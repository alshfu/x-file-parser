// Capacitor env для парсера и читалки на iOS.
// Никакого bundler'а — пользуемся глобальным window.Capacitor,
// который runtime инжектит в WebView автоматически.

function plugins() {
  if (!window.Capacitor || !window.Capacitor.Plugins) {
    throw new Error('Capacitor runtime недоступен');
  }
  return window.Capacitor.Plugins;
}

const DOWNLOADS_ROOT = 'comix';   // под Documents/comix

function dirArgs(p) {
  return { directory: 'DOCUMENTS', path: p };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sha256Hex(s) {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function normalizeSetCookie(headers) {
  if (!headers) return [];
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'set-cookie');
  if (!key) return [];
  const v = headers[key];
  return Array.isArray(v) ? v : [v];
}

function locationHeader(headers) {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'location');
  return key ? headers[key] : '';
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function httpAdapter() {
  return {
    async request({ url, method = 'GET', headers, body, manualRedirect, responseType }) {
      const { CapacitorHttp } = plugins();
      const r = await CapacitorHttp.request({
        url,
        method,
        headers,
        data: body,
        responseType: responseType === 'arraybuffer' ? 'arraybuffer' : 'text',
        disableRedirects: !!manualRedirect,
      });
      const setCookie = normalizeSetCookie(r.headers);
      const location = locationHeader(r.headers);
      let textCache = null;
      let bytesCache = null;
      return {
        status: r.status,
        location,
        setCookie,
        async text() {
          if (textCache != null) return textCache;
          if (responseType === 'arraybuffer' && typeof r.data === 'string') {
            textCache = new TextDecoder('utf-8').decode(base64ToBytes(r.data));
          } else {
            textCache = typeof r.data === 'string' ? r.data : String(r.data);
          }
          return textCache;
        },
        async bytes() {
          if (bytesCache != null) return bytesCache;
          if (typeof r.data === 'string') {
            bytesCache = base64ToBytes(r.data);
          } else if (r.data instanceof ArrayBuffer) {
            bytesCache = new Uint8Array(r.data);
          } else if (r.data instanceof Uint8Array) {
            bytesCache = r.data;
          } else {
            bytesCache = new Uint8Array(0);
          }
          return bytesCache;
        },
      };
    },
  };
}

function fsAdapter() {
  return {
    join(...parts) {
      return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
    },
    async mkdir(p) {
      const { Filesystem } = plugins();
      try {
        await Filesystem.mkdir({ ...dirArgs(p), recursive: true });
      } catch (e) {
        if (!/exist/i.test(e.message || '')) throw e;
      }
    },
    async readTextFile(p) {
      const { Filesystem } = plugins();
      const r = await Filesystem.readFile({ ...dirArgs(p), encoding: 'utf8' });
      return r.data;
    },
    async writeTextFile(p, s) {
      const { Filesystem } = plugins();
      await Filesystem.writeFile({ ...dirArgs(p), data: s, encoding: 'utf8', recursive: true });
    },
    async writeBinaryFile(p, bytes) {
      const { Filesystem } = plugins();
      await Filesystem.writeFile({ ...dirArgs(p), data: bytesToBase64(bytes), recursive: true });
    },
    async readdir(p) {
      const { Filesystem } = plugins();
      const r = await Filesystem.readdir(dirArgs(p));
      return (r.files || []).map((f) => (typeof f === 'string' ? f : f.name));
    },
    async stat(p) {
      const { Filesystem } = plugins();
      return Filesystem.stat(dirArgs(p));
    },
  };
}

export function makeNativeEnv() {
  return {
    rootDir: DOWNLOADS_ROOT,
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    sleep,
    now: () => Date.now(),
    random: () => Math.random(),
    fs: fsAdapter(),
    crypto: { sha256Hex },
    http: httpAdapter(),
  };
}

export async function nativeFileUrl(relPath) {
  const { Filesystem } = plugins();
  const r = await Filesystem.getUri({ directory: 'DOCUMENTS', path: relPath });
  return window.Capacitor.convertFileSrc(r.uri);
}

export function isNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}
