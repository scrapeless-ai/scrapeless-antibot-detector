"""Tests for the Python SDK.

The browser is faked at the one seam that touches it: page.evaluate(). That
covers the whole public surface without Chrome, and keeps these runnable in CI
on a machine with no display. The bridge JavaScript itself is exercised by the
live test in README ("Verifying against a real browser").
"""

import json
import pathlib
import unittest

from scrapeless_detector import (
    Result,
    ScrapelessDetector,
    SyncScrapelessDetector,
    category_key_of,
)
from scrapeless_detector._bridge import AWAIT_DETECTION, INSTALLED, READY, SNAPSHOT
from scrapeless_detector._core import build_result


SDK_ROOT = pathlib.Path(__file__).resolve().parent.parent
VECTORS = json.loads((SDK_ROOT / "conformance.json").read_text(encoding="utf-8"))


class FakePage:
    """Answers exactly what the real bridge would, for a scripted detection."""

    def __init__(self, detection=None, ready=None, installed=True):
        self._detection = detection
        self._ready = ready
        self._installed = installed
        self.init_scripts = []

    def add_init_script(self, script):
        self.init_scripts.append(script)

    def evaluate(self, expression, arg=None):
        if expression == INSTALLED:
            return self._installed
        if expression == SNAPSHOT:
            return self._detection
        if expression == READY:
            return self._ready
        if expression == AWAIT_DETECTION:
            return self._detection  # None models the bounded wait expiring
        return None


class AsyncFakePage(FakePage):
    async def add_init_script(self, script):
        super().add_init_script(script)

    async def evaluate(self, expression, arg=None):
        return FakePage.evaluate(self, expression, arg)


ANTIBOT = {
    "url": "https://example.test/checkout",
    "detectionCount": 3,
    "detections": [
        {"name": "Cloudflare Bot Management", "category": "Anti-Bot", "confidence": 98},
        {"name": "hCaptcha", "category": "CAPTCHA"},
        {"name": "Canvas", "category": "Fingerprint"},
    ],
}


class CategoryFolding(unittest.TestCase):
    def test_every_spelling_matches_the_shared_vectors(self):
        # ../conformance.json is the shared truth for all nine SDKs.
        for vector in VECTORS["categoryFold"]:
            with self.subTest(raw=vector["raw"]):
                self.assertEqual(
                    category_key_of({"category": vector["raw"]}), vector["expect"]
                )

    def test_nested_detector_shape(self):
        self.assertEqual(category_key_of({"detector": {"category": "Anti-Bot"}}), "antibot")

    def test_non_dict_input_is_other_not_a_crash(self):
        self.assertEqual(category_key_of(None), "other")
        self.assertEqual(category_key_of("Anti-Bot"), "other")


class ResultShape(unittest.TestCase):
    def test_counts_each_category_independently(self):
        result = build_result(True, ANTIBOT)
        self.assertEqual(
            result.categories, {"antibot": 1, "captcha": 1, "fingerprint": 1, "other": 0}
        )
        self.assertTrue(result.is_antibot)
        self.assertTrue(result.is_captcha)
        self.assertTrue(result.is_fingerprinted)
        self.assertTrue(result.is_protected)

    def test_clean_page_is_available_but_empty(self):
        result = build_result(True, {"url": "https://clean.test/", "detections": []})
        self.assertTrue(result.available)
        self.assertEqual(result.total, 0)
        self.assertFalse(result.is_antibot)
        self.assertFalse(result.is_protected)

    def test_reported_total_keeps_the_claim_separate(self):
        result = build_result(True, {"detectionCount": 9, "detections": [{"name": "Akamai"}]})
        self.assertEqual(result.total, 1, "total counts what actually arrived")
        self.assertEqual(result.reported_total, 9, "reported_total keeps the claim")

    def test_malformed_detections_are_normalized_not_thrown_on(self):
        result = build_result(
            True, {"detections": [None, {}, {"name": "X", "confidence": "not a number"}]}
        )
        self.assertEqual(result.total, 3)
        self.assertEqual(result.detections[0].name, "Unknown")
        self.assertEqual(result.detections[0].category_key, "other")
        self.assertIsNone(
            result.detections[2].confidence, "a non-numeric confidence becomes None, not NaN"
        )

    def test_original_fields_are_preserved(self):
        result = build_result(True, {"detections": [{"name": "Akamai", "vendorNote": "keep me"}]})
        self.assertEqual(result.detections[0].get("vendorNote"), "keep me")
        self.assertEqual(result.detections[0]["name"], "Akamai")

    def test_of_category_filters(self):
        names = [d.name for d in build_result(True, ANTIBOT).of_category("antibot")]
        self.assertEqual(names, ["Cloudflare Bot Management"])

    def test_unavailable_is_not_clean(self):
        result = build_result(False, None, "unavailable")
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "unavailable")
        # False here must not be read as "clean" — available says which it is.
        self.assertFalse(result.is_antibot)
        self.assertFalse(result.is_protected)


class SyncSurface(unittest.TestCase):
    def test_detect_returns_the_result(self):
        detector = SyncScrapelessDetector.attach(FakePage(ANTIBOT))
        result = detector.detect()
        self.assertIsInstance(result, Result)
        self.assertTrue(result.available)
        self.assertTrue(detector.is_antibot())

    def test_attach_installs_the_init_script(self):
        page = FakePage(ANTIBOT)
        SyncScrapelessDetector.attach(page)
        self.assertEqual(len(page.init_scripts), 1, "listener must go in at document_start")
        self.assertIn("__scrapelessSdkBridge", page.init_scripts[0])

    def test_no_extension_resolves_unavailable_rather_than_hanging(self):
        detector = SyncScrapelessDetector.attach(FakePage(installed=False))
        result = detector.detect()
        self.assertFalse(result.available)
        self.assertEqual(result.reason, "unavailable")
        self.assertFalse(detector.is_antibot())
        self.assertEqual(detector.ready(), {"available": False, "version": None})
        self.assertIsNone(detector.snapshot())

    def test_bounded_wait_expiring_is_unavailable(self):
        # Bridge installed, but no detection ever arrived: page signals is off.
        detector = SyncScrapelessDetector.attach(FakePage(detection=None))
        self.assertFalse(detector.detect().available)

    def test_ready_reports_the_announcement(self):
        detector = SyncScrapelessDetector.attach(FakePage(ANTIBOT, ready={"version": "1.0.1"}))
        self.assertEqual(detector.ready(), {"available": True, "version": "1.0.1"})

    def test_snapshot_never_waits(self):
        self.assertEqual(SyncScrapelessDetector.attach(FakePage(ANTIBOT)).snapshot().total, 3)


class AsyncSurface(unittest.IsolatedAsyncioTestCase):
    async def test_detect_and_helpers(self):
        detector = await ScrapelessDetector.attach(AsyncFakePage(ANTIBOT))
        result = await detector.detect()
        self.assertTrue(result.available)
        self.assertTrue(await detector.is_antibot())
        self.assertTrue(await detector.is_captcha())
        self.assertTrue(await detector.is_fingerprinted())
        self.assertTrue(await detector.is_protected())

    async def test_no_extension(self):
        detector = await ScrapelessDetector.attach(AsyncFakePage(installed=False))
        result = await detector.detect()
        self.assertFalse(result.available)
        self.assertFalse(await detector.is_antibot())
        self.assertIsNone(await detector.snapshot())

    async def test_parity_with_sync(self):
        # The two classes must not drift; same input, same result.
        a = await (await ScrapelessDetector.attach(AsyncFakePage(ANTIBOT))).detect()
        s = SyncScrapelessDetector.attach(FakePage(ANTIBOT)).detect()
        self.assertEqual(a, s)


class SharedConformance(unittest.TestCase):
    """Every SDK asserts these same vectors, so a fold that drifts fails here."""

    def test_result_shape_matches_every_shared_vector(self):
        for vector in VECTORS["results"]:
            with self.subTest(case=vector["name"]):
                result = build_result(True, vector["detail"])
                want = vector["expect"]
                self.assertEqual(result.available, want["available"])
                self.assertEqual(result.total, want["total"])
                self.assertEqual(result.reported_total, want["reportedTotal"])
                self.assertEqual(result.categories, want["categories"])
                self.assertEqual(result.is_antibot, want["isAntibot"])
                self.assertEqual(result.is_protected, want["isProtected"])
                if "firstName" in want:
                    self.assertEqual(result.detections[0].name, want["firstName"])
                    self.assertEqual(
                        result.detections[0].category_key, want["firstCategoryKey"]
                    )
                if want.get("lastConfidenceIsNull"):
                    self.assertIsNone(result.detections[-1].confidence)

    def test_unavailable_matches_the_shared_vector(self):
        want = VECTORS["unavailable"]["expect"]
        result = build_result(False, None, "unavailable")
        self.assertEqual(result.available, want["available"])
        self.assertEqual(result.reason, want["reason"])
        self.assertEqual(result.total, want["total"])
        # false here must never be read as "clean" — available says which it is.
        self.assertEqual(result.is_antibot, want["isAntibot"])
        self.assertEqual(result.is_protected, want["isProtected"])

    def test_embedded_bridge_matches_canonical(self):
        from scrapeless_detector._bridge import INIT_SCRIPT

        canonical = (SDK_ROOT / "bridge.js").read_text(encoding="utf-8").strip()
        self.assertEqual(
            INIT_SCRIPT.strip(),
            canonical,
            "_bridge.py has drifted from scrapeless-sdks/bridge.js",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
