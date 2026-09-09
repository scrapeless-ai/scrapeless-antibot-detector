# Scrapeless Detector — Rust SDK

```rust
use scrapeless_detector::{build_result, category_key_of};

let result = build_result(true, Some(&detail_from_the_page));

if result.is_antibot() {
    for detection in result.of_category("antibot") {
        println!("{}", detection.name);
    }
}
```

Rust cannot hear the extension directly — the extension dispatches
`CustomEvent`s at the page's `window`. Reaching it means driving a real Chrome
with the extension loaded; the optional `browser` feature does that with
[chromiumoxide], installing `bridge::INIT_SCRIPT` through
`Page.addScriptToEvaluateOnNewDocument` before navigating.

[chromiumoxide]: https://github.com/mattsse/chromiumoxide

```toml
[dependencies]
scrapeless-detector = { version = "1.0", features = ["browser"] }
```

The browser half is **off by default**, so the result and category layer — the
part that must never drift from the other SDKs — builds and tests with nothing
but `serde_json`.

## Read this before trusting a `false`

`is_antibot()` returns false both when nothing was detected and when nothing was
heard. `available` separates them. The page API ships disabled
(*Settings → Detection → Page signals*) and the extension may not be loaded.

## API

`DetectionResult` — `available`, `reason`, `url`, `timestamp`, `from_cache`,
`total`, `reported_total`, `categories`, `detections`, with `has_category()`,
`is_antibot()`, `is_captcha()`, `is_fingerprinted()`, `is_protected()`,
`of_category()` and `DetectionResult::unavailable()`.

`category_key_of(&str) -> &'static str` folds any category spelling.

## Tests

```bash
cargo test
```

5 tests, no browser and no chromiumoxide fetch. They read
`../conformance.json` and assert `src/bridge.rs` matches `../bridge.js`.
