/**
 * Content Script - MAIN World
 * Runs in the MAIN world (page's JavaScript context) to install fingerprinting hooks
 * Receives hook definitions from src/entry/page-agent.js (ISOLATED world) via CustomEvent
 */

(function() {
  'use strict';

  let debugStrategy = false; // Will be set by ISOLATED world
  let traceCollectorActive = false;
  let localBridgeToken = null;
  let lastProbesInstallAt = 0;

  const BRIDGE_BRIDGE_TOKEN_FIELD = '__scrapelessBridgeToken';
  const BRIDGE_BRIDGE_INIT_SIGNAL = 'scrapeless-bridge-init';
  const BRIDGE_ISOLATED_TO_MAIN_SIGNAL = 'scrapeless-isolated-bridge-message';
  const BRIDGE_MAIN_TO_ISOLATED_SIGNAL = 'scrapeless-main-bridge-message';
  const BRIDGE_ALLOWED_ISOLATED_PACKET_TYPES = new Set([
    'SCRAPELESS_PAGE_READY',
    'SCRAPELESS_CACHE_HIT',
    'HALT_PROBES',
    'HALT_GLOBAL_POLLING',
    'SCRAPELESS_JS_API_EVENT'
  ]);

  function isAcceptedBridgeToken(localToken) {
    return typeof localToken === 'string' && localToken.length >= 16 && localToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(localToken);
  }

  function assignBridgeToken(localToken) {
    if (!isAcceptedBridgeToken(localToken)) return false;
    if (localBridgeToken && localBridgeToken !== localToken) return false;
    localBridgeToken = localToken;
    return true;
  }

  function postBridgePacket(packet) {
    if (!localBridgeToken || !packet || typeof packet !== 'object') {
      return false;
    }

    try {
      window.dispatchEvent(new CustomEvent(BRIDGE_MAIN_TO_ISOLATED_SIGNAL, {
        detail: {
          ...packet,
          [BRIDGE_BRIDGE_TOKEN_FIELD]: localBridgeToken
        }
      }));
      return true;
    } catch (failure) {
      return false;
    }
  }

  function resolveTrustedIsolatedPacketPayload(signal) {
    const payload = signal?.detail;
    if (!payload || typeof payload !== 'object') return null;
    if (payload[BRIDGE_BRIDGE_TOKEN_FIELD] !== localBridgeToken) return null;
    if (!BRIDGE_ALLOWED_ISOLATED_PACKET_TYPES.has(payload.type)) return null;
    return payload;
  }

  window.addEventListener(BRIDGE_BRIDGE_INIT_SIGNAL, (signal) => {
    signal.stopImmediatePropagation?.();
    assignBridgeToken(signal.detail?.[BRIDGE_BRIDGE_TOKEN_FIELD]);
  }, true);

  // Suppress hook reporting during extension-driven property reads
  const PROBE_SUPPRESSION_DEPTH_LOOKUP = '__scrapelessHookSuppressionDepth';

  function isProbeReportingSuppressed() {
    return (window[PROBE_SUPPRESSION_DEPTH_LOOKUP] || 0) > 0;
  }

  function localIncrementSuppressionDepth() {
    window[PROBE_SUPPRESSION_DEPTH_LOOKUP] = (window[PROBE_SUPPRESSION_DEPTH_LOOKUP] || 0) + 1;
  }

  function localDecrementSuppressionDepth() {
    const active = window[PROBE_SUPPRESSION_DEPTH_LOOKUP] || 0;
    if (active > 0) window[PROBE_SUPPRESSION_DEPTH_LOOKUP] = active - 1;
  }

  const TRACE_RATE_GLOBAL_MS = 1000;
  const TRACE_LIMIT_PER_GLOBAL = 20;
  const TRACE_LIMIT_PER_GLOBAL_WITH_COLLECTOR = 5;
  const LIMIT_TRACE_PACKET_EXTENT = 1000;
  let traceRateGlobalBegin = Date.now();
  let traceRateTotal = 0;

  // Completion timeouts, window polling, and memory limits
  const BASELINE_PROBES_PROFILE = Object.freeze({
    ACTIVITY_TIMEOUT_MS: 2000,
    MAX_DETECTION_MS: 8000,
    EMERGENCY_TIMEOUT_MS: 12000,
    HEARTBEAT_TIMEOUT_MS: 25000,
    POLL_INTERVAL_MS: 100,
    DEFAULT_MAX_WINDOW_MS: 60000,
    SETTLED_CHECKS: 50,
    INSTALL_DEBOUNCE_MS: 250,
    MAX_DETECTIONS_PER_TAB: 100
  });

  // APIs that are not always available (browser-specific, requires HTTPS, needs permissions, etc.)
  const LOCAL_EXPECTED_UNAVAILABLE_APIS = ['USB.getDevices', 'USB.requestDevice', 'DeviceOrientationEvent', 'DeviceMotionEvent', 'BatteryManager'];

  // Active hooks config (merged from settings on install)
  let runningProbesProfile = { ...BASELINE_PROBES_PROFILE };

  function localClampNumber(datum, floor, limit, localFallback) {
    const localNum = Number(datum);
    if (!Number.isFinite(localNum)) return localFallback;
    if (floor != null && localNum < floor) return floor;
    if (limit != null && localNum > limit) return limit;
    return localNum;
  }

  function assembleProbesProfile(localOverrides = {}) {
    const localMerged = { ...BASELINE_PROBES_PROFILE, ...(localOverrides || {}) };
    return {
      ACTIVITY_TIMEOUT_MS: localClampNumber(localMerged.ACTIVITY_TIMEOUT_MS, 250, 20000, BASELINE_PROBES_PROFILE.ACTIVITY_TIMEOUT_MS),
      MAX_DETECTION_MS: localClampNumber(localMerged.MAX_DETECTION_MS, 1000, 60000, BASELINE_PROBES_PROFILE.MAX_DETECTION_MS),
      EMERGENCY_TIMEOUT_MS: localClampNumber(localMerged.EMERGENCY_TIMEOUT_MS, 2000, 120000, BASELINE_PROBES_PROFILE.EMERGENCY_TIMEOUT_MS),
      HEARTBEAT_TIMEOUT_MS: localClampNumber(localMerged.HEARTBEAT_TIMEOUT_MS, 5000, 180000, BASELINE_PROBES_PROFILE.HEARTBEAT_TIMEOUT_MS),
      POLL_INTERVAL_MS: localClampNumber(localMerged.POLL_INTERVAL_MS, 20, 2000, BASELINE_PROBES_PROFILE.POLL_INTERVAL_MS),
      DEFAULT_MAX_WINDOW_MS: localClampNumber(localMerged.DEFAULT_MAX_WINDOW_MS, 5000, 120000, BASELINE_PROBES_PROFILE.DEFAULT_MAX_WINDOW_MS),
      SETTLED_CHECKS: localClampNumber(localMerged.SETTLED_CHECKS, 5, 200, BASELINE_PROBES_PROFILE.SETTLED_CHECKS),
      INSTALL_DEBOUNCE_MS: localClampNumber(localMerged.INSTALL_DEBOUNCE_MS, 0, 2000, BASELINE_PROBES_PROFILE.INSTALL_DEBOUNCE_MS),
      MAX_DETECTIONS_PER_TAB: localClampNumber(localMerged.MAX_DETECTIONS_PER_TAB, 20, 2000, BASELINE_PROBES_PROFILE.MAX_DETECTIONS_PER_TAB)
    };
  }

  const resolveFailurePacket = (failure) => {
    if (!failure) return '';
    if (typeof failure.message === 'string') return failure.message;
    try {
      return String(failure);
    } catch (failure2) {
      return '';
    }
  };

  const isIllegalInvocationFailure = (failure) => {
    return resolveFailurePacket(failure).includes('Illegal invocation');
  };

  // Suppress hook-related errors from breaking the page.
  // Only suppress our own internal "Illegal invocation" noise — never swallow
  // genuine page/API errors that merely pass through our frame.
  window.addEventListener('error', (signal) => {
    const localMsg = resolveFailurePacket(signal.error || signal.message || signal);
    if (signal.filename && signal.filename.includes('content-main-world') && localMsg.includes('Illegal invocation')) {
      signal.preventDefault();
      signal.stopImmediatePropagation?.();
    }
  }, true);

  // Suppress unhandled promise rejections from hook wrappers
  window.addEventListener('unhandledrejection', (signal) => {
    try {
      const localMsg = resolveFailurePacket(signal.reason);
      if (!localMsg.includes('Illegal invocation')) return;

      const localStack = signal.reason && typeof signal.reason.stack === 'string' ? signal.reason.stack : '';
      if (localStack.includes('src/entry/page-probe.js')) {
        signal.preventDefault();
        signal.stopImmediatePropagation?.();
      }
    } catch (failure) {
      if (debugStrategy) sendTrace('error', `[Hooks MAIN] unhandledrejection inspection failed: ${resolveFailurePacket(failure)}`);
    }
  }, true);

  // Hooks monitoring state (module scope for disable monitoring)
  let installedProbes = new Map(); // Map: hook.target -> {obj, propertyName, originalDescriptor, detectors (Map), wrapper, fallbackContext}
  let completionDeadline = null;
  let sheetReadySignalReceived = false;
  const sheetReadyContinuations = [];


  // Early bind shims: prevent "Illegal invocation" for unbound API calls
  const LOCAL_EARLY_BIND_SHIMS = [
    {
      target: 'Navigator.prototype.getBattery',
      getProto: () => window.Navigator?.prototype,
      getInstance: () => window.navigator
    },
    {
      target: 'MediaDevices.prototype.enumerateDevices',
      getProto: () => window.MediaDevices?.prototype,
      getInstance: () => window.navigator?.mediaDevices
    }
  ];

  const composeBindShim = (prior, localInstance) => {
    const localShim = function(...operands) {
      const executionScope = (this === undefined || this === null || this === window) ? localInstance : this;
      try {
        // Return the original result/promise untouched to preserve identity.
        return Reflect.apply(prior, executionScope, operands);
      } catch (failure) {
        // Retry only for a genuine "Illegal invocation"; all other errors
        // propagate exactly like the native call.
        if (localInstance && localInstance !== executionScope && isIllegalInvocationFailure(failure)) {
          return Reflect.apply(prior, localInstance, operands);
        }
        throw failure;
      }
    };

    Object.defineProperty(localShim, '__scrapelessBindShim', { value: true });
    Object.defineProperty(localShim, 'toString', {
      value: function localToString() {
        return Function.prototype.toString.call(prior);
      },
      writable: true,
      configurable: true
    });

    return localShim;
  };

  const localInstallEarlyBindShims = () => {
    for (const localSpec of LOCAL_EARLY_BIND_SHIMS) {
      try {
        const localProto = localSpec.getProto();
        const localInstance = localSpec.getInstance();
        const signalLabel = localSpec.target.split('.').pop();

        // Prefer prototype patch (affects all instances)
        if (localProto) {
          const localDesc = Object.getOwnPropertyDescriptor(localProto, signalLabel);
          if (localDesc && typeof localDesc.value === 'function' && !localDesc.value.__scrapelessBindShim) {
            const localShim = composeBindShim(localDesc.value, localInstance);
            try {
              Object.defineProperty(localProto, signalLabel, {
                value: localShim,
                writable: localDesc.writable,
                enumerable: localDesc.enumerable,
                configurable: localDesc.configurable
              });
              continue;
            } catch (failure) {
              // Fall through to instance patch
            }
          }
        }

        // Fallback: instance patch (if prototype is locked)
        if (localInstance && typeof localInstance[signalLabel] === 'function' && !localInstance[signalLabel].__scrapelessBindShim) {
          const localShim2 = composeBindShim(localInstance[signalLabel], localInstance);
          try {
            // Prefer direct assignment (works for many DOM instances)
            localInstance[signalLabel] = localShim2;
          } catch (failure2) {
            try {
              Object.defineProperty(localInstance, signalLabel, { value: localShim2, writable: true, configurable: true });
            } catch (localE2) {
              // ignore
            }
          }
        }
      } catch (failure3) {
        // ignore
      }
    }
  };

  localInstallEarlyBindShims();

  // Uninstall failure tracking (module scope for cross-function access)
  const localUninstallStats = {
    attempts: 0,
    successes: 0,
    failures: 0,
    failedTargets: []
  };

  /**
   * Check if cache hit flag is set (helper to reduce duplication)
   * @returns {boolean} True if should exit due to cache hit
   */
  function shouldSkipDueToMemoHit() {
    return window.__scrapelessCacheHitEarlyExit === true;
  }

  /**
   * Reset module state for SPA navigation
   * Prevents memory leaks from accumulating state across page transitions
   */
  function restoreModuleSession() {
    // Restore previous hooks to avoid stacking wrappers across reinjection / SPA re-init.
    try {
      uninstallAllRemainingProbes();
    } catch (failure) {
      // Best-effort cleanup only
    }

    // Clear any pending completion timeout
    if (completionDeadline) {
      clearTimeout(completionDeadline);
      completionDeadline = null;
    }

    // Reset page ready state
    sheetReadySignalReceived = false;
    sheetReadyContinuations.length = 0;

    // Reset uninstall stats
    localUninstallStats.attempts = 0;
    localUninstallStats.successes = 0;
    localUninstallStats.failures = 0;
    localUninstallStats.failedTargets.length = 0;

    // Clear window property path cache
    if (globalSignalRouteMemo) {
      globalSignalRouteMemo.clear();
    }

    const localTracker = window.__ScrapelessGlobalSignalWatcher;
    if (localTracker && typeof localTracker.restore === 'function') {
      localTracker.restore();
    }
  }

  // Send debug logs to service worker when debug mode enabled
  const encodeTraceArg = (operand) => {
    if (operand === null || operand === undefined) return String(operand);
    if (typeof operand === 'string') return operand;
    if (typeof operand === 'number' || typeof operand === 'boolean' || typeof operand === 'bigint') {
      return String(operand);
    }
    if (operand instanceof Error) {
      return `Error(${operand.message})`;
    }
    if (Array.isArray(operand)) {
      return `[Array(${operand.length})]`;
    }
    if (typeof operand === 'object') {
      try {
        const lookups = Object.keys(operand).slice(0, 6);
        return `{${lookups.join(', ')}}`;
      } catch (failure) {
        return '[Object]';
      }
    }
    return String(operand);
  };

  const sendTrace = function(localLevel, ...operands) {
    // Early return for zero overhead when debug disabled
    if (!debugStrategy) return;

    // When log collector is enabled, avoid chatty logs
    if (traceCollectorActive && localLevel === 'log') {
      return;
    }

    const localNow = Date.now();
    if (localNow - traceRateGlobalBegin >= TRACE_RATE_GLOBAL_MS) {
      traceRateGlobalBegin = localNow;
      traceRateTotal = 0;
    }
    traceRateTotal += 1;
    const limitPerGlobal = traceCollectorActive ? TRACE_LIMIT_PER_GLOBAL_WITH_COLLECTOR : TRACE_LIMIT_PER_GLOBAL;
    if (traceRateTotal > limitPerGlobal) {
      return;
    }

    try {
      const localPrefix = '[MAIN_WORLD] [Hooks]';
      let packet = [localPrefix, ...operands].map(encodeTraceArg).join(' ');
      if (packet.length > LIMIT_TRACE_PACKET_EXTENT) {
        packet = `${packet.slice(0, LIMIT_TRACE_PACKET_EXTENT)}...`;
      }

      postBridgePacket({
        type: 'SCRAPELESS_DEBUG_LOG',
        level: localLevel,
        message: packet,
        source: 'content-main-world',
        timestamp: Date.now()
      });
    } catch (failure) {
      // Silently fail
    }
  };

  // Shared, safe condition language (no eval). Provided by src/probe/property-predicate.js.
  const resolveConditionLanguage = () => {
    const localLang = globalThis.PropertyPredicateLanguage;
    if (localLang && typeof localLang.compile === 'function' && typeof localLang.describe === 'function') {
      return localLang;
    }
    return null;
  };

  // Module-level cache persists across calls
  let globalSignalRouteMemo = null;

  /**
   * Check window properties for detection
   * This is the FASTEST detection method - runs in microseconds
   * @param {Array} propertyDefinitions - Array of property definitions from detectors
   * @param {Function} onDetection - Optional callback for each detection batch
   * @returns {Array} detections - Array of detection objects
   */
  function checkGlobalSignalsCore(signalDefinitions, onScan) {
    if (!signalDefinitions || signalDefinitions.length === 0) return [];

    // Early exit on cache hit - skip all window property checks
    if (shouldSkipDueToMemoHit()) {
      sendTrace('log', '[Window Props] Cache hit detected - skipping property checks');
      return [];
    }

    const findings = [];
    // Avoid performance.now(): Performance.prototype.now is a JS_HOOKS target.
    const beginMoment = Date.now();

    if (!globalSignalRouteMemo) {
      globalSignalRouteMemo = new Map();
    }

    for (const localPropDef of signalDefinitions) {
      try {
        // Safely access nested properties (e.g., "navigator.brave" -> window.navigator.brave)
        let routeParts = globalSignalRouteMemo.get(localPropDef.path);
        if (!routeParts) {
          routeParts = localPropDef.path.split('.');
          globalSignalRouteMemo.set(localPropDef.path, routeParts);
        }
        let datum = window;

        sendTrace('log', `[Window Props] Checking: window.${localPropDef.path}`);

        // Suppress hook reporting for extension-driven property reads to avoid false positives.
        localIncrementSuppressionDepth();
        try {
          for (const localPart of routeParts) {
            if (datum == null) break; // null or undefined
            datum = datum[localPart];
          }
        } finally {
          localDecrementSuppressionDepth();
        }

        // DEBUG: Log the actual value found
        const datumKind = datum === null ? 'null' : typeof datum;
        const datumPreview = datum === null ? 'null' :
                            datum === undefined ? 'undefined' :
                            typeof datum === 'object' ? '[object]' :
                            typeof datum === 'function' ? '[function]' :
                            String(datum).substring(0, 50);
        sendTrace('log', `[Window Props] window.${localPropDef.path} = ${datumPreview} (type: ${datumKind})`);

        // Evaluate the condition
        let localConditionMet = false;
        const localCondition = localPropDef.condition || 'truthy';
        sendTrace('log', `[Window Props] Testing condition: "${localCondition}"`);

        // SECURITY: No eval(). Conditions are compiled via the shared language module.
        const localLang = resolveConditionLanguage();
        if (localLang) {
          const localCompiled = localLang.compile(localCondition);
          if (localCompiled.ok && typeof localCompiled.fn === 'function') {
            try {
              localConditionMet = !!localCompiled.fn(datum);
            } catch (failure) {
              localConditionMet = false;
            }
          } else {
            sendTrace('error', `[Window Props] Unsupported condition: "${localCondition}" (${localCompiled.reason || 'UNSUPPORTED'}). ${localLang.describe()}`);
            localConditionMet = false;
          }
        } else {
          // Fallback: if the shared module didn't load, default to truthy.
          localConditionMet = !!datum;
        }


        if (localConditionMet) {
          sendTrace('log', `[Window Props] MATCH! Condition "${localCondition}" passed for window.${localPropDef.path}`);

          const evidence = localPropDef.confidence || 80;
          const findingsPane = {
            detectorId: localPropDef.detectorId,
            detectorName: localPropDef.detectorName,
            category: localPropDef.category,
            property: {
              path: localPropDef.path,
              actualType: datum === null ? 'null' : typeof datum,
              actualValue: typeof datum === 'object' ? '[object]' : String(datum).substring(0, 100),
              condition: localCondition,
              confidence: evidence,
              description: localPropDef.description || `Window property ${localPropDef.path} detected`
            }
          };
          findings.push(findingsPane);

          sendTrace('log', `[Window Props] Detected: window.${localPropDef.path} (${localPropDef.detectorName})`);
        } else {
          sendTrace('log', `[Window Props] NO MATCH: Condition "${localCondition}" failed for window.${localPropDef.path} (value: ${datumPreview}, type: ${datumKind})`);
        }
      } catch (failure2) {
        // Property access might throw (e.g., cross-origin restrictions)
        sendTrace('warn', `[Window Props] Error checking ${localPropDef.path}:`, failure2.message);
      }
    }

    const localElapsed = Date.now() - beginMoment;
    sendTrace('log', `[Window Props] Checked ${signalDefinitions.length} properties in ${localElapsed.toFixed(2)}ms - found ${findings.length} detections`);

    // Send detections to content script if any found
    if (findings.length > 0) {
      postBridgePacket({
        type: 'GLOBAL_SIGNALS',
        detections: findings,
        timestamp: Date.now(),
        elapsedMs: localElapsed
      });
    }

    // Call detection handler if provided (for retry mechanism tracking)
    if (onScan && typeof onScan === 'function') {
      onScan(findings);
    }

    return findings;
  }

  /**
   * Uninstall all remaining hooks (called on disable or completion)
   * @returns {Object} - Statistics about uninstall results
   */
  function uninstallAllRemainingProbes() {
    if (installedProbes.size === 0) {
      sendTrace('log', `[Hooks MAIN] All hooks already uninstalled`);
      return { total: 0, successes: 0, failures: 0, failedTargets: [] };
    }

    const localTargetsToUninstall = Array.from(installedProbes.keys());

    sendTrace('log', `[Hooks MAIN] Uninstalling ${localTargetsToUninstall.length} remaining hooks...`);

    const localStats = {
      total: localTargetsToUninstall.length,
      successes: 0,
      failures: 0,
      failedTargets: []
    };

    // Batch uninstall - iterate once
    for (const probeDestination of localTargetsToUninstall) {
      const probePayload = installedProbes.get(probeDestination);
      if (!probePayload) continue;

      const { obj: targetObject, propertyName: signalLabel, originalDescriptor: priorDescriptor } = probePayload;
      try {
        Object.defineProperty(targetObject, signalLabel, priorDescriptor);
        installedProbes.delete(probeDestination);
        localStats.successes++;
        sendTrace('log', `[Hooks MAIN] Uninstalled: ${probeDestination}`);
      } catch (failure) {
        // Property might not be configurable
        localStats.failures++;
        localStats.failedTargets.push(probeDestination);
        sendTrace('error', `[Hooks MAIN] Failed to uninstall ${probeDestination}: ${failure.message}`);
      }
    }

    sendTrace('log', `[Hooks MAIN] Uninstall complete: ${localStats.successes} succeeded, ${localStats.failures} failed`);
    if (localStats.failures > 0) {
      sendTrace('warn', `[Hooks MAIN] Failed hooks remain active: ${localStats.failedTargets.join(', ')}`);
    }

    return localStats;
  }

  // Cache hit confirmed async by ISOLATED world/background via postMessage
  window.__scrapelessCacheHitEarlyExit = false;

  // Listen for authenticated control messages from ISOLATED world.
  window.addEventListener(BRIDGE_ISOLATED_TO_MAIN_SIGNAL, (signal) => {
    signal.stopImmediatePropagation?.();
    const payload = resolveTrustedIsolatedPacketPayload(signal);
    if (!payload) return;

    if (payload && payload.type === 'SCRAPELESS_PAGE_READY') {
      if (!sheetReadySignalReceived) {
        sheetReadySignalReceived = true;
        sendTrace('log', '[MAIN WORLD] Page ready message received');
        while (sheetReadyContinuations.length > 0) {
          const continuation = sheetReadyContinuations.shift();
          try {
            continuation();
          } catch (failure) {
            sendTrace('error', '[MAIN WORLD] Error executing page ready callback:', failure);
          }
        }
      }
      return;
    }

    // Handle cache hit notification from ISOLATED world
    if (payload && payload.type === 'SCRAPELESS_CACHE_HIT') {
      sendTrace('log', '[MAIN WORLD] Cache hit notification received - setting flag to stop hook reporting');
      window.__scrapelessCacheHitEarlyExit = true;
      return;
    }

    // Handle disable monitoring command (cache hit)
    if (payload && payload.type === 'HALT_PROBES') {
      sendTrace('log', '[MAIN WORLD] HALT_PROBES received - cache hit, stopping all monitoring');
      sendTrace('log', '[MAIN WORLD]   Reason:', payload.reason);
      sendTrace('log', '[MAIN WORLD]   URL:', payload.url);

      // Disable hooks monitoring - clear timeout
      if (completionDeadline) {
        clearTimeout(completionDeadline);
        completionDeadline = null;
      }
      sendTrace('log', '[Hooks MAIN] Hooks monitoring disabled due to cache hit');

      // Uninstall any installed hooks to reduce overhead
      const memoHitUninstallStats = uninstallAllRemainingProbes();
      if (memoHitUninstallStats.failures > 0) {
        sendTrace('warn', `[MAIN WORLD] Cache hit cleanup: ${memoHitUninstallStats.failures} hooks failed to uninstall`);
      }

      sendTrace('log', '[MAIN WORLD] All monitoring disabled successfully (cache hit)');
    }

    // Stop window property polling after detection completes (late results won't update anything)
    if (payload && payload.type === 'HALT_GLOBAL_POLLING') {
      const localTracker = window.__ScrapelessGlobalSignalWatcher;
      if (localTracker && localTracker.isPolling && typeof localTracker.halt === 'function') {
        localTracker.halt();
        sendTrace('log', '[MAIN WORLD] Window property polling stopped (detection finalized)');
      }
    }

    // Handle JS API events from ISOLATED world - dispatch CustomEvent to page
    // This bridges the ISOLATED/MAIN world gap so page scripts can receive events
    if (payload && payload.type === 'SCRAPELESS_JS_API_EVENT') {
      try {
        const signalLabel = payload.eventName;
        const signalDetail = payload.detail;
        const fullSignalLabel = `scrapeless:${signalLabel}`;

        // Log to PAGE DevTools console (MAIN world) so users can see events when JS API is enabled.
        // This handler only fires when JS API is enabled (checked in settings-runtime.js).
        try {
          if (typeof console !== 'undefined' && console) {
            const localLabel = `[Scrapeless JS API] ${fullSignalLabel}`;
            if (typeof console.groupCollapsed === 'function') {
              console.groupCollapsed(localLabel);
              console.log(signalDetail);
              if (typeof console.groupEnd === 'function') console.groupEnd();
            } else if (typeof console.info === 'function') {
              console.info(localLabel, signalDetail);
            } else if (typeof console.log === 'function') {
              console.log(localLabel, signalDetail);
            }
          }
        } catch (failure2) {
          // Never let console logging break event dispatch
        }

        // Store last detection for sync access by page scripts
        window.__scrapelessLastDetection = signalDetail;

        // Method 1: Dispatch CustomEvent to page window (MAIN world)
        const signal2 = new CustomEvent(fullSignalLabel, {
          detail: signalDetail,
          bubbles: true,
          cancelable: false
        });
        window.dispatchEvent(signal2);
        sendTrace('log', `[MAIN WORLD] Dispatched JS API event: ${fullSignalLabel}`);

        // Method 2: Call callback function if defined (for early setup)
        // Page can do: window.onDetection = (data) => console.log(data);
        // eventName is already like 'onDetection', so use it directly
        if (typeof window[signalLabel] === 'function') {
          try {
            window[signalLabel](signalDetail);
            sendTrace('log', `[MAIN WORLD] Called callback: window.${signalLabel}()`);
          } catch (continuationFailure) {
            sendTrace('error', `[MAIN WORLD] Callback error: ${continuationFailure.message}`);
          }
        }
      } catch (failure3) {
        sendTrace('error', '[MAIN WORLD] Failed to dispatch JS API event:', failure3.message);
      }
      return;
    }
  }, true);

  window.addEventListener('scrapeless-install-hooks', (signal) => {
    signal.stopImmediatePropagation?.();
    if (!assignBridgeToken(signal.detail?.[BRIDGE_BRIDGE_TOKEN_FIELD])) {
      return;
    }

    const localNow = Date.now();
    if (localNow - lastProbesInstallAt < runningProbesProfile.INSTALL_DEBOUNCE_MS) {
      return;
    }
    lastProbesInstallAt = localNow;

    // Check if cache hit - skip hook installation entirely
    if (shouldSkipDueToMemoHit()) {
      return;
    }

    // Reset module state for SPA navigation (prevents memory leaks)
    restoreModuleSession();

    // Set diagnosticMode first, before any logging
    debugStrategy = signal.detail?.diagnosticMode || false; // Receive debug mode from ISOLATED world
    traceCollectorActive = signal.detail?.journalActive || false;

    runningProbesProfile = assembleProbesProfile(signal.detail?.probeConfig || {});

    // Handle fingerprintEnabled flag from event
    // This is the authoritative value from ISOLATED world (updated from storage)
    const fingerprintActive = signal.detail?.fingerprintEnabled !== false;

    sendTrace('log', '[MAIN WORLD] scrapeless-install-hooks event received!', {
      hasDetail: !!signal.detail,
      hookDefinitionsCount: signal.detail?.hookDefinitions?.length,
      windowPropertiesCount: signal.detail?.windowProperties?.length,
      diagnosticMode: debugStrategy,
      fingerprintEnabled: fingerprintActive,
      probeConfig: runningProbesProfile
    });

    const probeDefinitions = signal.detail?.hookDefinitions || [];
    const globalSignals = signal.detail?.windowProperties || [];

    sendTrace('log', `[Hooks MAIN] Received ${probeDefinitions.length} detectors and ${globalSignals.length} window property checks`);

    const resilienceCoordinator = window.__ScrapelessHookRecoveryGuard;
    if (resilienceCoordinator) {
      if (typeof resilienceCoordinator.assignFailureReporter === 'function') {
        resilienceCoordinator.assignFailureReporter(postBridgePacket);
      }
      resilienceCoordinator.assignExpectedTargets(probeDefinitions);
      sendTrace('log', `[HookResilienceManager] Set ${resilienceCoordinator.expectedTargets.size} expected targets from detector definitions`);
    }
    sendTrace('log', '[MAIN WORLD] Window properties to check:', globalSignals.map(localP => localP.path));

    // Check window properties with WindowPropertyTracker
    if (globalSignals.length > 0) {
      sendTrace('log', `[Window Props] Starting WindowPropertyTracker for ${globalSignals.length} properties...`);

      const beginGlobalChecksWithTracker = () => {
        // Check cache flag before starting
        if (shouldSkipDueToMemoHit()) {
          sendTrace('log', '[Window Props] Cache hit - skipping window property checks');
          postBridgePacket({
            type: 'GLOBAL_SIGNALS_COMPLETE',
            url: window.location.href,
            timestamp: Date.now(),
            detectedCount: 0,
            reason: 'cache_hit'
          });
          return;
        }

        // Check if WindowPropertyTracker is available
        const localTracker = window.__ScrapelessGlobalSignalWatcher;
        if (localTracker) {
          // Initialize tracker with property definitions
          localTracker.start(globalSignals, {
            diagnosticMode: debugStrategy,
            postMessageToIsolated: postBridgePacket,
            onDetection: (findings) => {
              // Forward detections to content script
              postBridgePacket({
                type: 'GLOBAL_SIGNALS',
                detections: findings,
                timestamp: Date.now()
              });
            },
            onComplete: (outcome) => {
              sendTrace('log', `[Window Props] WindowPropertyTracker complete: ${outcome.detectedCount}/${outcome.totalChecked} in ${outcome.elapsedMs}ms (${outcome.reason})`);
              // GLOBAL_SIGNALS_COMPLETE is sent by the tracker itself
            }
          });

          // Start adaptive polling: EARLY 100ms -> NORMAL 200ms -> LATE 500ms -> FINAL 1000ms
          localTracker.beginPolling();
          sendTrace('log', '[Window Props] WindowPropertyTracker started with adaptive 60s polling');
        } else {
          // Fallback to legacy polling if tracker not available
          sendTrace('warn', '[Window Props] WindowPropertyTracker not available, using legacy polling');
          legacyGlobalSignalPolling(globalSignals);
        }
      };

      // Legacy polling fallback (simplified version of old code)
      const legacyGlobalSignalPolling = (signals) => {
        let detectedTotal = 0;
        const localDetectedPaths = new Set();
        const beginMoment = Date.now();
        const LIMIT_GLOBAL_MS = runningProbesProfile.DEFAULT_MAX_WINDOW_MS;
        let pollTotal = 0;
        let localChecksWithoutNew = 0;

        const localPoll = () => {
          pollTotal++;
          const localElapsed = Date.now() - beginMoment;

          if (localElapsed >= LIMIT_GLOBAL_MS || localChecksWithoutNew >= runningProbesProfile.SETTLED_CHECKS) {
            postBridgePacket({
              type: 'GLOBAL_SIGNALS_COMPLETE',
              url: window.location.href,
              timestamp: Date.now(),
              detectedCount: detectedTotal,
              totalChecked: signals.length,
              elapsedMs: localElapsed,
              reason: localElapsed >= LIMIT_GLOBAL_MS ? 'max_window_reached' : 'settled'
            });
            return;
          }

          let localNewThisPoll = 0;
          checkGlobalSignalsCore(signals, (findings) => {
            findings.forEach(localD => {
              if (!localDetectedPaths.has(localD.property?.path)) {
                localDetectedPaths.add(localD.property?.path);
                detectedTotal++;
                localNewThisPoll++;
              }
            });
          });

          localChecksWithoutNew = localNewThisPoll > 0 ? 0 : localChecksWithoutNew + 1;
          setTimeout(localPoll, runningProbesProfile.POLL_INTERVAL_MS);
        };

        localPoll();
      };

      if (document.readyState === 'complete' || sheetReadySignalReceived) {
        beginGlobalChecksWithTracker();
      } else {
        sheetReadyContinuations.push(beginGlobalChecksWithTracker);
      }
    } else {
      // No window properties to check - send completion immediately
      sendTrace('log', '[Window Props] No window properties to check - sending completion immediately');
      postBridgePacket({
        type: 'GLOBAL_SIGNALS_COMPLETE',
        url: window.location.href,
        timestamp: Date.now(),
        detectedCount: 0
      });
    }

    // Initialize/reset hooks state for this page load
    const triggeredProbes = new Set();
    // Targets whose detectors have all fired their one-shot detection. The
    // wrapper short-circuits the entire detection path for these, eliminating
    // per-call overhead on hot APIs (e.g. performance.now, getComputedStyle).
    // Lives in the per-install scope, so it resets naturally on SPA re-init.
    const exhaustedProbes = new Set();
    let probesBeginMoment = Date.now();
    let floorMonitorMs = Math.min(
      runningProbesProfile.MAX_DETECTION_MS,
      Math.max(4000, runningProbesProfile.ACTIVITY_TIMEOUT_MS * 2)
    );

    // Unified completion system with single entry point
    // Prevents race conditions between activity timeout (2s) and max timeout (3s)
    let limitDeadlineToken = null;
    let localCompletionSignalSent = false;

    /**
     * Complete hook detection with cleanup
     * @param {string} reason - 'activity_timeout' | 'max_timeout' | 'no_hooks' | 'cache_hit'
     */
    const finishedScan = (localReason) => {
      if (localCompletionSignalSent) return;
      localCompletionSignalSent = true;

      const localElapsed = Date.now() - probesBeginMoment;
      sendTrace('log', `[Hooks MAIN] Detection complete (${localReason}) - ${triggeredProbes.size} hooks in ${localElapsed}ms`);

      // Cleanup: uninstall any remaining hooks (only needed for timeout completions)
      if (localReason !== 'no_hooks' && localReason !== 'cache_hit') {
        // Log fired hooks summary before uninstalling unfired ones
        sendTrace('log', `[Hooks MAIN] DETECTION SUMMARY:`);
        sendTrace('log', `[Hooks MAIN]    Hooks that FIRED: ${triggeredProbes.size}/${priorProbesTotal || 0}`);

        if (triggeredProbes.size > 0) {
          const firedProbesCollection = Array.from(triggeredProbes).map(lookupKey => lookupKey.split(':')[1]).sort();
          sendTrace('log', `[Hooks MAIN]    Fired hooks:`, firedProbesCollection);
        }

        if (installedProbes.size > 0) {
          const unfiredProbes = Array.from(installedProbes.keys()).sort();
          sendTrace('log', `[Hooks MAIN]    Hooks that NEVER FIRED: ${installedProbes.size}`);
          sendTrace('log', `[Hooks MAIN]    Unfired hooks:`, unfiredProbes);
          sendTrace('log', `[Hooks MAIN] Uninstalling ${installedProbes.size} remaining unfired hooks...`);
          const localBulkUninstallStats = uninstallAllRemainingProbes();
          localUninstallStats.attempts += localBulkUninstallStats.total;
          localUninstallStats.successes += localBulkUninstallStats.successes;
          localUninstallStats.failures += localBulkUninstallStats.failures;
          localUninstallStats.failedTargets.push(...localBulkUninstallStats.failedTargets);
        }

        // Log final stats
        if (localUninstallStats.attempts > 0) {
          sendTrace('log', `[Hooks MAIN] Final: ${localUninstallStats.successes}/${localUninstallStats.attempts} uninstalled (${localUninstallStats.failures} failed)`);
        }
      }

      // Clear pending timeouts
      if (completionDeadline) {
        clearTimeout(completionDeadline);
        completionDeadline = null;
      }
      if (limitDeadlineToken) {
        clearTimeout(limitDeadlineToken);
        limitDeadlineToken = null;
      }

      // Send completion signal
      postBridgePacket({
        type: 'PROBE_HOOKS_COMPLETE',
        url: window.location.href,
        timestamp: Date.now(),
        totalDetections: triggeredProbes.size,
        uniqueHooks: triggeredProbes.size,
        completionReason: localReason,
        completionTime: localElapsed,
        uninstallStats: {
          attempts: localUninstallStats.attempts,
          successes: localUninstallStats.successes,
          failures: localUninstallStats.failures,
          failedTargets: localUninstallStats.failedTargets.slice()
        }
      });
    };

    // Reset uninstall failure tracking for this page load
    localUninstallStats.attempts = 0;
    localUninstallStats.successes = 0;
    localUninstallStats.failures = 0;
    localUninstallStats.failedTargets.length = 0;

    let aggregateProbesTotal = 0;
    for (const rule of probeDefinitions) {
      aggregateProbesTotal += rule.hooks.length;
    }
    sendTrace('log', `[Hooks MAIN] Total hooks to install: ${aggregateProbesTotal}`);

    /**
     * Uninstall a hook by restoring its original property descriptor
     * @param {string} hookTarget - Hook target (e.g., "Performance.prototype.now")
     * @returns {boolean} - True if uninstalled successfully, false if failed
     */
    function uninstallProbe(probeDestination) {
      const probePayload = installedProbes.get(probeDestination);
      if (!probePayload) {
        sendTrace('warn', `[Hooks MAIN] Cannot uninstall ${probeDestination} - not found in installedHooks`);
        return false; // Already uninstalled or never installed
      }

      const { obj: targetObject, propertyName: signalLabel, originalDescriptor: priorDescriptor } = probePayload;
      try {
        Object.defineProperty(targetObject, signalLabel, priorDescriptor);
        installedProbes.delete(probeDestination);
        sendTrace('log', `[Hooks MAIN] Uninstalled: ${probeDestination}`);
        return true;
      } catch (failure) {
        // Uninstall failed - likely property is non-configurable
        sendTrace('error', `[Hooks MAIN] Failed to uninstall ${probeDestination}: ${failure.message}`);
        sendTrace('error', `[Hooks MAIN]    Reason: Property "${signalLabel}" is likely non-configurable`);
        sendTrace('error', `[Hooks MAIN]    Hook will remain active until page unload`);
        // Don't delete from installedHooks - keeps metadata for debugging
        return false;
      }
    }

    /**
     * Schedule completion after activity timeout (2s of inactivity)
     * Resets on each hook detection
     */
    function localScheduleCompletion() {
      if (completionDeadline) clearTimeout(completionDeadline);
      completionDeadline = setTimeout(() => {
        const localElapsed = Date.now() - probesBeginMoment;
        if (localElapsed < floorMonitorMs) {
          const localRemaining = floorMonitorMs - localElapsed;
          sendTrace('log', `[Hooks MAIN] Minimum monitor window not reached (${localElapsed}ms/${floorMonitorMs}ms) - extending by ${localRemaining}ms`);
          completionDeadline = setTimeout(() => {
            finishedScan('activity_timeout');
          }, localRemaining);
          return;
        }

        finishedScan('activity_timeout');
      }, runningProbesProfile.ACTIVITY_TIMEOUT_MS);
    }

    function reportProbeFindingsForDestination(probeDestination) {
      // Cache-hit decisions must come from authoritative signals (ISOLATED world/background).
      // sessionStorage-based cache hints can go stale after manual cache clears or settings changes.
      if (shouldSkipDueToMemoHit()) {
        return;
      }

      const probePayload = installedProbes.get(probeDestination);
      const ruleSet = probePayload && probePayload.detectors instanceof Map ? probePayload.detectors : null;
      const ruleTotal = ruleSet ? ruleSet.size : 0;

      if (!ruleSet || ruleTotal === 0) {
        // Still count activity so completion can settle reliably.
        localScheduleCompletion();
        return;
      }

      const momentElapsed = Date.now() - probesBeginMoment;
      let newFindings = 0;

      for (const [ruleToken, detail] of ruleSet.entries()) {
        const scanLookup = `${ruleToken}:${probeDestination}`;
        if (triggeredProbes.has(scanLookup)) continue;

        triggeredProbes.add(scanLookup);
        newFindings++;

        const ruleLabel = detail?.detectorName || ruleToken;
        const taxonomy = detail?.category;
        const probe = detail?.hook || { target: probeDestination };

        sendTrace('log', `[Hooks MAIN] Hook detected: ${probeDestination} (${ruleLabel})`);

        postBridgePacket({
          type: 'PROBE_SIGNAL',
          detection: {
            detectorId: ruleToken,
            detectorName: ruleLabel,
            category: taxonomy,
            hook: {
              target: probeDestination,
              confidence: probe.confidence,
              description: probe.description
            },
            timestamp: Date.now()
          },
          url: window.location.href
        });
      }

      if (newFindings > 0) {
        // DEBUG: log once per target fire (prevents log spam when multiple detectors share a hook target)
        sendTrace('log', `[Hooks DEBUG] HOOK FIRED +${newFindings}: ${probeDestination} (${ruleTotal} detector(s)) - at ${momentElapsed}ms`);
        // Reset the inactivity timer only on genuine NEW detections. Duplicate
        // fires of an already-detected target are not new activity and must not
        // churn clearTimeout/setTimeout on every hot-path call.
        localScheduleCompletion();
      } else {
        sendTrace('log', `[Hooks MAIN] Duplicate hook detected: ${probeDestination}`);
      }

      // Once every detector for this target has fired its one-shot message, mark
      // the target exhausted so the wrapper stops invoking the detection path.
      // This also covers non-configurable targets that cannot be uninstalled.
      let localAllTriggered = true;
      for (const ruleToken2 of ruleSet.keys()) {
        if (!triggeredProbes.has(`${ruleToken2}:${probeDestination}`)) { localAllTriggered = false; break; }
      }
      if (localAllTriggered) exhaustedProbes.add(probeDestination);

      // Uninstall hook immediately after firing to reduce overhead
      if (newFindings > 0) {
        const localUninstalled = uninstallProbe(probeDestination);
        if (localUninstalled) {
          localUninstallStats.successes++;
          sendTrace('log', `[Hooks MAIN] Immediately uninstalled: ${probeDestination} (${installedProbes.size} remaining)`);
        } else {
          localUninstallStats.failures++;
          localUninstallStats.failedTargets.push(probeDestination);
          sendTrace('warn', `[Hooks MAIN] Failed to uninstall: ${probeDestination}`);
        }
      }
    }

    const localStealthDescriptors = {
      name: { writable: false, enumerable: false, configurable: true },
      length: { writable: false, enumerable: false, configurable: true },
      toString: { writable: true, enumerable: false, configurable: true }
    };

    // Wrapper factory for faster hook creation
    // Creates lightweight wrappers without repeated property definitions
    // FIXED: Preserves proper 'this' context to avoid "Illegal invocation" errors
    function resolveContextFromDestination(destination) {
      if (!destination || typeof destination !== 'string') return null;
      if (destination.startsWith('Navigator.prototype.')) return window.navigator || null;
      if (destination.startsWith('NavigatorUAData.prototype.')) return window.navigator?.userAgentData || null;
      if (destination.startsWith('MediaDevices.prototype.')) return window.navigator?.mediaDevices || null;
      if (destination.startsWith('Performance.prototype.')) return window.performance || null;
      if (destination.startsWith('Screen.prototype.')) return window.screen || null;
      if (destination.startsWith('History.prototype.')) return window.history || null;
      if (destination.startsWith('Location.prototype.')) return window.location || null;
      if (destination.startsWith('Document.prototype.') || destination.startsWith('HTMLDocument.prototype.')) return window.document || null;
      if (destination.startsWith('Storage.prototype.')) return window.localStorage || window.sessionStorage || null;
      return null;
    }

    function composeStealthWrapper(prior, continuation, localExplicitContext, destination, localIsGetter = false) {
      const localWrapper = function(...operands) {
        // Detection is one-shot per target. Skip the whole detection path for
        // extension-driven internal reads AND for targets already fully detected
        // (exhausted) — this removes per-call overhead on hot APIs.
        if (!isProbeReportingSuppressed() && !exhaustedProbes.has(destination)) {
          try {
            continuation();
          } catch (failure) {
            // Detection error must never break the page API.
            if (debugStrategy) sendTrace('error', `[Hooks MAIN] Detection callback error for ${destination}: ${resolveFailurePacket(failure)}`);
          }
        }

        // Prefer the natural 'this'; fall back to a resolved context only when
        // 'this' is missing (e.g. destructured calls: const { getBattery } = navigator).
        const localDynamicContext = (localExplicitContext && typeof localExplicitContext !== 'function')
          ? localExplicitContext
          : resolveContextFromDestination(destination);
        const localContext = (this === undefined || this === null) ? (localDynamicContext || this) : this;

        try {
          // Return the original result/promise untouched to preserve identity.
          return Reflect.apply(prior, localContext, operands);
        } catch (failure2) {
          // Last-resort retry ONLY for a genuine "Illegal invocation" when a
          // different context is available. All other errors propagate exactly
          // like the native call (no double-execution of side-effecting APIs).
          if (localDynamicContext && localDynamicContext !== localContext && isIllegalInvocationFailure(failure2)) {
            return Reflect.apply(prior, localDynamicContext, operands);
          }
          throw failure2;
        }
      };

      // Apply stealth properties in one batch
      try {
        Object.defineProperties(localWrapper, {
          'name': { ...localStealthDescriptors.name, value: prior.name },
          'length': { ...localStealthDescriptors.length, value: prior.length },
          'toString': {
            ...localStealthDescriptors.toString,
            value: function localToString() {
              return Function.prototype.toString.call(prior);
            }
          }
        });

        // Copy prototype for methods
        if (!localIsGetter && prior.prototype) {
          localWrapper.prototype = prior.prototype;
          Object.setPrototypeOf(localWrapper, Object.getPrototypeOf(prior));
        }
      } catch (failure) {
        // Stealth properties failed, wrapper still works
      }

      return localWrapper;
    }

    // A non-`.prototype.` function target that owns a real prototype object is a
    // constructor/namespace (Intl.DateTimeFormat, DeviceMotionEvent, …). Wrapping it
    // as a plain function would silently drop its static methods (e.g.
    // Intl.DateTimeFormat.supportedLocalesOf) and break `new`/subclassing, which
    // crashes strict apps during init. We refuse to hook these.
    function isConstructorLikeDestination(operation) {
      try {
        const localProtoDesc = Object.getOwnPropertyDescriptor(operation, 'prototype');
        return !!(localProtoDesc && localProtoDesc.value && typeof localProtoDesc.value === 'object');
      } catch (failure) {
        return true; // conservative: if unsure, don't wrap
      }
    }

    function installProbe(ruleToken, ruleLabel, taxonomy, probe) {
      // Enhanced with HookResilienceManager integration
      try {
        // Step 1: Verify hook target is valid using HookResilienceManager
        const resilienceCoordinator = window.__ScrapelessHookRecoveryGuard;
        if (resilienceCoordinator) {
          const localVerification = resilienceCoordinator.verifyProbeDestination(probe.target);
          if (!localVerification.canInstall) {
            // Report verification failure
            resilienceCoordinator.registerProbeFailure(probe.target, localVerification.reason);
            sendTrace('warn', `[Hooks MAIN] Verification failed for ${probe.target}: ${localVerification.reason}`);
            return false;
          }
        }

        const localParts = probe.target.split('.');
        if (localParts.length < 2) {
          if (resilienceCoordinator) {
            resilienceCoordinator.registerProbeFailure(probe.target, 'INVALID_PATH');
          }
          return false;
        }

        let targetObject = window;
        for (let cursor = 0; cursor < localParts.length - 1; cursor++) {
          targetObject = targetObject[localParts[cursor]];
          if (!targetObject) {
            if (resilienceCoordinator) {
              resilienceCoordinator.registerProbeFailure(probe.target, 'PATH_NOT_FOUND');
            }
            return false;
          }
        }

        const signalLabel = localParts[localParts.length - 1];
        const priorDescriptor = Reflect.getOwnPropertyDescriptor(targetObject, signalLabel);
        if (!priorDescriptor) {
          if (resilienceCoordinator) {
            resilienceCoordinator.registerProbeFailure(probe.target, 'PROPERTY_NOT_FOUND');
          }
          return false;
        }

        // Never destructively wrap a constructor/namespace target. Detectors that
        // target these (e.g. Intl.DateTimeFormat) must use a window-property check
        // instead. Accessor/data window.* props (devicePixelRatio, innerHeight,
        // speechSynthesis) are NOT functions, so they remain hookable.
        if (!probe.target.includes('.prototype.') &&
            typeof priorDescriptor.value === 'function' &&
            isConstructorLikeDestination(priorDescriptor.value)) {
          if (resilienceCoordinator) {
            resilienceCoordinator.registerProbeFailure(probe.target, 'CONSTRUCTOR_TARGET_NOT_HOOKABLE');
          }
          sendTrace('warn', `[Hooks MAIN] Skipped constructor/namespace target (would break page): ${probe.target}`);
          return false;
        }

        const retainedProbe = installedProbes.get(probe.target);
        if (retainedProbe) {
          // Hook already installed - just add this detector to its list
          retainedProbe.detectors.set(ruleToken, { detectorName: ruleLabel, category: taxonomy, hook: probe });
          return retainedProbe;
        }

        // Resolve windowPath if provided in JSON (e.g., "navigator" for Navigator.prototype.getBattery)
        let localExplicitContext = null;
        if (probe.windowPath) {
          const routeParts = probe.windowPath.split('.');
          localExplicitContext = routeParts.reduce((localParent, localPart) => localParent?.[localPart], window);
          if (!localExplicitContext) {
            sendTrace('warn', `[Hooks] Failed to resolve windowPath "${probe.windowPath}" for ${probe.target}`);
            localExplicitContext = null;
          } else if (typeof localExplicitContext === 'function') {
            // windowPath points to a constructor (e.g., BatteryManager); not a usable instance
            localExplicitContext = null;
          }
        }
        if (!localExplicitContext) {
          localExplicitContext = resolveContextFromDestination(probe.target);
        }

        const probeMetadata = {
          obj: targetObject,
          propertyName: signalLabel,
          originalDescriptor: priorDescriptor,
          detectors: new Map([[ruleToken, { detectorName: ruleLabel, category: taxonomy, hook: probe }]]),
          wrapper: null
        };

        // Create callback once to avoid closure overhead
        const reportContinuation = () => reportProbeFindingsForDestination(probe.target);

        // Handle getter properties - use optimized wrapper factory
        let localWrapperDescriptor = null;
        if (priorDescriptor.get && !priorDescriptor.value) {
          const localStealthGetter = composeStealthWrapper(priorDescriptor.get, reportContinuation, localExplicitContext, probe.target, true);

          localWrapperDescriptor = {
            get: localStealthGetter,
            set: priorDescriptor.set,
            enumerable: priorDescriptor.enumerable,
            configurable: priorDescriptor.configurable
          };
          Object.defineProperty(targetObject, signalLabel, localWrapperDescriptor);
          probeMetadata.wrapper = localStealthGetter;
        }
        // Handle regular methods - use optimized wrapper factory
        else if (typeof priorDescriptor.value === 'function') {
          const localWrapper = composeStealthWrapper(priorDescriptor.value, reportContinuation, localExplicitContext, probe.target, false);

          localWrapperDescriptor = {
            value: localWrapper,
            writable: priorDescriptor.writable,
            enumerable: priorDescriptor.enumerable,
            configurable: priorDescriptor.configurable
          };
          Object.defineProperty(targetObject, signalLabel, localWrapperDescriptor);
          probeMetadata.wrapper = localWrapper;
        }

        installedProbes.set(probe.target, probeMetadata);

        // Register successful installation with HookResilienceManager
        if (resilienceCoordinator && localWrapperDescriptor) {
          resilienceCoordinator.registerProbeInstall(probe.target, priorDescriptor, localWrapperDescriptor);
        }

        return probeMetadata;
      } catch (failure) {
        sendTrace('error', `[Hooks MAIN] Failed to install ${probe.target}:`, failure);
        // Report failure to HookResilienceManager
        const resilienceCoordinator2 = window.__ScrapelessHookRecoveryGuard;
        if (resilienceCoordinator2) {
          resilienceCoordinator2.registerProbeFailure(probe.target, failure.message);
        }
        return false;
      }
    }

    // Track installation success/failure
    let completionTotal = 0;
    let failTotal = 0;
    const localFailed = [];
    const localExpectedFailed = [];
    const localInstalled = new Map();
    const localFailureReasons = {};

    for (const rule2 of probeDefinitions) {
      for (const probe of rule2.hooks) {
        try {
          const installOutcome = installProbe(rule2.id, rule2.name, rule2.category, probe);

          if (installOutcome !== false) {
            const localAlreadyInstalled = localInstalled.has(probe.target);
            if (!localAlreadyInstalled) {
              completionTotal++;
              sendTrace('log', `[Hooks DEBUG] INSTALLED: ${probe.target} (${rule2.name})`);
            } else {
              sendTrace('log', `[Hooks DEBUG] Reused existing hook for ${probe.target} (already installed)`);
            }

            const localEntry = localInstalled.get(probe.target) || { detectors: new Set() };
            localEntry.detectors.add(rule2.name);
            localInstalled.set(probe.target, localEntry);
          } else {
            failTotal++;
            const localIsExpectedFailure = LOCAL_EXPECTED_UNAVAILABLE_APIS.some(localEf => probe.target.includes(localEf));

            if (localIsExpectedFailure) {
              localExpectedFailed.push(probe.target);
              sendTrace('log', `[Hooks DEBUG] EXPECTED: ${probe.target} not available (${rule2.name}) - API not present in this context`);
            } else {
              localFailed.push(probe.target);
              sendTrace('warn', `[Hooks DEBUG] FAILED: ${probe.target} (${rule2.name}) - returned false`);
            }

            localFailureReasons[probe.target] = (localFailureReasons[probe.target] || []).concat('installHook returned false');
          }
        } catch (failure) {
          failTotal++;
          localFailed.push(probe.target);
          localFailureReasons[probe.target] = (localFailureReasons[probe.target] || []).concat(failure.message);
          sendTrace('error', `[Hooks DEBUG] EXCEPTION: ${probe.target} (${rule2.name}) - ${failure.message}`);
        }
      }
    }

    // CRITICAL TIMING: Record when hook installation completes
    // Avoid performance.now(): Performance.prototype.now is a JS_HOOKS target.
    const probesInstalledMoment = Date.now();

    sendTrace('log', `[Hooks MAIN] Installation complete: ${completionTotal} hooks installed, ${failTotal} failures (${localExpectedFailed.length} expected), ${localInstalled.size} total hook targets`);
    if (localInstalled.size) {
      sendTrace('log', `[Hooks DEBUG] Active hooks: ${Array.from(localInstalled.entries()).map(([destination, localMeta]) => `${destination} (detectors: ${Array.from(localMeta.detectors).join(', ')})`).join('; ')}`);
    }

    // Report unexpected failures as warnings, expected failures as info
    if (localFailed.length > 0) {
      sendTrace('warn', `[Hooks MAIN] Unexpected failures (${localFailed.length}): ${localFailed.join(', ')}`);
      sendTrace('warn', `[Hooks DEBUG] Failure details:`, localFailureReasons);
    }

    if (localExpectedFailed.length > 0) {
      sendTrace('log', `[Hooks MAIN] Expected unavailable APIs (${localExpectedFailed.length}): ${localExpectedFailed.join(', ')}`);
      sendTrace('log', `[Hooks MAIN] These APIs are browser/context-specific (WebUSB requires HTTPS + Chrome, Battery API deprecated, sensors require permission)`);
    }

    if (failTotal === 0) {
      sendTrace('log', `[Hooks MAIN] All hooks installed successfully!`);
    }
    const plannedFloorMonitorMs = Math.min(
      runningProbesProfile.MAX_DETECTION_MS,
      Math.max(4000, runningProbesProfile.ACTIVITY_TIMEOUT_MS * 2)
    );
    sendTrace('log', `[Hooks MAIN] Waiting for page to trigger fingerprinting APIs (max ${runningProbesProfile.MAX_DETECTION_MS}ms, activity ${runningProbesProfile.ACTIVITY_TIMEOUT_MS}ms, min ${plannedFloorMonitorMs}ms)...`);

    // Save original hooks list since they're uninstalled when they fire
    const originallyInstalledProbes = Array.from(installedProbes.keys());
    const priorProbesTotal = originallyInstalledProbes.length;

    const beginProbeMonitoring = () => {
      sendTrace('log', '[Hooks MAIN] Hook monitoring active - scheduling completion');

      sendTrace('log', `[Hooks MAIN] Config: activity=${runningProbesProfile.ACTIVITY_TIMEOUT_MS}ms, minMonitor=${floorMonitorMs}ms, max=${runningProbesProfile.MAX_DETECTION_MS}ms`);

      // Maximum timeout for guaranteed completion (even if hooks keep firing)
      limitDeadlineToken = setTimeout(() => {
        finishedScan('max_timeout');
      }, runningProbesProfile.MAX_DETECTION_MS);

      // Activity timeout (2s of inactivity)
      localScheduleCompletion();
    };

    if (sheetReadySignalReceived || document.readyState === 'complete') {
      beginProbeMonitoring();
    } else {
      sheetReadyContinuations.push(beginProbeMonitoring);
    }

    // Send completion if no hooks installed
    if (probeDefinitions.length === 0 || probeDefinitions.every(localD => localD.hooks.length === 0)) {
      finishedScan('no_hooks');
    }
  }, { capture: true });
})();
