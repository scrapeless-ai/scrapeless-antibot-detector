# Scrapeless Anti-Bot Detector — notices

Scrapeless Anti-Bot Detector is a Chrome MV3 extension that identifies anti-bot,
CAPTCHA and fingerprinting systems on any page. It ships a detection console,
scan history, an editable catalogue of 44 detectors, an analytics board, a
12-language interface, and SDKs for nine languages.

**Copyright (c) 2026 Scrapeless.** Licensed under the Non-Profit Open Software
License 3.0 (NPOSL-3.0) — see [LICENSE](LICENSE).

## What is in this repository

- **Detection** — 44 detectors across anti-bot/WAF (15), CAPTCHA (8) and
  fingerprinting (21), matching on eight kinds of signal: page content, window
  properties, JS hooks, request URLs, cookies, DOM, headers and request
  payloads. Hooks install at `document_start`, so a fingerprinting call is
  caught as it happens rather than inferred from markup.
- **Console** — findings, scan history, an editable detector catalogue and
  preferences, with relative timestamps, pagination and a tokenized teal accent
  applied across every stylesheet.
- **Analytics** — a separate board charting detections over time, category
  split, vendor ranking, bypass difficulty, confidence spread, which signal gave
  each vendor away, and which vendors co-occur. Exports to JSON or PDF.
- **Localization** — 653 keys across 12 languages, covering the console and the
  analytics board in full, checked for parity.
- **Storage** — record envelopes, sealed reads, and a forward migration that
  brings older records onto the current shape.
- **SDKs** — nine (browser, Node, Python, Go, Java, C#, Ruby, PHP, Rust),
  sharing one conformance suite and one canonical page bridge, with a drift
  check asserting every embedded copy stays byte-identical.

## Third-party components

None. The extension has no runtime dependencies, and each SDK depends only on
the browser-automation library for its language.
