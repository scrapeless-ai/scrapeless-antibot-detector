# Scrapeless Detector — Java SDK

```java
DetectionResult result = DetectionResult.build(true, detailFromThePage);

if (result.isAntibot()) {
    result.ofCategory("antibot").forEach(d -> System.out.println(d.name()));
}
```

Java cannot hear the extension directly — the extension dispatches
`CustomEvent`s at the page's `window`. Reaching it means driving a real Chrome
with the extension loaded, via [Playwright for Java], installing
`Bridge.INIT_SCRIPT` with `page.addInitScript(...)` **before** navigating.

[Playwright for Java]: https://playwright.dev/java/

That timing matters: on a cache hit the extension dispatches
`scrapeless:onDetection` almost immediately, so a listener added after
`page.navigate(...)` returns would routinely hear nothing — and silence is
indistinguishable from a clean page.

## Read this before trusting a `false`

`isAntibot()` returns false both when nothing was detected and when nothing was
heard. `available()` separates them. The page API ships disabled
(*Settings → Detection → Page signals*) and the extension may not be loaded.

## API

`io.scrapeless.detector.DetectionResult` — `available()`, `reason()`, `url()`,
`timestamp()`, `fromCache()`, `total()`, `reportedTotal()`, `categories()`,
`detections()`, `hasCategory()`, `isAntibot()`, `isCaptcha()`,
`isFingerprinted()`, `isProtected()`, `ofCategory()`.

`Categories.keyOf(String)` folds any category spelling.
`Bridge.chromiumExtensionArgs(path)` gives the two Chrome flags you need.

## Build and test

No Maven or Gradle required — the SDK has zero dependencies, and the test
harness includes its own minimal JSON reader rather than pulling in Jackson:

```bash
javac -d build $(find src -name '*.java')
java -cp build io.scrapeless.detector.ConformanceTest ..
```

77 assertions, no browser. They read `../conformance.json` and assert
`Bridge.java` matches `../bridge.js`.
