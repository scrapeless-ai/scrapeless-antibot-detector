// Package scrapeless asks a page whether it is protected, from Go.
//
// Go cannot hear the extension directly. The extension talks to the *page*, by
// dispatching CustomEvents at window, so this package drives a real Chrome with
// the extension loaded and reads the result back out of the document.
package scrapeless

import "strings"

// Category keys. Every detection folds to exactly one of these.
const (
	CategoryAntibot     = "antibot"
	CategoryCaptcha     = "captcha"
	CategoryFingerprint = "fingerprint"
	CategoryOther       = "other"
)

// Reasons carried by an unavailable Result.
const (
	ReasonUnavailable = "unavailable"
)

// CategoryKeyOf folds any category spelling to one of the Category constants.
//
// The bundled detectors ship the category in four different spellings —
// "Anti-Bot", "ANTIBOT", "CAPTCHA", "Fingerprint" — so comparing against any
// single one matches almost nothing. This mirrors the extension's own fold; the
// two must agree or these buckets disagree with the badge the user is seeing.
func CategoryKeyOf(raw string) string {
	var folded strings.Builder
	for _, symbol := range strings.ToLower(strings.TrimSpace(raw)) {
		if symbol >= 'a' && symbol <= 'z' {
			folded.WriteRune(symbol)
		}
	}
	switch folded.String() {
	case "antibot", "waf":
		return CategoryAntibot
	case "captcha":
		return CategoryCaptcha
	case "fingerprint", "fingerprinting":
		return CategoryFingerprint
	default:
		return CategoryOther
	}
}

// Detection is one detection, normalized without discarding what else it carried.
type Detection struct {
	Name        string         `json:"name"`
	CategoryKey string         `json:"categoryKey"`
	Confidence  *float64       `json:"confidence"`
	Raw         map[string]any `json:"-"`
}

// Result is a value you can always read, present or not.
//
// Available is the field that matters. A false from IsAntibot means "no anti-bot
// detection was reported", which is NOT "this page is clean" when Available is
// false. Check Available before trusting a false.
type Result struct {
	Available     bool           `json:"available"`
	Reason        string         `json:"reason,omitempty"`
	URL           string         `json:"url,omitempty"`
	Timestamp     string         `json:"timestamp,omitempty"`
	FromCache     bool           `json:"fromCache"`
	Total         int            `json:"total"`
	ReportedTotal int            `json:"reportedTotal"`
	Categories    map[string]int `json:"categories"`
	Detections    []Detection    `json:"detections"`
}

// HasCategory reports whether the extension found anything in that bucket.
func (r Result) HasCategory(key string) bool {
	return r.Available && r.Categories[strings.ToLower(strings.TrimSpace(key))] > 0
}

// IsAntibot reports any anti-bot or WAF detection.
func (r Result) IsAntibot() bool { return r.HasCategory(CategoryAntibot) }

// IsCaptcha reports any CAPTCHA detection.
func (r Result) IsCaptcha() bool { return r.HasCategory(CategoryCaptcha) }

// IsFingerprinted reports any fingerprinting detection.
func (r Result) IsFingerprinted() bool { return r.HasCategory(CategoryFingerprint) }

// IsProtected reports whether anything at all was detected, in any category.
func (r Result) IsProtected() bool { return r.Available && r.Total > 0 }

// OfCategory returns just the detections in one bucket.
func (r Result) OfCategory(key string) []Detection {
	wanted := strings.ToLower(strings.TrimSpace(key))
	found := make([]Detection, 0, len(r.Detections))
	for _, detection := range r.Detections {
		if detection.CategoryKey == wanted {
			found = append(found, detection)
		}
	}
	return found
}

func emptyCounts() map[string]int {
	return map[string]int{
		CategoryAntibot:     0,
		CategoryCaptcha:     0,
		CategoryFingerprint: 0,
		CategoryOther:       0,
	}
}

// Unavailable builds the result returned when nothing was heard: no extension,
// page signals switched off, or the wait ran out.
func Unavailable(reason string) Result {
	return Result{
		Available:  false,
		Reason:     reason,
		Categories: emptyCounts(),
		Detections: []Detection{},
	}
}

func textOf(source map[string]any, key string) string {
	if value, ok := source[key].(string); ok {
		return value
	}
	return ""
}

func normalizeDetection(source map[string]any) Detection {
	name := textOf(source, "name")
	if name == "" {
		switch nested := source["detector"].(type) {
		case map[string]any:
			name = textOf(nested, "name")
		case string:
			name = nested
		}
	}
	if name == "" {
		name = "Unknown"
	}

	category := textOf(source, "category")
	if category == "" {
		if nested, ok := source["detector"].(map[string]any); ok {
			category = textOf(nested, "category")
		}
	}

	// A non-numeric confidence becomes nil, never a bogus number.
	var confidence *float64
	if value, ok := source["confidence"].(float64); ok {
		confidence = &value
	}

	return Detection{
		Name:        name,
		CategoryKey: CategoryKeyOf(category),
		Confidence:  confidence,
		Raw:         source,
	}
}

// BuildResult turns the raw detail the page reported into a Result.
func BuildResult(available bool, detail map[string]any) Result {
	if detail == nil {
		return Unavailable(ReasonUnavailable)
	}

	raw, _ := detail["detections"].([]any)
	detections := make([]Detection, 0, len(raw))
	categories := emptyCounts()
	for _, entry := range raw {
		source, ok := entry.(map[string]any)
		if !ok {
			source = map[string]any{}
		}
		detection := normalizeDetection(source)
		detections = append(detections, detection)
		categories[detection.CategoryKey]++
	}

	// detectionCount is what the extension claimed; len is what arrived. They
	// can disagree if a payload was trimmed, so keep both.
	reported := len(detections)
	if claimed, ok := detail["detectionCount"].(float64); ok {
		reported = int(claimed)
	}

	fromCache, _ := detail["fromCache"].(bool)
	return Result{
		Available:     available,
		URL:           textOf(detail, "url"),
		Timestamp:     textOf(detail, "timestamp"),
		FromCache:     fromCache,
		Total:         len(detections),
		ReportedTotal: reported,
		Categories:    categories,
		Detections:    detections,
	}
}
