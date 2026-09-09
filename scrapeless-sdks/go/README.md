# Scrapeless Detector — Go SDK

Ask a page whether it is protected, from Go.

```go
package main

import (
    "context"
    "fmt"
    "log"

    scrapeless "github.com/pedro-scrapeless/scrapeless-antibot-detector/scrapeless-sdks/go"
)

func main() {
    result, err := scrapeless.DetectURL(context.Background(),
        "https://example.com/checkout",
        scrapeless.Options{ExtensionPath: "../../scrapeless-extension"})
    if err != nil {
        log.Fatal(err)
    }

    if !result.Available {
        log.Fatal("no extension loaded, or Page signals is off — this is NOT 'clean'")
    }
    for _, detection := range result.OfCategory(scrapeless.CategoryAntibot) {
        fmt.Println(detection.Name)
    }
}
```

## Tests

```bash
go test ./...
```

13 tests, no browser and no chromedp fetch needed for the result and category
layer — `result.go` and `conformance_test.go` use only the standard library.
They read [`../conformance.json`](../conformance.json), the shared vectors every
SDK asserts, and check `bridge.go` still matches [`../bridge.js`](../bridge.js).

Verified on Go 1.27.1: `go build ./...`, `go vet ./...` and `gofmt -l .` are all
clean.

## How it works, and why it needs a browser

Go cannot hear the extension. The extension talks to the **page**, by
dispatching `CustomEvent`s at `window`, so this package drives a real Chrome via
[chromedp](https://github.com/chromedp/chromedp) with the extension loaded and
reads the result back out of the document.

The bridge is installed with `Page.addScriptToEvaluateOnNewDocument`, so it runs
at document_start on every navigation. That timing is the whole trick: on a
cache hit the extension dispatches `scrapeless:onDetection` almost immediately,
so a listener added after `Navigate` returns would routinely hear nothing — and
a silent listener looks exactly like a clean page.

## Read this before trusting a `false`

```go
if !result.Available {
    // No extension, or Page signals is off. NOT the same as "clean".
    fmt.Println(result.Reason) // "unavailable"
}
```

`IsAntibot()` returns `false` in that state too, so **check `Available` first**.
Two things produce silence and neither announces itself: the page API ships
disabled (*Settings → Detection → Page signals*), and Chrome may not have loaded
the extension.

## API

| Function | Returns | Notes |
|---|---|---|
| `DetectURL(ctx, url, opts)` | `(Result, error)` | launch, navigate, answer, shut down |
| `Launch(ctx, opts)` | `(context.Context, context.CancelFunc, error)` | browser with the extension loaded |
| `Install(ctx)` | `error` | add the bridge; call before navigating |
| `Detect(ctx, timeout)` | `(Result, error)` | bounded; replays if already finished |
| `Snapshot(ctx)` | `(Result, error)` | never waits |
| `Ready(ctx)` | `(bool, string, error)` | available, version |

`Result` carries `Available`, `Reason`, `URL`, `Timestamp`, `FromCache`,
`Total`, `ReportedTotal`, `Categories` and `Detections`, with
`IsAntibot()`, `IsCaptcha()`, `IsFingerprinted()`, `IsProtected()`,
`HasCategory(key)` and `OfCategory(key)`. Every original field survives on
`Detection.Raw`.

`Total` is what actually arrived; `ReportedTotal` is what the extension claimed.
They differ only if a payload was trimmed, and keeping both means neither
silently wins.

## Chrome will not load an extension headless

Classic headless Chrome cannot load extensions, so `Launch` forces
`headless=false`. On a machine with no display:

```bash
xvfb-run -a go run ./your-program
```
