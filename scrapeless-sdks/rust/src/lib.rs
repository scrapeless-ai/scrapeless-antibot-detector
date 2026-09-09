//! Scrapeless Anti-Bot Detector — Rust SDK.
//!
//! Rust cannot hear the extension directly. The extension talks to the *page*,
//! by dispatching `CustomEvent`s at `window`, so reaching it means driving a
//! real Chrome with the extension loaded and reading the result back out of the
//! document. The `browser` feature does that with chromiumoxide; this module is
//! the part that must stay identical across every SDK.
//!
//! `available` is the field that matters. A `false` from [`Result::is_antibot`]
//! means "no anti-bot detection was reported", which is **not** "this page is
//! clean" when `available` is false.

use serde_json::Value;

pub mod bridge;

pub const CATEGORY_ANTIBOT: &str = "antibot";
pub const CATEGORY_CAPTCHA: &str = "captcha";
pub const CATEGORY_FINGERPRINT: &str = "fingerprint";
pub const CATEGORY_OTHER: &str = "other";

pub const REASON_UNAVAILABLE: &str = "unavailable";

/// Default bound on every wait, in milliseconds.
pub const DEFAULT_TIMEOUT_MS: u64 = 8000;

/// Fold any category spelling to one of the four keys.
///
/// The bundled detectors ship the category in four different spellings —
/// `Anti-Bot`, `ANTIBOT`, `CAPTCHA`, `Fingerprint` — so comparing against any
/// single one matches almost nothing. This mirrors the extension's own fold; if
/// they disagree, these buckets disagree with the badge the user is looking at.
pub fn category_key_of(raw: &str) -> &'static str {
    let folded: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .filter(|symbol| symbol.is_ascii_alphabetic())
        .collect();

    match folded.as_str() {
        "antibot" | "waf" => CATEGORY_ANTIBOT,
        "captcha" => CATEGORY_CAPTCHA,
        "fingerprint" | "fingerprinting" => CATEGORY_FINGERPRINT,
        _ => CATEGORY_OTHER,
    }
}

/// Read the category out of either shape the extension emits.
fn category_of_detection(source: &Value) -> &'static str {
    let direct = source.get("category").and_then(Value::as_str);
    let nested = source
        .get("detector")
        .and_then(|d| d.get("category"))
        .and_then(Value::as_str);
    category_key_of(direct.or(nested).unwrap_or(""))
}

/// One detection, normalized without discarding what else it carried.
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub name: String,
    pub category_key: &'static str,
    /// A number, or `None` when the extension sent something non-numeric.
    pub confidence: Option<f64>,
    /// Everything the extension sent, untouched.
    pub raw: Value,
}

impl Detection {
    fn normalize(source: &Value) -> Self {
        let name = source
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| source.get("detector").and_then(|d| d.get("name")).and_then(Value::as_str))
            .or_else(|| source.get("detector").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .unwrap_or("Unknown")
            .to_string();

        Detection {
            name,
            category_key: category_of_detection(source),
            // A non-numeric confidence becomes None, never a bogus number.
            confidence: source.get("confidence").and_then(Value::as_f64),
            raw: source.clone(),
        }
    }
}

/// Counts per category. Always carries all four keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryCounts {
    pub antibot: usize,
    pub captcha: usize,
    pub fingerprint: usize,
    pub other: usize,
}

impl CategoryCounts {
    fn empty() -> Self {
        CategoryCounts { antibot: 0, captcha: 0, fingerprint: 0, other: 0 }
    }

    pub fn get(&self, key: &str) -> usize {
        match key.trim().to_lowercase().as_str() {
            "antibot" => self.antibot,
            "captcha" => self.captcha,
            "fingerprint" => self.fingerprint,
            "other" => self.other,
            _ => 0,
        }
    }

    fn increment(&mut self, key: &str) {
        match key {
            "antibot" => self.antibot += 1,
            "captcha" => self.captcha += 1,
            "fingerprint" => self.fingerprint += 1,
            _ => self.other += 1,
        }
    }
}

/// A value you can always read, present or not.
#[derive(Debug, Clone, PartialEq)]
pub struct DetectionResult {
    /// Was the extension actually heard from? Check this before trusting a false.
    pub available: bool,
    pub reason: Option<String>,
    pub url: Option<String>,
    pub timestamp: Option<String>,
    pub from_cache: bool,
    /// Detections that actually arrived.
    pub total: usize,
    /// What the extension claimed; differs only if a payload was trimmed.
    pub reported_total: usize,
    pub categories: CategoryCounts,
    pub detections: Vec<Detection>,
}

impl DetectionResult {
    pub fn has_category(&self, key: &str) -> bool {
        self.available && self.categories.get(key) > 0
    }

    pub fn is_antibot(&self) -> bool { self.has_category(CATEGORY_ANTIBOT) }
    pub fn is_captcha(&self) -> bool { self.has_category(CATEGORY_CAPTCHA) }
    pub fn is_fingerprinted(&self) -> bool { self.has_category(CATEGORY_FINGERPRINT) }

    /// True when anything at all was detected, in any category.
    pub fn is_protected(&self) -> bool { self.available && self.total > 0 }

    pub fn of_category(&self, key: &str) -> Vec<&Detection> {
        let wanted = key.trim().to_lowercase();
        self.detections.iter().filter(|d| d.category_key == wanted).collect()
    }

    /// The result returned when nothing was heard: no extension, page signals
    /// off, or the bounded wait ran out.
    pub fn unavailable(reason: &str) -> Self {
        DetectionResult {
            available: false,
            reason: Some(reason.to_string()),
            url: None,
            timestamp: None,
            from_cache: false,
            total: 0,
            reported_total: 0,
            categories: CategoryCounts::empty(),
            detections: Vec::new(),
        }
    }
}

/// Turn the raw detail the page reported into a [`DetectionResult`].
pub fn build_result(available: bool, detail: Option<&Value>) -> DetectionResult {
    let Some(payload) = detail else {
        return DetectionResult::unavailable(REASON_UNAVAILABLE);
    };

    let raw = payload.get("detections").and_then(Value::as_array);
    let mut detections = Vec::new();
    let mut categories = CategoryCounts::empty();

    if let Some(entries) = raw {
        for entry in entries {
            let detection = Detection::normalize(entry);
            categories.increment(detection.category_key);
            detections.push(detection);
        }
    }

    // detectionCount is the extension's claim; len is what arrived.
    let reported = payload
        .get("detectionCount")
        .and_then(Value::as_u64)
        .map(|claimed| claimed as usize)
        .unwrap_or(detections.len());

    DetectionResult {
        available,
        reason: None,
        url: payload.get("url").and_then(Value::as_str).map(str::to_string),
        timestamp: payload.get("timestamp").and_then(Value::as_str).map(str::to_string),
        from_cache: payload.get("fromCache").and_then(Value::as_bool).unwrap_or(false),
        total: detections.len(),
        reported_total: reported,
        categories,
        detections,
    }
}
