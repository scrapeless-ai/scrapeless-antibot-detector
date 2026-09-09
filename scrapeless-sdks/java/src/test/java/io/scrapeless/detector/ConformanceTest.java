package io.scrapeless.detector;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * Reads ../../conformance.json, the shared truth for every SDK, so a fold that
 * drifts here fails here.
 *
 * <p>Plain assertions and a {@code main}, so it runs with nothing but a JDK:
 * {@code javac ... && java io.scrapeless.detector.ConformanceTest}.
 */
public final class ConformanceTest {
    private static int passed;
    private static int failed;

    private static void check(boolean condition, String label) {
        if (condition) {
            passed++;
            return;
        }
        failed++;
        System.err.println("  FAIL " + label);
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args.length > 0 ? args[0] : "../..");
        Map<String, Object> vectors =
                (Map<String, Object>) MiniJson.parse(Files.readString(root.resolve("conformance.json")));

        for (Object entry : (List<Object>) vectors.get("categoryFold")) {
            Map<String, Object> vector = (Map<String, Object>) entry;
            String raw = (String) vector.get("raw");
            String expect = (String) vector.get("expect");
            check(Categories.keyOf(raw).equals(expect), "fold \"" + raw + "\" -> " + expect);
        }

        for (Object entry : (List<Object>) vectors.get("results")) {
            Map<String, Object> vector = (Map<String, Object>) entry;
            String name = (String) vector.get("name");
            Map<String, Object> want = (Map<String, Object>) vector.get("expect");
            DetectionResult result =
                    DetectionResult.build(true, (Map<String, Object>) vector.get("detail"));

            check(result.available() == (Boolean) want.get("available"), name + ": available");
            check(result.total() == ((Number) want.get("total")).intValue(), name + ": total");
            check(result.reportedTotal() == ((Number) want.get("reportedTotal")).intValue(),
                    name + ": reportedTotal");
            Map<String, Object> counts = (Map<String, Object>) want.get("categories");
            for (Map.Entry<String, Object> bucket : counts.entrySet()) {
                check(result.categories().get(bucket.getKey())
                                .equals(((Number) bucket.getValue()).intValue()),
                        name + ": categories." + bucket.getKey());
            }
            check(result.isAntibot() == (Boolean) want.get("isAntibot"), name + ": isAntibot");
            check(result.isProtected() == (Boolean) want.get("isProtected"), name + ": isProtected");

            if (want.get("firstName") instanceof String first) {
                check(result.detections().get(0).name().equals(first), name + ": firstName");
                check(result.detections().get(0).categoryKey().equals(want.get("firstCategoryKey")),
                        name + ": firstCategoryKey");
            }
            if (Boolean.TRUE.equals(want.get("lastConfidenceIsNull"))) {
                check(result.detections().get(result.detections().size() - 1).confidence() == null,
                        name + ": a non-numeric confidence must be null");
            }
        }

        Map<String, Object> want =
                (Map<String, Object>) ((Map<String, Object>) vectors.get("unavailable")).get("expect");
        DetectionResult missing = DetectionResult.unavailable(DetectionResult.REASON_UNAVAILABLE);
        check(missing.available() == (Boolean) want.get("available"), "unavailable: available");
        check(missing.reason().equals(want.get("reason")), "unavailable: reason");
        check(missing.total() == ((Number) want.get("total")).intValue(), "unavailable: total");
        // false here must never be read as "clean" — available says which it is.
        check(missing.isAntibot() == (Boolean) want.get("isAntibot"), "unavailable: isAntibot");
        check(missing.isProtected() == (Boolean) want.get("isProtected"), "unavailable: isProtected");

        String canonical = Files.readString(root.resolve("bridge.js")).trim();
        check(Bridge.INIT_SCRIPT.trim().equals(canonical),
                "Bridge.java matches scrapeless-sdks/bridge.js");

        Map<String, Object> sample =
                (Map<String, Object>) ((Map<String, Object>) ((List<Object>) vectors.get("results")).get(0))
                        .get("detail");
        DetectionResult result = DetectionResult.build(true, sample);
        check(result.ofCategory("antibot").size() == 1, "ofCategory filters to one bucket");
        check(result.ofCategory("antibot").get(0).name().equals("Cloudflare Bot Management"),
                "ofCategory returns the right one");

        Map<String, Object> kept = Map.of("detections",
                List.of(Map.of("name", "Akamai", "vendorNote", "keep me")));
        check("keep me".equals(DetectionResult.build(true, kept).detections().get(0).get("vendorNote")),
                "original fields survive");

        check(Categories.keyOfDetection(Map.of("detector", Map.of("category", "Anti-Bot")))
                .equals("antibot"), "nested detector shape");
        check(Categories.keyOfDetection(null).equals("other"), "null folds to other");

        System.out.printf("%n  %d passed, %d failed%n", passed, failed);
        System.exit(failed > 0 ? 1 : 0);
    }
}
