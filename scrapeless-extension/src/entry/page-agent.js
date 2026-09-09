/**
 * Content Script (ISOLATED World)
 * Detection system phases 3-4: Batching & completion.
 * Batches hook detections from MAIN world, deduplicates by "detectorId:target",
 * and completes after 2s of inactivity (resets on any hook activity).
 */

// Global variables - use var to allow redeclaration during extension reloads
var scanEvaluator = scanEvaluator || null;
var isDisposed = isDisposed || false;
var contextWatchTimer = contextWatchTimer || null; // Interval for context validity checks
var routeMutationObserver = routeMutationObserver || null; // SPA URL-change observer (module-scoped so cleanup can disconnect it)
var routeDebounceTimer = routeDebounceTimer || null;
var scanDelivered = scanDelivered || false; // Flag to suppress late events after onDetection
var probeFinished = probeFinished || false;

const BRIDGE_BRIDGE_TOKEN_FIELD = '__scrapelessBridgeToken';
const BRIDGE_BRIDGE_INIT_SIGNAL = 'scrapeless-bridge-init';
const BRIDGE_ISOLATED_TO_MAIN_SIGNAL = 'scrapeless-isolated-bridge-message';
const BRIDGE_MAIN_TO_ISOLATED_SIGNAL = 'scrapeless-main-bridge-message';
const BRIDGE_ALLOWED_MAIN_PACKET_TYPES = new Set([
    'PROBE_FAILURE_REPORT',
    'PROBE_TAMPERING_DETECTED',
    'PROBE_RECOVERY_RESULT',
    'GLOBAL_SIGNALS',
    'SCRAPELESS_DEBUG_LOG',
    'SCRAPELESS_LOG',
    'PROBE_SIGNAL',
    'PROBE_HOOKS_COMPLETE',
    'GLOBAL_SIGNALS_COMPLETE',
    'PAGE_AGENT_RECORD'
]);

var bridgeNonce = bridgeNonce || composeBridgeBridgeToken();

function composeBridgeBridgeToken() {
    try {
        const localBytes = new Uint32Array(4);
        crypto.getRandomValues(localBytes);
        return Array.from(localBytes, datum => datum.toString(16).padStart(8, '0')).join('');
    } catch (failure) {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
}

function localSendToMainWorld(packet) {
    if (!packet || typeof packet !== 'object') {
        return false;
    }

    try {
        window.dispatchEvent(new CustomEvent(BRIDGE_ISOLATED_TO_MAIN_SIGNAL, {
            detail: {
                ...packet,
                [BRIDGE_BRIDGE_TOKEN_FIELD]: bridgeNonce
            }
        }));
        return true;
    } catch (failure) {
        Telemetry.performDebug('CONTENT', '[bridge] Failed to send MAIN world message', failure);
        return false;
    }
}

function startMainWorldBridge() {
    try {
        window.dispatchEvent(new CustomEvent(BRIDGE_BRIDGE_INIT_SIGNAL, {
            detail: {
                [BRIDGE_BRIDGE_TOKEN_FIELD]: bridgeNonce
            }
        }));
    } catch (failure) {
        Telemetry.performDebug('CONTENT', '[bridge] Failed to initialize MAIN world bridge', failure);
    }
}

function resolveTrustedMainWorldPacketPayload(signal) {
    const payload = signal?.detail;
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    if (payload[BRIDGE_BRIDGE_TOKEN_FIELD] !== bridgeNonce) {
        return null;
    }

    if (!BRIDGE_ALLOWED_MAIN_PACKET_TYPES.has(payload.type)) {
        return null;
    }

    return payload;
}

window.ScrapelessBridge = {
    getToken: () => bridgeNonce,
    sendToMainWorld: localSendToMainWorld
};

/**
 * Install JS Hooks early (at document_start)
 * Delegates to DetectionEngineManager.installHooksOrchestrator()
 */
async function installJsProbes() {
    return ScanEngine.installProbesOrchestrator(window, chrome);
}

async function rearmProbesForNewScanIfNeeded() {
    if (!scanDelivered && !probeFinished && window.__scrapelessCacheHitEarlyExit !== true) {
        return;
    }

    scanDelivered = false;
    probeFinished = false;
    window.__scrapelessCacheHitEarlyExit = false;
    startMainWorldBridge();
    try {
        await installJsProbes();
    } catch (failure) {
        Telemetry.performWarn('CONTENT', '[hooks] Failed to re-arm hooks for new detection', failure);
    }
}

/**
 * Check if extension context is still valid
 * Delegates to Utils.isExtensionContextValid()
 */
function isExtensionContextAccepted() {
    if (typeof ExtensionGateway === 'undefined') {
        if (typeof Telemetry !== 'undefined') {
            Telemetry.performDebug('CONTENT', '[isExtensionContextValid] Utils not loaded yet');
        }
        return false;
    }
    return ExtensionGateway.hasLiveRuntime();
}

/**
 * Clean up when extension context is invalidated
 * Delegates to Utils.cleanupOrphanedScript()
 */
function localCleanupOrphanedScript() {
    if (typeof ExtensionGateway === 'undefined') {
        if (typeof Telemetry !== 'undefined') {
            Telemetry.performDebug('CONTENT', '[cleanupOrphanedScript] Utils not loaded, skipping');
        }
        return;
    }
    const localCleaned = ExtensionGateway.disposePageAgent({
        hasCleanedUp: isDisposed,
        contextCheckInterval: contextWatchTimer,
        notifyPageLoad: notifySheetRead,
        detectionEngine: scanEvaluator
    });
    if (localCleaned) {
        // The boolean was passed by value, so Utils flipped only its own copy.
        // Write the latch back to the module flag here, then disconnect the SPA
        // observer (otherwise it keeps firing for the orphaned page's lifetime).
        isDisposed = true;
        haltSpaObserver();
    }
    return localCleaned;
}

function haltSpaObserver() {
    if (routeMutationObserver) {
        try { routeMutationObserver.disconnect(); } catch (failure) {}
        routeMutationObserver = null;
    }
    if (routeDebounceTimer) {
        clearTimeout(routeDebounceTimer);
        routeDebounceTimer = null;
    }
}

/**
 * Safely send message to background with context check
 * @param {Object} message - Message to send
 * @returns {Promise} Response or null if context invalid
 */
async function safeSendPacket(packet) {
    if (!isExtensionContextAccepted()) {
        Telemetry.performContent('Context invalid, skipping message', { type: packet.type });
        return null;
    }

    try {
        return await chrome.runtime.sendMessage(packet);
    } catch (failure) {
        if (failure.message?.includes('Extension context invalidated')) {
            localCleanupOrphanedScript();
            return null;
        }
        throw failure;
    }
}

/**
 * Dispatch JS API event to page window
 * Delegates to the runtime-safe PreferencesPresenter facade.
 */
async function dispatchJsApiSignal(signalLabel, payload = {}) {
    return PreferencesPresenter.emitPublicApiEvent(signalLabel, payload);
}

/**
 * Dispatch ready event
 * Delegates to the runtime-safe PreferencesPresenter facade.
 */
async function dispatchReadySignal() {
    await PreferencesPresenter.emitPublicReady();
}

/**
 * Notify background about page load (cache check first)
 * Delegates to Utils.notifyPageLoad()
 * @param {string} triggerSource - What triggered this notification (page_load, visibility_change, url_change, manual)
 */
async function notifySheetRead(triggerOrigin = 'page_load') {
    if (typeof ExtensionGateway === 'undefined') {
        if (typeof Telemetry !== 'undefined') {
            Telemetry.performDebug('CONTENT', '[notifyPageLoad] Utils not loaded, skipping');
        }
        return;
    }
    return ExtensionGateway.announceNavigation({
        detectionEngine: scanEvaluator,
        isExtensionContextValid: isExtensionContextAccepted,
        cleanupOrphanedScript: localCleanupOrphanedScript,
        triggerSource: triggerOrigin
    });
}

/**
 * Collect page data and send to background (called when cache miss)
 * Delegates to Utils.collectAndSendData()
 */
async function collectAndSendPayload() {
    Telemetry.performDebug('CONTENT', '[collectAndSendData] Called');
    if (typeof ExtensionGateway === 'undefined') {
        if (typeof Telemetry !== 'undefined') {
            Telemetry.performDebug('CONTENT', '[collectAndSendData] Utils not loaded, skipping');
        }
        return;
    }
    await rearmProbesForNewScanIfNeeded();
    Telemetry.performDebug('CONTENT', '[collectAndSendData] Delegating to Utils');
    return ExtensionGateway.submitPageSnapshot({
        detectionEngine: scanEvaluator,
        isExtensionContextValid: isExtensionContextAccepted,
        cleanupOrphanedScript: localCleanupOrphanedScript
    });
}

/**
 * Setup detection triggers
 * OPTIMIZED 2.3: Consolidated event listeners with debouncing
 */
function wireScanTriggers() {
    Telemetry.performContent('Setting up detection triggers...');

    // Notify page load AFTER all resources load (background checks cache first)
    // Use 'load' event instead of 'DOMContentLoaded' to ensure async scripts (like reCAPTCHA) are loaded
    if (document.readyState === 'complete') {
        // Page already fully loaded, notify immediately
        setTimeout(notifySheetRead, 100);
    } else {
        // Wait for all external resources to load
        window.addEventListener('load', () => {
            // Add small delay to ensure scripts have executed
            setTimeout(notifySheetRead, 200);
        }, { once: true });
    }

    // Debounced SPA URL change detection
    let lastAddress = location.href;
    routeMutationObserver = new MutationObserver(() => {
        if (isDisposed) return;

        const activeAddress = location.href;
        if (activeAddress !== lastAddress) {
            lastAddress = activeAddress;

            // Debounce URL changes (utils.js has 2000ms debounce)
            if (routeDebounceTimer) clearTimeout(routeDebounceTimer);
            routeDebounceTimer = setTimeout(() => {
                Telemetry.performContent('URL changed, notifying with url_change trigger...');
                notifySheetRead('url_change');
                routeDebounceTimer = null;
            }, 100);
        }
    });

    // Start observing URL changes (wait for body to exist since we run at document_start)
    if (document.body) {
        routeMutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    } else {
        // Wait for body to be available (with safety timeout)
        let checkTotal = 0;
        const limitChecks = 500; // 5 seconds max (500 * 10ms)
        const localCheckBody = setInterval(() => {
            checkTotal++;
            if (document.body) {
                clearInterval(localCheckBody);
                routeMutationObserver.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            } else if (checkTotal >= limitChecks) {
                clearInterval(localCheckBody);
                Telemetry.performWarn('CONTENT', '[init] Timeout waiting for document.body');
            }
        }, 10);
    }

    // Listen for messages from background script
    if (isExtensionContextAccepted()) {
        chrome.runtime.onMessage.addListener((inbound, localSender, sendReply) => {
            // Check if context is still valid
            if (!isExtensionContextAccepted()) {
                Telemetry.performContent('Extension context invalidated, cannot respond to message');
                return false;
            }

            Telemetry.performContent('Received message', { type: inbound.type });

            if (inbound.type === 'REQUEST_PAGE_DATA') {
                // Background requests data collection (cache miss)
                Telemetry.performContent('REQUEST_PAGE_DATA received - starting collection');

                // JS API: Notify page that detection is starting (cache miss)
                dispatchJsApiSignal('onStart', {
                    url: window.location.href,
                    trigger: 'cache_miss',
                    timestamp: new Date().toISOString()
                }).catch(() => {});

                // Ensure Utils is loaded before collecting data
                if (typeof ExtensionGateway === 'undefined') {
                    Telemetry.performDebug('CONTENT', '[init] Utils not loaded, retrying in 500ms');
                    // Retry after Utils loads
                    setTimeout(() => {
                        if (typeof ExtensionGateway !== 'undefined') {
                            Telemetry.performDebug('CONTENT', '[init] Utils loaded on retry, collecting data');
                            collectAndSendPayload();
                        } else {
                            Telemetry.performWarn('CONTENT', '[init] Utils still not loaded after retry');
                        }
                    }, 500);
                } else {
                    Telemetry.performDebug('CONTENT', '[init] Utils loaded, collecting data');
                    collectAndSendPayload();
                }

                sendReply({ status: 'collecting_data' });
            } else if (inbound.type === 'RUN_DETECTION') {
                // Manual detection request from popup (force bypass cache)
                Telemetry.performContent('RUN_DETECTION received - starting manual detection');

                // JS API: Notify page that detection is starting (manual trigger)
                dispatchJsApiSignal('onStart', {
                    url: window.location.href,
                    trigger: 'manual',
                    timestamp: new Date().toISOString()
                }).catch(() => {});

                // Ensure Utils is loaded before collecting data
                if (typeof ExtensionGateway === 'undefined') {
                    Telemetry.failure('CONTENT', 'Utils not loaded yet, waiting and retrying...');
                    // Retry after Utils loads
                    setTimeout(() => {
                        if (typeof ExtensionGateway !== 'undefined') {
                            Telemetry.performContent('Utils now loaded, collecting data...');
                            collectAndSendPayload();
                        } else {
                            Telemetry.failure('CONTENT', 'Utils still not loaded, detection failed');
                        }
                    }, 500);
                } else {
                    collectAndSendPayload();
                }

                sendReply({ status: 'detection_started' });
            } else if (inbound.type === 'GET_DETECTION_STATUS') {
                // Return current detection status
                sendReply({
                    status: 'active',
                    lastDetection: scanEvaluator ? scanEvaluator.lastDetectionTime : null,
                    hasData: scanEvaluator ? scanEvaluator.detectionData !== null : false
                });
            } else if (inbound.type === 'DETECTION_COMPLETE') {
                // Detection completed - dispatch JS API event
                scanDelivered = true;
                probeFinished = true;
                Telemetry.performContent('[Content] Received DETECTION_COMPLETE from background', {
                    url: inbound.url,
                    detectionCount: inbound.detectionCount
                });
                dispatchJsApiSignal('onDetection', {
                    url: inbound.url || window.location.href,
                    detections: inbound.detections || [],
                    detectionCount: inbound.detectionCount || 0,
                    timestamp: inbound.timestamp || new Date().toISOString(),
                    fromCache: inbound.fromCache === true,
                    memoScope: inbound.memoScope
                }).then(() => {
                    Telemetry.performContent('[Content] dispatchJsApiEvent completed successfully');
                }).catch(failure => Telemetry.failure('CONTENT', 'Failed to dispatch detection event', failure));

                // Stop window property polling - detection is finalized, late results won't update anything
                localSendToMainWorld({ type: 'HALT_GLOBAL_POLLING', reason: 'detection_complete' });

                sendReply({ status: 'event_dispatched' });
            } else if (inbound.type === 'DETECTION_PROGRESS') {
                // Detection progress updates (method-level)
                const localProgress = inbound.progress || {};
                dispatchJsApiSignal('onProgress', {
                    url: window.location.href,
                    method: localProgress.method,
                    completedMethods: Array.isArray(localProgress.completedMethods) ? localProgress.completedMethods : [],
                    message: localProgress.message,
                    timestamp: new Date().toISOString()
                }).catch(() => {});

                sendReply({ status: 'progress_event_dispatched' });
            } else if (inbound.type === 'DETECTION_ERROR') {
                // Detection error - dispatch JS API error event
                dispatchJsApiSignal('onError', {
                    url: inbound.url || window.location.href,
                    error: inbound.error || 'Unknown error',
                    timestamp: inbound.timestamp || new Date().toISOString()
                }).catch(failure => Telemetry.failure('CONTENT', 'Failed to dispatch error event', failure));
                sendReply({ status: 'error_event_dispatched' });
            } else if (inbound.type === 'UPDATE_CAPTURE_STEP') {
                const localNotif = document.getElementById('scrapeless-capture-notification');
                if (localNotif) {
                    localNotif.innerHTML = `
                        <style>
                            @keyframes slideIn {
                                from { transform: translateX(400px); opacity: 0; }
                                to { transform: translateX(0); opacity: 1; }
                            }
                        </style>
                        <div style="font-weight: 600; font-size: 16px; margin-bottom: 8px;">
                            reCAPTCHA Capture - Step ${TextCodec.escapeMarkup(String(inbound.step))}
                        </div>
                        <div style="opacity: 0.9;">
                            ${TextCodec.escapeMarkup(String(inbound.message))}
                        </div>
                        <div id="scrapeless-timer" style="margin-top: 12px; font-size: 12px; opacity: 0.8; font-weight: 600;">
                            Capturing...
                        </div>
                    `;
                }
                sendReply({ status: 'updated' });
            } else if (inbound.type === 'CACHE_HIT_DISABLE_MONITORING') {
                // Cache hit - disable hooks and window properties monitoring
                localSendToMainWorld({
                    type: 'HALT_PROBES',
                    reason: 'cache_hit',
                    url: inbound.url
                });
                sendReply({ status: 'disabled' });
            }

            // Return true to indicate async response
            return true;
        });
    }

    Telemetry.performContent('Detection triggers setup complete');
}

/**
 * Initialize content script
 */
async function start() {
    Telemetry.performContent('Initializing on', { url: window.location.href });

    // Check context before any operations
    if (!isExtensionContextAccepted()) {
        Telemetry.performContent('Extension context not valid, cleaning up');
        localCleanupOrphanedScript();
        return; // Exit early
    }

    // Don't run on extension pages or chrome:// URLs
    if (!ExtensionGateway.isAcceptedContentScriptAddress(window.location.href)) {
        Telemetry.performContent('Skipping initialization on browser page');
        return;
    }

    // Check if extension is enabled
    try {
        const outcome = await chrome.storage.local.get(['scrapeless_enabled']);
        if (outcome.scrapeless_enabled === false) {
            Telemetry.performContent('Extension is disabled, skipping initialization');
            return;
        }
    } catch (failure) {
        Telemetry.failure('CONTENT', 'Failed to check enabled state', failure);
        // Continue with initialization on error (fail-safe)
    }

    // Initialize the detection engine
    if (!scanEvaluator) {
        scanEvaluator = new ScanEngine();
    }

    // Load detectors from background for smart data collection (Phase C.1 optimization)
    // Add retry logic to handle cases where background script isn't ready yet
    let catalogReady = false;
    let retryTotal = 0;
    const limitRetries = 3;
    let localRetryDelay = 500; // Start with 500ms, exponential backoff to 1s

    while (!catalogReady && retryTotal < limitRetries) {
        // Verify context before each retry attempt
        if (!isExtensionContextAccepted()) {
            Telemetry.performContent('Extension context lost during detector loading');
            localCleanupOrphanedScript();
            return; // Exit initialization
        }

        try {
            const catalogReply = await safeSendPacket({ type: 'READ_RULE_CATALOG' });

            if (!catalogReply) {
                // Context invalid, already handled by safeSendMessage
                return;
            }

            if (catalogReply && catalogReply.detectors) {
                // Count total detectors received
                const ruleTotal = Object.values(catalogReply.detectors)
                    .reduce((localSum, taxonomy) => localSum + Object.keys(taxonomy).length, 0);

                if (ruleTotal > 0) {
                    Telemetry.performContent(`Detectors loaded - smart data collection enabled (${ruleTotal} detectors)`);

                    // Set detectors in detection engine to enable smart data collection
                    scanEvaluator.assignCatalog(catalogReply.detectors);

                    catalogReady = true;
                } else {
                    retryTotal++;

                    if (retryTotal < limitRetries) {
                        // Silent retry with exponential backoff
                        await new Promise(localResolve => setTimeout(localResolve, localRetryDelay));
                        // Exponential backoff: 500ms → 1000ms
                        localRetryDelay = Math.min(localRetryDelay * 2, 1000);
                    }
                }
            } else {
                retryTotal++;

                if (retryTotal < limitRetries) {
                    // Silent retry with exponential backoff
                    await new Promise(localResolve => setTimeout(localResolve, localRetryDelay));
                    // Exponential backoff: 500ms → 1000ms
                    localRetryDelay = Math.min(localRetryDelay * 2, 1000);
                }
            }
        } catch (failure2) {
            // Only log non-context errors
            if (!failure2.message?.includes('Extension context invalidated')) {
                retryTotal++;

                if (retryTotal < limitRetries) {
                    // Silent retry with exponential backoff
                    await new Promise(localResolve => setTimeout(localResolve, localRetryDelay));
                    // Exponential backoff: 500ms → 1000ms
                    localRetryDelay = Math.min(localRetryDelay * 2, 1000);
                }
            } else {
                return; // Context invalid, stop trying
            }
        }
    }

    if (!catalogReady) {
        Telemetry.performWarn('CONTENT', '[init] Detector load failed after retries, collecting all data types as fallback');
    }

    // Note: JS hooks are installed by install-hooks.js at document_start (before this script runs)

    // Early cache check - skip all detection work if cached
    Telemetry.memo('Checking cache before starting detection work...');
    try {
        const memoCheckReply = await chrome.runtime.sendMessage({
            type: 'PROBE_MEMO_EARLY',
            url: window.location.href
        });

        if (memoCheckReply?.cacheHit) {
            Telemetry.memo('CACHE HIT - skipping all detection work, returning cached detections immediately');

            // Set flag to prevent hook installation (ISOLATED world)
            window.__scrapelessCacheHitEarlyExit = true;

            // Notify MAIN world about cache hit so hooks stop firing
            localSendToMainWorld({
                type: 'SCRAPELESS_CACHE_HIT',
                timestamp: Date.now()
            });

            // JS API: Still dispatch "ready" so page scripts can reliably initialize listeners
            // even when we exit early due to cache hit.
            await dispatchReadySignal();

            // JS API: Dispatch detection event immediately with cached data
            const memoizedPayload = memoCheckReply.detectionData;
            if (memoizedPayload) {
                Telemetry.memo('Dispatching JS API event with cached detection data');
                dispatchJsApiSignal('onDetection', {
                    url: window.location.href,
                    detections: memoizedPayload.detectionResults || [],
                    detectionCount: memoizedPayload.detectionCount || 0,
                    timestamp: memoizedPayload.timestamp || new Date().toISOString(),
                    fromCache: true
                }).catch(failure => Telemetry.failure('CONTENT', 'Failed to dispatch cached detection event', failure));
            }

            // Notify background about early cache exit AND send cached detection data
            // This ensures the badge is updated with detection count immediately
            try {
                chrome.runtime.sendMessage({
                    type: 'MEMO_HIT_EARLY_EXIT',
                    url: window.location.href,
                    detectionData: memoCheckReply.detectionData  // Include cached data for badge update
                }).catch(() => {});
            } catch (failure3) {
                // Extension context invalidated - silently ignore
            }

            // Keep lightweight page/message triggers active so a same-document
            // cache hit can still be re-scanned later if the user requests it.
            wireScanTriggers();

            // Exit initialization - don't run detection work
            Telemetry.memo('Content script initialization complete (cache hit path)');
            return;
        } else {
            Telemetry.memo('CACHE MISS - proceeding with full detection');
        }
    } catch (failure4) {
        Telemetry.failure('CACHE', 'Error during cache check, proceeding with detection', failure4);
        // If cache check fails, proceed with normal detection (safe fallback)
    }

    // Setup all detection triggers
    wireScanTriggers();

    // Dispatch JS API ready event
    dispatchReadySignal();

    // Notify background that content script is ready (only if context is valid)
    if (isExtensionContextAccepted()) {
        try {
            chrome.runtime.sendMessage({
                type: 'PAGE_AGENT_READY',
                url: window.location.href
            }, (reply) => {
                if (chrome.runtime.lastError) {
                    if (chrome.runtime.lastError.message &&
                        chrome.runtime.lastError.message.includes('Extension context invalidated')) {
                        Telemetry.performDebug('CONTENT', '[init] Extension reloaded before initialization completed');
                        // Don't cleanup immediately, might be temporary
                    } else {
                        Telemetry.failure('CONTENT', '[init] Failed to notify background', chrome.runtime.lastError);
                    }
                } else {
                    Telemetry.performContent('Successfully notified background of readiness');
                }
            });
        } catch (failure5) {
            if (failure5.message && failure5.message.includes('Extension context invalidated')) {
                Telemetry.performDebug('CONTENT', '[init] Extension context invalidated during initialization');
                // Don't cleanup immediately, might be temporary
            } else {
                Telemetry.failure('CONTENT', '[init] Error notifying background', failure5);
            }
        }
    } else {
        Telemetry.performDebug('CONTENT', '[init] Extension context not available');
    }
}

/**
 * Wait for Utils to load before initializing
 */
function waitForSupportAndStart() {
    if (typeof ExtensionGateway !== 'undefined') {
        if (typeof Telemetry !== 'undefined') {
            Telemetry.performContent('Utils loaded, initializing...');
        }
        start();
    } else {
        // Utils not yet loaded, wait and retry
        setTimeout(waitForSupportAndStart, 50);
    }
}

// Don't clear cache here -- PAGE_LOAD_SIGNAL handles it

// Create the adaptive hook-message batcher using DetectionEngineManager.
const probeBatch = ScanEngine.composeProbePacketBatcher(chrome);

// Listen for JS Hook detections from MAIN world script
// Delegate to DetectionEngineManager.handleHookBridgeMessage().
const DEBUG_TRACE_RATE_GLOBAL_MS = 1000;
const DEBUG_TRACE_LIMIT_PER_GLOBAL = 20;
let debugTraceGlobalBegin = Date.now();
let debugTraceTotal = 0;

function shouldForwardDebugTrace() {
    const localNow = Date.now();
    if (localNow - debugTraceGlobalBegin >= DEBUG_TRACE_RATE_GLOBAL_MS) {
        debugTraceGlobalBegin = localNow;
        debugTraceTotal = 0;
    }
    debugTraceTotal += 1;
    return debugTraceTotal <= DEBUG_TRACE_LIMIT_PER_GLOBAL;
}

window.addEventListener(BRIDGE_MAIN_TO_ISOLATED_SIGNAL, (signal) => {
    signal.stopImmediatePropagation?.();

    const payload = resolveTrustedMainWorldPacketPayload(signal);
    if (!payload) return;

    // Stop propagation for hook detections to prevent page scripts from seeing them
    if (payload.type === 'PROBE_SIGNAL') {
        signal.stopImmediatePropagation?.();
    }

    // Forward hook failure reports from HookResilienceManager
    if (payload.type === 'PROBE_FAILURE_REPORT') {
        try {
            chrome.runtime.sendMessage({
                type: 'PROBE_FAILURE_REPORT',
                target: payload.target,
                failureType: payload.failureType,
                message: payload.message,
                timestamp: payload.timestamp
            }).catch(() => {});
        } catch (failure) {
            // Extension context invalidated - silently ignore
        }
        return;
    }

    // Forward hook tampering detection
    if (payload.type === 'PROBE_TAMPERING_DETECTED') {
        try {
            chrome.runtime.sendMessage({
                type: 'PROBE_TAMPERING_DETECTED',
                target: payload.target,
                timestamp: payload.timestamp
            }).catch(() => {});
        } catch (failure2) {
            // Extension context invalidated - silently ignore
        }
        return;
    }

    // Forward hook recovery results
    if (payload.type === 'PROBE_RECOVERY_RESULT') {
        try {
            chrome.runtime.sendMessage({
                type: 'PROBE_RECOVERY_RESULT',
                target: payload.target,
                success: payload.success,
                error: payload.error,
                timestamp: payload.timestamp
            }).catch(() => {});
        } catch (failure3) {
            // Extension context invalidated - silently ignore
        }
        return;
    }

    // Forward window property detections from WindowPropertyTracker
    if (payload.type === 'GLOBAL_SIGNALS') {
        try {
            chrome.runtime.sendMessage({
                type: 'GLOBAL_SIGNALS',
                detections: payload.detections,
                timestamp: payload.timestamp
            }).catch(() => {});
        } catch (failure4) {
            // Extension context invalidated - silently ignore
        }
        return;
    }

    // Forward debug logs from MAIN world to background service worker
    if (payload.type === 'SCRAPELESS_DEBUG_LOG') {
        if (!shouldForwardDebugTrace()) {
            return;
        }
        try {
            chrome.runtime.sendMessage({
                type: 'SCRAPELESS_DEBUG_LOG',
                level: payload.level,
                message: payload.message,
                source: payload.source,
                timestamp: payload.timestamp
            }).catch(() => {});
        } catch (failure5) {
            // Extension context invalidated - silently ignore
        }
        return;
    }

    // Forward centralized logs from MAIN world Logger to background
    if (payload.type === 'SCRAPELESS_LOG') {
        try {
            chrome.runtime.sendMessage({
                type: 'RECORD',
                log: payload.log
            }).catch(() => {});
        } catch (failure6) {
            // Extension context invalidated - silently ignore
        }
        return;
    }

    // Dispatch JS API events before the hook bridge forwards completion with retry.
    if (payload.type === 'PROBE_HOOKS_COMPLETE') {
        probeFinished = true;
        if (!scanDelivered) {
            const probesTs = (typeof payload.timestamp === 'number')
                ? new Date(payload.timestamp).toISOString()
                : (payload.timestamp || new Date().toISOString());

            dispatchJsApiSignal('onHooksComplete', {
                url: payload.url || window.location.href,
                timestamp: probesTs,
                totalDetections: payload.totalDetections,
                uniqueHooks: payload.uniqueHooks,
                completionReason: payload.completionReason,
                completionTime: payload.completionTime,
                uninstallStats: payload.uninstallStats
            }).catch(() => {});
        }
    }

    if (payload.type === 'GLOBAL_SIGNALS_COMPLETE') {
        if (!scanDelivered) {
            const globalTs = (typeof payload.timestamp === 'number')
                ? new Date(payload.timestamp).toISOString()
                : (payload.timestamp || new Date().toISOString());

            dispatchJsApiSignal('onWindowPropsComplete', {
                url: payload.url || window.location.href,
                timestamp: globalTs,
                detectedCount: payload.detectedCount,
                totalChecked: payload.totalChecked,
                elapsedMs: payload.elapsedMs,
                reason: payload.reason
            }).catch(() => {});
        }
    }

    // The hook bridge manages completion forwarding with retry.
    ScanEngine.routeProbeBridgePacket({ source: window, data: payload }, chrome, probeBatch);
}, true);

// Install hooks at document_start before page scripts; no async operations before installJSHooks()
(function() {
    if (window.__scrapelessHooksInstalled) {
        return; // Already installed
    }

    // CHECK CONTEXT BEFORE INSTALLING HOOKS (synchronous check)
    if (!chrome?.runtime?.id) {
        return;
    }

    // IMPORTANT: Always install hooks at document_start for correctness.
    // Cache hits are handled asynchronously (background discards batches + disables monitoring),
    // and relying on sessionStorage can go stale (manual cache clear, settings changes).
    window.__scrapelessCacheHitEarlyExit = false;
    startMainWorldBridge();

    // Install hooks immediately without async storage checks (cache/enabled checked after)
    window.__scrapelessHooksInstalled = true;
    installJsProbes();

    // Test Logger (with safety check)
    if (typeof Telemetry !== 'undefined') {
        Telemetry.performContent('Logger initialized in CONTENT (ISOLATED) context');
    }

    // Use flag to prevent duplicate triggers
    let probeBeginTriggered = false;
    const triggerProbeBegin = () => {
        if (probeBeginTriggered) return;
        probeBeginTriggered = true;
        localSendToMainWorld({
            type: 'SCRAPELESS_PAGE_READY'
        });
    };

    if (document.readyState === 'complete') {
        triggerProbeBegin();
    } else {
        // Use load event - most reliable for ensuring page is ready
        window.addEventListener('load', triggerProbeBegin, { once: true });
    }
})();

// Check if script is already initialized to prevent duplicates
// Only the initialization call is wrapped, not the function definitions
if (window.__scrapelessContentScriptInitialized) {
    // Already initialized, silently skip
} else {
    window.__scrapelessContentScriptInitialized = true;
    // Wait for Utils to load before initializing
    waitForSupportAndStart();
}
