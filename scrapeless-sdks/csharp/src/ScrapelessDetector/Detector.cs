namespace Scrapeless.Detector;

/// <summary>
/// Category folding, identical to every other Scrapeless SDK.
/// </summary>
/// <remarks>
/// The bundled detectors ship the category in four different spellings —
/// <c>Anti-Bot</c>, <c>ANTIBOT</c>, <c>CAPTCHA</c>, <c>Fingerprint</c> — so
/// comparing against any single one matches almost nothing. Fold, then alias.
/// If this drifts from the extension's own fold, these buckets disagree with
/// the badge the user is looking at and nothing would notice.
/// </remarks>
public static class Categories
{
    public const string Antibot = "antibot";
    public const string Captcha = "captcha";
    public const string Fingerprint = "fingerprint";
    public const string Other = "other";

    private static readonly Dictionary<string, string> Aliases = new()
    {
        ["antibot"] = Antibot,
        ["waf"] = Antibot,
        ["captcha"] = Captcha,
        ["fingerprint"] = Fingerprint,
        ["fingerprinting"] = Fingerprint,
    };

    /// <summary>Fold any category spelling to one of the four keys.</summary>
    public static string KeyOf(string? raw)
    {
        if (raw is null)
        {
            return Other;
        }

        var folded = new string(raw.Trim().ToLowerInvariant()
            .Where(symbol => symbol is >= 'a' and <= 'z').ToArray());

        return Aliases.TryGetValue(folded, out var key) ? key : Other;
    }

    /// <summary>Counts carrying all four keys, always.</summary>
    public static Dictionary<string, int> EmptyCounts() => new()
    {
        [Antibot] = 0,
        [Captcha] = 0,
        [Fingerprint] = 0,
        [Other] = 0,
    };
}

/// <summary>One detection, normalized without discarding what else it carried.</summary>
public sealed record Detection(
    string Name,
    string CategoryKey,
    /// <summary>A number, or null when the extension sent something non-numeric.</summary>
    double? Confidence,
    IReadOnlyDictionary<string, object?> Raw)
{
    public object? Get(string field) => Raw.TryGetValue(field, out var value) ? value : null;
}

/// <summary>
/// A value you can always read, present or not.
/// </summary>
/// <remarks>
/// <see cref="Available"/> is the field that matters. A false from
/// <see cref="IsAntibot"/> means "no anti-bot detection was reported", which is
/// <em>not</em> "this page is clean" when <see cref="Available"/> is false.
/// </remarks>
public sealed class DetectionResult
{
    public const string ReasonUnavailable = "unavailable";

    public required bool Available { get; init; }
    public string? Reason { get; init; }
    public string? Url { get; init; }
    public string? Timestamp { get; init; }
    public bool FromCache { get; init; }

    /// <summary>Detections that actually arrived.</summary>
    public required int Total { get; init; }

    /// <summary>What the extension claimed; differs from Total only if trimmed.</summary>
    public required int ReportedTotal { get; init; }

    public required IReadOnlyDictionary<string, int> Categories { get; init; }
    public required IReadOnlyList<Detection> Detections { get; init; }

    public bool HasCategory(string key) =>
        Available && Categories.TryGetValue(key.Trim().ToLowerInvariant(), out var count) && count > 0;

    public bool IsAntibot => HasCategory(Detector.Categories.Antibot);
    public bool IsCaptcha => HasCategory(Detector.Categories.Captcha);
    public bool IsFingerprinted => HasCategory(Detector.Categories.Fingerprint);

    /// <summary>True when anything at all was detected, in any category.</summary>
    public bool IsProtected => Available && Total > 0;

    public IReadOnlyList<Detection> OfCategory(string key)
    {
        var wanted = key.Trim().ToLowerInvariant();
        return Detections.Where(d => d.CategoryKey == wanted).ToList();
    }

    /// <summary>Returned when nothing was heard: no extension, signals off, or wait expired.</summary>
    public static DetectionResult Unavailable(string reason = ReasonUnavailable) => new()
    {
        Available = false,
        Reason = reason,
        Total = 0,
        ReportedTotal = 0,
        Categories = Detector.Categories.EmptyCounts(),
        Detections = Array.Empty<Detection>(),
    };

    /// <summary>Turn the raw detail the page reported into a result.</summary>
    public static DetectionResult Build(bool available, IReadOnlyDictionary<string, object?>? detail)
    {
        if (detail is null)
        {
            return Unavailable();
        }

        var detections = new List<Detection>();
        var categories = Detector.Categories.EmptyCounts();

        if (detail.TryGetValue("detections", out var rawList) && rawList is IEnumerable<object?> entries)
        {
            foreach (var entry in entries)
            {
                var detection = Normalize(entry);
                detections.Add(detection);
                categories[detection.CategoryKey]++;
            }
        }

        // detectionCount is the extension's claim; Count is what arrived.
        var reported = detections.Count;
        if (detail.TryGetValue("detectionCount", out var claimed) && claimed is not null
            && double.TryParse(Convert.ToString(claimed, System.Globalization.CultureInfo.InvariantCulture),
                System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out var number))
        {
            reported = (int)number;
        }

        return new DetectionResult
        {
            Available = available,
            Url = Text(detail, "url"),
            Timestamp = Text(detail, "timestamp"),
            FromCache = detail.TryGetValue("fromCache", out var cached) && cached is true,
            Total = detections.Count,
            ReportedTotal = reported,
            Categories = categories,
            Detections = detections,
        };
    }

    private static string? Text(IReadOnlyDictionary<string, object?> source, string key) =>
        source.TryGetValue(key, out var value) ? value as string : null;

    private static Detection Normalize(object? source)
    {
        var payload = source as IReadOnlyDictionary<string, object?>
                      ?? new Dictionary<string, object?>();

        var name = payload.TryGetValue("name", out var direct) ? direct as string : null;
        var nested = payload.TryGetValue("detector", out var shape)
            ? shape as IReadOnlyDictionary<string, object?>
            : null;

        if (string.IsNullOrEmpty(name))
        {
            name = nested is not null && nested.TryGetValue("name", out var inner)
                ? inner as string
                : shape as string;
        }
        if (string.IsNullOrEmpty(name))
        {
            name = "Unknown";
        }

        var category = payload.TryGetValue("category", out var raw) ? raw as string : null;
        if (category is null && nested is not null && nested.TryGetValue("category", out var innerCategory))
        {
            category = innerCategory as string;
        }

        // A non-numeric confidence becomes null, never a bogus number.
        double? confidence = null;
        if (payload.TryGetValue("confidence", out var value) && value is not null
            && value is not string && double.TryParse(
                Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture),
                System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out var parsed))
        {
            confidence = parsed;
        }

        return new Detection(name!, Detector.Categories.KeyOf(category), confidence, payload);
    }
}
