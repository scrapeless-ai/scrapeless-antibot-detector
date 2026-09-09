package scrapeless

import (
	"context"
	"fmt"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

// DefaultTimeout bounds every wait. The page API ships disabled and the
// extension may be absent; neither announces itself, so a wait that could not be
// answered returns an unavailable Result rather than blocking forever.
const DefaultTimeout = 8 * time.Second

// Options configure a browser launched by Launch.
type Options struct {
	// ExtensionPath is the unpacked extension directory — the repository's
	// scrapeless-extension/ folder. Required.
	ExtensionPath string

	// UserDataDir is Chrome's profile directory. Extensions require a
	// persistent profile; when empty, Chrome picks a temporary one.
	UserDataDir string

	// Timeout bounds each detection wait. Zero means DefaultTimeout.
	Timeout time.Duration

	// ExtraFlags are appended to the Chrome command line.
	ExtraFlags []chromedp.ExecAllocatorOption
}

func (o Options) timeout() time.Duration {
	if o.Timeout <= 0 {
		return DefaultTimeout
	}
	return o.Timeout
}

// Install adds the bridge to every document opened in this browser context, and
// to the current one. Call it before navigating.
func Install(ctx context.Context) error {
	return chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
		if _, err := page.AddScriptToEvaluateOnNewDocument(bridgeScript).Do(ctx); err != nil {
			return fmt.Errorf("install bridge on new documents: %w", err)
		}
		// Also cover a document that is already open, so attaching to a
		// running browser works — at the cost of possibly having missed a
		// detection that already fired.
		_ = chromedp.Evaluate(bridgeScript, nil).Do(ctx)
		return nil
	}))
}

// Detect waits for the detection result on the context's current page.
//
// It replays immediately if detection already finished, which is the common case
// on a cache hit.
func Detect(ctx context.Context, timeout time.Duration) (Result, error) {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	var installed bool
	if err := chromedp.Run(ctx, chromedp.Evaluate(installedExpression, &installed)); err != nil {
		return Unavailable(ReasonUnavailable), fmt.Errorf("probe for bridge: %w", err)
	}
	if !installed {
		// Install was never called, or the document replaced it.
		return Unavailable(ReasonUnavailable), nil
	}

	var detail map[string]any
	action := chromedp.Evaluate(
		awaitExpression(int(timeout.Milliseconds())), &detail,
		func(params *runtime.EvaluateParams) *runtime.EvaluateParams {
			return params.WithAwaitPromise(true)
		},
	)
	if err := chromedp.Run(ctx, action); err != nil {
		return Unavailable(ReasonUnavailable), fmt.Errorf("await detection: %w", err)
	}
	if detail == nil {
		return Unavailable(ReasonUnavailable), nil
	}
	return BuildResult(true, detail), nil
}

// Snapshot returns the last result already seen, or Available=false. Never waits.
func Snapshot(ctx context.Context) (Result, error) {
	var detail map[string]any
	if err := chromedp.Run(ctx, chromedp.Evaluate(snapshotExpression, &detail)); err != nil {
		return Unavailable(ReasonUnavailable), fmt.Errorf("read snapshot: %w", err)
	}
	if detail == nil {
		return Unavailable(ReasonUnavailable), nil
	}
	return BuildResult(true, detail), nil
}

// Ready reports what the extension announced about itself, if anything.
func Ready(ctx context.Context) (bool, string, error) {
	var detail map[string]any
	if err := chromedp.Run(ctx, chromedp.Evaluate(readyExpression, &detail)); err != nil {
		return false, "", fmt.Errorf("read ready: %w", err)
	}
	if detail == nil {
		return false, "", nil
	}
	version, _ := detail["version"].(string)
	return true, version, nil
}

// Launch starts Chrome with the extension loaded and returns a browser context.
//
// Classic headless Chrome cannot load extensions, so headless is forced off. The
// returned cancel func shuts the browser down; call it.
func Launch(parent context.Context, options Options) (context.Context, context.CancelFunc, error) {
	if options.ExtensionPath == "" {
		return nil, nil, fmt.Errorf("scrapeless: Options.ExtensionPath is required")
	}

	allocatorOptions := append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...)
	allocatorOptions = append(allocatorOptions,
		chromedp.Flag("headless", false),
		// Both flags are needed: load-extension is ignored unless the
		// extension is also exempted from the disable list.
		chromedp.Flag("disable-extensions-except", options.ExtensionPath),
		chromedp.Flag("load-extension", options.ExtensionPath),
	)
	if options.UserDataDir != "" {
		allocatorOptions = append(allocatorOptions, chromedp.UserDataDir(options.UserDataDir))
	}
	allocatorOptions = append(allocatorOptions, options.ExtraFlags...)

	allocatorCtx, cancelAllocator := chromedp.NewExecAllocator(parent, allocatorOptions...)
	browserCtx, cancelBrowser := chromedp.NewContext(allocatorCtx)

	shutdown := func() {
		cancelBrowser()
		cancelAllocator()
	}

	if err := Install(browserCtx); err != nil {
		shutdown()
		return nil, nil, err
	}
	return browserCtx, shutdown, nil
}

// DetectURL is the one-call form: launch, navigate, answer, shut down.
func DetectURL(parent context.Context, url string, options Options) (Result, error) {
	browserCtx, shutdown, err := Launch(parent, options)
	if err != nil {
		return Unavailable(ReasonUnavailable), err
	}
	defer shutdown()

	if err := chromedp.Run(browserCtx, chromedp.Navigate(url)); err != nil {
		return Unavailable(ReasonUnavailable), fmt.Errorf("navigate to %s: %w", url, err)
	}
	return Detect(browserCtx, options.timeout())
}
