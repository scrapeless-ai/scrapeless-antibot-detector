'use strict';

/**
 * The JavaScript half: a buffering listener installed before page scripts run.
 *
 * Playwright cannot receive the extension's CustomEvents itself — they are
 * dispatched at the page's window. So this listener is installed into every
 * document at document_start via addInitScript, it records what it hears, and
 * Node reads it back with evaluate().
 *
 * Installing at document_start is the whole trick. The extension dispatches
 * scrapeless:onDetection almost immediately on a cache hit, so a listener added
 * after page.goto() returns would routinely hear nothing at all — and a silent
 * listener is indistinguishable from a clean page.
 *
 * This text is byte-identical to scrapeless-sdks/bridge.js in every SDK; a test
 * asserts it, because a drifted copy would fail silently.
 */

const INIT_SCRIPT = "(() => {\n  if (window.__scrapelessSdkBridge) { return; }\n  const EVENTS = ['ready', 'onStart', 'onProgress', 'onHooksComplete',\n                  'onWindowPropsComplete', 'onDetection', 'onError'];\n  const last = Object.create(null);\n  let waiters = [];\n\n  for (const name of EVENTS) {\n    window.addEventListener('scrapeless:' + name, (signal) => {\n      last[name] = (signal && signal.detail) || {};\n      if (name === 'onDetection') {\n        const pending = waiters;\n        waiters = [];\n        for (const settle of pending) { settle(last[name]); }\n      }\n    });\n  }\n\n  window.__scrapelessSdkBridge = {\n    snapshot: () => last.onDetection || null,\n    readyDetail: () => last.ready || null,\n    seen: () => Object.keys(last),\n    // Bounded: the page API ships disabled and the extension may be absent,\n    // and neither announces itself. Resolve null rather than hang forever.\n    awaitDetection: (timeoutMs) => new Promise((resolve) => {\n      if (last.onDetection) { resolve(last.onDetection); return; }\n      let settled = false;\n      const finish = (value) => {\n        if (settled) { return; }\n        settled = true;\n        resolve(value || null);\n      };\n      waiters.push(finish);\n      if (timeoutMs > 0) { setTimeout(() => finish(null), timeoutMs); }\n    })\n  };\n})();\n";

const AWAIT_DETECTION = '(ms) => window.__scrapelessSdkBridge.awaitDetection(ms)';
const SNAPSHOT = '() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.snapshot()';
const READY = '() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.readyDetail()';
const INSTALLED = '() => Boolean(window.__scrapelessSdkBridge)';

/**
 * Flags Chrome needs to actually load an unpacked extension. Both are required:
 * --load-extension is ignored unless the extension is also exempted from the
 * disable list.
 */
function chromiumExtensionArgs(extensionPath) {
    return [
        '--disable-extensions-except=' + extensionPath,
        '--load-extension=' + extensionPath
    ];
}

module.exports = {
    INIT_SCRIPT, AWAIT_DETECTION, SNAPSHOT, READY, INSTALLED, chromiumExtensionArgs
};
