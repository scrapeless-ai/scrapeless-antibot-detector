package io.scrapeless.detector;

import java.util.List;

/**
 * The JavaScript half: a buffering listener installed before page scripts run.
 *
 * <p>Installing at document_start is the whole trick. The extension dispatches
 * {@code scrapeless:onDetection} almost immediately on a cache hit, so a
 * listener added after navigation would routinely hear nothing — and a silent
 * listener is indistinguishable from a clean page.
 *
 * <p>Byte-identical to {@code scrapeless-sdks/bridge.js} in every SDK; the Node
 * suite asserts it, because a drifted copy fails silently otherwise.
 */
public final class Bridge {
    /** Install with Playwright's {@code addInitScript}. */
    public static final String INIT_SCRIPT = """
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
""";

    public static final String AWAIT_DETECTION =
            "(ms) => window.__scrapelessSdkBridge.awaitDetection(ms)";
    public static final String SNAPSHOT =
            "() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.snapshot()";
    public static final String READY =
            "() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.readyDetail()";
    public static final String INSTALLED = "() => Boolean(window.__scrapelessSdkBridge)";

    private Bridge() {
    }

    /**
     * Flags Chrome needs to actually load an unpacked extension. Both are
     * required: {@code --load-extension} is ignored unless the extension is also
     * exempted from the disable list.
     */
    public static List<String> chromiumExtensionArgs(String extensionPath) {
        return List.of(
                "--disable-extensions-except=" + extensionPath,
                "--load-extension=" + extensionPath);
    }
}
