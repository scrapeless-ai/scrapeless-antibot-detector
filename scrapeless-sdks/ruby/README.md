# Scrapeless Detector — Ruby SDK

```ruby
require 'scrapeless_detector'
require 'scrapeless_detector/browser'

detector = ScrapelessDetector::Detector.attach(page) # BEFORE navigating
page.goto('https://example.com/checkout')
result = detector.detect

puts result.of_category('antibot').map { |d| d['name'] } if result.antibot?
```

Ruby cannot hear the extension directly — the extension dispatches
`CustomEvent`s at the page's `window`. This SDK drives a real Chrome with the
extension loaded (via [playwright-ruby-client]) and reads the result back out of
the document.

[playwright-ruby-client]: https://github.com/YusukeIwaki/playwright-ruby-client

The listener is installed at `document_start`, because on a cache hit the
extension dispatches `scrapeless:onDetection` almost immediately — a listener
added after navigation would routinely hear nothing, and silence looks exactly
like a clean page.

## Read this before trusting a `false`

```ruby
unless result.available
  # No extension, or Page signals is off. NOT the same as "clean".
  puts result.reason # "unavailable"
end
```

## API

`ScrapelessDetector::Detector` — `.attach(page, timeout_ms)`, `#detect`,
`#snapshot`, `#ready`, `#antibot?`, `#captcha?`, `#fingerprinted?`, `#protected?`.

`ScrapelessDetector::Result` — `available`, `reason`, `url`, `timestamp`,
`from_cache`, `total`, `reported_total`, `categories`, `detections`,
`has_category?`, `of_category`.

## Tests

```bash
ruby test_scrapeless_detector.rb
```

11 tests / 74 assertions, no browser needed. They read `../conformance.json` and
assert the embedded bridge matches `../bridge.js`.
