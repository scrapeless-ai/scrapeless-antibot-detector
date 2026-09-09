//! The JavaScript half: a buffering listener installed before page scripts run.
//!
//! Installing at document_start is the whole trick. The extension dispatches
//! `scrapeless:onDetection` almost immediately on a cache hit, so a listener
//! added after navigation would routinely hear nothing — and a silent listener
//! is indistinguishable from a clean page.
//!
//! Byte-identical to `scrapeless-sdks/bridge.js` in every SDK; the Node suite
//! asserts it, because a drifted copy fails silently otherwise.

/// Installed via `Page.addScriptToEvaluateOnNewDocument`.
pub const INIT_SCRIPT: &str = r#"
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
"#;

pub const SNAPSHOT: &str =
    "(window.__scrapelessSdkBridge ? window.__scrapelessSdkBridge.snapshot() : null)";
pub const READY: &str =
    "(window.__scrapelessSdkBridge ? window.__scrapelessSdkBridge.readyDetail() : null)";
pub const INSTALLED: &str = "Boolean(window.__scrapelessSdkBridge)";

/// CDP evaluates an expression, not a function, so the wait is built as an IIFE
/// with the budget interpolated.
pub fn await_expression(timeout_ms: u64) -> String {
    format!(
        "(window.__scrapelessSdkBridge ? window.__scrapelessSdkBridge.awaitDetection({}) : null)",
        timeout_ms
    )
}

/// Flags Chrome needs to actually load an unpacked extension. Both are required:
/// `--load-extension` is ignored unless the extension is also exempted from the
/// disable list.
pub fn chromium_extension_args(extension_path: &str) -> Vec<String> {
    vec![
        format!("--disable-extensions-except={}", extension_path),
        format!("--load-extension={}", extension_path),
    ]
}
