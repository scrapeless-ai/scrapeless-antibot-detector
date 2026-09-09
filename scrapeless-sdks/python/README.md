# Scrapeless Detector — Python SDK

Ask a page whether it is protected, from a Playwright script.

```python
from scrapeless_detector import ScrapelessDetector

async with ScrapelessDetector.launch("../../scrapeless-extension") as session:
    result = await session.detect("https://example.com/checkout")

    if result.is_antibot:
        print([d.name for d in result.of_category("antibot")])
```

## How it works, and why it needs a browser

Python cannot hear the extension. The extension talks to the **page**, by
dispatching `CustomEvent`s at `window`, so this SDK drives a real Chrome with
the extension loaded and reads the result back out of the document.

The listener goes in through `add_init_script`, so it runs at `document_start`
on every navigation. That timing is the whole trick: on a cache hit the
extension dispatches `scrapeless:onDetection` almost immediately, so a listener
added after `page.goto()` returns would routinely hear nothing at all — and a
silent listener looks exactly like a clean page.

## Install

```bash
pip install playwright
playwright install chromium
```

The SDK itself has no dependencies beyond Playwright. Copy the
`scrapeless_detector/` package next to your script, or put this directory on
`PYTHONPATH`.

## Read this before trusting a `False`

```python
result = await session.detect(url)

if not result.available:
    # No extension loaded, or Page signals is off. This is NOT "clean".
    print(result.reason)   # 'unavailable'
```

`is_antibot` is `False` in that state too, so **check `available` first** if the
difference matters. Two things produce silence and neither announces itself:
the page API ships disabled (*Settings → Detection → Page signals*), and Chrome
may not have loaded the extension.

## Attaching to a page you already have

`launch()` is convenience. If you already run Playwright, attach instead —
**before** navigating:

```python
detector = await ScrapelessDetector.attach(page)
await page.goto("https://example.com")
result = await detector.detect()
```

Attaching after `goto()` still works, but may have missed the detection that
already fired.

## Sync API

Same semantics, for `playwright.sync_api`:

```python
from scrapeless_detector import SyncScrapelessDetector

with SyncScrapelessDetector.launch("../../scrapeless-extension") as session:
    result = session.detect("https://example.com")
```

## API

| Member | Returns | Notes |
|---|---|---|
| `ScrapelessDetector.launch(path, ...)` | async context manager | Chrome with the extension loaded |
| `ScrapelessDetector.attach(page)` | detector | installs the listener; call before `goto` |
| `detect(timeout_ms=None)` | `Result` | bounded; replays if detection already finished |
| `snapshot()` | `Result \| None` | never waits |
| `ready()` | `{available, version}` | what the extension announced |
| `is_antibot()` / `is_captcha()` / `is_fingerprinted()` / `is_protected()` | `bool` | |

### Result

```python
result.available       # was the extension actually heard from?
result.reason          # 'unavailable' when not
result.url, result.timestamp, result.from_cache
result.total           # detections actually delivered
result.reported_total  # what the extension claimed; usually equal
result.categories      # {'antibot': 1, 'captcha': 1, 'fingerprint': 3, 'other': 0}
result.detections      # [Detection(name=..., category_key=..., confidence=...)]
result.of_category('antibot')
```

Every original field survives on `Detection.raw`, reachable with `d["field"]`
or `d.get("field")`. The SDK only *adds* `category_key`, a normalized `name`,
and a `confidence` that is a number or `None` — never `NaN`.

## Chrome will not load an extension headless

Classic headless Chrome cannot load extensions, so `launch()` defaults to
`headless=False`. On a machine with no display, run it under a virtual one:

```bash
xvfb-run -a python your_script.py
```

## Tests

```bash
python3 -m unittest test_detector -v
```

19 tests, no browser and no display needed — the one seam that touches Chrome
(`page.evaluate`) is faked, which covers the whole public surface. They also
assert that the sync and async classes cannot drift apart, and that the category
fold matches the same ten vectors the browser and Go SDKs use.
