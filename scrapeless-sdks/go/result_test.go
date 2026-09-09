package scrapeless

import "testing"

// The same vectors the Python and browser SDKs assert. If the three ever
// disagree, the SDKs bucket detections differently from the badge the user is
// looking at, and nothing in either codebase would notice.
func TestCategoryKeyOfEverySpellingTheDetectorsShip(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"Anti-Bot", CategoryAntibot},
		{"ANTIBOT", CategoryAntibot},
		{"anti bot", CategoryAntibot},
		{"WAF", CategoryAntibot},
		{"CAPTCHA", CategoryCaptcha},
		{"Captcha", CategoryCaptcha},
		{"Fingerprint", CategoryFingerprint},
		{"fingerprinting", CategoryFingerprint},
		{"something else", CategoryOther},
		{"", CategoryOther},
	}
	for _, testCase := range cases {
		if got := CategoryKeyOf(testCase.raw); got != testCase.want {
			t.Errorf("CategoryKeyOf(%q) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}

func detectionPayload() map[string]any {
	return map[string]any{
		"url":            "https://example.test/checkout",
		"detectionCount": float64(3),
		"detections": []any{
			map[string]any{"name": "Cloudflare Bot Management", "category": "Anti-Bot", "confidence": float64(98)},
			map[string]any{"name": "hCaptcha", "category": "CAPTCHA"},
			map[string]any{"name": "Canvas", "category": "Fingerprint"},
		},
	}
}

func TestBuildResultCountsEachCategoryIndependently(t *testing.T) {
	result := BuildResult(true, detectionPayload())
	if !result.IsAntibot() || !result.IsCaptcha() || !result.IsFingerprinted() {
		t.Fatalf("expected one of each category, got %v", result.Categories)
	}
	if !result.IsProtected() {
		t.Error("IsProtected should be true when anything was detected")
	}
	if result.Total != 3 {
		t.Errorf("Total = %d, want 3", result.Total)
	}
}

func TestCleanPageIsAvailableButEmpty(t *testing.T) {
	result := BuildResult(true, map[string]any{"url": "https://clean.test/", "detections": []any{}})
	if !result.Available {
		t.Error("a clean page is still an available answer")
	}
	if result.IsAntibot() || result.IsProtected() {
		t.Error("nothing was detected, so nothing should report true")
	}
}

func TestUnavailableIsNotClean(t *testing.T) {
	result := Unavailable(ReasonUnavailable)
	if result.Available {
		t.Error("Available must be false")
	}
	// false here must not be read as "clean" — Available says which it is.
	if result.IsAntibot() || result.IsProtected() {
		t.Error("an unavailable result must not report detections")
	}
	if result.Reason != ReasonUnavailable {
		t.Errorf("Reason = %q, want %q", result.Reason, ReasonUnavailable)
	}
}

func TestReportedTotalKeepsTheClaimSeparate(t *testing.T) {
	result := BuildResult(true, map[string]any{
		"detectionCount": float64(9),
		"detections":     []any{map[string]any{"name": "Akamai"}},
	})
	if result.Total != 1 {
		t.Errorf("Total = %d, want 1 (what actually arrived)", result.Total)
	}
	if result.ReportedTotal != 9 {
		t.Errorf("ReportedTotal = %d, want 9 (what was claimed)", result.ReportedTotal)
	}
}

func TestMalformedDetectionsAreNormalized(t *testing.T) {
	result := BuildResult(true, map[string]any{
		"detections": []any{
			nil,
			map[string]any{},
			map[string]any{"name": "X", "confidence": "not a number"},
		},
	})
	if result.Total != 3 {
		t.Fatalf("Total = %d, want 3", result.Total)
	}
	if result.Detections[0].Name != "Unknown" {
		t.Errorf("nameless detection = %q, want %q", result.Detections[0].Name, "Unknown")
	}
	if result.Detections[0].CategoryKey != CategoryOther {
		t.Errorf("categoryless detection = %q, want %q", result.Detections[0].CategoryKey, CategoryOther)
	}
	if result.Detections[2].Confidence != nil {
		t.Error("a non-numeric confidence must be nil, not a bogus number")
	}
}

func TestNestedDetectorShape(t *testing.T) {
	result := BuildResult(true, map[string]any{
		"detections": []any{
			map[string]any{"detector": map[string]any{"name": "Akamai", "category": "Anti-Bot"}},
		},
	})
	if result.Detections[0].Name != "Akamai" {
		t.Errorf("Name = %q, want Akamai", result.Detections[0].Name)
	}
	if result.Detections[0].CategoryKey != CategoryAntibot {
		t.Errorf("CategoryKey = %q, want antibot", result.Detections[0].CategoryKey)
	}
}

func TestOfCategoryFilters(t *testing.T) {
	found := BuildResult(true, detectionPayload()).OfCategory(CategoryAntibot)
	if len(found) != 1 || found[0].Name != "Cloudflare Bot Management" {
		t.Errorf("OfCategory(antibot) = %v, want just the Cloudflare entry", found)
	}
}

func TestOriginalFieldsArePreserved(t *testing.T) {
	result := BuildResult(true, map[string]any{
		"detections": []any{map[string]any{"name": "Akamai", "vendorNote": "keep me"}},
	})
	if result.Detections[0].Raw["vendorNote"] != "keep me" {
		t.Error("Raw must keep every original field")
	}
}
