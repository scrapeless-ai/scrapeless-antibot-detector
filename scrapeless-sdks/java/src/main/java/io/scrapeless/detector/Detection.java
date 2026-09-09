package io.scrapeless.detector;

import java.util.Collections;
import java.util.Map;

/** One detection, normalized without discarding what else it carried. */
public final class Detection {
    private final String name;
    private final String categoryKey;
    private final Double confidence;
    private final Map<String, Object> raw;

    Detection(String name, String categoryKey, Double confidence, Map<String, Object> raw) {
        this.name = name;
        this.categoryKey = categoryKey;
        this.confidence = confidence;
        this.raw = Collections.unmodifiableMap(raw);
    }

    public String name() {
        return name;
    }

    public String categoryKey() {
        return categoryKey;
    }

    /** A number, or null when the extension sent something non-numeric. */
    public Double confidence() {
        return confidence;
    }

    /** Everything the extension sent, untouched. */
    public Map<String, Object> raw() {
        return raw;
    }

    public Object get(String field) {
        return raw.get(field);
    }

    @SuppressWarnings("unchecked")
    static Detection normalize(Object source) {
        Map<String, Object> payload = source instanceof Map
                ? (Map<String, Object>) source
                : Map.of();

        String name = payload.get("name") instanceof String text && !text.isEmpty() ? text : null;
        if (name == null) {
            Object nested = payload.get("detector");
            if (nested instanceof Map<?, ?> shape && shape.get("name") instanceof String text) {
                name = text;
            } else if (nested instanceof String text && !text.isEmpty()) {
                name = text;
            }
        }
        if (name == null || name.isEmpty()) {
            name = "Unknown";
        }

        // A non-numeric confidence becomes null, never a bogus number.
        Double confidence = payload.get("confidence") instanceof Number number
                ? number.doubleValue()
                : null;

        return new Detection(name, Categories.keyOfDetection(payload), confidence, payload);
    }

    @Override
    public String toString() {
        return "Detection[" + name + ", " + categoryKey + ", " + confidence + "]";
    }
}
