# Changelog

All notable changes to Scrapeless Anti-Bot Detector are documented here. This
project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-09-08

First release.

### Detection

- 44 detectors: 15 anti-bot/WAF (Cloudflare Bot Management, Akamai, DataDome,
  PerimeterX, Kasada, Shape Security, AWS WAF, Imperva, F5 BIG-IP ASM, Reblaze,
  Sucuri, ThreatMetrix, Cheq, Ocule, Meetrics), 8 CAPTCHA (reCAPTCHA, hCaptcha,
  FunCaptcha, GeeTest, Friendly Captcha, Captcha.eu, QCloud, AliExpress) and 21
  fingerprinting techniques.
- Eight signal types per detector: page content, window properties, JS hooks,
  request URLs, cookies, DOM, response headers and request payloads.
- JS hooks install synchronously at `document_start`, so a fingerprinting call
  is caught as it happens rather than inferred from markup. Hook targets come
  from the detector definitions, so adding one means editing a detector.
- Conditions are evaluated by a pre-built matcher — never `eval`.

### Console

- Findings, scan history, an editable detector catalogue and preferences.
- Badge showing the detection count, with per-category colours.
- Detectors editor with full create/read/update/delete over the catalogue.
- Configurable cache duration, history limit, domain blacklist and debug mode.

### Analytics

- A separate board charting detections over time, category split, vendor
  ranking, bypass difficulty, confidence spread, catalogue coverage, which
  signal gave each vendor away, and which vendors appear together on a page.
- Exports to JSON or PDF, and reads a history export dropped onto the page.

### SDKs

- Nine of them — browser, Node, Python, Go, Java, C#, Ruby, PHP and Rust —
  answering `isAntibot()`, `isCaptcha()` and `isFingerprinted()`.
- The browser SDK hears the extension's `CustomEvent`s directly; the other
  eight drive a real Chrome with the extension loaded, because nothing outside
  a page receives those events.
- All nine fold detection categories identically, enforced by a shared
  `conformance.json` their tests read and a canonical `bridge.js` each embeds.

### Localization

- 653 keys across 12 languages: English, Spanish, Portuguese (BR), French,
  German, Italian, Russian, Japanese, Korean, Chinese (Simplified), Arabic and
  Hindi. Console and analytics board both covered in full.

### Privacy

- No telemetry and no account. Detection runs entirely in the browser.
- Eight permissions, all load-bearing — no `scripting`, no `webNavigation`.
- CSP without `unsafe-eval`; MAIN and ISOLATED worlds kept separate and bridged
  by an authenticated channel.
- Detector-catalogue sync is off by default and updates only on request.

[1.0.1]: https://github.com/scrapeless-ai/scrapeless-antibot-detector/releases/tag/v1.0.1
