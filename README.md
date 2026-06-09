# x-file-parser

Парсер манги/комиксов и локальная читалка. Один и тот же код работает в трёх местах:
**Node CLI**, **локальная веб-читалка** в браузере и **нативное iOS-приложение**
для iPhone/iPad — комиксы скачиваются на устройство и читаются офлайн.

```
                 ┌─────────────────────────────────────┐
                 │      www/parser.mjs (изоморфный)    │
                 │      PoW · cookies · ретраи         │
                 └──────────────┬──────────────────────┘
                                │ env: http · fs · crypto
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  ┌───────────┐         ┌───────────────┐       ┌──────────────┐
  │ index.js  │         │ reader-server │       │ www/native-  │
  │  Node     │         │ + www/index   │       │ env.mjs      │
  │ node:fs   │         │ браузер ↔ JS  │       │ Capacitor    │
  │ node:crypto│        │ через HTTP    │       │ Filesystem · │
  │ fetch     │         │               │       │ Http · WebCr │
  └─────┬─────┘         └───────┬───────┘       └──────┬───────┘
        ▼                       ▼                       ▼
    downloads/             downloads/              Documents/comix/
   (диск Mac/PC)          (диск Mac/PC)              (iOS device)
```

## Возможности

- **Парсер.** Скачивает серию или произвольный диапазон глав по URL.
  Решает PoW-челлендж сайта, держит cookies, ретраит сетевые ошибки.
  Идемпотентный — повторный запуск докачивает только то, чего не хватает.
- **Очередь закачек.** Несколько URL подряд — выстраиваются в очередь,
  выполняются по одному, можно отменять стоящие в очереди и стопать
  активный. История последних 20 запусков.
- **Читалка.** Авто-разворот по соотношению сторон (одинарная или
  двухстраничная), 3D-анимация перелистывания, клавиатура/тач/свайп,
  прогресс по томам в `localStorage`, продолжение чтения.
- **iOS-сборка.** Через Capacitor: парсер крутится прямо на устройстве,
  файлы в `Documents/comix/` видны в Files.app, никакого бэкенда не
  нужно — летите в самолёте и читаете.

## Запуск

### CLI парсер

```bash
npm run parse -- https://example.com/reader/<news_id>/<chapter_id>
# или несколько за раз
npm run parse -- <url1> <url2> <url3>
```

URL принимается двух видов:
- **страница главы** `/reader/<news_id>/<chapter_id>` — качается с этой главы и далее;
- **страница серии** (без `/reader/...`) — качается вся серия с начала.

### Локальная читалка в браузере

```bash
npm run serve            # → http://localhost:3000
PORT=4000 npm run serve  # порт можно переопределить
```

В читалке тот же парсер: карточка «+ Добавить серию по URL» открывает
менеджер очереди — `Сейчас качается / Очередь / История` с живым логом.

### iOS-сборка

```bash
npm run ios:open   # открыть проект в XCode
```

В XCode:
1. **Target App → Signing & Capabilities → Team:** твой Apple ID
   (бесплатного достаточно для sideload, $99/год Apple Developer — для
   TestFlight).
2. Подключить iPhone/iPad по кабелю, выбрать как destination.
3. ⌘R — Build & Run.
4. На устройстве: **Settings → General → VPN & Device Management** →
   подтвердить твою подпись.

После любых правок веб-кода (`www/`) — пересинхронизировать:

```bash
npm run ios:sync
```

## Структура

```
.
├── index.js                ← Node-обёртка над парсером (CLI)
├── reader-server.js        ← HTTP-сервер читалки + очередь парсинга
├── bootstrap-manifest.mjs  ← одноразовая утилита для досборки манифеста
├── capacitor.config.json   ← appId / appName / webDir
├── package.json
├── www/
│   ├── index.html          ← SPA-читалка (модульный ES-скрипт)
│   ├── parser.mjs          ← парсер (изоморфный — Node и WebView)
│   ├── platform.mjs        ← абстракция: list/image/queue для web vs native
│   └── native-env.mjs      ← Capacitor env (Http + Filesystem + WebCrypto)
├── ios/                    ← XCode-проект (генерируется `cap add ios`)
└── downloads/              ← результат: <Серия>/<том N>/page N.<ext>
```

## Архитектура

### Изоморфный парсер

Вся логика парсинга в `www/parser.mjs`. Файл не зависит от Node и не
зависит от браузера — платформенные примитивы (HTTP-клиент, файловая
система, SHA-256, sleep) принимаются параметром `env`:

```js
import { runParser } from './www/parser.mjs';
await runParser(url, env);
// env = { http, fs, crypto, log, warn, sleep, now, random, rootDir }
```

Два env-конструктора:
- **`index.js`** делает Node-env: `fetch` + `node:fs/promises` + `node:crypto`.
- **`www/native-env.mjs`** делает Capacitor-env: `CapacitorHttp` (минует
  WebView/CORS, идёт через нативный `URLSession`) + `@capacitor/filesystem`
  (запись в `Documents/`) + `crypto.subtle.digest('SHA-256', …)`.

### Платформенный слой читалки

`www/platform.mjs` — единый API, который читалка дёргает независимо от
платформы:

```js
platform.listSeries()                   → [{name, volumes, pages}]
platform.listVolumes(series)            → [{name, volume, pages}]
platform.listPages(series, volume)      → [filename]
platform.imageUrl(series, volume, file) → string

platform.parseSubscribe(handler)        → () => unsubscribe
platform.parseAdd(url)                  → job
platform.parseStop()
platform.parseCancel(id)
```

В вебе внутри — `fetch` к `reader-server.js`. На iOS — прямой
`Filesystem.readdir` и встроенный in-memory queue-runner, который сам
запускает `runParser`. Один и тот же UI работает в обоих режимах.

### Очередь закачек

Менеджер очереди (и в `reader-server.js` для веба, и в `platform.mjs` для
iOS) держит `jobs Map · queue[] · activeJobId · history[20]`. Любой POST
кладёт в очередь, следующий автостартует по завершении предыдущего.
События (`queued / started / log / done / cancelled`) идут через SSE
(веб) или локальный pub/sub (iOS).

## Как работает парсер

1. **Анти-бот.** Сайт отдаёт 302 → `/_c?...` (PoW-челлендж):
   - получает токен из HTML челленджа;
   - ищет nonce такой, что `sha256(token + ':' + nonce)` начинается с `00`
     (8 ведущих бит — миллисекунды на любом устройстве);
   - имитирует «человеческое» время решения (450–700 мс);
   - POST на `/_v` с метриками браузера → получает cookie доступа.
2. **Страница главы.** Извлекается `window.__DATA__ = {...};`:
   `news_id`, `chapter_id`, `chapters[]` (каталог серии), `images[]`
   (пути картинок), `host`.
3. **Очередь глав.** `chapters` реверсится (сайт отдаёт от новых к
   старым). Если стартовый URL — внутри списка, режется до этой главы;
   если «серийный» — берётся всё.
4. **Том.** Из title главы: `/Том\s+(\d+)/i`, иначе `1`. Альт-переводы
   («альт» / `alt`) **пропускаются**.
5. **Картинки.** `том N/page <N>.<ext>` со сквозной нумерацией в томе.
6. **Манифест** `<серия>/.manifest.json` — идемпотентность:

   ```json
   {
     "title": "...",
     "news_id": 3038,
     "completed": { "<chapter_id>": { "volume": 1, "pages": 19, "title": "..." } },
     "counters":  { "1": 19, "2": 38 }
   }
   ```

   Главы из `completed` повторно не качаются. `counters[vol]` — последняя
   использованная страница в томе.
7. **Ретраи** (`guardedFetch`):
   - 302 → `/_c?` → проходит челлендж и повторяет;
   - 302 на обычный URL → следует;
   - 403 / 429 → экспоненциальная пауза (`2s × 2^attempt`);
   - 404 → 2 коротких ретрая;
   - сетевые ошибки → `1.5s × 2^attempt`, 5 попыток;
   - между картинками — sleep 150 мс, между главами — 800 мс.

## API локального сервера читалки

| Endpoint                              | Ответ                                          |
|---------------------------------------|------------------------------------------------|
| `GET /`                               | `www/index.html`                               |
| `GET /<file>.mjs`                     | статические модули из `www/`                   |
| `GET /api/series`                     | `[{name, volumes, pages}]`                     |
| `GET /api/series/<name>`              | `{volumes: [{name, volume, pages}]}`           |
| `GET /api/series/<name>/<volume>`     | `{pages: [filename]}`                          |
| `GET /files/<series>/<volume>/<file>` | байты картинки (safe-join, кэш 24ч)            |
| `POST /api/parse` `{url}`             | добавляет в очередь, возвращает `{job}`        |
| `GET /api/parse/status`               | `{active, queue, history}`                     |
| `GET /api/parse/events`               | SSE: `snapshot → queued · started · log · done · cancelled` (heartbeat 15s) |
| `POST /api/parse/stop`                | SIGTERM активному (если есть)                  |
| `DELETE /api/parse/queue/<id>`        | отмена queued-задания                          |

## Зависимости

- **Node ≥ 20** (`fetch`, `Headers.getSetCookie`).
- **CocoaPods** не требуется — Capacitor 8 использует Swift Package Manager.
- Для iOS-сборки — **XCode 15+** и Apple ID (бесплатного достаточно для
  sideload на свои устройства).

```bash
npm i                # установить зависимости
npx cap add ios      # один раз — создать XCode-проект (уже сделано)
```

В `dependencies`: `@capacitor/{core,cli,ios,filesystem}` — используются
только для iOS-сборки, в Node CLI и в браузере не подгружаются.

## bootstrap-manifest.mjs

Одноразовая утилита — была написана, когда часть томов уже лежала в
`downloads/`, но без `.manifest.json`. Скачивает первую главу, помечает
все главы скачанных томов как `completed`, считает фактические
`counters` по файлам на диске. В обычной работе **не нужна**.

## Дисклеймер

Проект сделан в образовательных целях — для изучения PoW-челленджей,
HTTP-протокола, ESM-модулей и портирования веб-приложений на нативные
платформы. Скачанные материалы должны использоваться в соответствии с
авторским правом владельцев контента. Автор не несёт ответственности за
использование инструмента третьими лицами.

## Лицензия

[MIT](./LICENSE)
