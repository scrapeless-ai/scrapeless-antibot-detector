"""Pure result handling — no browser, no Playwright, no I/O.

Everything here is a direct port of scrapeless-sdks/browser/scrapeless-detector.js.
The two must agree: if this folds a category differently from the extension, the
SDK's buckets disagree with the badge the user is looking at, and nothing in
either codebase would notice.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

EVENTS = (
    "ready",
    "onStart",
    "onProgress",
    "onHooksComplete",
    "onWindowPropsComplete",
    "onDetection",
    "onError",
)

DEFAULT_TIMEOUT_MS = 8000

UNAVAILABLE = "unavailable"
DESTROYED = "destroyed"

# The bundled detectors ship the category in four different spellings —
# 'Anti-Bot', 'ANTIBOT', 'CAPTCHA', 'Fingerprint' — so an equality check against
# any single one matches almost nothing. Fold, then alias.
_CATEGORY_ALIASES = {
    "antibot": "antibot",
    "waf": "antibot",
    "captcha": "captcha",
    "fingerprint": "fingerprint",
    "fingerprinting": "fingerprint",
}


def category_key_of(detection: Any) -> str:
    """Fold any category spelling to one of antibot/captcha/fingerprint/other."""
    raw = ""
    if isinstance(detection, dict):
        if detection.get("category") is not None:
            raw = detection["category"]
        else:
            nested = detection.get("detector")
            if isinstance(nested, dict) and nested.get("category") is not None:
                raw = nested["category"]
            elif nested is not None and not isinstance(nested, dict):
                raw = ""
    folded = "".join(ch for ch in str(raw).strip().lower() if ch.isascii() and ch.isalpha())
    return _CATEGORY_ALIASES.get(folded, "other")


def _empty_counts() -> Dict[str, int]:
    return {"antibot": 0, "captcha": 0, "fingerprint": 0, "other": 0}


@dataclass(frozen=True)
class Detection:
    """One detection, normalized without discarding what else it carried."""

    name: str
    category_key: str
    confidence: Optional[float]
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


def _normalize_detection(source: Any) -> Detection:
    payload = source if isinstance(source, dict) else {}

    name = payload.get("name")
    if not name:
        nested = payload.get("detector")
        if isinstance(nested, dict):
            name = nested.get("name")
        elif isinstance(nested, str):
            name = nested
    if not name:
        name = "Unknown"

    try:
        confidence: Optional[float] = float(payload.get("confidence"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        confidence = None
    else:
        # Mirror Number.isFinite: NaN and infinities become None, never a bogus number.
        if confidence != confidence or confidence in (float("inf"), float("-inf")):
            confidence = None

    return Detection(
        name=str(name),
        category_key=category_key_of(payload),
        confidence=confidence,
        raw=dict(payload),
    )


@dataclass(frozen=True)
class Result:
    """A result you can always destructure, present or not.

    ``available`` is the field that matters. ``False`` from :attr:`is_antibot`
    means "no anti-bot detection was reported", which is NOT the same as "this
    page is clean" when ``available`` is False — see the README.
    """

    available: bool
    reason: Optional[str]
    url: Optional[str]
    timestamp: Optional[str]
    from_cache: bool
    total: int
    reported_total: int
    categories: Dict[str, int]
    detections: List[Detection]

    def has_category(self, key: str) -> bool:
        return self.available and self.categories.get(str(key).strip().lower(), 0) > 0

    @property
    def is_antibot(self) -> bool:
        return self.has_category("antibot")

    @property
    def is_captcha(self) -> bool:
        return self.has_category("captcha")

    @property
    def is_fingerprinted(self) -> bool:
        return self.has_category("fingerprint")

    @property
    def is_protected(self) -> bool:
        """True when anything at all was detected, in any category."""
        return self.available and self.total > 0

    def of_category(self, key: str) -> List[Detection]:
        wanted = str(key).strip().lower()
        return [d for d in self.detections if d.category_key == wanted]


def build_result(available: bool, detail: Any, reason: Optional[str] = None) -> Result:
    payload = detail if isinstance(detail, dict) else {}
    raw = payload.get("detections")
    detections = [_normalize_detection(d) for d in raw] if isinstance(raw, list) else []

    categories = _empty_counts()
    for entry in detections:
        categories[entry.category_key] += 1

    # detectionCount is what the extension reported; len() is what actually
    # arrived. They can disagree if a payload was trimmed, so keep the honest
    # count and expose the claim separately.
    try:
        reported = int(payload.get("detectionCount"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        reported = len(detections)

    return Result(
        available=available is True,
        reason=reason,
        url=payload.get("url"),
        timestamp=payload.get("timestamp"),
        from_cache=payload.get("fromCache") is True,
        total=len(detections),
        reported_total=reported,
        categories=categories,
        detections=detections,
    )


def unavailable(reason: str = UNAVAILABLE) -> Result:
    return build_result(False, None, reason)
