# Scrapeless Detector SDK

Ask a page whether it is protected, from page JavaScript.

```js
const sdk = new ScrapelessDetector();

if (await sdk.isAntibot()) {
  console.log('this page runs an anti-bot system');
}
```

## Why this exists

The extension already talks to the page, but only by pushing `CustomEvent`s at
`window`:

```js
window.addEventListener('scrapeless:onDetection', (e) => { /* … */ });
```

That has two sharp edges:

- **It is push-only.** There is no way to *ask*. You had to be listening at the
  moment the event fired.
- **Detection usually finishes before your code runs.** On a cache hit the
  extension dispatches `onDetection` almost immediately, so a listener added by
  a page script never hears it — and a silent listener looks exactly like a
  clean page.

This SDK subscribes the instant it is constructed and keeps what it heard, so a
question asked later is still answerable.

## Install

Zero dependencies, single file, UMD.

```html
<script src="scrapeless-sdks/browser/scrapeless-detector.js"></script>
<script>
  const sdk = new ScrapelessDetector();
</script>
```

```js
const ScrapelessDetector = require('./scrapeless-sdks/browser/scrapeless-detector.js');
```

## Read this before trusting `false`

The page API is **opt-in and off by default** — `pageSignals.pageSignalsActive`
is `false` in `defaults.json`, and the user must enable *Settings → Detection →
Page signals*. The extension may also simply not be installed.

Neither case is distinguishable from "nothing detected" by listening, so every
wait is bounded (8s by default) and resolves to a result rather than hanging:

```js
const result = await sdk.detect();

if (!result.available) {
  // No extension, or the page API is switched off. This is NOT "clean".
  console.log(result.reason); // 'unavailable'
}
```

`isAntibot()` returns `false` in that state, so **check `available` first** if
the difference matters to you.

## API

| Method | Returns | Notes |
| --- | --- | --- |
| `ready()` | `Promise<{available, version}>` | Resolves when the extension announces itself |
| `detect()` | `Promise<Result>` | Full result; replays if detection already finished |
| `isAntibot()` | `Promise<boolean>` | Any anti-bot / WAF detection |
| `isCaptcha()` | `Promise<boolean>` | Any CAPTCHA detection |
| `isFingerprinted()` | `Promise<boolean>` | Any fingerprinting detection |
| `isProtected()` | `Promise<boolean>` | Anything at all, any category |
| `hasCategory(key)` | `Promise<boolean>` | `'antibot'`, `'captcha'`, `'fingerprint'`, `'other'` |
| `snapshot()` | `Result \| null` | Synchronous; never waits |
| `on(event, fn)` | `() => void` | Returns an unsubscribe function |
| `destroy()` | `void` | Detaches listeners, settles pending waits |

### Result

```js
{
  available: true,          // was the extension actually heard from?
  reason: null,             // 'unavailable' | 'destroyed' when not
  url: 'https://example.com/checkout',
  timestamp: '2026-09-07T10:14:22.104Z',
  fromCache: false,
  total: 5,                 // detections actually delivered
  reportedTotal: 5,         // what the extension claimed; usually equal
  categories: { antibot: 1, captcha: 1, fingerprint: 3, other: 0 },
  detections: [
    { name: 'Cloudflare Bot Management', category: 'Anti-Bot',
      categoryKey: 'antibot', confidence: 98, /* …original fields kept… */ }
  ]
}
```

Every original field on a detection is preserved; the SDK only *adds*
`categoryKey`, a normalized `name`, and a `confidence` that is a number or
`null` (never `NaN`).

### Categories are normalized for you

The bundled detectors ship the category in four different spellings —
`'Anti-Bot'`, `'ANTIBOT'`, `'CAPTCHA'`, `'Fingerprint'` — so a naive
`d.category === 'antibot'` matches **nothing**. Use `categoryKey`, or the
`is*()` helpers, which fold exactly the way the extension's own
`FindingTotals` does (lowercase, strip non-letters, then alias `waf → antibot`
and `fingerprinting → fingerprint`).

```js
ScrapelessDetector.categoryKeyOf({ category: 'Anti-Bot' }); // 'antibot'
```

### Events

`on()` takes any of `ready`, `onStart`, `onProgress`, `onHooksComplete`,
`onWindowPropsComplete`, `onDetection`, `onError` — with or without the
`scrapeless:` prefix. An unknown name throws rather than silently never firing.

A subscriber that arrives late is replayed the event it missed:

```js
const off = sdk.on('onDetection', (detail) => console.log(detail.detections));
off();
```

A handler that throws is caught and logged; the other handlers still run.

## Options

```js
new ScrapelessDetector({
  timeout: 8000,   // ms before an unanswered wait resolves unavailable; 0 disables
  target: window   // event source, for tests
});
```

## Example: gate a scraper

```js
const sdk = new ScrapelessDetector({ timeout: 5000 });
const result = await sdk.detect();

if (!result.available) {
  throw new Error('Cannot assess this page: enable Page signals in the extension.');
}
if (result.categories.antibot > 0) {
  console.warn('anti-bot present:',
    result.detections.filter((d) => d.categoryKey === 'antibot').map((d) => d.name));
}
```
