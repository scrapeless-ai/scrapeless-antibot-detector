# Scrapeless SDKs

Nine ways to ask a page whether it is protected. They return the same shape and
fold categories identically — that is not a convention, it is enforced; see
*Keeping nine SDKs honest* below.

| SDK | Reaches the extension by | Driver | Tests |
|---|---|---|---|
| [`browser/`](browser) | listening to the `CustomEvent`s directly | — | in the extension's own suite |
| [`node/`](node) | driving Chrome | Playwright | 12, `npm test` |
| [`python/`](python) | driving Chrome | Playwright | 22, `python3 -m unittest test_detector` |
| [`go/`](go) | driving Chrome | chromedp | 13, `go test ./...` |
| [`java/`](java) | driving Chrome | Playwright for Java | 77 assertions, `javac` + `java` |
| [`csharp/`](csharp) | driving Chrome | Microsoft.Playwright | 75 assertions, `dotnet run` |
| [`ruby/`](ruby) | driving Chrome | playwright-ruby-client | 11 tests / 74 assertions, `ruby` |
| [`php/`](php) | driving Chrome | php-webdriver + CDP passthrough | 62 assertions, `php` |
| [`rust/`](rust) | driving Chrome | chromiumoxide (optional feature) | 5, `cargo test` |

## Why only the browser SDK is direct

The extension talks to the **page**, by dispatching `CustomEvent`s at `window`.
Nothing outside a page can receive those. So `browser/` is a thin wrapper over
events it can already hear, and every other SDK has to launch a Chrome with the
extension loaded and read the answer back out of the document.

`node/` is worth calling out, because the obvious assumption is wrong in both
directions. The browser SDK is UMD, so it *imports* fine under `require()` — and
does nothing, because Node has no `window` and no extension. `node/` works not
because Node is special but because it brings its own browser. Importable is not
usable; driving Chrome is.

## Install the listener before you navigate

Every driving SDK installs the bridge at `document_start`
(`addInitScript`, or `Page.addScriptToEvaluateOnNewDocument` over CDP). This is
not a detail to optimise away. On a cache hit the extension dispatches
`scrapeless:onDetection` almost immediately, so a listener added after
`goto`/`navigate` returns would routinely hear nothing — and a silent listener
is indistinguishable from a clean page.

## The one thing to get right in all of them

**A `false` is not "clean" unless `available` is true.**

Two conditions produce silence, and neither announces itself:

- The page API ships **disabled** — the user must switch on *Settings →
  Detection → Page signals*.
- The extension may not be loaded at all.

Neither is distinguishable from "nothing was detected" by listening, so every
wait is bounded and returns a result carrying `available: false` rather than
hanging. Check that field before acting on a negative.

Classic headless Chrome also **cannot load extensions**, so the launching
helpers default to headed. With no display, use `xvfb-run -a …`.

## Keeping nine SDKs honest

Nine copies of the same logic is nine places to drift, and drift here is silent:
the detectors ship the category in four spellings — `Anti-Bot`, `ANTIBOT`,
`CAPTCHA`, `Fingerprint` — so an SDK that folds them differently buckets
detections differently from the badge the user is looking at, and every test
still passes. Two shared files prevent that, and both are enforced rather than
documented:

- **[`conformance.json`](conformance.json)** — 12 category-fold vectors and 5
  result cases. Every SDK's tests *read this file*. They do not carry their own
  copies, so a fold that drifts fails that SDK's own suite.
- **[`bridge.js`](bridge.js)** — the canonical injected listener. Each SDK
  embeds it in its own language's string syntax, and the Node suite asserts all
  eight embedded copies are byte-identical to it. That guard caught a real
  omission the first time it ran (a missing `seen:` line in the Go copy).

If you add a tenth SDK: read `conformance.json` in its tests, embed `bridge.js`
verbatim, and add its extraction pattern to the drift test in
`node/test/detector.test.js`.
