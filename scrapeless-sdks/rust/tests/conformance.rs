//! Tests read ../../conformance.json, the shared truth for every SDK, so a fold
//! that drifts here fails here.

use scrapeless_detector::{build_result, bridge, category_key_of, DetectionResult};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read conformance.json"))
        .expect("parse conformance.json")
}

#[test]
fn category_fold_matches_every_shared_vector() {
    for vector in vectors()["categoryFold"].as_array().unwrap() {
        let raw = vector["raw"].as_str().unwrap();
        let expect = vector["expect"].as_str().unwrap();
        assert_eq!(category_key_of(raw), expect, "{:?} should fold to {}", raw, expect);
    }
}

#[test]
fn result_shape_matches_every_shared_vector() {
    for vector in vectors()["results"].as_array().unwrap() {
        let name = vector["name"].as_str().unwrap();
        let result = build_result(true, Some(&vector["detail"]));
        let want = &vector["expect"];

        assert_eq!(result.available, want["available"].as_bool().unwrap(), "{}: available", name);
        assert_eq!(result.total, want["total"].as_u64().unwrap() as usize, "{}: total", name);
        assert_eq!(
            result.reported_total,
            want["reportedTotal"].as_u64().unwrap() as usize,
            "{}: reportedTotal", name
        );
        for key in ["antibot", "captcha", "fingerprint", "other"] {
            assert_eq!(
                result.categories.get(key),
                want["categories"][key].as_u64().unwrap() as usize,
                "{}: categories.{}", name, key
            );
        }
        assert_eq!(result.is_antibot(), want["isAntibot"].as_bool().unwrap(), "{}: isAntibot", name);
        assert_eq!(
            result.is_protected(),
            want["isProtected"].as_bool().unwrap(),
            "{}: isProtected", name
        );

        if let Some(first) = want["firstName"].as_str() {
            assert_eq!(result.detections[0].name, first, "{}: firstName", name);
            assert_eq!(
                result.detections[0].category_key,
                want["firstCategoryKey"].as_str().unwrap(),
                "{}: firstCategoryKey", name
            );
        }
        if want["lastConfidenceIsNull"].as_bool().unwrap_or(false) {
            assert!(
                result.detections.last().unwrap().confidence.is_none(),
                "{}: a non-numeric confidence must be None, not a bogus number", name
            );
        }
    }
}

#[test]
fn unavailable_matches_the_shared_vector_and_is_not_clean() {
    let all = vectors();
    let want = &all["unavailable"]["expect"];
    let result = DetectionResult::unavailable("unavailable");

    assert_eq!(result.available, want["available"].as_bool().unwrap());
    assert_eq!(result.reason.as_deref(), want["reason"].as_str());
    assert_eq!(result.total, want["total"].as_u64().unwrap() as usize);
    // false here must never be read as "clean" — available says which it is.
    assert_eq!(result.is_antibot(), want["isAntibot"].as_bool().unwrap());
    assert_eq!(result.is_protected(), want["isProtected"].as_bool().unwrap());
}

#[test]
fn embedded_bridge_matches_canonical() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../bridge.js");
    let canonical = std::fs::read_to_string(path).expect("read bridge.js");
    assert_eq!(
        bridge::INIT_SCRIPT.trim(),
        canonical.trim(),
        "src/bridge.rs has drifted from scrapeless-sdks/bridge.js"
    );
}

#[test]
fn of_category_filters_and_original_fields_survive() {
    let all = vectors();
    let result = build_result(true, Some(&all["results"][0]["detail"]));
    let antibot = result.of_category("antibot");
    assert_eq!(antibot.len(), 1);
    assert_eq!(antibot[0].name, "Cloudflare Bot Management");

    let kept: Value =
        serde_json::json!({ "detections": [{ "name": "Akamai", "vendorNote": "keep me" }] });
    let result = build_result(true, Some(&kept));
    assert_eq!(result.detections[0].raw["vendorNote"], "keep me");
}
