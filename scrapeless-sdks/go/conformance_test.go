package scrapeless

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Reads ../conformance.json, the shared truth for all nine SDKs, so a fold that
// drifts here fails here. Only the standard library, so `go test` runs without
// fetching chromedp or launching a browser.

type foldVector struct {
	Raw    string `json:"raw"`
	Expect string `json:"expect"`
}

type expectation struct {
	Available            bool           `json:"available"`
	Reason               string         `json:"reason"`
	Total                int            `json:"total"`
	ReportedTotal        int            `json:"reportedTotal"`
	Categories           map[string]int `json:"categories"`
	IsAntibot            bool           `json:"isAntibot"`
	IsCaptcha            bool           `json:"isCaptcha"`
	IsFingerprinted      bool           `json:"isFingerprinted"`
	IsProtected          bool           `json:"isProtected"`
	FirstName            string         `json:"firstName"`
	FirstCategoryKey     string         `json:"firstCategoryKey"`
	LastConfidenceIsNull bool           `json:"lastConfidenceIsNull"`
}

type resultVector struct {
	Name   string         `json:"name"`
	Detail map[string]any `json:"detail"`
	Expect expectation    `json:"expect"`
}

type conformance struct {
	CategoryFold []foldVector   `json:"categoryFold"`
	Results      []resultVector `json:"results"`
	Unavailable  struct {
		Expect expectation `json:"expect"`
	} `json:"unavailable"`
}

func loadConformance(t *testing.T) conformance {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "conformance.json"))
	if err != nil {
		t.Fatalf("read conformance.json: %v", err)
	}
	var vectors conformance
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("parse conformance.json: %v", err)
	}
	return vectors
}

func TestCategoryFoldMatchesSharedVectors(t *testing.T) {
	for _, vector := range loadConformance(t).CategoryFold {
		if got := CategoryKeyOf(vector.Raw); got != vector.Expect {
			t.Errorf("CategoryKeyOf(%q) = %q, want %q", vector.Raw, got, vector.Expect)
		}
	}
}

func TestResultShapeMatchesSharedVectors(t *testing.T) {
	for _, vector := range loadConformance(t).Results {
		result := BuildResult(true, vector.Detail)
		want := vector.Expect

		if result.Available != want.Available {
			t.Errorf("%s: Available = %v, want %v", vector.Name, result.Available, want.Available)
		}
		if result.Total != want.Total {
			t.Errorf("%s: Total = %d, want %d", vector.Name, result.Total, want.Total)
		}
		if result.ReportedTotal != want.ReportedTotal {
			t.Errorf("%s: ReportedTotal = %d, want %d", vector.Name, result.ReportedTotal, want.ReportedTotal)
		}
		for key, count := range want.Categories {
			if result.Categories[key] != count {
				t.Errorf("%s: Categories[%q] = %d, want %d", vector.Name, key, result.Categories[key], count)
			}
		}
		if result.IsAntibot() != want.IsAntibot {
			t.Errorf("%s: IsAntibot = %v, want %v", vector.Name, result.IsAntibot(), want.IsAntibot)
		}
		if result.IsProtected() != want.IsProtected {
			t.Errorf("%s: IsProtected = %v, want %v", vector.Name, result.IsProtected(), want.IsProtected)
		}
		if want.FirstName != "" {
			if result.Detections[0].Name != want.FirstName {
				t.Errorf("%s: first Name = %q, want %q", vector.Name, result.Detections[0].Name, want.FirstName)
			}
			if result.Detections[0].CategoryKey != want.FirstCategoryKey {
				t.Errorf("%s: first CategoryKey = %q, want %q",
					vector.Name, result.Detections[0].CategoryKey, want.FirstCategoryKey)
			}
		}
		if want.LastConfidenceIsNull {
			if last := result.Detections[len(result.Detections)-1]; last.Confidence != nil {
				t.Errorf("%s: a non-numeric confidence must be nil, got %v", vector.Name, *last.Confidence)
			}
		}
	}
}

func TestUnavailableMatchesSharedVectorAndIsNotClean(t *testing.T) {
	want := loadConformance(t).Unavailable.Expect
	result := Unavailable(ReasonUnavailable)

	if result.Available != want.Available {
		t.Errorf("Available = %v, want %v", result.Available, want.Available)
	}
	if result.Reason != want.Reason {
		t.Errorf("Reason = %q, want %q", result.Reason, want.Reason)
	}
	// false here must never be read as "clean" — Available says which it is.
	if result.IsAntibot() != want.IsAntibot || result.IsProtected() != want.IsProtected {
		t.Error("an unavailable result must not report detections")
	}
}

func TestEmbeddedBridgeMatchesCanonical(t *testing.T) {
	canonical, err := os.ReadFile(filepath.Join("..", "bridge.js"))
	if err != nil {
		t.Fatalf("read bridge.js: %v", err)
	}
	if strings.TrimSpace(bridgeScript) != strings.TrimSpace(string(canonical)) {
		t.Error("bridge.go has drifted from scrapeless-sdks/bridge.js")
	}
}
