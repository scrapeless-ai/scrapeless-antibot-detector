# Scrapeless Detector — PHP SDK

```php
use Scrapeless\Detector\Result;

$result = Result::build(true, $detailFromThePage);

if ($result->isAntibot()) {
    foreach ($result->ofCategory('antibot') as $detection) {
        echo $detection->name, PHP_EOL;
    }
}
```

PHP cannot hear the extension directly — the extension dispatches `CustomEvent`s
at the page's `window`. Reaching it means driving a real Chrome with the
extension loaded, via [php-webdriver] against ChromeDriver.

[php-webdriver]: https://github.com/php-webdriver/php-webdriver

**One wrinkle specific to PHP.** WebDriver has no init-script hook, so the
bridge cannot be installed the way Playwright does it. Use ChromeDriver's CDP
passthrough to call `Page.addScriptToEvaluateOnNewDocument` with
`Bridge::INIT_SCRIPT` before navigating. Installing after navigation is not
equivalent: on a cache hit the extension dispatches `scrapeless:onDetection`
almost immediately, and a listener that arrives late hears nothing — which is
indistinguishable from a clean page.

## Read this before trusting a `false`

`isAntibot()` returns false both when nothing was detected and when nothing was
heard. `isAvailable`/`$result->available` is what separates them. The page API
ships disabled (*Settings → Detection → Page signals*) and the extension may not
be loaded at all.

## API

`Scrapeless\Detector\Result` — `available`, `reason`, `url`, `timestamp`,
`fromCache`, `total`, `reportedTotal`, `categories`, `detections`,
`hasCategory()`, `isAntibot()`, `isCaptcha()`, `isFingerprinted()`,
`isProtected()`, `ofCategory()`.

`Scrapeless\Detector\Categories::keyOf()` folds any category spelling.

## Tests

```bash
php test/DetectorTest.php
```

62 assertions, no PHPUnit dependency and no browser. They read
`../conformance.json` and assert the embedded bridge matches `../bridge.js`.
