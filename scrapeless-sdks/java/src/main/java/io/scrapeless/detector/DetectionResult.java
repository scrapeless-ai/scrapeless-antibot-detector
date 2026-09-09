package io.scrapeless.detector;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * A value you can always read, present or not.
 *
 * <p>{@link #available()} is the field that matters. A {@code false} from
 * {@link #isAntibot()} means "no anti-bot detection was reported", which is
 * <em>not</em> "this page is clean" when {@code available} is false.
 */
public final class DetectionResult {
    public static final String REASON_UNAVAILABLE = "unavailable";

    private final boolean available;
    private final String reason;
    private final String url;
    private final String timestamp;
    private final boolean fromCache;
    private final int total;
    private final int reportedTotal;
    private final Map<String, Integer> categories;
    private final List<Detection> detections;

    private DetectionResult(boolean available, String reason, String url, String timestamp,
            boolean fromCache, int total, int reportedTotal,
            Map<String, Integer> categories, List<Detection> detections) {
        this.available = available;
        this.reason = reason;
        this.url = url;
        this.timestamp = timestamp;
        this.fromCache = fromCache;
        this.total = total;
        this.reportedTotal = reportedTotal;
        this.categories = Collections.unmodifiableMap(categories);
        this.detections = Collections.unmodifiableList(detections);
    }

    public boolean available() { return available; }
    public String reason() { return reason; }
    public String url() { return url; }
    public String timestamp() { return timestamp; }
    public boolean fromCache() { return fromCache; }

    /** Detections that actually arrived. */
    public int total() { return total; }

    /** What the extension claimed; differs from {@link #total()} only if trimmed. */
    public int reportedTotal() { return reportedTotal; }

    public Map<String, Integer> categories() { return categories; }
    public List<Detection> detections() { return detections; }

    public boolean hasCategory(String key) {
        return available && categories.getOrDefault(key.trim().toLowerCase(Locale.ROOT), 0) > 0;
    }

    public boolean isAntibot() { return hasCategory(Categories.ANTIBOT); }
    public boolean isCaptcha() { return hasCategory(Categories.CAPTCHA); }
    public boolean isFingerprinted() { return hasCategory(Categories.FINGERPRINT); }

    /** True when anything at all was detected, in any category. */
    public boolean isProtected() { return available && total > 0; }

    public List<Detection> ofCategory(String key) {
        String wanted = key.trim().toLowerCase(Locale.ROOT);
        List<Detection> found = new ArrayList<>();
        for (Detection detection : detections) {
            if (detection.categoryKey().equals(wanted)) {
                found.add(detection);
            }
        }
        return found;
    }

    /** Returned when nothing was heard: no extension, signals off, or wait expired. */
    public static DetectionResult unavailable(String reason) {
        return new DetectionResult(false, reason, null, null, false, 0, 0,
                Categories.emptyCounts(), List.of());
    }

    /** Turn the raw detail the page reported into a result. */
    @SuppressWarnings("unchecked")
    public static DetectionResult build(boolean available, Map<String, Object> detail) {
        if (detail == null) {
            return unavailable(REASON_UNAVAILABLE);
        }

        List<Detection> detections = new ArrayList<>();
        Map<String, Integer> categories = Categories.emptyCounts();

        if (detail.get("detections") instanceof List<?> entries) {
            for (Object entry : entries) {
                Detection detection = Detection.normalize(entry);
                detections.add(detection);
                categories.merge(detection.categoryKey(), 1, Integer::sum);
            }
        }

        // detectionCount is the extension's claim; size() is what arrived.
        int reported = detail.get("detectionCount") instanceof Number number
                ? number.intValue()
                : detections.size();

        return new DetectionResult(
                available,
                null,
                detail.get("url") instanceof String text ? text : null,
                detail.get("timestamp") instanceof String text ? text : null,
                Boolean.TRUE.equals(detail.get("fromCache")),
                detections.size(),
                reported,
                categories,
                detections);
    }
}
