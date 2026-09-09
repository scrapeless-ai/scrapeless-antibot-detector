"""The JavaScript half: a buffering listener installed before page scripts run.

Playwright cannot receive the extension's CustomEvents itself — they are
dispatched at the page's `window`. So a small listener is installed into every
document at document_start via add_init_script, it records what it hears, and
Python reads it back with evaluate().

Installing at document_start is the whole trick. The extension dispatches
`scrapeless:onDetection` almost immediately on a cache hit, so a listener added
after page.goto() returns would routinely hear nothing at all — and a silent
listener is indistinguishable from a clean page.
"""

# Guarded so repeated installs (or a page that re-runs init scripts) are a no-op,
# and so the buffer survives for late readers on the same document.
INIT_SCRIPT = """
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
"""

AWAIT_DETECTION = "(ms) => window.__scrapelessSdkBridge.awaitDetection(ms)"
SNAPSHOT = "() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.snapshot()"
READY = "() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.readyDetail()"
INSTALLED = "() => Boolean(window.__scrapelessSdkBridge)"


def chromium_extension_args(extension_path: str) -> list:
    """Flags Chrome needs to actually load an unpacked extension.

    Both flags are required: --load-extension alone is ignored unless the
    extension is also exempted from the disable list.
    """
    return [
        f"--disable-extensions-except={extension_path}",
        f"--load-extension={extension_path}",
    ]
