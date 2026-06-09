import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { runParser } from './www/parser.mjs';

const URLS = process.argv.slice(2);
if (URLS.length === 0) {
  console.error('usage: node index.js <url1> [url2] ...');
  process.exit(1);
}

function nodeEnv() {
  return {
    rootDir: path.resolve('./downloads'),
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    sleep,
    now: () => Date.now(),
    random: () => Math.random(),
    fs: {
      join: (...p) => path.join(...p),
      mkdir: (p) => fs.mkdir(p, { recursive: true }),
      readTextFile: (p) => fs.readFile(p, 'utf8'),
      writeTextFile: (p, s) => fs.writeFile(p, s),
      writeBinaryFile: (p, bytes) => fs.writeFile(p, Buffer.from(bytes)),
      readdir: (p) => fs.readdir(p),
    },
    crypto: {
      sha256Hex: async (s) => crypto.createHash('sha256').update(s).digest('hex'),
    },
    http: {
      async request({ url, method = 'GET', headers, body, manualRedirect, responseType }) {
        const r = await fetch(url, {
          method,
          headers,
          body,
          redirect: manualRedirect ? 'manual' : 'follow',
        });
        const setCookie = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
        let textCache = null;
        let bytesCache = null;
        return {
          status: r.status,
          location: r.headers.get('location') || '',
          setCookie,
          async text() {
            if (textCache == null) {
              if (responseType === 'arraybuffer') {
                const ab = await r.arrayBuffer();
                textCache = Buffer.from(ab).toString('utf8');
              } else {
                textCache = await r.text();
              }
            }
            return textCache;
          },
          async bytes() {
            if (bytesCache == null) {
              const ab = await r.arrayBuffer();
              bytesCache = new Uint8Array(ab);
            }
            return bytesCache;
          },
        };
      },
    },
  };
}

async function main() {
  const env = nodeEnv();
  await env.fs.mkdir(env.rootDir);
  for (const url of URLS) {
    try {
      await runParser(url, env);
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
