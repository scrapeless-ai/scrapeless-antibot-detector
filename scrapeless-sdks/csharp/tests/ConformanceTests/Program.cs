using System.Text.Json;
using Scrapeless.Detector;

// Reads ../../../conformance.json, the shared truth for every SDK, so a fold
// that drifts here fails here. Plain assertions and a Main, so it runs with
// nothing but the .NET SDK — no xunit dependency on a zero-dependency SDK.

var passed = 0;
var failed = 0;

void Check(bool condition, string label)
{
    if (condition) { passed++; return; }
    failed++;
    Console.Error.WriteLine($"  FAIL {label}");
}

// System.Text.Json hands back JsonElement; the SDK works over plain
// dictionaries, which is what Playwright would give it.
object? Plain(JsonElement element) => element.ValueKind switch
{
    JsonValueKind.Object => element.EnumerateObject()
        .ToDictionary(field => field.Name, field => Plain(field.Value))
        as IReadOnlyDictionary<string, object?>,
    JsonValueKind.Array => element.EnumerateArray().Select(Plain).ToList()
        as IEnumerable<object?>,
    JsonValueKind.String => element.GetString(),
    JsonValueKind.Number => element.GetDouble(),
    JsonValueKind.True => true,
    JsonValueKind.False => false,
    _ => null,
};

var root = args.Length > 0 ? args[0] : "../..";
using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "conformance.json")));
var vectors = document.RootElement;

foreach (var vector in vectors.GetProperty("categoryFold").EnumerateArray())
{
    var raw = vector.GetProperty("raw").GetString();
    var expect = vector.GetProperty("expect").GetString();
    Check(Categories.KeyOf(raw) == expect, $"fold \"{raw}\" -> {expect}");
}

foreach (var vector in vectors.GetProperty("results").EnumerateArray())
{
    var name = vector.GetProperty("name").GetString();
    var detail = Plain(vector.GetProperty("detail")) as IReadOnlyDictionary<string, object?>;
    var want = vector.GetProperty("expect");
    var result = DetectionResult.Build(true, detail);

    Check(result.Available == want.GetProperty("available").GetBoolean(), $"{name}: available");
    Check(result.Total == want.GetProperty("total").GetInt32(), $"{name}: total");
    Check(result.ReportedTotal == want.GetProperty("reportedTotal").GetInt32(), $"{name}: reportedTotal");
    foreach (var bucket in want.GetProperty("categories").EnumerateObject())
    {
        Check(result.Categories[bucket.Name] == bucket.Value.GetInt32(),
            $"{name}: categories.{bucket.Name}");
    }
    Check(result.IsAntibot == want.GetProperty("isAntibot").GetBoolean(), $"{name}: isAntibot");
    Check(result.IsProtected == want.GetProperty("isProtected").GetBoolean(), $"{name}: isProtected");

    if (want.TryGetProperty("firstName", out var firstName))
    {
        Check(result.Detections[0].Name == firstName.GetString(), $"{name}: firstName");
        Check(result.Detections[0].CategoryKey == want.GetProperty("firstCategoryKey").GetString(),
            $"{name}: firstCategoryKey");
    }
    if (want.TryGetProperty("lastConfidenceIsNull", out var nullConfidence) && nullConfidence.GetBoolean())
    {
        Check(result.Detections[^1].Confidence is null,
            $"{name}: a non-numeric confidence must be null");
    }
}

var missingWant = vectors.GetProperty("unavailable").GetProperty("expect");
var missing = DetectionResult.Unavailable();
Check(missing.Available == missingWant.GetProperty("available").GetBoolean(), "unavailable: available");
Check(missing.Reason == missingWant.GetProperty("reason").GetString(), "unavailable: reason");
Check(missing.Total == missingWant.GetProperty("total").GetInt32(), "unavailable: total");
// false here must never be read as "clean" — Available says which it is.
Check(missing.IsAntibot == missingWant.GetProperty("isAntibot").GetBoolean(), "unavailable: isAntibot");
Check(missing.IsProtected == missingWant.GetProperty("isProtected").GetBoolean(), "unavailable: isProtected");

var canonical = File.ReadAllText(Path.Combine(root, "bridge.js")).Trim();
Check(Bridge.InitScript.Trim() == canonical, "Bridge.cs matches scrapeless-sdks/bridge.js");

var sample = Plain(vectors.GetProperty("results")[0].GetProperty("detail"))
    as IReadOnlyDictionary<string, object?>;
var built = DetectionResult.Build(true, sample);
Check(built.OfCategory("antibot").Count == 1, "OfCategory filters to one bucket");
Check(built.OfCategory("antibot")[0].Name == "Cloudflare Bot Management", "OfCategory returns the right one");

var kept = new Dictionary<string, object?>
{
    ["detections"] = new List<object?>
    {
        new Dictionary<string, object?> { ["name"] = "Akamai", ["vendorNote"] = "keep me" }
            as IReadOnlyDictionary<string, object?>,
    } as IEnumerable<object?>,
} as IReadOnlyDictionary<string, object?>;
Check((DetectionResult.Build(true, kept).Detections[0].Get("vendorNote") as string) == "keep me",
    "original fields survive");

Console.WriteLine($"\n  {passed} passed, {failed} failed");
return failed > 0 ? 1 : 0;
