package scrapeless

import "fmt"

// bridgeScript is a buffering listener installed into every document at
// document_start.
//
// Installing it that early is the whole trick. The extension dispatches
// scrapeless:onDetection almost immediately on a cache hit, so a listener added
// after Navigate returns would routinely hear nothing — and a silent listener is
// indistinguishable from a clean page.
//
// This text is byte-identical to scrapeless-sdks/bridge.js in every SDK. The
// Node suite asserts it, because a drifted copy fails silently otherwise.
const bridgeScript = `
(() => {
  if (window.__scrapelessSdkBridge) { return; }
  const EVENTS = ['ready', 'onStart', 'onProgress', 'onHooksComplete',
                  'onWindowPropsComplete', 'onDetection', 'onError'];
  const last = Object.create(null);
  let waiters = [];

  for (const name of EVENTS) {
    window.addEventListener('scrapeless:' + name, (signal) => {
      last[name] = (signal && signal.detail) || {};
      if (name === 'onDetection') {
        const pending = waiters;
        waiters = [];
        for (const settle of pending) { settle(last[name]); }
      }
    });
  }

  window.__scrapelessSdkBridge = {
    snapshot: () => last.onDetection || null,
    readyDetail: () => last.ready || null,
    seen: () => Object.keys(last),
    // Bounded: the page API ships disabled and the extension may be absent,
    // and neither announces itself. Resolve null rather than hang forever.
    awaitDetection: (timeoutMs) => new Promise((resolve) => {
      if (last.onDetection) { resolve(last.onDetection); return; }
      let settled = false;
      const finish = (value) => {
        if (settled) { return; }
        settled = true;
        resolve(value || null);
      };
      waiters.push(finish);
      if (timeoutMs > 0) { setTimeout(() => finish(null), timeoutMs); }
    })
  };
})();
`

// Expressions are built as self-contained IIFEs because CDP evaluates an
// expression, not a function to be called.
func awaitExpression(timeoutMS int) string {
	return fmt.Sprintf(
		`(window.__scrapelessSdkBridge ? window.__scrapelessSdkBridge.awaitDetection(%d) : null)`,
		timeoutMS,
	)
}

const (
	snapshotExpression  = `(window.__scrapelessSdkBridge ? window.__scrapelessSdkBridge.snapshot() : null)`
	readyExpression     = `(window.__scrapelessSdkBridge ? window.__scrapelessSdkBridge.readyDetail() : null)`
	installedExpression = `Boolean(window.__scrapelessSdkBridge)`
)
