# Scrapeless Detector — C# SDK

```csharp
var result = DetectionResult.Build(true, detailFromThePage);

if (result.IsAntibot)
{
    foreach (var detection in result.OfCategory("antibot"))
    {
        Console.WriteLine(detection.Name);
    }
}
```

C# cannot hear the extension directly — the extension dispatches `CustomEvent`s
at the page's `window`. Reaching it means driving a real Chrome with the
extension loaded, via [Microsoft.Playwright], installing `Bridge.InitScript`
with `page.AddInitScriptAsync(...)` **before** navigating.

[Microsoft.Playwright]: https://playwright.dev/dotnet/

That timing matters: on a cache hit the extension dispatches
`scrapeless:onDetection` almost immediately, so a listener added after
`GotoAsync` returns would routinely hear nothing — and silence is
indistinguishable from a clean page.

## Read this before trusting a `false`

`IsAntibot` is false both when nothing was detected and when nothing was heard.
`Available` separates them. The page API ships disabled
(*Settings → Detection → Page signals*) and the extension may not be loaded.

## API

`Scrapeless.Detector.DetectionResult` — `Available`, `Reason`, `Url`,
`Timestamp`, `FromCache`, `Total`, `ReportedTotal`, `Categories`, `Detections`,
`HasCategory()`, `IsAntibot`, `IsCaptcha`, `IsFingerprinted`, `IsProtected`,
`OfCategory()`.

`Categories.KeyOf(string?)` folds any category spelling.
`Bridge.ChromiumExtensionArgs(path)` gives the two Chrome flags you need.

## Build and test

Zero dependencies — `System.Text.Json` is in the BCL, so no xunit or NuGet
fetch is needed:

```bash
cd tests/ConformanceTests && dotnet run -- ../..
```

75 assertions, no browser. They read `../conformance.json` and assert
`Bridge.cs` matches `../bridge.js`.
