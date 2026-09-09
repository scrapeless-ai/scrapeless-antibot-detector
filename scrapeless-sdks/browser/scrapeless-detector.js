/**
 * Scrapeless Anti-Bot Detector — page SDK
 *
 * The extension already speaks to the page, but only by pushing CustomEvents at
 * `window` (`scrapeless:ready`, `scrapeless:onDetection`, …). That shape has two
 * sharp edges for anyone consuming it:
 *
 *   1. It is push-only. There is no way to *ask* whether the current page is
 *      protected — you had to be listening at the moment the event fired.
 *   2. Detection often completes before page scripts run, especially on a cache
 *      hit, where the extension dispatches `onDetection` almost immediately. An
 *      addEventListener registered a tick too late never hears anything, and the
 *      caller cannot tell that apart from "this page is clean".
 *
 * This SDK subscribes the moment it is constructed and retains what it heard, so
 * a question asked later is still answerable. Everything returns a promise:
 *
 *     const sdk = new ScrapelessDetector();
 *     if (await sdk.isAntibot()) { … }
 *
 * The page API ships **disabled** (`pageSignals.pageSignalsActive` is false in
 * defaults.json), and the extension may not be installed at all. Neither case
 * can be distinguished from "no detections yet" by listening, so every wait is
 * bounded and resolves to a result carrying `available: false` rather than
 * hanging or throwing. Check `available` before trusting `false`.
 *
 * Zero dependencies. UMD: script tag, CommonJS or bundler.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        root.ScrapelessDetector = factory();
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var SIGNAL_PREFIX = 'scrapeless:';

    var EVENTS = [
        'ready',
        'onStart',
        'onProgress',
        'onHooksComplete',
        'onWindowPropsComplete',
        'onDetection',
        'onError'
    ];

    var DEFAULT_TIMEOUT_MS = 8000;

    /**
     * Category strings ship in four different spellings across the bundled
     * detectors — 'Anti-Bot', 'ANTIBOT', 'CAPTCHA', 'Fingerprint' — so an
     * equality check against any one of them matches almost nothing. Fold to
     * lowercase, drop every non-letter, then alias. This mirrors
     * FindingTotals.normalizeCategoryKey in the extension; the two must agree or
     * the SDK's buckets disagree with the badge the user is looking at.
     */
    var CATEGORY_ALIASES = {
        antibot: 'antibot',
        waf: 'antibot',
        captcha: 'captcha',
        fingerprint: 'fingerprint',
        fingerprinting: 'fingerprint'
    };

    function categoryKeyOf(detection) {
        var raw = '';
        if (detection && detection.category != null) {
            raw = detection.category;
        } else if (detection && detection.detector && detection.detector.category != null) {
            raw = detection.detector.category;
        }
        var folded = String(raw).trim().toLowerCase().replace(/[^a-z]/g, '');
        return Object.prototype.hasOwnProperty.call(CATEGORY_ALIASES, folded)
            ? CATEGORY_ALIASES[folded]
            : 'other';
    }

    function emptyCounts() {
        return { antibot: 0, captcha: 0, fingerprint: 0, other: 0 };
    }

    /** Normalize one detection without discarding whatever else it carried. */
    function normalizeDetection(detection) {
        var source = (detection && typeof detection === 'object') ? detection : {};
        var name = source.name
            || (source.detector && (source.detector.name || source.detector))
            || 'Unknown';
        var confidence = Number(source.confidence);
        var normalized = {};
        for (var key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                normalized[key] = source[key];
            }
        }
        normalized.name = String(name);
        normalized.categoryKey = categoryKeyOf(source);
        normalized.confidence = Number.isFinite(confidence) ? confidence : null;
        return normalized;
    }

    /** A result the caller can always destructure, present or not. */
    function buildResult(available, detail, reason) {
        var payload = detail || {};
        var raw = Array.isArray(payload.detections) ? payload.detections : [];
        var detections = raw.map(normalizeDetection);
        var categories = emptyCounts();
        detections.forEach(function (entry) {
            categories[entry.categoryKey] += 1;
        });

        return {
            available: available === true,
            reason: reason || null,
            url: payload.url || null,
            timestamp: payload.timestamp || null,
            fromCache: payload.fromCache === true,
            // detectionCount is what the extension reported; length is what it
            // actually sent. They can disagree if a payload was trimmed, so keep
            // the honest count and expose the claim separately.
            total: detections.length,
            reportedTotal: Number.isFinite(Number(payload.detectionCount))
                ? Number(payload.detectionCount)
                : detections.length,
            categories: categories,
            detections: detections
        };
    }

    var UNAVAILABLE_REASON = 'unavailable';

    function ScrapelessDetector(options) {
        if (!(this instanceof ScrapelessDetector)) {
            return new ScrapelessDetector(options);
        }
        var settings = options || {};

        this._target = settings.target
            || (typeof window !== 'undefined' ? window : null);
        this._timeout = Number.isFinite(Number(settings.timeout))
            ? Number(settings.timeout)
            : DEFAULT_TIMEOUT_MS;

        this._handlers = {};
        this._last = {};
        this._listeners = [];
        this._detectionWaiters = [];
        this._readyWaiters = [];
        this._closed = false;

        if (this._target && typeof this._target.addEventListener === 'function') {
            this._subscribe();
        }
    }

    ScrapelessDetector.EVENTS = EVENTS.slice();
    ScrapelessDetector.prototype.constructor = ScrapelessDetector;

    /** Attach to every documented signal at once, before any caller asks. */
    ScrapelessDetector.prototype._subscribe = function () {
        var self = this;
        EVENTS.forEach(function (name) {
            var handler = function (signal) {
                var detail = (signal && signal.detail) || {};
                self._last[name] = detail;

                if (name === 'onDetection') {
                    self._drain(self._detectionWaiters, buildResult(true, detail));
                }
                if (name === 'ready') {
                    self._drain(self._readyWaiters, {
                        available: true,
                        version: detail.version || null
                    });
                }
                self._emit(name, detail);
            };
            self._target.addEventListener(SIGNAL_PREFIX + name, handler);
            self._listeners.push({ name: SIGNAL_PREFIX + name, handler: handler });
        });
    };

    ScrapelessDetector.prototype._drain = function (queue, value) {
        var pending = queue.splice(0, queue.length);
        pending.forEach(function (entry) {
            if (entry.timer !== null && typeof clearTimeout === 'function') {
                clearTimeout(entry.timer);
            }
            entry.resolve(value);
        });
    };

    ScrapelessDetector.prototype._emit = function (name, detail) {
        var handlers = this._handlers[name];
        if (!handlers) {
            return;
        }
        handlers.slice().forEach(function (handler) {
            try {
                handler(detail);
            } catch (failure) {
                // A subscriber that throws must not stop the others, and must
                // not surface inside the extension's dispatch.
                if (typeof console !== 'undefined' && console.error) {
                    console.error('[ScrapelessDetector] listener threw:', failure);
                }
            }
        });
    };

    /**
     * Wait for a value, but never forever: the page API is opt-in and the
     * extension may be absent, and neither announces itself.
     */
    ScrapelessDetector.prototype._await = function (queue, onTimeout) {
        var self = this;
        return new Promise(function (resolve) {
            if (self._closed || !self._target) {
                resolve(onTimeout());
                return;
            }
            var entry = { resolve: resolve, timer: null };
            if (self._timeout > 0 && typeof setTimeout === 'function') {
                entry.timer = setTimeout(function () {
                    var position = queue.indexOf(entry);
                    if (position !== -1) {
                        queue.splice(position, 1);
                    }
                    resolve(onTimeout());
                }, self._timeout);
            }
            queue.push(entry);
        });
    };

    /** Resolves once the extension announces itself, or on timeout. */
    ScrapelessDetector.prototype.ready = function () {
        if (this._last.ready) {
            return Promise.resolve({
                available: true,
                version: this._last.ready.version || null
            });
        }
        return this._await(this._readyWaiters, function () {
            return { available: false, version: null };
        });
    };

    /**
     * The full detection result. Replays the last one if detection already
     * finished — which is the common case on a cache hit.
     */
    ScrapelessDetector.prototype.detect = function () {
        if (this._last.onDetection) {
            return Promise.resolve(buildResult(true, this._last.onDetection));
        }
        return this._await(this._detectionWaiters, function () {
            return buildResult(false, null, UNAVAILABLE_REASON);
        });
    };

    /** Last result already seen, or null. Synchronous; never waits. */
    ScrapelessDetector.prototype.snapshot = function () {
        return this._last.onDetection
            ? buildResult(true, this._last.onDetection)
            : null;
    };

    ScrapelessDetector.prototype.hasCategory = function (categoryKey) {
        var wanted = String(categoryKey || '').trim().toLowerCase();
        return this.detect().then(function (result) {
            return result.available === true && (result.categories[wanted] || 0) > 0;
        });
    };

    ScrapelessDetector.prototype.isAntibot = function () {
        return this.hasCategory('antibot');
    };

    ScrapelessDetector.prototype.isCaptcha = function () {
        return this.hasCategory('captcha');
    };

    ScrapelessDetector.prototype.isFingerprinted = function () {
        return this.hasCategory('fingerprint');
    };

    /** True when anything at all was detected, in any category. */
    ScrapelessDetector.prototype.isProtected = function () {
        return this.detect().then(function (result) {
            return result.available === true && result.total > 0;
        });
    };

    /**
     * Subscribe to a raw signal. Accepts the bare name ('onDetection') or the
     * prefixed one ('scrapeless:onDetection'). Returns an unsubscribe function.
     */
    ScrapelessDetector.prototype.on = function (name, handler) {
        if (typeof handler !== 'function') {
            throw new TypeError('ScrapelessDetector.on requires a handler function');
        }
        var key = String(name || '').replace(SIGNAL_PREFIX, '');
        if (EVENTS.indexOf(key) === -1) {
            throw new RangeError(
                'Unknown Scrapeless event "' + name + '". Known: ' + EVENTS.join(', ')
            );
        }
        if (!this._handlers[key]) {
            this._handlers[key] = [];
        }
        this._handlers[key].push(handler);

        // A subscriber arriving after the fact still gets the event it missed,
        // which is the whole reason this SDK exists.
        if (this._last[key]) {
            var detail = this._last[key];
            var self = this;
            Promise.resolve().then(function () {
                if (self._handlers[key] && self._handlers[key].indexOf(handler) !== -1) {
                    handler(detail);
                }
            });
        }

        var handlers = this._handlers[key];
        return function off() {
            var position = handlers.indexOf(handler);
            if (position !== -1) {
                handlers.splice(position, 1);
            }
        };
    };

    /** Detach every listener and settle anything still waiting. */
    ScrapelessDetector.prototype.destroy = function () {
        var self = this;
        if (this._closed) {
            return;
        }
        this._closed = true;
        if (this._target && typeof this._target.removeEventListener === 'function') {
            this._listeners.forEach(function (entry) {
                self._target.removeEventListener(entry.name, entry.handler);
            });
        }
        this._listeners = [];
        this._handlers = {};
        this._drain(this._detectionWaiters, buildResult(false, null, 'destroyed'));
        this._drain(this._readyWaiters, { available: false, version: null });
    };

    // Exposed so tests and callers can reuse the exact bucketing the extension
    // uses, rather than reimplementing the four-spelling fold.
    ScrapelessDetector.categoryKeyOf = categoryKeyOf;

    return ScrapelessDetector;
}));
