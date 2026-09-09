# frozen_string_literal: true

module ScrapelessDetector
  # The JavaScript half: a buffering listener installed before page scripts run.
  #
  # Installing at document_start is the whole trick. The extension dispatches
  # scrapeless:onDetection almost immediately on a cache hit, so a listener added
  # after page.goto returns would routinely hear nothing — and a silent listener
  # is indistinguishable from a clean page.
  #
  # Byte-identical to scrapeless-sdks/bridge.js in every SDK; the Node suite
  # asserts it, because a drifted copy fails silently otherwise.
  INIT_SCRIPT = <<~'JAVASCRIPT'
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
  JAVASCRIPT

  AWAIT_DETECTION = '(ms) => window.__scrapelessSdkBridge.awaitDetection(ms)'
  SNAPSHOT = '() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.snapshot()'
  READY = '() => window.__scrapelessSdkBridge && window.__scrapelessSdkBridge.readyDetail()'
  INSTALLED = '() => Boolean(window.__scrapelessSdkBridge)'

  module_function

  # Both flags are required: --load-extension is ignored unless the extension is
  # also exempted from the disable list.
  def chromium_extension_args(extension_path)
    ["--disable-extensions-except=#{extension_path}", "--load-extension=#{extension_path}"]
  end

  # Drives a Playwright page. Attach BEFORE navigating.
  class Detector
    def initialize(page, timeout_ms = DEFAULT_TIMEOUT_MS)
      @page = page
      @timeout_ms = timeout_ms
    end

    attr_reader :page

    def self.attach(page, timeout_ms = DEFAULT_TIMEOUT_MS)
      page.add_init_script(script: INIT_SCRIPT)
      begin
        page.evaluate(INIT_SCRIPT)
      rescue StandardError
        # No document yet; the init script still covers every real navigation.
      end
      new(page, timeout_ms)
    end

    # Wait for the result, bounded. Replays if detection already finished.
    def detect(timeout_ms = nil)
      return ScrapelessDetector.unavailable unless @page.evaluate(INSTALLED)

      detail = @page.evaluate(AWAIT_DETECTION, arg: (timeout_ms || @timeout_ms))
      detail.nil? ? ScrapelessDetector.unavailable : ScrapelessDetector.build_result(true, detail)
    end

    # The last result already seen, or nil. Never waits.
    def snapshot
      return nil unless @page.evaluate(INSTALLED)

      detail = @page.evaluate(SNAPSHOT)
      detail.nil? ? nil : ScrapelessDetector.build_result(true, detail)
    end

    def ready
      return { 'available' => false, 'version' => nil } unless @page.evaluate(INSTALLED)

      detail = @page.evaluate(READY)
      return { 'available' => false, 'version' => nil } if detail.nil?

      { 'available' => true, 'version' => detail['version'] }
    end

    def antibot?(timeout_ms = nil) = detect(timeout_ms).antibot?
    def captcha?(timeout_ms = nil) = detect(timeout_ms).captcha?
    def fingerprinted?(timeout_ms = nil) = detect(timeout_ms).fingerprinted?
    def protected?(timeout_ms = nil) = detect(timeout_ms).protected?
  end
end
