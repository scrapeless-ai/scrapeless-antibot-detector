# Scrapeless Detector — Node SDK

```js
const { ScrapelessDetector } = require('scrapeless-detector');

await ScrapelessDetector.withBrowser('./scrapeless-extension', async (session) => {
  const result = await session.detect('https://example.com/checkout');
  if (result.isAntibot) {
    console.log(result.ofCategory('antibot').map((d) => d.name));
  }
});
```

## This is not the browser SDK

`../browser` is UMD, so it imports fine under `require()` — and does nothing,
because Node has no `window` and no extension, so every call returns
`available: false`. This SDK works because it **brings its own browser**: it
launches Chrome with the extension loaded via Playwright and reads the result
back out of the document.

The listener goes in through `addInitScript`, so it runs at `document_start` on
every navigation. That timing is the point: on a cache hit the extension
dispatches `scrapeless:onDetection` almost immediately, so a listener added
after `page.goto()` returns would routinely hear nothing — and a silent listener
looks exactly like a clean page.

## Install

```bash
npm install playwright     # peer dependency, optional in package.json
npx playwright install chromium
```

## Read this before trusting a `false`

```js
if (!result.available) {
  // No extension loaded, or Page signals is off. This is NOT "clean".
  console.log(result.reason); // 'unavailable'
}
```

Two things produce silence and neither announces itself: the page API ships
disabled (*Settings → Detection → Page signals*), and Chrome may not have loaded
the extension. Both are indistinguishable from "nothing detected" by listening,
so every wait is bounded.

## Attaching to a page you already have

```js
const detector = await ScrapelessDetector.attach(page); // BEFORE goto
await page.goto('https://example.com');
const result = await detector.detect();
```

## API

| Member | Returns |
|---|---|
| `ScrapelessDetector.withBrowser(path, fn, opts?)` | whatever `fn` returns |
| `ScrapelessDetector.attach(page, timeoutMs?)` | `Promise<ScrapelessDetector>` |
| `detect(timeoutMs?)` | `Promise<Result>` |
| `snapshot()` | `Promise<Result \| null>` — never waits |
| `ready()` | `Promise<{ available, version }>` |
| `isAntibot()` / `isCaptcha()` / `isFingerprinted()` / `isProtected()` | `Promise<boolean>` |

`Result` carries `available`, `reason`, `url`, `timestamp`, `fromCache`,
`total`, `reportedTotal`, `categories`, `detections`, plus `hasCategory(key)`
and `ofCategory(key)`. `total` is what arrived; `reportedTotal` is what the
extension claimed — they differ only if a payload was trimmed.

TypeScript definitions ship in `index.d.ts`.

## Chrome will not load an extension headless

Classic headless Chrome cannot load extensions, so `headless` defaults to
`false`. With no display, use `xvfb-run -a node your-script.js`.

## Tests

```bash
npm test        # node --test
```

12 tests, no browser needed. They read `../conformance.json` — the shared
vectors every SDK asserts — and include the drift guard that checks all eight
embedded copies of `../bridge.js` are byte-identical.
