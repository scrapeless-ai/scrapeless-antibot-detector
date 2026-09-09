<?php

declare(strict_types=1);

namespace Scrapeless\Detector;

/**
 * The JavaScript half: a buffering listener installed before page scripts run.
 *
 * Installing at document_start is the whole trick. The extension dispatches
 * scrapeless:onDetection almost immediately on a cache hit, so a listener added
 * after navigation would routinely hear nothing — and a silent listener is
 * indistinguishable from a clean page.
 *
 * WebDriver has no init-script hook, so the browser layer installs this through
 * ChromeDriver's CDP passthrough (Page.addScriptToEvaluateOnNewDocument).
 *
 * Byte-identical to scrapeless-sdks/bridge.js in every SDK; the Node suite
 * asserts it, because a drifted copy fails silently otherwise.
 */
final class Bridge
{
    public const INIT_SCRIPT = <<<'JAVASCRIPT'
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
JAVASCRIPT;

    public const AWAIT_DETECTION = 'window.__scrapelessSdkBridge.awaitDetection(arguments[0])';
    public const SNAPSHOT = 'return window.__scrapelessSdkBridge ? window.__scrapelessSdkBridge.snapshot() : null;';
    public const READY = 'return window.__scrapelessSdkBridge ? window.__scrapelessSdkBridge.readyDetail() : null;';
    public const INSTALLED = 'return Boolean(window.__scrapelessSdkBridge);';

    /**
     * Both flags are required: --load-extension is ignored unless the extension
     * is also exempted from the disable list.
     *
     * @return list<string>
     */
    public static function chromiumExtensionArgs(string $extensionPath): array
    {
        return [
            '--disable-extensions-except=' . $extensionPath,
            '--load-extension=' . $extensionPath,
        ];
    }
}
