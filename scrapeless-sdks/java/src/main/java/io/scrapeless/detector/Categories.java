package io.scrapeless.detector;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Category folding, identical to every other Scrapeless SDK.
 *
 * <p>The bundled detectors ship the category in four different spellings —
 * {@code Anti-Bot}, {@code ANTIBOT}, {@code CAPTCHA}, {@code Fingerprint} — so
 * comparing against any single one matches almost nothing. Fold, then alias. If
 * this drifts from the extension's own fold, these buckets disagree with the
 * badge the user is looking at and nothing would notice.
 */
public final class Categories {
    public static final String ANTIBOT = "antibot";
    public static final String CAPTCHA = "captcha";
    public static final String FINGERPRINT = "fingerprint";
    public static final String OTHER = "other";

    private static final Map<String, String> ALIASES = Map.of(
            "antibot", ANTIBOT,
            "waf", ANTIBOT,
            "captcha", CAPTCHA,
            "fingerprint", FINGERPRINT,
            "fingerprinting", FINGERPRINT);

    private Categories() {
    }

    /** Fold any category spelling to one of the four keys. */
    public static String keyOf(String raw) {
        if (raw == null) {
            return OTHER;
        }
        StringBuilder folded = new StringBuilder();
        for (char symbol : raw.trim().toLowerCase().toCharArray()) {
            if (symbol >= 'a' && symbol <= 'z') {
                folded.append(symbol);
            }
        }
        return ALIASES.getOrDefault(folded.toString(), OTHER);
    }

    /** Read the category out of either shape the extension emits. */
    @SuppressWarnings("unchecked")
    public static String keyOfDetection(Object source) {
        if (!(source instanceof Map)) {
            return OTHER;
        }
        Map<String, Object> payload = (Map<String, Object>) source;
        Object direct = payload.get("category");
        if (direct instanceof String text) {
            return keyOf(text);
        }
        if (payload.get("detector") instanceof Map<?, ?> nested
                && nested.get("category") instanceof String text) {
            return keyOf(text);
        }
        return OTHER;
    }

    /** Counts carrying all four keys, always. */
    public static Map<String, Integer> emptyCounts() {
        Map<String, Integer> counts = new LinkedHashMap<>();
        counts.put(ANTIBOT, 0);
        counts.put(CAPTCHA, 0);
        counts.put(FINGERPRINT, 0);
        counts.put(OTHER, 0);
        return counts;
    }
}
