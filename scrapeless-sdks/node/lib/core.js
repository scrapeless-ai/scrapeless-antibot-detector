'use strict';

/**
 * Pure result handling — no browser, no Playwright, no I/O.
 *
 * The fold below must agree with every other SDK and with the extension's own
 * FindingTotals. If they drift, these buckets disagree with the badge the user
 * is looking at. ../conformance.json is the shared truth; the tests read it.
 */

const CATEGORY_ANTIBOT = 'antibot';
const CATEGORY_CAPTCHA = 'captcha';
const CATEGORY_FINGERPRINT = 'fingerprint';
const CATEGORY_OTHER = 'other';

const REASON_UNAVAILABLE = 'unavailable';

// The bundled detectors ship the category in four different spellings —
// 'Anti-Bot', 'ANTIBOT', 'CAPTCHA', 'Fingerprint' — so comparing against any
// single one matches almost nothing. Fold, then alias.
const CATEGORY_ALIASES = {
    antibot: CATEGORY_ANTIBOT,
    waf: CATEGORY_ANTIBOT,
    captcha: CATEGORY_CAPTCHA,
    fingerprint: CATEGORY_FINGERPRINT,
    fingerprinting: CATEGORY_FINGERPRINT
};

function categoryKeyOf(detection) {
    let raw = '';
    if (detection && typeof detection === 'object') {
        if (detection.category != null) {
            raw = detection.category;
        } else if (detection.detector && typeof detection.detector === 'object'
                   && detection.detector.category != null) {
            raw = detection.detector.category;
        }
    }
    const folded = String(raw).trim().toLowerCase().replace(/[^a-z]/g, '');
    return Object.prototype.hasOwnProperty.call(CATEGORY_ALIASES, folded)
        ? CATEGORY_ALIASES[folded]
        : CATEGORY_OTHER;
}

function emptyCounts() {
    return { antibot: 0, captcha: 0, fingerprint: 0, other: 0 };
}

/** Normalize one detection without discarding whatever else it carried. */
function normalizeDetection(source) {
    const payload = (source && typeof source === 'object') ? source : {};

    let name = payload.name;
    if (!name && payload.detector) {
        name = typeof payload.detector === 'object' ? payload.detector.name : payload.detector;
    }
    if (!name) { name = 'Unknown'; }

    const confidence = Number(payload.confidence);
    const normalized = Object.assign({}, payload);
    normalized.name = String(name);
    normalized.categoryKey = categoryKeyOf(payload);
    // A non-numeric confidence becomes null, never NaN.
    normalized.confidence = Number.isFinite(confidence) ? confidence : null;
    return normalized;
}

/** A result the caller can always destructure, present or not. */
function buildResult(available, detail, reason) {
    const payload = (detail && typeof detail === 'object') ? detail : {};
    const raw = Array.isArray(payload.detections) ? payload.detections : [];
    const detections = raw.map(normalizeDetection);

    const categories = emptyCounts();
    for (const entry of detections) { categories[entry.categoryKey] += 1; }

    // detectionCount is what the extension claimed; length is what arrived.
    // They differ only if a payload was trimmed, so keep both.
    const claimed = Number(payload.detectionCount);

    return {
        available: available === true,
        reason: reason || null,
        url: payload.url || null,
        timestamp: payload.timestamp || null,
        fromCache: payload.fromCache === true,
        total: detections.length,
        reportedTotal: Number.isFinite(claimed) ? claimed : detections.length,
        categories,
        detections,
        hasCategory(key) {
            return this.available && (this.categories[String(key).trim().toLowerCase()] || 0) > 0;
        },
        get isAntibot() { return this.hasCategory(CATEGORY_ANTIBOT); },
        get isCaptcha() { return this.hasCategory(CATEGORY_CAPTCHA); },
        get isFingerprinted() { return this.hasCategory(CATEGORY_FINGERPRINT); },
        get isProtected() { return this.available && this.total > 0; },
        ofCategory(key) {
            const wanted = String(key).trim().toLowerCase();
            return this.detections.filter((d) => d.categoryKey === wanted);
        }
    };
}

function unavailable(reason) {
    return buildResult(false, null, reason || REASON_UNAVAILABLE);
}

module.exports = {
    CATEGORY_ANTIBOT,
    CATEGORY_CAPTCHA,
    CATEGORY_FINGERPRINT,
    CATEGORY_OTHER,
    REASON_UNAVAILABLE,
    categoryKeyOf,
    buildResult,
    unavailable
};
