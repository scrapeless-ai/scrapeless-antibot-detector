// Core detection engine: page data collection and pattern matching

// Serializes read-modify-write access to scrapeless_detection_storage so concurrent
// tab finalizations (store-vs-store) cannot lost-update each other. Callers await
// the prior critical section, then call the returned release fn in a finally.
let scanRepositoryLockTail = Promise.resolve();
function acquireScanRepositoryLock() {
    let localRelease;
    const following = new Promise((localResolve) => { localRelease = localResolve; });
    const localPrior = scanRepositoryLockTail;
    scanRepositoryLockTail = following;
    return localPrior.then(() => localRelease);
}

class ScanEngine {
    static BASELINE_EXPIRY_HOURS = 12;
    static REPOSITORY_LOOKUP = 'scrapeless_detection_storage';
    static matcherMemo = new CompiledPatternPool(500);

    constructor() {
        this.scanSnapshot = null;
        this.lastScanAt = null;
        // ConfidenceManager only available in background context
        this.evidenceScorer = typeof EvidenceScorer !== 'undefined' ? new EvidenceScorer() : null;
        this.executionPlan = null;
        this.methodPlanCache = null;
        this.analyzedMethodsCacheTime = 0;
        this.ANALYSIS_CACHE_TTL = (typeof RuntimePolicy !== 'undefined' && Number.isFinite(RuntimePolicy.ANALYSIS_CACHE_TTL))
            ? RuntimePolicy.ANALYSIS_CACHE_TTL
            : 300000;

        if (typeof RuntimePolicy === 'undefined' || !Number.isFinite(RuntimePolicy.ANALYSIS_CACHE_TTL)) {
            Telemetry.performWarn('DETECTION', '[DetectionEngineManager] Constants.ANALYSIS_CACHE_TTL unavailable, using fallback 300000ms');
        }
    }

    /**
     * Build detector info object
     * @param {object} detector - Detector object
     * @param {string} fallbackName - Fallback name if detector.name is not available
     * @param {string} fallbackId - Fallback ID if detector.id is not available
     * @returns {object} Detector info object
     */
    static assembleRuleDetail(rule, fallbackLabel, fallbackToken) {
        const localManualDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
            ? FindingMetrics.canonicalizeDifficulty(rule?.difficulty)
            : null;
        const baselineDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.baselineDifficultyForTaxonomy === 'function')
            ? FindingMetrics.baselineDifficultyForTaxonomy(rule?.category)
            : 'Medium';
        const outcome = {
            name: rule.name || fallbackLabel,
            icon: rule.icon,
            // Color resolved dynamically from CategoryManager
            id: rule.id || fallbackToken,
            description: rule.description,
            difficulty: localManualDifficulty || baselineDifficulty
        };

        if (!outcome.id) {
            Telemetry.performWarn('DETECTOR', '[buildDetectorInfo] MISSING ID:', {
                detectorName: outcome.name,
                detectorId: rule.id,
                fallbackId: fallbackToken,
                detectorKeys: Object.keys(rule).slice(0, 5)
            });
        }

        return outcome;
    }

    /**
     * Get cache expiry time in milliseconds from settings
     * @returns {Promise<number>} Expiry time in milliseconds
     */
    static async resolveExpiryMs() {
        try {
            const actualPreferences = await ExtensionGateway.resolvePreferences();
            if (actualPreferences && Object.keys(actualPreferences).length > 0) {

                Telemetry.memo('[CACHE] Raw settings object:', {
                    memoDuration: actualPreferences.memoDuration,
                    memoUnit: actualPreferences.memoUnit,
                    cacheHours: actualPreferences.cacheHours,
                    detectionCacheDuration: actualPreferences.scanning?.memoDuration,
                    detectionCacheUnit: actualPreferences.scanning?.memoUnit
                });

                // Support both old (cacheHours) and new (memoDuration + memoUnit) formats
                let localExpiryMs;
                // Prefer nested detection settings (current), fall back to legacy flat keys
                const localDuration = actualPreferences.scanning?.memoDuration ?? actualPreferences.memoDuration;
                const localUnit = actualPreferences.scanning?.memoUnit ?? actualPreferences.memoUnit;
                if (localDuration !== undefined && localUnit) {

                    // Convert to milliseconds based on unit
                    const localConversions = {
                        minutes: localDuration * 60 * 1000,
                        hours: localDuration * 60 * 60 * 1000,
                        days: localDuration * 24 * 60 * 60 * 1000
                    };

                    localExpiryMs = localConversions[localUnit] || (localDuration * 60 * 60 * 1000); // Default to hours
                    Telemetry.debugStrategy && Telemetry.findingsPane(`[CACHE] Using cache duration: ${localDuration} ${localUnit} (${localExpiryMs}ms)`);
                } else {
                    // Fallback to old cacheHours format
                    const memoHours = actualPreferences.cacheHours || ScanEngine.BASELINE_EXPIRY_HOURS;
                    localExpiryMs = memoHours * 60 * 60 * 1000;
                    Telemetry.debugStrategy && Telemetry.findingsPane(`[CACHE] Using legacy cache duration: ${memoHours} hours (${localExpiryMs}ms)`);
                }

                return localExpiryMs;
            }
            const baselineMs = ScanEngine.BASELINE_EXPIRY_HOURS * 60 * 60 * 1000;
            Telemetry.debugStrategy && Telemetry.findingsPane(`[CACHE] No settings found, using default: ${ScanEngine.BASELINE_EXPIRY_HOURS} hours`);
            return baselineMs;
        } catch (failure) {
            Telemetry.performWarn('CACHE', '[getCacheDuration] Settings read failed, using default', failure);
            return ScanEngine.BASELINE_EXPIRY_HOURS * 60 * 60 * 1000;
        }
    }

    /**
     * Orchestrate JS hook installation by loading detectors and dispatching
     * hook definitions to the MAIN world via CustomEvent.
     * Called from src/entry/page-agent.js (ISOLATED world) at document_start.
     * @param {Window} window - The window object
     * @param {object} chrome - The chrome API object
     */
    static async installProbesOrchestrator(global, localChrome) {
        try {
            const outcome = await localChrome.storage.local.get(['scrapeless_detectors', 'scrapeless_settings', 'scrapeless_enabled']);
            const localBridgeToken = global.ScrapelessBridge?.getToken?.() || null;
            const dispatchInstallProbes = (localDetail) => {
                const localSafeDetail = localBridgeToken
                    ? { ...localDetail, __scrapelessBridgeToken: localBridgeToken }
                    : localDetail;
                global.dispatchEvent(new CustomEvent('scrapeless-install-hooks', {
                    detail: localSafeDetail
                }));
            };
            const canonicalizeProbe = (probe) => {
                if (!probe || probe.enabled === false || typeof probe.target !== 'string') {
                    return null;
                }

                const destination = probe.target.trim();
                if (!destination || destination.length > 200) {
                    return null;
                }

                return {
                    ...probe,
                    target: destination
                };
            };

            // Extension disabled - skip hook installation entirely
            // Dispatch empty event so MAIN world sends completion signals and doesn't hang
            if (outcome.scrapeless_enabled === false) {
                dispatchInstallProbes({
                    hookDefinitions: [],
                    windowProperties: [],
                    diagnosticMode: false,
                    journalActive: false,
                    pageSignalsActive: false,
                    fingerprintEnabled: false
                });
                return;
            }

            const actualPreferences = typeof ExtensionStore !== 'undefined' && typeof ExtensionStore.canonicalizePreferences === 'function'
                ? ExtensionStore.canonicalizePreferences(outcome.scrapeless_settings)
                : {};
            const debugStrategy = actualPreferences.diagnosticMode || false;
            const traceCollectorActive = actualPreferences.journalActive || false;
            const localEnableJsApi = actualPreferences.pageSignals?.pageSignalsActive ?? false;
            const probesProfile = actualPreferences.probeConfig || actualPreferences.scanning?.probeConfig || {};

            const catalogPayload = outcome.scrapeless_detectors;

            // No detectors: dispatch empty event to prevent MAIN world hang
            if (!catalogPayload?.detectors) {
                dispatchInstallProbes({
                    hookDefinitions: [],
                    windowProperties: [],
                    diagnosticMode: debugStrategy,
                    journalActive: traceCollectorActive,
                    pageSignalsActive: localEnableJsApi,
                    probeConfig: probesProfile,
                    fingerprintEnabled: true
                });
                return;
            }

            // Extract hook definitions from fingerprint detectors
            const probeDefinitions = [];
            const fingerprintCatalog = catalogPayload.detectors.fingerprint || {};
            for (const [ruleLookup, rule] of Object.entries(fingerprintCatalog)) {
                if (rule.enabled === false) continue;
                if (!rule.detection?.js_hooks || rule.detection.js_hooks.length === 0) continue;

                probeDefinitions.push({
                    id: rule.id || ruleLookup,
                    name: rule.name,
                    category: 'fingerprint',
                    hooks: rule.detection.js_hooks.map(canonicalizeProbe).filter(Boolean)
                });
            }

            // Extract window properties (all categories)
            const globalSignals = [];
            for (const [taxonomy, taxonomyCatalog] of Object.entries(catalogPayload.detectors)) {
                for (const [ruleLookup2, rule2] of Object.entries(taxonomyCatalog || {})) {
                    if (rule2.enabled === false) continue;
                    if (!rule2.detection?.window || rule2.detection.window.length === 0) continue;

                    for (const localProp of rule2.detection.window) {
                        globalSignals.push({
                            ...localProp,
                            detectorId: rule2.id || ruleLookup2,
                            detectorName: rule2.name,
                            category: taxonomy
                        });
                    }
                }
            }

            dispatchInstallProbes({
                hookDefinitions: probeDefinitions,
                windowProperties: globalSignals,
                diagnosticMode: debugStrategy,
                journalActive: traceCollectorActive,
                pageSignalsActive: localEnableJsApi,
                probeConfig: probesProfile,
                fingerprintEnabled: true
            });

        } catch (failure) {
            if (typeof Telemetry !== 'undefined') {
                Telemetry.failure('DETECTION', '[installHooksOrchestrator] Failed:', failure);
            }
            // Still dispatch empty event so MAIN world doesn't hang
            const localBridgeToken2 = global.ScrapelessBridge?.getToken?.() || null;
            global.dispatchEvent(new CustomEvent('scrapeless-install-hooks', {
                detail: {
                    hookDefinitions: [],
                    windowProperties: [],
                    diagnosticMode: false,
                    journalActive: false,
                    pageSignalsActive: false,
                    fingerprintEnabled: true,
                    ...(localBridgeToken2 ? { __scrapelessBridgeToken: localBridgeToken2 } : {})
                }
            }));
        }
    }

    /**
     * Analyze which detection methods are actually used by loaded detectors
     * Scans all detectors to determine which data types need to be collected
     * @returns {Object} Map of detection methods that are actually used
     */
    analyzeUsedPhases() {
        return analyzeConfiguredScanPhases.apply(this, arguments);
    }
    performNeedsExternalContent() {
        return localRequiresExternalScriptContent.apply(this, arguments);
    }
    performExtractCookies() {
        return localExtractDocumentCookies.apply(this, arguments);
    }
    extractScriptNodes() {
        return localExtractDocumentScripts.apply(this, arguments);
    }
    performExtractDomSnapshot() {
        return localExtractRelevantDomSnapshot.apply(this, arguments);
    }
    resolveRelevantNodeAttributes(node) {
        return collectRelevantNodeAttributes.apply(this, arguments);
    }
    shouldRunScan(floorCadence = 1000) {
        if (!this.lastScanAt) return true;
        return (Date.now() - this.lastScanAt) > floorCadence;
    }

    /**
     * Clear stored detection data
     */
    purgeScanPayload() {
        this.scanSnapshot = null;
        this.lastScanAt = null;
    }

    /**
     * Collect page data for detection analysis
     * Uses lazy getters (Object.defineProperty) to only extract data when accessed
     * @returns {Promise<object>} Page data object with lazy getters
     */
    async collectSheetPayload() {
        Telemetry.debugStrategy && Telemetry.findingsPane('DetectionEngineManager: Collecting page data...');
        const beginMoment = Date.now();

        // Analyze used detection methods
        const usedPhases = this.analyzeUsedPhases();

        // Check needed data types
        const localNeedsExternal = this.performNeedsExternalContent();

        let localExternalContent = [];
        if (localNeedsExternal) {
            Telemetry.debugStrategy && Telemetry.findingsPane('[8E: Incremental] External content needed, fetching...');
            try {
                localExternalContent = await this.performExtractExternalContent();
            } catch (failure) {
                Telemetry.performWarn('DETECTION', '[runDetection] External content fetch failed, continuing without', failure);
                localExternalContent = [];
            }
        } else {
            Telemetry.debugStrategy && Telemetry.findingsPane('[8E: Incremental] Skipping external content fetch (not needed by any detector)');
        }

        let sitemark = '';
        const sitemarkSelectors = [
            'link[rel="icon"]',
            'link[rel="shortcut icon"]',
            'link[rel="apple-touch-icon"]',
            'link[rel="apple-touch-icon-precomposed"]',
            'link[type="image/x-icon"]',
            'link[type="image/png"]',
            'link[rel*="icon"]'
        ];

        for (const localSelector of sitemarkSelectors) {
            const localLink = document.querySelector(localSelector);
            if (localLink && localLink.href) {
                sitemark = localLink.href;
                break;
            }
        }

        // Get JS Hook detections from storage
        let jsProbes = [];
        try {
            const probePayload = await new Promise((localResolve) => {
                chrome.storage.local.get(['scrapeless_js_hook_detections'], (outcome) => {
                    localResolve(outcome.scrapeless_js_hook_detections || {});
                });
            });

            const activeProbes = probePayload[window.location.href];
            if (activeProbes && activeProbes.hooks) {
                jsProbes = activeProbes.hooks;
                Telemetry.debugStrategy && Telemetry.findingsPane(`[JS Hooks] Found ${jsProbes.length} hook detections for this page`);
            }
        } catch (failure2) {
            Telemetry.performWarn('HOOKS', '[runDetection] Hook detections load failed', failure2);
        }

        // Smart lazy data collection
        let memoizedSheetMarkup = null;
        let memoizedCookies = null;
        let memoizedContent = null;
        let memoizedDom = null;

        const sheetPayload = {
            url: window.location.href,
            hostname: window.location.hostname,
            title: document.title || 'Untitled',
            favicon: sitemark,
            timestamp: new Date().toISOString(),

            externalContent: localExternalContent,
            jsHooks: jsProbes,
            headers: [],

            _extractCookies: () => this.performExtractCookies(),
            _extractScriptElements: () => this.extractScriptNodes(),
            _extractDOM: () => this.performExtractDomSnapshot()
        };

        if (usedPhases.cookie) {
            Object.defineProperty(sheetPayload, 'cookies', {
                get() {
                    if (memoizedCookies === null) {
                        const begin = Date.now();
                        memoizedCookies = this._extractCookies();
                        Telemetry.debugStrategy && Telemetry.findingsPane(`[C.1: Lazy Cookies] Extracted ${memoizedCookies.length} cookies in ${Date.now() - begin}ms`);
                    }
                    return memoizedCookies;
                },
                set(datum) { memoizedCookies = datum; },
                enumerable: true
            });
        } else {
            Telemetry.debugStrategy && Telemetry.findingsPane('[C.1] Skipped cookies getter - no detector uses cookie detection');
        }

        if (usedPhases.content) {
            Object.defineProperty(sheetPayload, 'content', {
                get() {
                    if (memoizedContent === null) {
                        const begin = Date.now();
                        memoizedContent = this._extractScriptElements();
                        Telemetry.debugStrategy && Telemetry.findingsPane(`[C.1: Lazy Content] Extracted ${memoizedContent.length} scripts in ${Date.now() - begin}ms`);
                    }
                    return memoizedContent;
                },
                set(datum) { memoizedContent = datum; },
                enumerable: true
            });
        } else {
            Telemetry.debugStrategy && Telemetry.findingsPane('[C.1] Skipped content getter - no detector uses content detection');
        }

        if (usedPhases.dom) {
            Object.defineProperty(sheetPayload, 'dom', {
                get() {
                    if (memoizedDom === null) {
                        const begin = Date.now();
                        memoizedDom = this._extractDOM();
                        Telemetry.debugStrategy && Telemetry.findingsPane(`[C.1: Lazy DOM] Extracted ${memoizedDom.length} elements in ${Date.now() - begin}ms`);
                    }
                    return memoizedDom;
                },
                set(datum) { memoizedDom = datum; },
                enumerable: true
            });
        } else {
            Telemetry.debugStrategy && Telemetry.findingsPane('[C.1] Skipped DOM getter - no detector uses DOM detection');
        }

        if (usedPhases.content) {
            Object.defineProperty(sheetPayload, 'pageHTML', {
                get() {
                    if (memoizedSheetMarkup === null) {
                        memoizedSheetMarkup = document.body ? document.body.innerHTML : '';
                        Telemetry.debugStrategy && Telemetry.findingsPane(`[C.1: Lazy HTML] Extracted pageHTML on first access (${memoizedSheetMarkup.length} bytes)`);
                    }
                    return memoizedSheetMarkup;
                },
                set(datum) { memoizedSheetMarkup = datum; },
                enumerable: true
            });
        } else {
            Telemetry.debugStrategy && Telemetry.findingsPane('[C.1] Skipped pageHTML getter - content detection not used');
        }

        this.scanSnapshot = sheetPayload;
        this.lastScanAt = Date.now();

        const collectionMoment = Date.now() - beginMoment;
        const skippedPhases = Object.entries(usedPhases).filter(([keyCursor, entryValue]) => !entryValue).map(([keyCursor]) => keyCursor);
        Telemetry.debugStrategy && Telemetry.findingsPane(`[C.1: Smart Collection] Data collected in ${collectionMoment}ms`);
        if (skippedPhases.length > 0) {
            Telemetry.debugStrategy && Telemetry.findingsPane(`[C.1: Smart Collection] Skipped ${skippedPhases.length} unused methods: ${skippedPhases.join(', ')}`);
        }

        return sheetPayload;
    }

    /**
     * Fetch external resource content (JS, CSS files) via HTTP
     * @returns {Promise<array>} Array of fetched resource content
     */
    async performExtractExternalContent() {
        const scriptNodes = document.querySelectorAll('script[src]');
        const scriptAddresses = Array.from(scriptNodes).map(localS => localS.src).filter(Boolean);
        Telemetry.debugStrategy && Telemetry.findingsPane(`extractExternalContent: Found ${scriptAddresses.length} external scripts`);

        const linkNodes = document.querySelectorAll('link[rel="stylesheet"]');
        const cssAddresses = Array.from(linkNodes).map(localL => localL.href).filter(Boolean);
        Telemetry.debugStrategy && Telemetry.findingsPane(`extractExternalContent: Found ${cssAddresses.length} CSS files`);

        const allAddresses = [...scriptAddresses, ...cssAddresses];
        Telemetry.debugStrategy && Telemetry.findingsPane(`extractExternalContent: Total ${allAddresses.length} external resources to fetch`);

        const LOCAL_CONCURRENCY_LIMIT = 6;
        const LIMIT_CONTENT_CAPACITY = 5 * 1024 * 1024;
        const FETCH_DEADLINE = RuntimePolicy.FETCH_DEADLINE;

        const beginMoment = Date.now();
        const outcomes = [];

        for (let cursor = 0; cursor < allAddresses.length; cursor += LOCAL_CONCURRENCY_LIMIT) {
            const localBatch = allAddresses.slice(cursor, cursor + LOCAL_CONCURRENCY_LIMIT);
            const localBatchPromises = localBatch.map(address =>
                fetch(address, {
                    method: 'GET',
                    cache: 'default',
                    credentials: 'omit',
                    signal: AbortSignal.timeout(FETCH_DEADLINE)
                })
                .then(async reply => {
                    if (reply.ok) {
                        const contentExtent = parseInt(reply.headers.get('content-length'), 10);
                        if (contentExtent && contentExtent > LIMIT_CONTENT_CAPACITY) {
                            Telemetry.debugStrategy && Telemetry.findingsPane(`Skipping large file: ${address} (${(contentExtent / 1024 / 1024).toFixed(2)} MB)`);
                            return null;
                        }

                        const localContent = await reply.text();

                        if (localContent.length > LIMIT_CONTENT_CAPACITY) {
                            return {
                                url: address,
                                type: address.endsWith('.css') ? 'css' : 'javascript',
                                content: localContent.substring(0, LIMIT_CONTENT_CAPACITY),
                                size: localContent.length,
                                truncated: true
                            };
                        }

                        return {
                            url: address,
                            type: address.endsWith('.css') ? 'css' : 'javascript',
                            content: localContent,
                            size: localContent.length
                        };
                    }
                    return null;
                })
                .catch(failure => {
                    Telemetry.debugStrategy && Telemetry.findingsPane(`Error fetching: ${address} (${failure.message})`);
                    return null;
                })
            );

            const batchOutcomes = await Promise.allSettled(localBatchPromises);
            outcomes.push(...batchOutcomes);
        }

        const localResources = outcomes
            .filter(outcome => outcome.status === 'fulfilled' && outcome.value !== null)
            .map(outcome => outcome.value);

        const fetchMoment = Date.now() - beginMoment;
        Telemetry.debugStrategy && Telemetry.findingsPane(`extractExternalContent: Successfully fetched ${localResources.length}/${allAddresses.length} resources in ${fetchMoment}ms`);

        return localResources;
    }

    /**
     * Set detectors for detection analysis
     * Pre-computes priorities for faster detection
     * @param {object} detectors - Detector configurations organized by category
     */
    assignCatalog(ruleSet) {
        this.ruleSet = ruleSet;
        // Clear cache; force re-analysis
        this.methodPlanCache = null;
        this.analyzedMethodsCacheTime = 0;
        this._refreshRulePriorities();
    }

    /**
     * Pre-compute detector priorities for faster detection
     * Calculate once instead of per-detection (saves 50-100ms per detection)
     * @private
     */
    _refreshRulePriorities() {
        return measureRulePriorities.apply(this, arguments);
    }
    runRule(rule, sheetPayload) {
        const { url: address, content: localContent, dom: localDom, cookies: localCookies = [], headers: localHeaders = {}, pageHTML: sheetMarkup = '', externalContent: localExternalContent = [], allCookies: localAllCookies = [], responseCookies: replyCookies = [] } = sheetPayload;
        const hits = [];

        // allCookies includes HttpOnly cookies from chrome.cookies API
        const cookiesToHit = localAllCookies.length > 0 ? localAllCookies : localCookies;

        if (rule.detection?.url) {
            // Use Set for O(1) duplicate checking instead of O(n) .some()
            const addedAddressMatchers = new Set();

            for (const addressMatcher of rule.detection.url) {
                const hitChoices = {
                    regex: addressMatcher.textRegex === true,
                    wholeWord: addressMatcher.textWholeWord === true,
                    caseSensitive: addressMatcher.textCaseSensitive === true
                };

                // Get textScope (default to 'all')
                const copyBoundary = addressMatcher.textScope || 'all';

                // Check main page URL (always checked unless scope is explicitly scripts-only)
                // Match against full URL including query parameters for "contains" matching
                Telemetry.debugStrategy && Telemetry.findingsPane(`[URL Detection] ${rule.name}: Testing pattern "${addressMatcher.text}" against URL "${address}"`);
                const addressHit = this.findMatcherHit(address, addressMatcher.text, hitChoices);
                if (addressHit) {
                    Telemetry.debugStrategy && Telemetry.findingsPane(`[URL Detection] ${rule.name}: MATCHED! Value: "${addressHit}"`);
                    addedAddressMatchers.add(addressMatcher.text);
                    hits.push({
                        type: 'url',
                        pattern: addressMatcher.text,
                        value: addressHit,
                        fullUrl: address,
                        confidence: addressMatcher.confidence,
                        description: addressMatcher.description
                    });
                } else {
                    Telemetry.debugStrategy && Telemetry.findingsPane(`[URL Detection] ${rule.name}: No match`);
                }

                // Check script src URLs if scope is 'page_and_scripts' or 'all'
                if ((copyBoundary === 'page_and_scripts' || copyBoundary === 'all') && localContent && localContent.length > 0) {
                    for (const localScript of localContent) {
                        const localScriptSrc = localScript.src || '';
                        if (localScriptSrc && !addedAddressMatchers.has(addressMatcher.text)) {
                            const scriptHit = this.findMatcherHit(localScriptSrc, addressMatcher.text, hitChoices);
                            if (scriptHit) {
                                addedAddressMatchers.add(addressMatcher.text);
                                hits.push({
                                    type: 'url',
                                    pattern: addressMatcher.text,
                                    value: scriptHit,
                                    fullUrl: localScriptSrc,
                                    confidence: addressMatcher.confidence,
                                    description: addressMatcher.description
                                });
                            }
                        }
                    }
                }

                // Check all external resource URLs if scope is 'all'
                if (copyBoundary === 'all' && localExternalContent && localExternalContent.length > 0) {
                    for (const localResource of localExternalContent) {
                        const resourceAddress = localResource.url || '';
                        if (resourceAddress && !addedAddressMatchers.has(addressMatcher.text)) {
                            const resourceHit = this.findMatcherHit(resourceAddress, addressMatcher.text, hitChoices);
                            if (resourceHit) {
                                addedAddressMatchers.add(addressMatcher.text);
                                hits.push({
                                    type: 'url',
                                    pattern: addressMatcher.text,
                                    value: resourceHit,
                                    fullUrl: resourceAddress,
                                    confidence: addressMatcher.confidence,
                                    description: addressMatcher.description
                                });
                            }
                        }
                    }
                }

                // Check ALL network request URLs if scope is 'all' (NEW: captures XHR, fetch, etc.)
                if (copyBoundary === 'all' && sheetPayload.networkUrls && sheetPayload.networkUrls.length > 0) {
                    Telemetry.debugStrategy && Telemetry.findingsPane(`[URL Detection] ${rule.name}: Checking ${sheetPayload.networkUrls.length} network request URLs`);
                    for (const networkAddress of sheetPayload.networkUrls) {
                        if (addedAddressMatchers.has(addressMatcher.text)) break; // Already found, skip remaining URLs
                        const networkHit = this.findMatcherHit(networkAddress.url, addressMatcher.text, hitChoices);
                        if (networkHit) {
                            addedAddressMatchers.add(addressMatcher.text);
                            Telemetry.debugStrategy && Telemetry.findingsPane(`[URL Detection] ${rule.name}: Network URL MATCHED! URL: ${networkAddress.url}, Type: ${networkAddress.type}, Method: ${networkAddress.method}`);
                            hits.push({
                                type: 'url',
                                pattern: addressMatcher.text,
                                value: networkHit,
                                fullUrl: networkAddress.url,
                                resourceType: networkAddress.type,
                                method: networkAddress.method,
                                confidence: addressMatcher.confidence,
                                description: addressMatcher.description
                            });
                        }
                    }
                }
            }
        }

        // Check content patterns
        const contentMatchers = rule.detection?.content;
        Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: contentPatterns=${!!contentMatchers}, count=${contentMatchers?.length || 0}, hasPageHTML=${!!sheetMarkup}, pageHTMLLength=${sheetMarkup?.length || 0}`);

        if (contentMatchers && sheetMarkup) {
            // Lowercase the (potentially large) pageHTML once and reuse it across
            // every content pattern instead of re-lowercasing per pattern.
            const sheetMarkupLower = sheetMarkup.toLowerCase();
            Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: Starting check of ${contentMatchers.length} patterns`);
            for (const contentMatcher of contentMatchers) {
                const matcherCopy = contentMatcher.text || '';
                Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: Pattern="${matcherCopy}", regex=${contentMatcher.textRegex}, wholeWord=${contentMatcher.textWholeWord}, caseSensitive=${contentMatcher.textCaseSensitive}`);

                const hitChoices2 = {
                    regex: contentMatcher.textRegex === true,
                    wholeWord: contentMatcher.textWholeWord === true,
                    caseSensitive: contentMatcher.textCaseSensitive === true
                };

                // Determine where to search based on settings
                // If checkScripts is explicitly set to true, restrict search to scripts only
                // If false or undefined, search entire page (default)
                const localCheckScripts = contentMatcher.checkScripts === true;

                Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: checkScripts=${localCheckScripts}`);

                let localFound = false;
                let localFoundIn = '';

                if (!localCheckScripts) {
                    // No restrictions = check entire page HTML + external content (default behavior)
                    Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: Searching entire page HTML for "${matcherCopy}"`);
                    if (this.hitMatcher(sheetMarkup, matcherCopy, hitChoices2, sheetMarkupLower)) {
                        localFound = true;
                        localFoundIn = 'page content';
                        Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: MATCH FOUND in page content!`);
                    }

                    // Also search external fetched content
                    if (!localFound && sheetPayload.externalContent && sheetPayload.externalContent.length > 0) {
                        Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: Searching ${sheetPayload.externalContent.length} external resources`);
                        for (const localResource2 of sheetPayload.externalContent) {
                            if (this.hitMatcher(localResource2.content, matcherCopy, hitChoices2)) {
                                localFound = true;
                                localFoundIn = localResource2.url;
                                Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: MATCH FOUND in external resource: ${localResource2.url}`);
                                break;
                            }
                        }
                    }

                    if (!localFound) {
                        Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: No match in page content or external resources`);
                    }
                } else {
                    // Check only scripts
                    if (localContent.length > 0) {
                        for (const localScript2 of localContent) {
                            const localScriptContent = localScript2.content || localScript2.src || '';
                            if (this.hitMatcher(localScriptContent, matcherCopy, hitChoices2)) {
                                localFound = true;
                                localFoundIn = localScript2.src || 'inline script';
                                break;
                            }
                        }
                    }
                }

                if (localFound) {
                    Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: Adding match! confidence=${contentMatcher.confidence}, foundIn=${localFoundIn}`);
                    hits.push({
                        type: 'content',
                        pattern: matcherCopy,
                        value: matcherCopy, // Show the matched pattern itself
                        confidence: contentMatcher.confidence,
                        description: contentMatcher.description
                    });
                } else {
                    Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: Pattern not found: "${matcherCopy}"`);
                }
            }
        } else {
            if (!contentMatchers) {
                Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: No content patterns defined`);
            }
            if (!sheetMarkup) {
                Telemetry.debugStrategy && Telemetry.findingsPane(`[Content Detection] ${rule.name}: No pageHTML provided!`);
            }
        }

        // Check cookies patterns
        if (rule.detection?.cookie && (cookiesToHit.length > 0 || (replyCookies && replyCookies.length > 0))) {
            // Log cookies being matched for this detector
            if (typeof Telemetry !== 'undefined') {
                const originLabel = localAllCookies.length > 0 ? '(via chrome.cookies)' : '(document.cookie)';
                Telemetry.memo(`Matching ${rule.id} against ${cookiesToHit.length} cookies ${originLabel}`, {
                    cookies: cookiesToHit.map(localC => localC.name),
                    patterns: rule.detection.cookie.map(localP => localP.name)
                });
            }

            // Track matched cookies and filter before searching
            const localMatchedCookieNames = new Set();

        // Pre-build cookie arrays and Maps by scope (O(1) lookup vs O(n) filter)
        const inboundCookies = localAllCookies.length > 0 ? localAllCookies : localCookies;
        // "all" should mean cookie sources (request + response), not storage keys
        const allBoundaryCookies = localAllCookies.length > 0
            ? [...localAllCookies, ...(replyCookies || [])]
            : [...localCookies, ...(replyCookies || [])];
        // IMPORTANT: We do not treat localStorage/sessionStorage entries as cookies.

            // Pre-build Maps for O(1) value lookup by name
            const assembleCookieIndex = (localCookieArray) => {
                const index = new Map();
                for (const localC of localCookieArray) {
                    if (!index.has(localC.name)) index.set(localC.name, localC);
                }
                return index;
            };

        const cookieIndexByBoundary = {
            request: assembleCookieIndex(inboundCookies),
            response: assembleCookieIndex(replyCookies || []),
            all: assembleCookieIndex(allBoundaryCookies)
        };

        const cookieArrayByBoundary = {
            request: inboundCookies,
            response: replyCookies || [],
            all: allBoundaryCookies
        };

            const canonicalizeCookieBoundary = (boundary, localFallback) => {
                const localNormalized = typeof boundary === 'string' ? boundary.trim().toLowerCase() : '';
                if (localNormalized === 'all_with_storage') return 'all';
                if (localNormalized === 'storage') return localFallback;
                if (localNormalized === 'request' || localNormalized === 'response' || localNormalized === 'all') return localNormalized;
                return localFallback;
            };

            for (const cookieMatcher of rule.detection.cookie) {
                const labelHitChoices = {
                    regex: cookieMatcher.nameRegex === true,
                    wholeWord: cookieMatcher.nameWholeWord === true,
                    caseSensitive: cookieMatcher.nameCaseSensitive === true
                };

                const datumHitChoices = {
                    regex: cookieMatcher.valueRegex === true,
                    wholeWord: cookieMatcher.valueWholeWord === true,
                    caseSensitive: cookieMatcher.valueCaseSensitive === true
                };

                // Get scope settings (default to 'request' for backward compatibility)
                const labelBoundary = canonicalizeCookieBoundary(cookieMatcher.nameScope, 'request');
                const datumBoundary = canonicalizeCookieBoundary(cookieMatcher.valueScope, 'request');

                const cookiesForLabel = cookieArrayByBoundary[labelBoundary] || inboundCookies;
                const datumIndex = cookieIndexByBoundary[datumBoundary] || cookieIndexByBoundary.request;

                // Filter out already-matched cookies
                const localUnmatchedCookies = cookiesForLabel.filter(localC => !localMatchedCookieNames.has(localC.name));

                // Find matching cookies
                const localMatchingCookies = localUnmatchedCookies.filter(localCookie => {
                    if (cookieMatcher.name && localCookie.name) {
                        const localMatched = this.hitCookieLabel(localCookie.name, cookieMatcher.name, labelHitChoices);

                        if (localMatched) {
                            // If value pattern specified, use Map for O(1) lookup
                            if (cookieMatcher.value) {
                                const cookieInDatumBoundary = datumIndex.get(localCookie.name);
                                if (cookieInDatumBoundary) {
                                    return this.hitMatcher(cookieInDatumBoundary.value || '', cookieMatcher.value, datumHitChoices);
                                }
                                return false;
                            }
                            return true;
                        }
                    }
                    return false;
                });

                // Add all matching cookies to results
                for (const localMatchingCookie of localMatchingCookies) {
                    // Prevent duplicate matches across cookie sources
                    if (localMatchedCookieNames.has(localMatchingCookie.name)) {
                        continue;
                    }
                    localMatchedCookieNames.add(localMatchingCookie.name); // Mark as matched

                    // Log successful match
                    if (typeof Telemetry !== 'undefined') {
                        Telemetry.memo(`${rule.id}: Pattern '${cookieMatcher.name}' matched cookie '${localMatchingCookie.name}'`);
                    }

                    hits.push({
                        type: 'cookie',
                        name: localMatchingCookie.name,
                        value: `${localMatchingCookie.name}=${localMatchingCookie.value || ''}`,
                        confidence: cookieMatcher.confidence || 80,
                        description: cookieMatcher.description
                    });
                }
            }
        }

        // Check headers patterns
        if (rule.detection?.header && (Object.keys(localHeaders).length > 0 || (sheetPayload.requestHeaders && Object.keys(sheetPayload.requestHeaders).length > 0))) {
            for (const headerMatcher of rule.detection.header) {
                const labelHitChoices2 = {
                    regex: headerMatcher.nameRegex === true,
                    wholeWord: headerMatcher.nameWholeWord === true,
                    caseSensitive: headerMatcher.nameCaseSensitive === true
                };

                const datumHitChoices2 = {
                    regex: headerMatcher.valueRegex === true,
                    wholeWord: headerMatcher.valueWholeWord === true,
                    caseSensitive: headerMatcher.valueCaseSensitive === true
                };

                // Get scope settings (default to 'response' for backward compatibility)
                const labelBoundary2 = headerMatcher.nameScope || 'response';
                const datumBoundary2 = headerMatcher.valueScope || 'response';

                // Build headers object based on scope
                const resolveHeadersByBoundary = (boundary) => {
                    if (boundary === 'request') {
                        return sheetPayload.requestHeaders || {};
                    } else if (boundary === 'response') {
                        return localHeaders; // responseHeaders
                    } else if (boundary === 'all') {
                        return { ...(sheetPayload.requestHeaders || {}), ...localHeaders };
                    } else {
                        // Default fallback (shouldn't happen)
                        return localHeaders;
                    }
                };

                const headersForLabel = resolveHeadersByBoundary(labelBoundary2);
                const headersForDatum = resolveHeadersByBoundary(datumBoundary2);

                for (const [headerLabel, headerDatum] of Object.entries(headersForLabel)) {
                    if (headerMatcher.name && this.hitMatcher(headerLabel, headerMatcher.name, labelHitChoices2)) {
                        // If value pattern specified, check it in valueScope headers
                        if (headerMatcher.value) {
                            // Check if this header also exists in value scope
                            const datumToCheck = headersForDatum[headerLabel];
                            if (datumToCheck && this.hitMatcher(datumToCheck, headerMatcher.value, datumHitChoices2)) {
                                hits.push({
                                    type: 'header',
                                    name: headerMatcher.name,
                                    value: `${headerLabel}: ${datumToCheck}`,
                                    confidence: headerMatcher.confidence || 80,
                                    description: headerMatcher.description
                                });
                                // Continue checking for more matching headers
                            }
                        } else {
                            // Just check for header name match
                            hits.push({
                                type: 'header',
                                name: headerMatcher.name,
                                value: `${headerLabel}: ${headerDatum}`,
                                confidence: headerMatcher.confidence || 80,
                                description: headerMatcher.description
                            });
                            // Continue checking for more matching headers
                        }
                    }
                }
            }
        }

        // Check payload patterns - handle both single payload and multiple payloads array
        // First check if we have multiple payloads (new format)
        if (rule.detection?.payload && sheetPayload.payloads && Array.isArray(sheetPayload.payloads)) {
            // Track which patterns have already matched to prevent duplicates
            const matchedMatchers = new Set();

            // Check each payload in the array
            for (const payloadEntry of sheetPayload.payloads) {
                for (const payloadMatcher of rule.detection.payload) {
                    // Skip already-matched patterns
                    const matcherLookup = payloadMatcher.description || payloadMatcher.text;
                    if (matchedMatchers.has(matcherLookup)) {
                        continue;
                    }
                    // Match options for pattern matching
                    const hitChoices3 = {
                        regex: payloadMatcher.textRegex === true,
                        wholeWord: payloadMatcher.textWholeWord === true,
                        caseSensitive: payloadMatcher.textCaseSensitive === true
                    };

                    // NEW: Check HTTP method constraint
                    if (payloadMatcher.methods && Array.isArray(payloadMatcher.methods) && payloadMatcher.methods.length > 0) {
                        const phaseAllowed = payloadMatcher.methods.some(localM =>
                            localM.toUpperCase() === payloadEntry.method.toUpperCase()
                        );
                        if (!phaseAllowed) {
                            continue; // Skip this pattern
                        }
                    }

                    // NEW: Check URL pattern constraint (match against full URL including query parameters)
                    if (payloadMatcher.urlPattern && payloadMatcher.urlPattern.trim() !== '') {
                        const addressHitChoices = {
                            regex: payloadMatcher.urlRegex === true,
                            wholeWord: payloadMatcher.urlWholeWord === true,
                            caseSensitive: payloadMatcher.urlCaseSensitive === true
                        };

                        // Match against full URL (includes query parameters for "contains" matching)
                        const addressMatched = this.hitMatcher(payloadEntry.url, payloadMatcher.urlPattern, addressHitChoices);
                        if (!addressMatched) {
                            continue; // Skip this pattern
                        }
                    }

                    let payloadPayload = payloadEntry.data;

                    // Convert payload to searchable string based on type
                    if (payloadEntry.type === 'formData' && typeof payloadPayload === 'object') {
                        // Convert FormData object to URL-encoded string format for proper pattern matching
                        // Chrome's webRequest API returns FormData as {key: [value, value2, ...]}
                        const localParams = Object.entries(payloadPayload).map(([lookupKey, data]) => {
                            // Values are arrays, take first value (or all values if multiple)
                            const datum = Array.isArray(data) ? data.join(',') : data;
                            return `${lookupKey}=${datum}`;
                        }).join('&');
                        payloadPayload = localParams;
                    } else if (typeof payloadPayload === 'object') {
                        // Convert any other object to JSON string
                        try {
                            payloadPayload = JSON.stringify(payloadPayload);
                        } catch (failure) {
                            payloadPayload = String(payloadPayload);
                        }
                    }

                    // Check if pattern matches in payload data
                    const hitOutcome = this.hitMatcher(payloadPayload, payloadMatcher.text, hitChoices3);

                    if (hitOutcome) {
                        // Extract the matched portion from the payload
                        let matchedDatum = '';
                        const filterStr = payloadPayload.toString();
                        const matcherStr = payloadMatcher.text.toLowerCase();
                        const filterLower = filterStr.toLowerCase();

                        // Find the pattern and extract surrounding context
                        const hitPosition = filterLower.indexOf(matcherStr);
                        if (hitPosition !== -1) {
                            // Extract up to 100 chars around the match for context
                            const begin = Math.max(0, hitPosition - 20);
                            const localEnd = Math.min(filterStr.length, hitPosition + matcherStr.length + 60);
                            matchedDatum = filterStr.substring(begin, localEnd);

                            // Clean up and truncate if too long
                            if (matchedDatum.length > 80) {
                                matchedDatum = matchedDatum.substring(0, 80) + '...';
                            }

                            // If it starts mid-string, add ellipsis
                            if (begin > 0) {
                                matchedDatum = '...' + matchedDatum;
                            }
                        } else {
                            // Fallback to showing just the pattern found
                            matchedDatum = `${payloadMatcher.text} found`;
                        }

                        hits.push({
                            type: 'payload',
                            pattern: payloadMatcher.text,
                            value: matchedDatum,
                            confidence: payloadMatcher.confidence || 80,
                            description: payloadMatcher.description || 'Payload pattern detected'
                        });

                        // Mark this pattern as matched to prevent duplicates
                        // Use same key as check above (description or text)
                        matchedMatchers.add(matcherLookup);

                        break; // Found match, no need to check this pattern again
                    }
                }
            }
        }
        // Fallback to single payload for backward compatibility
        else if (rule.detection?.payload && sheetPayload.payload) {
            for (const payloadMatcher2 of rule.detection.payload) {
                // Match options for pattern matching
                const hitChoices4 = {
                    regex: payloadMatcher2.textRegex === true,
                    wholeWord: payloadMatcher2.textWholeWord === true,
                    caseSensitive: payloadMatcher2.textCaseSensitive === true
                };

                // NEW: Check HTTP method constraint
                if (payloadMatcher2.methods && Array.isArray(payloadMatcher2.methods) && payloadMatcher2.methods.length > 0) {
                    const phaseAllowed2 = payloadMatcher2.methods.some(localM =>
                        localM.toUpperCase() === sheetPayload.payload.method.toUpperCase()
                    );
                    if (!phaseAllowed2) {
                        continue; // Skip this pattern
                    }
                }

                // NEW: Check URL pattern constraint (match against full URL including query parameters)
                if (payloadMatcher2.urlPattern && payloadMatcher2.urlPattern.trim() !== '') {
                    const addressHitChoices2 = {
                        regex: payloadMatcher2.urlRegex === true,
                        wholeWord: payloadMatcher2.urlWholeWord === true,
                        caseSensitive: payloadMatcher2.urlCaseSensitive === true
                    };

                    // Match against full URL (includes query parameters for "contains" matching)
                    const addressMatched2 = this.hitMatcher(sheetPayload.payload.url, payloadMatcher2.urlPattern, addressHitChoices2);
                    if (!addressMatched2) {
                        continue; // Skip this pattern
                    }
                }

                let payloadPayload2 = sheetPayload.payload.data;

                // Convert payload to searchable string based on type
                if (sheetPayload.payload.type === 'formData' && typeof payloadPayload2 === 'object') {
                    // Convert FormData object to URL-encoded string format for proper pattern matching
                    const localParams2 = Object.entries(payloadPayload2).map(([lookupKey, data]) => {
                        const datum = Array.isArray(data) ? data.join(',') : data;
                        return `${lookupKey}=${datum}`;
                    }).join('&');
                    payloadPayload2 = localParams2;
                } else if (typeof payloadPayload2 === 'object') {
                    // Convert any other object to JSON string
                    try {
                        payloadPayload2 = JSON.stringify(payloadPayload2);
                    } catch (failure2) {
                        payloadPayload2 = String(payloadPayload2);
                    }
                }

                // Check if pattern matches in payload data
                if (this.hitMatcher(payloadPayload2, payloadMatcher2.text, hitChoices4)) {
                    // Extract the matched portion from the payload
                    let matchedDatum2 = '';
                    const filterStr2 = payloadPayload2.toString();
                    const matcherStr2 = payloadMatcher2.text.toLowerCase();
                    const filterLower2 = filterStr2.toLowerCase();

                    // Find the pattern and extract surrounding context
                    const hitPosition2 = filterLower2.indexOf(matcherStr2);
                    if (hitPosition2 !== -1) {
                        // Extract up to 100 chars around the match for context
                        const begin2 = Math.max(0, hitPosition2 - 20);
                        const localEnd2 = Math.min(filterStr2.length, hitPosition2 + matcherStr2.length + 60);
                        matchedDatum2 = filterStr2.substring(begin2, localEnd2);

                        // Clean up and truncate if too long
                        if (matchedDatum2.length > 80) {
                            matchedDatum2 = matchedDatum2.substring(0, 80) + '...';
                        }

                        // If it starts mid-string, add ellipsis
                        if (begin2 > 0) {
                            matchedDatum2 = '...' + matchedDatum2;
                        }
                    } else {
                        // Fallback to showing just the pattern found
                        matchedDatum2 = `${payloadMatcher2.text} found`;
                    }

                    hits.push({
                        type: 'payload',
                        pattern: payloadMatcher2.text,
                        value: matchedDatum2,
                        confidence: payloadMatcher2.confidence || 80,
                        description: payloadMatcher2.description || 'Payload pattern detected'
                    });
                }
            }
        }

        // Check DOM patterns
        if (rule.detection?.dom && localDom.length > 0) {
            for (const domMatcher of rule.detection.dom) {
                const matchingNodes = localDom.filter(node => {
                    // The DOM data from content script contains various properties
                    // We need to match the selector pattern against the element data

                    // Handle different selector types
                    const selectorMatcher = domMatcher.selector;

                    // Class selector (e.g., .g-recaptcha)
                    if (selectorMatcher.startsWith('.')) {
                        const classLabel = selectorMatcher.substring(1);
                        const nodeClass = node.class || node.attributes?.class || '';
                        return nodeClass.includes(classLabel);
                    }

                    // ID selector (e.g., #cf-wrapper)
                    if (selectorMatcher.startsWith('#')) {
                        const tokenMatcher = selectorMatcher.substring(1);
                        const nodeToken = node.id || node.attributes?.id || '';
                        return nodeToken === tokenMatcher;
                    }

                    // Attribute selector (e.g., [data-sitekey])
                    if (selectorMatcher.startsWith('[') && selectorMatcher.endsWith(']')) {
                        const attrHit = selectorMatcher.match(/\[([^=\]]+)(?:=['"]*.([^'"\]]+)['"]*.)?(?:\*=["']?([^'"\]]+)["']?)?\]/);
                        if (attrHit) {
                            const [, attrLabel, exactDatum, containsDatum] = attrHit;

                            // Check if element has the attribute
                            if (node.attributes && node.attributes[attrLabel]) {
                                if (exactDatum) {
                                    return node.attributes[attrLabel] === exactDatum;
                                } else if (containsDatum) {
                                    return node.attributes[attrLabel].includes(containsDatum);
                                } else {
                                    return true; // Just checking for attribute existence
                                }
                            }

                            // Also check top-level properties
                            if (node[attrLabel]) {
                                if (exactDatum) {
                                    return node[attrLabel] === exactDatum;
                                } else if (containsDatum) {
                                    return node[attrLabel].includes(containsDatum);
                                } else {
                                    return true;
                                }
                            }
                        }
                    }

                    // Complex selector with src/href contains (e.g., iframe[src*='recaptcha'])
                    if (selectorMatcher.includes('[') && selectorMatcher.includes('*=')) {
                        const hit = selectorMatcher.match(/^(\w+)\[(\w+)\*=['"]*([^'"\]]+)['"]*\]/);
                        if (hit) {
                            const [, tagLabel, attrLabel2, containsDatum2] = hit;

                            // Check if tag matches (if specified)
                            if (tagLabel && node.selector !== tagLabel && node.tagName !== tagLabel) {
                                return false;
                            }

                            // Check attribute contains value
                            const attrDatum = node[attrLabel2] || node.attributes?.[attrLabel2] || '';
                            return attrDatum.includes(containsDatum2);
                        }
                    }

                    // Simple tag selector (e.g., canvas)
                    if (selectorMatcher.match(/^[a-z]+$/)) {
                        return node.selector === selectorMatcher || node.tagName === selectorMatcher;
                    }

                    // Direct selector match (for elements that store their original selector)
                    if (node.selector === selectorMatcher) {
                        return true;
                    }

                    return false;
                });

                // Add all matching DOM elements to results
                for (const matchingNode of matchingNodes) {
                    const nodeCopy = matchingNode.text || matchingNode.textContent || matchingNode.innerText || '';
                    const truncatedCopy = nodeCopy.length > 50 ? nodeCopy.substring(0, 50) + '...' : nodeCopy;
                    hits.push({
                        type: 'dom',
                        selector: domMatcher.selector,
                        value: `${domMatcher.selector}=${truncatedCopy}`,
                        confidence: domMatcher.confidence || 85,
                        description: domMatcher.description
                    });
                }
            }
        }

        // JS hooks detected via MAIN world postMessage

        // Calculate confidence if ConfidenceManager is available, otherwise use max confidence
        const overallEvidence = this.evidenceScorer
            ? this.evidenceScorer.deriveEvidence(hits)
            : Math.max(...hits.map(localM => localM.confidence || 0), 0);

        // Extract unique detection method types from matches
        const scanPhases = [...new Set(hits.map(localM => localM.type))];
        const localManualDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
            ? FindingMetrics.canonicalizeDifficulty(rule?.difficulty)
            : null;
        const baselineDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.baselineDifficultyForTaxonomy === 'function')
            ? FindingMetrics.baselineDifficultyForTaxonomy(rule?.category)
            : 'Medium';
        const localDifficulty = localManualDifficulty || baselineDifficulty;

        return {
            detected: overallEvidence > 0,
            confidence: overallEvidence,
            difficulty: localDifficulty,
            signals: hits,
            detectionMethods: scanPhases,
            detector: {
                id: rule.id,
                name: rule.name,
                category: rule.category,
                // Color resolved dynamically from CategoryManager
                icon: rule.icon,
                description: rule.description,
                difficulty: localDifficulty
            }
        };
    }

    /**
     * Run detection on all loaded detectors against collected page data
     * Uses pre-computed priorities for faster detection
     * @param {object} pageData - Page data from collectPageData()
     * @returns {Promise<array>} Array of detection results
     */
    async detectOnSheet(sheetPayload = {}) {
        Telemetry.debugStrategy && Telemetry.findingsPane('DetectionEngineManager.detectOnPage called');

        if (!this.ruleSet) {
            Telemetry.failure('DETECTION', 'Detectors not set!');
            throw new Error('Detectors not set. Call setDetectors() first.');
        }

        const findings = [];
        const { url: address = '', content: localContent = [], dom: localDom = [], cookies: localCookies = [], headers: localHeaders = {}, pageHTML: sheetMarkup = '', externalContent: localExternalContent = [], jsHooks: jsProbes = [], payload: localPayload, payloads: localPayloads, networkUrls: networkAddresses = [], allCookies: localAllCookies = [], responseCookies: replyCookies = [] } = sheetPayload;

        const cookiesToHit = localAllCookies.length > 0 ? localAllCookies : localCookies;

        const beginMoment = Date.now();

        Telemetry.debugStrategy && Telemetry.findingsPane('Page Data Summary:', {
            url: address,
            contentCount: localContent.length,
            domCount: localDom.length,
            documentCookies: localCookies.length,
            allCookies: localAllCookies.length,
            cookiesForMatching: cookiesToHit.length,
            headersCount: Object.keys(localHeaders).length,
            pageHTMLLength: sheetMarkup.length,
            externalContentCount: localExternalContent.length
        });

        const taxonomiesTotal = Object.keys(this.ruleSet).length;
        Telemetry.debugStrategy && Telemetry.findingsPane(`Processing ${taxonomiesTotal} categories...`);

        // Use pre-computed priorities (saves 50-100ms per detection)
        let rulePriorities = this.executionPlan || [];

        if (rulePriorities.length === 0) {
            Telemetry.performDebug('DETECTION', '[detectOnPage] Pre-computed priorities missing, falling back to runtime calculation');
            this._refreshRulePriorities();
            rulePriorities = this.executionPlan || [];
        }

        Telemetry.debugStrategy && Telemetry.findingsPane(`Running ${rulePriorities.length} detectors (using pre-computed priorities)`);

        let highEvidenceTotal = 0;
        const HIGH_EVIDENCE_THRESHOLD = 95;
        const EARLY_EXIT_TOTAL = 3;

        for (const { category: taxonomy, detectorName: ruleLabel, detector: rule } of rulePriorities) {
            const findingsPane = this.runRule(rule, { url: address, content: localContent, dom: localDom, cookies: localCookies, headers: localHeaders, pageHTML: sheetMarkup, externalContent: localExternalContent, payload: localPayload, payloads: localPayloads, networkUrls: networkAddresses, allCookies: localAllCookies, responseCookies: replyCookies });
            if (findingsPane.detected) {
                Telemetry.debugStrategy && Telemetry.findingsPane(`DETECTED: ${ruleLabel} (confidence: ${findingsPane.confidence}%)`);
                const scanObj = {
                    ...findingsPane,
                    category: taxonomy,
                    detector: ScanEngine.assembleRuleDetail(rule, ruleLabel, ruleLabel)
                };

                if (!scanObj.detector?.id) {
                    Telemetry.failure('DETECTION', `[detectOnPage] CRITICAL: Detection created without detector.id for ${ruleLabel}:`, {
                        hasDetector: !!scanObj.detector,
                        detectorId: scanObj.detector?.id,
                        detectorName: scanObj.detector?.name
                    });
                }

                findings.push(scanObj);

                if (findingsPane.confidence >= HIGH_EVIDENCE_THRESHOLD) {
                    highEvidenceTotal++;
                }

                if (highEvidenceTotal >= EARLY_EXIT_TOTAL) {
                    Telemetry.debugStrategy && Telemetry.findingsPane(`Early exit: Found ${highEvidenceTotal} high-confidence detections`);
                    break;
                }
            }
        }

        // Process JS Hook detections from MAIN world
        if (jsProbes && jsProbes.length > 0) {
            Telemetry.debugStrategy && Telemetry.findingsPane(`[JS Hooks] Processing ${jsProbes.length} hook detections`);

            // Build detector lookup table once (O(1) lookup instead of nested loop)
            const ruleLookup = new Map();
            for (const [taxonomy2, taxonomyCatalog] of Object.entries(this.ruleSet)) {
                for (const [ruleToken, rule2] of Object.entries(taxonomyCatalog)) {
                    ruleLookup.set(rule2.id || ruleToken, { category: taxonomy2, detector: rule2 });
                }
            }

            for (const probePayload of jsProbes) {
                const localFound = ruleLookup.get(probePayload.detectorId);

                if (localFound) {
                    const { category: taxonomy3, detector: rule3 } = localFound;
                    const retainedScan = findings.find(localD => localD.detector.id === probePayload.detectorId);

                    if (retainedScan) {
                        retainedScan.signals.push({
                            type: 'js_hooks',
                            target: probePayload.target,
                            value: probePayload.target,
                            confidence: probePayload.confidence || 80,
                            description: probePayload.description || 'JavaScript API hook'
                        });

                        if (!retainedScan.detectionMethods) {
                            retainedScan.detectionMethods = [];
                        }
                        if (!retainedScan.detectionMethods.includes('js_hooks')) {
                            retainedScan.detectionMethods.push('js_hooks');
                        }

                        retainedScan.confidence = this.evidenceScorer
                            ? this.evidenceScorer.deriveEvidence(retainedScan.signals)
                            : Math.max(...retainedScan.signals.map(localM => localM.confidence || 0), 0);

                        Telemetry.debugStrategy && Telemetry.findingsPane(`[JS Hooks] Added hook to existing detection: ${rule3.name}`);
                    } else {
                        const ruleDetail = ScanEngine.assembleRuleDetail(rule3, probePayload.detectorName, probePayload.detectorId);
                        findings.push({
                            detected: true,
                            confidence: probePayload.confidence || 80,
                            difficulty: ruleDetail.difficulty,
                            signals: [{
                                type: 'js_hooks',
                                target: probePayload.target,
                                value: probePayload.target,
                                confidence: probePayload.confidence || 80,
                                description: probePayload.description || 'JavaScript API hook'
                            }],
                            detectionMethods: ['js_hooks'],
                            category: taxonomy3,
                            detector: ruleDetail
                        });

                        Telemetry.debugStrategy && Telemetry.findingsPane(`[JS Hooks] Created new detection: ${rule3.name}`);
                    }
                }
            }
        }

        const scanMoment = Date.now() - beginMoment;
        Telemetry.debugStrategy && Telemetry.findingsPane(`Total detections found: ${findings.length} in ${scanMoment}ms`);
        if (findings.length > 0) {
            Telemetry.debugStrategy && Telemetry.findingsPane('Detections:', findings.map(localD => localD.detector.name));
        }

        return findings;
    }

    /**
     * Match cookie names with stricter defaults (exact match unless regex/wholeWord)
     * @param {string} name - Cookie name
     * @param {string} pattern - Pattern to match
     * @param {object} options - Matching options
     * @returns {boolean}
     */
    hitCookieLabel(label, matcher, choices = {}) {
        return hitCookieLabelMatcher.apply(this, arguments);
    }
    hitMatcher(copy, matcher, choices = {}) {
        return hitScanMatcher.apply(this, arguments);
    }
    findMatcherHit(copy, matcher, choices = {}) {
        return findScanMatcherHit.apply(this, arguments);
    }
    escapeRegexMatcher(localString) {
        return globalThis.escapeRegexMatcher.apply(this, arguments);
    }
    static composeProbePacketBatcher(localChrome) {
        return composeAdaptiveProbeBatcher.apply(this, arguments);
    }
    static routeProbeBridgePacket(signal, localChrome, probeBatch) {
        return routeProbeBridgePacket.apply(this, arguments);
    }

    /**
     * Look up cached detection data by URL hash
     * @param {string} url - Page URL
     * @returns {Promise<object|null>} Cached detection data or null
     */
    static async resolveStoredScan(address) {
        const releaseRepositoryLock = await acquireScanRepositoryLock();
        try { // outer: release the storage lock in finally
        try {
            const memoBoundary = await ExtensionGateway.resolveMemoBoundary();
            const outcome = await chrome.storage.local.get([ScanEngine.REPOSITORY_LOOKUP]);
            let repository = outcome[ScanEngine.REPOSITORY_LOOKUP] || {};
            if (typeof repository === 'string') {
                try {
                    repository = JSON.parse(repository);
                } catch (failure) {
                    Telemetry.performWarn('DETECTION', '[getStoredDetection] Stored cache is not valid JSON; ignoring cache', failure);
                    repository = {};
                }
            }
            if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
                repository = {};
            }
            const expiredLookups = [];
            const resolveStoredScanTotal = (localStored) => (
                localStored?.detectionCount ?? (Array.isArray(localStored?.detectionResults) ? localStored.detectionResults.length : 0)
            );
            const resolveAcceptedStored = (lookupKey, origin) => {
                const localStored = repository[lookupKey];
                if (!localStored) {
                    return null;
                }

                if (Date.now() >= localStored.expiry) {
                    Telemetry.debugStrategy && Telemetry.findingsPane(`[getStoredDetection] Cache expired for ${address} (${origin})`);
                    expiredLookups.push(lookupKey);
                    return null;
                }

                Telemetry.debugStrategy && Telemetry.findingsPane(`[getStoredDetection] Cache hit for ${address} via ${origin} (stored scope: ${localStored.memoScope || 'unknown'})`);
                return localStored;
            };

            const localScopesToTry = [memoBoundary, ...['domain', 'path', 'full'].filter(boundary => boundary !== memoBoundary)];
            let boundaryFallback = null;
            for (const boundary of localScopesToTry) {
                const addressHash = WebAddress.hashAddress(address, boundary);
                const localStored = resolveAcceptedStored(addressHash, `scope:${boundary}`);
                if (localStored) {
                    if (resolveStoredScanTotal(localStored) > 0) {
                        if (expiredLookups.length > 0) {
                            for (const expiredLookup of new Set(expiredLookups)) {
                                delete repository[expiredLookup];
                            }
                            await chrome.storage.local.set({ [ScanEngine.REPOSITORY_LOOKUP]: repository });
                        }
                        return localStored;
                    }

                    if (!boundaryFallback || localStored.timestamp > boundaryFallback.timestamp) {
                        boundaryFallback = localStored;
                    }
                }
            }

            const localRequestedHostname = WebAddress.resolveHostnameFromAddress(address);
            let localHostnameFallback = null;
            for (const [lookupKey, localStored2] of Object.entries(repository)) {
                if (!localStored2) continue;
                if (Date.now() >= localStored2.expiry) {
                    expiredLookups.push(lookupKey);
                    continue;
                }
                const localStoredHostname = localStored2.hostname || WebAddress.resolveHostnameFromAddress(localStored2.url || '');
                if (WebAddress.hostnamesHit(localRequestedHostname, localStoredHostname)) {
                    if (!localHostnameFallback ||
                        resolveStoredScanTotal(localStored2) > resolveStoredScanTotal(localHostnameFallback) ||
                        (resolveStoredScanTotal(localStored2) === resolveStoredScanTotal(localHostnameFallback) && localStored2.timestamp > localHostnameFallback.timestamp)) {
                        localHostnameFallback = localStored2;
                    }
                }
            }

            if (expiredLookups.length > 0) {
                for (const lookupKey2 of new Set(expiredLookups)) {
                    delete repository[lookupKey2];
                }
                await chrome.storage.local.set({ [ScanEngine.REPOSITORY_LOOKUP]: repository });
            }

            if (localHostnameFallback) {
                Telemetry.debugStrategy && Telemetry.findingsPane(`[getStoredDetection] Cache hit for ${address} via hostname fallback`);
                return localHostnameFallback;
            }

            if (boundaryFallback) {
                Telemetry.debugStrategy && Telemetry.findingsPane(`[getStoredDetection] Cache hit for ${address} via zero-result scope fallback`);
                return boundaryFallback;
            }
        } catch (failure2) {
            Telemetry.performWarn('DETECTION', '[getStoredDetection] Storage read failed', failure2);
        }
        return null;
        } finally {
            releaseRepositoryLock();
        }
    }

    /**
     * Get detection data for a specific tab
     * @param {number} tabId - Tab ID
     * @returns {Promise<object|null>} Detection data or null
     */
    static async resolveScanPayload(pageToken) {
        try {
            const page = await chrome.tabs.get(pageToken);
            if (!page || !page.url) {
                return null;
            }

            const storedPayload = await ScanEngine.resolveStoredScan(page.url);
            if (storedPayload) {
                return {
                    data: storedPayload,
                    detectionResults: storedPayload.detectionResults || [],
                    timestamp: storedPayload.timestamp,
                    expiry: storedPayload.expiry,
                    storageExpiry: storedPayload.expiry,
                    fromStorage: true,
                    processed: true,
                    url: storedPayload.url,
                    memoScope: storedPayload.memoScope
                };
            }
        } catch (failure) {
            Telemetry.performWarn('DETECTION', '[getDetectionData] Storage read failed', failure);
        }

        return null;
    }

    /**
     * Store detection results for a URL
     * @param {string} url - Page URL
     * @param {object} pageData - Page data (url, hostname, favicon)
     * @param {array} detectionResults - Detection results
     * @returns {Promise<object|null>} Stored data object or null
     */
    static async cacheScan(address, sheetPayload, scanOutcomes) {
        const releaseRepositoryLock = await acquireScanRepositoryLock();
        try { // outer: release the storage lock in finally
        try {
            const memoBoundary = await ExtensionGateway.resolveMemoBoundary();
            const outcome = await chrome.storage.local.get([ScanEngine.REPOSITORY_LOOKUP]);
            let repository = outcome[ScanEngine.REPOSITORY_LOOKUP] || {};
            if (typeof repository === 'string') {
                try {
                    repository = JSON.parse(repository);
                } catch (failure) {
                    Telemetry.performWarn('STORAGE', '[storeDetection] Stored cache is not valid JSON; replacing cache', failure);
                    repository = {};
                }
            }
            if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
                repository = {};
            }
            const addressHash = WebAddress.hashAddress(address, memoBoundary);
            const retainedStoredPayload = repository[addressHash];
            const retainedIsAccepted = retainedStoredPayload &&
                (!retainedStoredPayload.memoScope || retainedStoredPayload.memoScope === memoBoundary) &&
                Date.now() < retainedStoredPayload.expiry;
            const resolveStoredScanTotal = (localStored) => (
                localStored?.detectionCount ?? (Array.isArray(localStored?.detectionResults) ? localStored.detectionResults.length : 0)
            );
            let retainedPositivePayload = retainedIsAccepted && resolveStoredScanTotal(retainedStoredPayload) > 0
                ? retainedStoredPayload
                : null;

            if (scanOutcomes.length === 0 && !retainedPositivePayload) {
                const localRequestedHostname = WebAddress.resolveHostnameFromAddress(address);
                for (const localStored of Object.values(repository)) {
                    if (!localStored || Date.now() >= localStored.expiry || resolveStoredScanTotal(localStored) <= 0) {
                        continue;
                    }

                    const exactAddressHit = localStored.url === address;
                    const localStoredHostname = localStored.hostname || WebAddress.resolveHostnameFromAddress(localStored.url || '');
                    if (!exactAddressHit && !WebAddress.hostnamesHit(localRequestedHostname, localStoredHostname)) {
                        continue;
                    }

                    if (!retainedPositivePayload ||
                        resolveStoredScanTotal(localStored) > resolveStoredScanTotal(retainedPositivePayload) ||
                        (resolveStoredScanTotal(localStored) === resolveStoredScanTotal(retainedPositivePayload) && localStored.timestamp > retainedPositivePayload.timestamp)) {
                        retainedPositivePayload = localStored;
                    }
                }
            }

            // A weak/no-signal re-detection should not erase a still-valid positive
            // cache entry. This commonly happens when an existing tab is revisited
            // after hooks have already fired or content-script signals are unavailable.
            if (scanOutcomes.length === 0 && retainedPositivePayload) {
                Telemetry.performWarn('STORAGE', `[storeDetection] Preserving existing positive cache for ${address}; new run produced zero detections`);
                return {
                    ...retainedPositivePayload,
                    preservedExisting: true
                };
            }

            // Compress detectionResults to essential fields only
            const compressedOutcomes = scanOutcomes.map((findingsPane) => {
                const localNormalizedDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
                    ? FindingMetrics.canonicalizeDifficulty(findingsPane?.difficulty || findingsPane?.detector?.difficulty)
                    : null;
                const baselineDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.baselineDifficultyForTaxonomy === 'function')
                    ? FindingMetrics.baselineDifficultyForTaxonomy(findingsPane?.category || findingsPane?.detector?.category)
                    : 'Medium';
                const localDifficulty = localNormalizedDifficulty || baselineDifficulty;

                return {
                    id: findingsPane.id,
                    difficulty: localDifficulty,
                    detector: {
                        id: findingsPane.detector?.id,
                        name: findingsPane.detector?.name || findingsPane.name || 'Unknown',
                        icon: findingsPane.detector?.icon || 'custom.png',
                        color: findingsPane.detector?.color,
                        description: findingsPane.detector?.description,
                        difficulty: localDifficulty
                    },
                    category: findingsPane.category,
                    confidence: findingsPane.confidence,
                    signals: findingsPane.signals?.map(localM => ({
                        type: localM.type,
                        pattern: localM.pattern,
                        value: localM.value || localM.pattern || localM.name || localM.selector,
                        confidence: localM.confidence,
                        description: localM.description,
                        fullUrl: localM.fullUrl
                    })) || []
                };
            });

            // Calculate overall confidence
            const overallEvidence = scanOutcomes.length > 0
                ? Math.round(scanOutcomes.reduce((localSum, localD) => localSum + localD.confidence, 0) / scanOutcomes.length)
                : 0;

            const localExpiryMs = await ScanEngine.resolveExpiryMs();
            const normalizedSitemark = WebAddress.canonicalizeSitemarkForRepository(
                sheetPayload.favicon,
                sheetPayload.url || sheetPayload.hostname || address
            );

            const storedPayload = {
                url: address,
                hostname: sheetPayload.hostname,
                favicon: normalizedSitemark,
                detectionResults: compressedOutcomes,
                timestamp: Date.now(),
                expiry: Date.now() + localExpiryMs,
                confidence: overallEvidence,
                detectionCount: scanOutcomes.length,
                fromStorage: false,
                memoScope: memoBoundary
            };

            repository[addressHash] = storedPayload;
            await chrome.storage.local.set({ [ScanEngine.REPOSITORY_LOOKUP]: repository });

            Telemetry.debugStrategy && Telemetry.findingsPane(`[storeDetection] Stored ${scanOutcomes.length} detections for ${address}`);
            return storedPayload;
        } catch (failure2) {
            Telemetry.failure('STORAGE', '[storeDetection] Error storing detection:', failure2);
            return null;
        }
        } finally {
            releaseRepositoryLock();
        }
    }

    /**
     * Handle PAGE_LOAD_SIGNAL message
     * @param {object} request - Message request object
     * @param {object} sender - Message sender
     * @param {object} dependencies - Required dependencies
     */
    static async routeSheetReadToast(inbound, localSender, localDependencies) {
        const {
            browserApi: localChrome,
            taxonomyType: TaxonomyCatalog,
            archiveType: ScanArchivePresenter,
            extensionGateway: ExtensionGateway,
            taxonomy,
            recentScanRequests
        } = localDependencies;

        const sheetAddress = inbound.url;
        const pageToken = localSender.tab?.id;
        const triggerOrigin = inbound.triggerSource || 'unknown';

        if (!pageToken) {
            Telemetry.performWarn('DETECTION', '[handlePageLoad] No tab ID in notification');
            return;
        }

        Telemetry.debugStrategy && Telemetry.findingsPane(`[handlePageLoadNotification] Detection trigger: ${triggerOrigin} for tab ${pageToken}`);

        // Check if extension is enabled
        try {
            const outcome = await localChrome.storage.local.get(['scrapeless_enabled']);
            if (outcome.scrapeless_enabled === false) {
                Telemetry.debugStrategy && Telemetry.findingsPane('Extension is disabled, skipping page load detection');
                localChrome.action.setBadgeText({ text: BadgeTokens.TEXT.DISABLED, tabId: pageToken }).catch(() => {});
                localChrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.DISABLED, tabId: pageToken }).catch(() => {});
                return;
            }
        } catch (failure) {
            Telemetry.performWarn('DETECTION', '[handlePageLoad] Enabled state check failed', failure);
        }

        // Check if URL is blacklisted
        const localIsBlacklisted = await ExtensionGateway.isAddressBlacklisted(sheetAddress);
        if (localIsBlacklisted) {
            Telemetry.debugStrategy && Telemetry.findingsPane(`[handlePageLoadNotification] URL is blacklisted: ${sheetAddress}`);
            localChrome.action.setBadgeText({ text: BadgeTokens.TEXT.BLACKLISTED, tabId: pageToken }).catch(() => {});
            localChrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.BLACKLISTED, tabId: pageToken }).catch(() => {});
            return;
        }

        // Check cache first
        const storedPayload = await ScanEngine.resolveStoredScan(sheetAddress);

        if (storedPayload) {
            Telemetry.debugStrategy && Telemetry.findingsPane(`[handlePageLoadNotification] Cache hit for ${sheetAddress} (${storedPayload.detectionCount} detectors)`);

            // Update badge with cached detection count
            if (storedPayload.detectionCount > 0) {
                const total = storedPayload.detectionCount.toString();
                const palette = await TaxonomyCatalog.resolveBadgeTint(
                    storedPayload.detectionResults,
                    storedPayload.detectionCount,
                    taxonomy
                );
                localChrome.action.setBadgeText({ text: total, tabId: pageToken }).catch(() => {});
                localChrome.action.setBadgeBackgroundColor({ color: palette, tabId: pageToken }).catch(() => {});
            } else {
                localChrome.action.setBadgeText({ text: BadgeTokens.TEXT.CLEAN, tabId: pageToken }).catch(() => {});
                localChrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.CLEAN, tabId: pageToken }).catch(() => {});
            }

            // Notify popup if open
            localChrome.runtime.sendMessage({
                type: 'NEW_DETECTION_DATA',
                tabId: pageToken,
                url: sheetAddress,
                favicon: storedPayload.favicon,
                detectionResults: storedPayload.detectionResults,
                fromStorage: true
            }).catch(() => {});

            // Notify content script to disable monitoring (cache hit)
            localChrome.tabs.sendMessage(pageToken, {
                type: 'CACHE_HIT_DISABLE_MONITORING',
                url: sheetAddress
            }).catch(() => {});

            // Check if we should save to history on cache hit
            const archivePreferences = await ExtensionGateway.resolveArchivePreferences();
            if (archivePreferences.archiveOnMemoHit === true && storedPayload.detectionResults && storedPayload.detectionResults.length > 0) {
                const shouldPersist = await ScanArchivePresenter.shouldPersistToArchive(sheetAddress, archivePreferences, localChrome);
                if (shouldPersist) {
                    const page = await localChrome.tabs.get(pageToken).catch(() => null);
                    if (page) {
                        const sheetPayload = {
                            url: sheetAddress,
                            hostname: WebAddress.resolveHostnameFromAddress(sheetAddress),
                            title: page.title || 'Untitled',
                            favicon: WebAddress.canonicalizeSitemarkForRepository(page.favIconUrl, sheetAddress)
                        };
                        await ScanArchivePresenter.persistScanToArchive(pageToken, sheetPayload, storedPayload.detectionResults, localChrome, {
                            historySettings: archivePreferences,
                            source: 'cache_hit'
                        });
                    }
                }
            }

            return;
        }

        // Cache miss - skip if recent detection exists
        if (ExtensionGateway.shouldSkipScan(pageToken, 1500, recentScanRequests)) {
            Telemetry.debugStrategy && Telemetry.findingsPane(`Skipping duplicate detection request for tab ${pageToken}`);
            return;
        }

        // Show loading indicator
        try {
            if (typeof beginBadgeSpinner === 'function') {
                beginBadgeSpinner(pageToken);
            }
        } catch (failure2) {
            Telemetry.performWarn('DETECTION', '[handlePageLoad] Loading badge failed', failure2);
        }

        // Request data collection from content script with retry
        let retryTotal = 0;
        const limitRetries = 5;
        const localRetryDelay = 200;

        const sendPayloadInbound = () => {
            localChrome.tabs.sendMessage(pageToken, { type: 'REQUEST_PAGE_DATA' }, (reply) => {
                if (localChrome.runtime.lastError) {
                    const failureMsg = localChrome.runtime.lastError?.message || '';
                    if ((failureMsg.includes('Could not establish connection') ||
                         failureMsg.includes('Receiving end does not exist') ||
                         failureMsg.includes('No receiving end')) && retryTotal < limitRetries) {
                        retryTotal++;
                        setTimeout(sendPayloadInbound, localRetryDelay);
                    } else {
                        Telemetry.performWarn('DETECTION', `Failed to send data collection request after ${retryTotal} retries: ${failureMsg}`);
                    }
                }
            });
        };

        sendPayloadInbound();
    }

    /**
     * Handle CLEAR_DETECTION_CACHE message
     * @param {object} request - Message request object
     * @param {function} sendResponse - Response callback
     * @param {Set} manuallyClearedCaches - Set to track manually cleared URLs
     * @returns {boolean} True (async response)
     */
    static async routePurgeScanMemo(inbound, sendReply, manualCacheKeys = null) {
        try {
            const requestedBoundaryUnprocessed = String(inbound.memoScope || '').toLowerCase();
            const requestedBoundary = requestedBoundaryUnprocessed === 'url' ? 'full' : requestedBoundaryUnprocessed;
            const localAllowedScopes = ['domain', 'path', 'full'];

            if (requestedBoundaryUnprocessed && !localAllowedScopes.includes(requestedBoundary)) {
                Telemetry.performWarn('DETECTION', `[handleClearDetectionCache] Invalid cache scope "${requestedBoundaryUnprocessed}", falling back to settings scope`);
            }

            const memoBoundary = localAllowedScopes.includes(requestedBoundary)
                ? requestedBoundary
                : await ExtensionGateway.resolveMemoBoundary();
            const outcome = await chrome.storage.local.get([ScanEngine.REPOSITORY_LOOKUP]);
            const repository = outcome[ScanEngine.REPOSITORY_LOOKUP] || {};
            const addressHash = WebAddress.hashAddress(inbound.url, memoBoundary);

            if (repository[addressHash]) {
                delete repository[addressHash];
                await chrome.storage.local.set({ [ScanEngine.REPOSITORY_LOOKUP]: repository });

                if (manualCacheKeys) {
                    manualCacheKeys.add(addressHash);
                }

                sendReply({ status: 'cleared', urlHash: addressHash });
            } else {
                sendReply({ status: 'not_found' });
            }
        } catch (failure) {
            Telemetry.failure('DETECTION', 'Error clearing cache:', failure);
            sendReply({ status: 'error', error: failure.message });
        }

        return true;
    }

    /**
     * Handle REQUEST_SCAN message - manually triggered detection
     * @param {object} request - Message request object
     * @param {function} sendResponse - Response callback
     * @param {object} dependencies - Required dependencies
     * @returns {boolean} True (async response)
     */
    static async routeInboundScan(inbound, sendReply, localDependencies) {
        const {
            browserApi: localChrome,
            extensionGateway: ExtensionGateway,
            recentScanRequests,
            runningScans
        } = localDependencies;
        const pageToken = inbound.tabId;

        if (!pageToken) {
            sendReply({ status: 'error', error: 'No tab ID provided' });
            return false;
        }

        // Check if extension is enabled
        try {
            const outcome = await localChrome.storage.local.get(['scrapeless_enabled']);
            if (outcome.scrapeless_enabled === false) {
                sendReply({ status: 'error', error: 'Extension is disabled' });
                return true;
            }
        } catch (failure) {
            Telemetry.performWarn('DETECTION', '[requestDetection] Enabled state check failed', failure);
        }

        try {
            const page = await localChrome.tabs.get(pageToken);

            if (!ExtensionGateway.isAcceptedContentScriptPage(page)) {
                sendReply({ status: 'error', error: 'Invalid URL for detection' });
                return true;
            }

            if (ExtensionGateway.shouldSkipScan(pageToken, RuntimePolicy.DETECTION_SKIP_THRESHOLD, recentScanRequests)) {
                sendReply({ status: 'skipped', reason: 'Recent detection exists' });
                return true;
            }

            const localIsSilent = inbound.silent === true;

            // Try to ping the content script first
            let localScriptExists = false;
            try {
                await new Promise((localResolve) => {
                    localChrome.tabs.sendMessage(pageToken, { type: 'GET_DETECTION_STATUS' }, (reply) => {
                        if (!localChrome.runtime.lastError && reply && reply.status === 'active') {
                            localScriptExists = true;
                        }
                        localResolve();
                    });
                });
            } catch (failure2) {
                // Content script may not be ready
            }

            if (!localScriptExists) {
                if (!localIsSilent) {
                    try {
                        await localChrome.action.setBadgeText({ text: BadgeTokens.TEXT.EMPTY, tabId: pageToken });
                    } catch (failure3) {
                        Telemetry.performWarn('DETECTION', '[requestDetection] Empty badge reset failed', failure3);
                    }
                }

                Telemetry.performWarn('DETECTION', '[requestDetection] Content script unavailable; page reload required', { tabId: pageToken });
                sendReply({
                    status: 'needs_reload',
                    reason: 'content_script_unavailable',
                    message: 'Reload the page to run detection.'
                });
                return true;
            }

            const inboundBeginMoment = Date.now();
            if (runningScans) {
                runningScans.assign(pageToken, {
                    url: page.url,
                    startTime: inboundBeginMoment,
                    abortController: new AbortController(),
                    pendingRequest: true,
                    source: inbound.source || 'request_detection'
                });

                setTimeout(() => {
                    try {
                        const active = runningScans.resolve(pageToken);
                        if (active?.pendingRequest && active.startTime === inboundBeginMoment) {
                            Telemetry.performWarn('DETECTION', `[requestDetection] Pending detection did not produce data for tab ${pageToken}; clearing marker`);
                            runningScans.delete(pageToken);
                        }
                    } catch (failure) {
                        Telemetry.performWarn('DETECTION', '[requestDetection] Pending marker cleanup failed', failure);
                    }
                }, RuntimePolicy.REQUEST_DETECTION_PENDING_TIMEOUT);
            }

            if (!localIsSilent) {
                try {
                    if (typeof beginBadgeSpinner === 'function') {
                        beginBadgeSpinner(pageToken);
                    }
                } catch (failure4) {
                    Telemetry.performWarn('DETECTION', '[requestDetection] Loading badge failed', failure4);
                }
            }

            // Send the detection request
            localChrome.tabs.sendMessage(pageToken, {
                type: 'RUN_DETECTION',
                silent: localIsSilent
            }, (reply) => {
                if (localChrome.runtime.lastError) {
                    Telemetry.performWarn('DETECTION', '[requestDetection] Trigger failed:', localChrome.runtime.lastError.message);
                    if (runningScans) {
                        const active = runningScans.resolve(pageToken);
                        if (active?.pendingRequest && active.startTime === inboundBeginMoment) {
                            runningScans.delete(pageToken);
                        }
                    }
                    sendReply({ status: 'error', error: localChrome.runtime.lastError.message });
                } else {
                    sendReply({ status: 'requested', response: reply });
                }
            });
        } catch (failure5) {
            Telemetry.failure('DETECTION', 'Error in REQUEST_SCAN:', failure5);
            sendReply({ status: 'error', error: failure5.message });
        }

        return true;
    }
}
