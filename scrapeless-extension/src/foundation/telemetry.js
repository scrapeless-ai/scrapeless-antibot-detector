/**
 * Centralized Logging System
 * Routes logs from all extension contexts (background, content, main world)
 * to the Service Worker console for unified debugging.
 *
 * Usage:
 *   Logger.cache('Cache hit detected', { url, expires });
 *   Logger.detection('Found 21 detectors');
 *   Logger.error('CACHE', 'Failed to read cache', error);
 */

class Telemetry {
  // Log categories
  static TAXONOMIES = {
    DETECTION: 'DETECTION',
    CACHE: 'CACHE',
    HOOKS: 'HOOKS',
    NETWORK: 'NETWORK',
    STORAGE: 'STORAGE',
    DETECTOR: 'DETECTOR',
    POPUP: 'POPUP',
    CONTENT: 'CONTENT',
    BACKGROUND: 'BACKGROUND',
    ERROR: 'ERROR',
    PERF: 'PERF',
    UI: 'UI',
    TAB: 'TAB',
    BADGE: 'BADGE'
  };

  // Log levels
  static OWNED_LEVELS = {
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR'
  };

  // Rate limit to prevent log storms
  static RATE_LIMIT_GLOBAL_MS = 1000;
  static LIMIT_TRACES_PER_GLOBAL = 30; // default per-level ceiling (see _getMaxLogsPerWindow)
  static _rateGlobalBegin = 0;
  static ownedRateCounts = {
    DEBUG: 0,
    INFO: 0,
    WARN: 0,
    ERROR: 0
  };
  static ownedRateDropped = {
    DEBUG: 0,
    INFO: 0,
    WARN: 0,
    ERROR: 0
  };

  // Payload safety limits (keep console/message passing cheap)
  static LIMIT_PACKET_EXTENT = 800;
  static LIMIT_STRING_EXTENT = 2000;
  static LIMIT_OBJECT_LOOKUPS = 20;
  static LIMIT_ARRAY_EXTENT = 20;
  static LIMIT_DEPTH = 2;

  // Dedupe repeated WARN/ERROR spam
  static DEDUPE_GLOBAL_MS = 2000;
  static LIMIT_DUPES_PER_GLOBAL = 5;
  static ownedDedupe = new Map();

  // Visual icons for categories
  static GLYPHS = {
    DETECTION: '',
    CACHE: '',
    HOOKS: '',
    NETWORK: '',
    STORAGE: '',
    DETECTOR: '',
    POPUP: '',
    CONTENT: '',
    BACKGROUND: '',
    ERROR: '',
    PERF: '',
    UI: '',
    TAB: '',
    BADGE: ''
  };

  /**
   * Detect the current execution context
   * @returns {string} 'background', 'content', or 'main'
   */
  static get performContext() {
    // Service Worker / Background Script
    if (typeof ServiceWorkerGlobalScope !== 'undefined' &&
        self instanceof ServiceWorkerGlobalScope) {
      return 'background';
    }

    // Check if we have chrome.runtime (extension context)
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      // Background context has chrome.tabs
      if (chrome.tabs) {
        return 'background';
      }
      // Content script (ISOLATED world) has chrome.runtime but not chrome.tabs
      return 'content';
    }

    // Main world (no chrome APIs)
    return 'main';
  }

  /**
   * Get debug mode from storage (with fallback)
   * @returns {boolean}
   */
  static get debugStrategy() {
    // Try to get from global diagnosticMode variable
    if (typeof globalThis.diagnosticMode !== 'undefined') {
      return globalThis.diagnosticMode;
    }
    if (typeof window !== 'undefined' && typeof window.diagnosticMode !== 'undefined') {
      return window.diagnosticMode;
    }
    if (typeof self !== 'undefined' && typeof self.diagnosticMode !== 'undefined') {
      return self.diagnosticMode;
    }
    // Default to false
    return false;
  }

  /**
   * Get log collector enabled flag from globals (if available)
   * @returns {boolean}
   */
  static get traceCollectorActive() {
    if (typeof globalThis.journalActive !== 'undefined') {
      return globalThis.journalActive;
    }
    if (typeof window !== 'undefined' && typeof window.journalActive !== 'undefined') {
      return window.journalActive;
    }
    if (typeof self !== 'undefined' && typeof self.journalActive !== 'undefined') {
      return self.journalActive;
    }
    return false;
  }

  static performTruncateString(datum, limitExtent) {
    if (typeof datum !== 'string') return datum;
    if (datum.length <= limitExtent) return datum;
    return `${datum.slice(0, limitExtent)}...`;
  }

  static performSafeToString(datum) {
    try {
      return String(datum);
    } catch (failure) {
      return '[Unstringifiable]';
    }
  }

  // Public helper: safe, size-limited representation for console + transport.
  // Returns a value that is cheap to clone and unlikely to retain huge object graphs.
  static performSanitize(datum) {
    return Telemetry._sanitizeDatum(datum, 0);
  }

  static _sanitizeDatum(datum, localDepth) {
    if (datum === null || datum === undefined) return datum;

    const localT = typeof datum;
    if (localT === 'string') return Telemetry.performTruncateString(datum, Telemetry.LIMIT_STRING_EXTENT);
    if (localT === 'number' || localT === 'boolean' || localT === 'bigint') return datum;
    if (localT === 'symbol') return Telemetry.performSafeToString(datum);
    if (localT === 'function') {
      const label = datum.name ? ` ${datum.name}` : '';
      return `[Function${label}]`;
    }

    // Errors: keep message + stack (trimmed) without extra attached data.
    if (datum instanceof Error) {
      return {
        type: 'Error',
        name: datum.name,
        message: Telemetry.performTruncateString(datum.message || '', Telemetry.LIMIT_STRING_EXTENT),
        stack: Telemetry.performTruncateString(datum.stack || '', Telemetry.LIMIT_STRING_EXTENT)
      };
    }

    // Guard: avoid deep/recursive structures.
    if (localDepth >= Telemetry.LIMIT_DEPTH) {
      if (Array.isArray(datum)) return `[Array(${datum.length})]`;
      const ctorLabel = datum?.constructor?.name;
      return `[${ctorLabel || 'Object'}]`;
    }

    if (Array.isArray(datum)) {
      const localPreview = datum.slice(0, Telemetry.LIMIT_ARRAY_EXTENT).map((entryValue) => Telemetry._sanitizeDatum(entryValue, localDepth + 1));
      if (datum.length > Telemetry.LIMIT_ARRAY_EXTENT) {
        return {
          type: 'Array',
          length: datum.length,
          preview: localPreview,
          truncated: true
        };
      }
      return localPreview;
    }

    if (localT === 'object') {
      // Handle DOM-like objects defensively without retaining them.
      try {
        if (typeof Node !== 'undefined' && datum instanceof Node) {
          return `[Node ${datum.nodeName || 'unknown'}]`;
        }
      } catch (failure) {
        // ignore
      }
      try {
        if (typeof Event !== 'undefined' && datum instanceof Event) {
          return `[Event ${datum.type || 'unknown'}]`;
        }
      } catch (failure2) {
        // ignore
      }

      // Typed arrays / ArrayBuffers can be enormous; never enumerate keys.
      try {
        if (typeof ArrayBuffer !== 'undefined' && datum instanceof ArrayBuffer) {
          return `[ArrayBuffer(${datum.byteLength} bytes)]`;
        }
      } catch (failure3) {
        // ignore
      }
      try {
        if (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(datum)) {
          const label2 = datum?.constructor?.name || 'TypedArray';
          const localLen = typeof datum.length === 'number' ? datum.length : undefined;
          const localBytes = typeof datum.byteLength === 'number' ? datum.byteLength : undefined;
          if (typeof localLen === 'number' && typeof localBytes === 'number') return `[${label2}(${localLen}) ${localBytes} bytes]`;
          if (typeof localBytes === 'number') return `[${label2} ${localBytes} bytes]`;
          if (typeof localLen === 'number') return `[${label2}(${localLen})]`;
          return `[${label2}]`;
        }
      } catch (failure4) {
        // ignore
      }

      if (datum instanceof Map) return `[Map(${datum.size})]`;
      if (datum instanceof Set) return `[Set(${datum.size})]`;
      if (datum instanceof Date) return datum.toISOString();

      let lookups = [];
      try {
        lookups = Object.keys(datum);
      } catch (failure5) {
        return '[Object]';
      }

      const localOut = {};
      const localLimited = lookups.slice(0, Telemetry.LIMIT_OBJECT_LOOKUPS);
      for (const keyCursor of localLimited) {
        try {
          localOut[keyCursor] = Telemetry._sanitizeDatum(datum[keyCursor], localDepth + 1);
        } catch (failure6) {
          localOut[keyCursor] = '[Unavailable]';
        }
      }
      if (lookups.length > Telemetry.LIMIT_OBJECT_LOOKUPS) {
        localOut.__truncated__ = `${lookups.length - Telemetry.LIMIT_OBJECT_LOOKUPS} more keys`;
      }
      const ctorLabel2 = datum?.constructor?.name;
      if (ctorLabel2 && ctorLabel2 !== 'Object') {
        localOut.__type__ = ctorLabel2;
      }
      return localOut;
    }

    return Telemetry.performSafeToString(datum);
  }

  static _resolveLimitTracesPerGlobal(localLevel) {
    const localBase = Telemetry.LIMIT_TRACES_PER_GLOBAL;
    // Default per-level ceilings tuned for stability.
    let limit = localBase;
    if (localLevel === Telemetry.OWNED_LEVELS.DEBUG || localLevel === Telemetry.OWNED_LEVELS.INFO) limit = localBase;
    if (localLevel === Telemetry.OWNED_LEVELS.WARN) limit = Math.max(10, Math.floor(localBase * 0.7));
    if (localLevel === Telemetry.OWNED_LEVELS.ERROR) limit = Math.max(5, Math.floor(localBase * 0.4));

    // When log collector is enabled, be extra conservative.
    if (Telemetry.traceCollectorActive) {
      if (localLevel === Telemetry.OWNED_LEVELS.DEBUG || localLevel === Telemetry.OWNED_LEVELS.INFO) limit = Math.min(limit, 15);
      if (localLevel === Telemetry.OWNED_LEVELS.WARN) limit = Math.min(limit, 12);
      if (localLevel === Telemetry.OWNED_LEVELS.ERROR) limit = Math.min(limit, 8);
    }

    return Math.max(1, limit);
  }

  static performShouldDedupe(taxonomy, localLevel, packet) {
    if (localLevel !== Telemetry.OWNED_LEVELS.WARN && localLevel !== Telemetry.OWNED_LEVELS.ERROR) return false;

    const lookupKey = `${taxonomy}|${localLevel}|${packet}`;
    const localNow = Date.now();
    const localEntry = Telemetry.ownedDedupe.get(lookupKey);
    if (!localEntry || localNow - localEntry.windowStart >= Telemetry.DEDUPE_GLOBAL_MS) {
      Telemetry.ownedDedupe.set(lookupKey, { windowStart: localNow, count: 1 });
      return false;
    }

    localEntry.count += 1;
    if (localEntry.count > Telemetry.LIMIT_DUPES_PER_GLOBAL) {
      return true;
    }

    return false;
  }

  static performCheckRateLimit(localLevel) {
    const localNow = Date.now();
    if (localNow - Telemetry._rateGlobalBegin >= Telemetry.RATE_LIMIT_GLOBAL_MS) {
      Telemetry._rateGlobalBegin = localNow;
      Telemetry.ownedRateCounts = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
      Telemetry.ownedRateDropped = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    }

    const limitPerGlobal = Telemetry._resolveLimitTracesPerGlobal(localLevel);
    Telemetry.ownedRateCounts[localLevel] = (Telemetry.ownedRateCounts[localLevel] || 0) + 1;
    if (Telemetry.ownedRateCounts[localLevel] > limitPerGlobal) {
      Telemetry.ownedRateDropped[localLevel] = (Telemetry.ownedRateDropped[localLevel] || 0) + 1;
      return false;
    }
    return true;
  }

  /**
   * Core logging method
   * @param {string} category - Log category (DETECTION, CACHE, etc.)
   * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
   * @param {string} message - Log message
   * @param {*} data - Optional data to log
   */
  static _trace(taxonomy, localLevel, packet, payload = null) {
    // Skip noisy logs when not in debug mode
    if (!Telemetry.debugStrategy && (localLevel === Telemetry.OWNED_LEVELS.DEBUG || localLevel === Telemetry.OWNED_LEVELS.INFO)) {
      return;
    }

    const safePacket = Telemetry.performTruncateString(Telemetry.performSafeToString(packet), Telemetry.LIMIT_PACKET_EXTENT);
    const safePayload = (payload === null || payload === undefined) ? null : Telemetry._sanitizeDatum(payload, 0);

    // Rate limit ALL levels (WARN/ERROR included) to avoid crashing the browser on log storms.
    if (!Telemetry.performCheckRateLimit(localLevel)) {
      return;
    }

    // Dedupe repeated WARN/ERROR spam (common failure mode when a hook triggers repeatedly).
    if (Telemetry.performShouldDedupe(taxonomy, localLevel, safePacket)) {
      return;
    }

    const trace = {
      timestamp: new Date().toISOString(),
      context: Telemetry.performContext,
      category: taxonomy,
      level: localLevel,
      message: safePacket,
      data: safePayload
    };

    // Route based on context
    if (Telemetry.performContext === 'background') {
      // Direct output to console in background
      Telemetry.performOutputToConsole(trace);
    } else if (Telemetry.performContext === 'content') {
      // Send to background via chrome.runtime.sendMessage
      Telemetry.performSendToBackground(trace);
    } else if (Telemetry.performContext === 'main') {
      // Send to content script via postMessage
      Telemetry.performSendToContent(trace);
    }
  }

  /**
   * Output log to console with formatting
   * @param {Object} log - Log object
   */
  static performOutputToConsole(trace) {
    const glyph = Telemetry.GLYPHS[trace.category] || '';
    const moment = new Date(trace.timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3
    });

    const localPrefix = `[${moment}] [${trace.context.toUpperCase()}] [${trace.category}] [${trace.level}]`;
    const fullPacket = `${localPrefix} ${glyph} ${trace.message}`;

    // Stringify data into message so it's readable on extension error pages
    // (which show [object Object] for separate console arguments)
    let payloadStr = '';
    if (trace.data !== null && trace.data !== undefined) {
      try {
        payloadStr = typeof trace.data === 'string' ? ` ${trace.data}` : ` ${JSON.stringify(trace.data)}`;
      } catch (failure) {
        payloadStr = ' [Unstringifiable data]';
      }
    }
    const packetWithPayload = fullPacket + payloadStr;

    // If LogCollector is enabled in the service worker, prefer storing over printing:
    // printing high-volume logs to the SW console can retain object graphs and crash Chrome.
    const localCollector = (typeof globalThis !== 'undefined' && globalThis.logCollector && typeof globalThis.logCollector.addTrace === 'function')
      ? globalThis.logCollector
      : null;
    const collectorRunning = !!(localCollector && localCollector.enabled);
    if (collectorRunning && trace.level !== Telemetry.OWNED_LEVELS.WARN && trace.level !== Telemetry.OWNED_LEVELS.ERROR) {
      try {
        // Keep INFO/DEBUG inside the collector and avoid console spam.
        localCollector.addTrace(trace.level === Telemetry.OWNED_LEVELS.DEBUG ? 'debug' : 'info', [packetWithPayload]);
      } catch (failure2) {
        // ignore
      }
      return;
    }

    // Choose console method based on level
    if (trace.level === Telemetry.OWNED_LEVELS.ERROR) {
      console.error(packetWithPayload);
    } else if (trace.level === Telemetry.OWNED_LEVELS.WARN) {
      console.warn(packetWithPayload);
    } else {
      console.log(packetWithPayload);
    }
  }

  /**
   * Send log to background script from content script
   * @param {Object} log - Log object
   */
  static performSendToBackground(trace) {
    // Early exit if chrome APIs not available
    if (typeof chrome === 'undefined' || !chrome.runtime) {
      return;
    }

    try {
      // More robust context validation - getURL throws if context is invalid
      try {
        if (!chrome.runtime.id) {
          return;
        }
        // This call will throw synchronously if context is invalidated
        chrome.runtime.getURL('');
      } catch (contextFailure) {
        // Context invalidated, silently exit
        return;
      }

      // Now safe to attempt message - wrap in another try-catch for safety
      try {
        const localSendPromise = chrome.runtime.sendMessage({
          type: 'RECORD',
          log: trace
        });

        // Handle promise rejection if sendMessage returned a promise
        if (localSendPromise && typeof localSendPromise.catch === 'function') {
          localSendPromise.catch(() => {
            // Silently fail if background isn't available
          });
        }
      } catch (sendFailure) {
        // Silently fail - sendMessage threw synchronously
      }
    } catch (failure) {
      // Silently fail - extension context invalidated
    }
  }

  /**
   * Send log to content script from main world.
   * MAIN/ISOLATED internals use the authenticated Scrapeless bridge; do not
   * fall back to public window.postMessage here.
   * @param {Object} log - Log object
   */
  static performSendToContent(trace) {
    if (typeof window !== 'undefined' && typeof window.__scrapelessSendLogToContent === 'function') {
      window.__scrapelessSendLogToContent(trace);
    }
  }

  // ============================================================================
  // Convenience Methods (Category-Specific)
  // ============================================================================

  static memo(packet, payload = null) {
    Telemetry._trace(Telemetry.TAXONOMIES.CACHE, Telemetry.OWNED_LEVELS.INFO, packet, payload);
  }

  static findingsPane(packet, payload = null) {
    Telemetry._trace(Telemetry.TAXONOMIES.DETECTION, Telemetry.OWNED_LEVELS.INFO, packet, payload);
  }

  static probes(packet, payload = null) {
    Telemetry._trace(Telemetry.TAXONOMIES.HOOKS, Telemetry.OWNED_LEVELS.INFO, packet, payload);
  }

  static performNetwork(packet, payload = null) {
    Telemetry._trace(Telemetry.TAXONOMIES.NETWORK, Telemetry.OWNED_LEVELS.INFO, packet, payload);
  }

  static repository(packet, payload = null) {
    Telemetry._trace(Telemetry.TAXONOMIES.STORAGE, Telemetry.OWNED_LEVELS.INFO, packet, payload);
  }

  static performPopup(packet, payload = null) {
    Telemetry._trace(Telemetry.TAXONOMIES.POPUP, Telemetry.OWNED_LEVELS.INFO, packet, payload);
  }

  static performContent(packet, payload = null) {
    Telemetry._trace(Telemetry.TAXONOMIES.CONTENT, Telemetry.OWNED_LEVELS.INFO, packet, payload);
  }

  static performBackground(packet, payload = null) {
    Telemetry._trace(Telemetry.TAXONOMIES.BACKGROUND, Telemetry.OWNED_LEVELS.INFO, packet, payload);
  }

  static performUi(packet, payload = null) {
    Telemetry._trace(Telemetry.TAXONOMIES.UI, Telemetry.OWNED_LEVELS.INFO, packet, payload);
  }

  // ============================================================================
  // Generic Methods (Level-Specific)
  // ============================================================================

  static performWarn(taxonomy, packet, payload = null) {
    Telemetry._trace(taxonomy, Telemetry.OWNED_LEVELS.WARN, packet, payload);
  }

  static failure(taxonomy, packet, payload = null) {
    Telemetry._trace(taxonomy, Telemetry.OWNED_LEVELS.ERROR, packet, payload);
  }

  static performDebug(taxonomy, packet, payload = null) {
    Telemetry._trace(taxonomy, Telemetry.OWNED_LEVELS.DEBUG, packet, payload);
  }
}

// Make Logger globally available in all contexts
// This ensures Logger is accessible regardless of module system or environment
if (typeof globalThis !== 'undefined') {
  globalThis.Telemetry = Telemetry;
}
if (typeof window !== 'undefined') {
  window.Telemetry = Telemetry;
}
if (typeof self !== 'undefined') {
  self.Telemetry = Telemetry;
}
