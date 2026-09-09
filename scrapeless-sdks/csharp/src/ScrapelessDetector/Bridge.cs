namespace Scrapeless.Detector;

/// <summary>
/// The JavaScript half: a buffering listener installed before page scripts run.
/// </summary>
/// <remarks>
/// Installing at document_start is the whole trick. The extension dispatches
/// <c>scrapeless:onDetection</c> almost immediately on a cache hit, so a
/// listener added after navigation would routinely hear nothing — and a silent
/// listener is indistinguishable from a clean page.
/// <para>
/// Byte-identical to <c>scrapeless-sdks/bridge.js</c> in every SDK; the Node
/// suite asserts it, because a drifted copy fails silently otherwise.
/// </para>
/// </remarks>
public static class Bridge
{
    /// <summary>Install with Playwright's AddInitScriptAsync.</summary>
    public const string InitScript = """
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

    public const string AwaitDetection =
        "(ms) => window.__scrapelessSdkBridge.awaitDetection(ms)";

    public const string Snapshot =
        "() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.snapshot()";

    public const string Ready =
        "() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.readyDetail()";

    public const string Installed = "() => Boolean(window.__scrapelessSdkBridge)";

    /// <summary>
    /// Flags Chrome needs to actually load an unpacked extension. Both are
    /// required: --load-extension is ignored unless the extension is also
    /// exempted from the disable list.
    /// </summary>
    public static string[] ChromiumExtensionArgs(string extensionPath) =>
    [
        $"--disable-extensions-except={extensionPath}",
        $"--load-extension={extensionPath}",
    ];
}
