/**
 * registerDetectionHandlers registration.
 * Extracted from message-router switch cases for maintainability.
 */
function registerScanRoutes(localRegistry, localContext) {
    void localContext;

    const routeSheetReadToast = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Clear interrupted marker on new page load
        if (localSender.tab?.id) {
            if (cancelledScans.performHas(localSender.tab.id)) {
                Telemetry.performBackground(`[Background] Clearing interrupted state for tab ${localSender.tab.id} (new page load)`);
                cancelledScans.delete(localSender.tab.id);
            }
        }

        (async () => {
            try {
                await ensureRuleCoordinatorStarted();

                await ScanEngine.routeSheetReadToast(inbound, localSender, {
                    browserApi: chrome,
                    taxonomyType: TaxonomyCatalog,
                    archiveType: ScanArchivePresenter,
                    extensionGateway: ExtensionGateway,
                    taxonomy,
                    recentScanRequests
                });

                sendReply({ status: 'ok' });
            } catch (failure) {
                Telemetry.failure('BACKGROUND', '[Background] Error handling PAGE_LOAD_SIGNAL:', failure);
                sendReply({ status: 'error', error: failure.message });
            }
        })();
        return true; // Keep SW alive until badge/cache work completes
    };
    localRegistry['PAGE_LOAD_SIGNAL'] = routeSheetReadToast;

    const routeScanPayload = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        (async () => {
            const debugSession = {};
            const debugStrategy = await ensureDebugStrategy(debugSession);
            if (debugStrategy) {
                Telemetry.performDebug('BACKGROUND', '[SCAN_PAYLOAD] Received', { tabId: localSender.tab?.id, keys: Object.keys(inbound) });
            }
            const sheetPayload = inbound.data;
            if (debugStrategy) {
                Telemetry.performDebug('BACKGROUND', '[SCAN_PAYLOAD] Page data', {
                    cookies: sheetPayload?.cookies?.length || 0,
                    headers: sheetPayload?.headers ? Object.keys(sheetPayload.headers).length : 0,
                    scripts: sheetPayload?.scripts?.length || 0,
                    dom: sheetPayload?.dom?.length || 0,
                    url: sheetPayload?.url
                });
            }
            try {
                if (debugStrategy) {
                    Telemetry.performDebug('BACKGROUND', '[SCAN_PAYLOAD] Processing...');
                }
                await ingestScanPayload(inbound, localSender);
                if (debugStrategy) {
                    Telemetry.performDebug('BACKGROUND', '[SCAN_PAYLOAD] Processing complete');
                }
                sendReply({ status: 'received', tabId: localSender.tab?.id });
            } catch (failure) {
                Telemetry.failure('BACKGROUND', '[DetectionData] ERROR in processDetectionData:', failure);
                // Notify content script for JS API error event (scrapeless:onError)
                try {
                    const pageToken = localSender.tab?.id;
                    if (pageToken) {
                        chrome.tabs.sendMessage(pageToken, {
                            type: 'DETECTION_ERROR',
                            url: inbound?.data?.url || localSender.tab?.url,
                            error: failure?.message || String(failure),
                            stage: 'processDetectionData',
                            timestamp: new Date().toISOString()
                        }).catch(() => {
                            // Content script may not be ready; ignore
                        });
                    }
                } catch (failure2) {
                    // Never let error reporting break message flow
                }
                sendReply({ status: 'error', error: failure.message });
            }
        })();
        return true; // Async response
    };
    localRegistry['SCAN_PAYLOAD'] = routeScanPayload;

    const routeContentScriptReady = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        Telemetry.performBackground(`Scrapeless Background: Content script ready on ${inbound.url}`);
        sendReply({ status: 'acknowledged' });
    };
    localRegistry['PAGE_AGENT_READY'] = routeContentScriptReady;

    const routeResolveScanPayload = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        (async () => {
            try {
                let payload = null;
                let condition = 'ok';
                let destinationPageToken = inbound.tabId || null;

                if (!destinationPageToken) {
                    const [runningPage] = await chrome.tabs.query({ active: true, currentWindow: true });
                    destinationPageToken = runningPage?.id || null;
                }

                if (destinationPageToken) {
                    if (destinationPageToken === focusedTabId && cancelledScans.performHas(destinationPageToken)) {
                        Telemetry.performBackground(`[READ_SCAN_PAYLOAD] Clearing interrupted state for current tab ${destinationPageToken} (user viewing popup)`);
                        cancelledScans.delete(destinationPageToken);
                    }

                    payload = inbound.tabId
                        ? await ScanEngine.resolveScanPayload(destinationPageToken)
                        : await resolveActivePageScanPayload();

                    // Completed data wins over stale interrupted markers
                    if (payload && cancelledScans.performHas(destinationPageToken)) {
                        Telemetry.performBackground(`[READ_SCAN_PAYLOAD] Clearing interrupted state for tab ${destinationPageToken} (has cached completed data)`);
                        cancelledScans.delete(destinationPageToken);
                    }

                    // Sync badge when returning cached data (ensures popup open always fixes stale badges)
                    if (payload) {
                        try {
                            const page = await chrome.tabs.get(destinationPageToken);
                            if (page && page.url) {
                                assignBadgeForFindings(destinationPageToken, page.url, payload.detectionResults || []);
                            }
                        } catch (failure) { /* tab may have closed */ }
                    }

                    if (!payload) {
                        const scanSession = scanSessions.resolve(destinationPageToken);
                        const hasRunningSession = !!(scanSession && !scanSession.finalized);
                        let runningScan = runningScans.resolve(destinationPageToken);
                        if (runningScan?.pendingRequest &&
                            Date.now() - runningScan.startTime > RuntimePolicy.REQUEST_DETECTION_PENDING_TIMEOUT) {
                            Telemetry.performBackground(`[READ_SCAN_PAYLOAD] Clearing stale pending request for tab ${destinationPageToken}`);
                            runningScans.delete(destinationPageToken);
                            runningScan = null;
                        }
                        const hasRunningScan = !!runningScan;
const localIsRecentlyCleared = purgedTabs.has(destinationPageToken);
                        const localIsInterrupted = cancelledScans.performHas(destinationPageToken);

                        if (localIsRecentlyCleared) {
                            condition = 'ok';
                        } else if (localIsInterrupted && !hasRunningSession && !hasRunningScan) {
                            condition = 'interrupted';
                        } else if (hasRunningSession || hasRunningScan) {
                            condition = 'pending';
                        } else {
                            let badgeCopy = '';
                            try {
                                badgeCopy = await chrome.action.getBadgeText({ tabId: destinationPageToken });
                            } catch (badgeFailure) {
                                Telemetry.performBackground(`[READ_SCAN_PAYLOAD] Failed to read badge text for tab ${destinationPageToken}:`, badgeFailure.message);
                            }
                            const localTrimmed = badgeCopy ? badgeCopy.trim() : '';
                            const localIsLoadingBadge = isLoadingBadgeCopy(localTrimmed);

                            // Clear stale loading badge for idle tab
                            if (localIsLoadingBadge) {
                                Telemetry.performBackground(`[READ_SCAN_PAYLOAD] Clearing stale loading badge for idle tab ${destinationPageToken}`);
                                try {
                                    await chrome.action.setBadgeText({ text: BadgeTokens.TEXT.EMPTY, tabId: destinationPageToken });
                                } catch (badgePurgeFailure) {
                                    Telemetry.performBackground(`[READ_SCAN_PAYLOAD] Failed to clear stale loading badge for tab ${destinationPageToken}:`, badgePurgeFailure.message);
                                }
                            }

                            condition = 'ok';
                        }

                        // Clear stale numeric badge if tab is truly idle
                        if (condition === 'ok' && !hasRunningSession && !hasRunningScan) {
                            try {
                                const badgeCopy2 = await chrome.action.getBadgeText({ tabId: destinationPageToken });
                                const localTrimmed2 = badgeCopy2 ? badgeCopy2.trim() : '';
                                const localIsNumericBadge = /^\d+\+?$/.test(localTrimmed2);
                                if (localIsNumericBadge) {
                                    Telemetry.performBackground(`[READ_SCAN_PAYLOAD] Clearing stale numeric badge '${localTrimmed2}' for idle tab ${destinationPageToken}`);
                                    await chrome.action.setBadgeText({ text: '', tabId: destinationPageToken });
                                }
                            } catch (failure2) {
                                // Silently fail
                            }
                        }
                    }
                }

                // Include progress state for popup step indicators
                const session = destinationPageToken ? scanSessions.resolve(destinationPageToken) : null;
                const finishedPhases = session ? Array.from(session.completedMethods || []) : [];
                const aggregatePercent = session ? Math.round((session.completedMethods?.size || 0) / 7 * 100) : 0;

                sendReply({
                    data: payload,
                    status: condition,
                    progress: {
                        completedMethods: finishedPhases,
                        totalPercent: aggregatePercent,
                        method: finishedPhases[finishedPhases.length - 1] || null // Last completed method
                    }
                });
            } catch (failure3) {
                Telemetry.failure('BACKGROUND', 'Scrapeless Background: Error in READ_SCAN_PAYLOAD:', failure3);
                sendReply({ data: null, status: 'error', error: failure3.message });
            }
        })();
        return true; // Will respond asynchronously
    };
    localRegistry['READ_SCAN_PAYLOAD'] = routeResolveScanPayload;

    const routeInboundScan = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Initialize progress update before delegation
        if (inbound.tabId) {
            sendProgressRefresh(inbound.tabId, 'main', new Set(), 7);
        }

        (async () => {
            try {
                await ensureRuleCoordinatorStarted();

                return await ScanEngine.routeInboundScan(inbound, sendReply, {
                    browserApi: chrome,
                    extensionGateway: ExtensionGateway,
                    recentScanRequests,
                    runningScans
                });
            } catch (failure) {
                // Without this, a throw before handleRequestDetection calls
                // sendResponse leaves the message channel open forever and the
                // popup hangs with no diagnostic.
                Telemetry.failure('BACKGROUND', '[REQUEST_SCAN] Unhandled error:', failure);
                try { sendReply({ status: 'error', error: failure && failure.message }); } catch (local) { /* channel already closed */ }
            }
        })();
        return true; // Will respond asynchronously
    };
    localRegistry['REQUEST_SCAN'] = routeInboundScan;

    const routeJsProbeScanBatch = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

            // Process batched JS hook detections
            (async () => {
                let pageToken;
                try {
                    if (!localSender.tab || !localSender.tab.id) {
                        Telemetry.performWarn('BACKGROUND', '[hookBatch] No tab info in sender');
                        return;
                    }

                    pageToken = localSender.tab.id;

                    // Early exit if tab is using cache
if (cacheBackedTabs.has(pageToken)) {
                        Telemetry.performBackground(`[Background] JS Hooks - Tab ${pageToken} using cache - discarding hooks immediately`);
                        return; // Skip all processing for cached tabs
                    }

                    const findings = inbound.detections || [];

                    if (findings.length === 0) return;

                    // Extract URL for cache check
                    const address = findings[0]?.url;
                    if (!address) return;

                    // Create state BEFORE cache check so we can set usedCache flag
                    const session = resolveOrComposeScanSession(pageToken, address);

                    // CACHE CHECK: If cache exists for this URL, skip processing hooks entirely
                    const memoizedPayload = await ScanEngine.resolveStoredScan(address);
                    if (memoizedPayload) {
                        // Mark this detection as using cache to suppress misleading warning logs
                        session.usedCache = true;

batchLocks.set(pageToken, false);
                        Telemetry.performBackground(`[Batch Flag] SET to FALSE (cache hit) for tab ${pageToken}`);
                        return; // Don't process hooks - we have cached results
                    }

                    // Mark batch processing as active to prevent finalization race
const priorFlag = batchLocks.get(pageToken);
batchLocks.set(pageToken, true);
                    Telemetry.performBackground(`[hookBatch] Batch processing started for tab ${pageToken}`);

                    Telemetry.performBackground(`[Background] JS Hook batch from tab ${pageToken}: ${findings.length} hooks`);

                    Telemetry.performBackground(`[Background] JS Hooks details:`);
                    findings.forEach(probePayload => {
                        const localDet = probePayload.detection;
                        const isInlineProbe = localDet.detectorId && localDet.detectorId.startsWith('inline-hook-');
                        Telemetry.performBackground(`[Background]   - ${localDet.detectorName} (ID: ${localDet.detectorId}) [${isInlineProbe ? 'INLINE' : 'DYNAMIC'}]: ${localDet.hook.target}`);
                    });
                    await ensureRuleCoordinatorStarted();

                    // Record batch arrival time for deterministic finalization
                    session.lastHookBatchTime = Date.now();

                    if (session.url !== address) {
                        Telemetry.performBackground(`[Background] URL changed during JS hooks for tab ${pageToken}: ${address} → ${session.url} - skipping hooks`);
                        return;
                    }
                    for (const probePayload of findings) {
                        const findingsPane = probePayload.detection;
                        const ruleToken = findingsPane.detectorId;
                        const normalizedTaxonomy = findingsPane.category ? findingsPane.category.toLowerCase() : 'fingerprint';

                        let fullRule = ruleCatalog.resolveRule(normalizedTaxonomy, ruleToken);
                        if (!fullRule) {
                            fullRule = ruleCatalog.findRuleByToken(ruleToken);
                        }
                        if (!fullRule) {
                            Telemetry.performWarn('BACKGROUND', `[hookBatch] Detector ${ruleToken} not found, skipping`);
                            continue;
                        }

                        if (!session.hooksData.has(ruleToken)) {
                            const localNormalizedDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
                                ? FindingMetrics.canonicalizeDifficulty(fullRule?.difficulty)
                                : null;
                            const baselineDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.baselineDifficultyForTaxonomy === 'function')
                                ? FindingMetrics.baselineDifficultyForTaxonomy(normalizedTaxonomy || fullRule?.category)
                                : 'Medium';
                            const localDifficulty = localNormalizedDifficulty || baselineDifficulty;

                            session.hooksData.set(ruleToken, {
                                detector: {
                                    id: fullRule.id || ruleToken,
                                    name: fullRule.name || findingsPane.detectorName || 'Unknown',
                                    icon: fullRule.icon,
                                    color: fullRule.color,
                                    description: fullRule.description,
                                    difficulty: localDifficulty
                                },
                                category: normalizedTaxonomy,
                                difficulty: localDifficulty,
                                confidence: 0,
                                detectionMethods: ['js_hooks'],
                                signals: []
                            });
                        }

                        const rule = session.hooksData.get(ruleToken);
                        const newHit = {
                            type: 'js_hooks',
                            pattern: findingsPane.hook.target,
                            value: findingsPane.hook.target.split('.').pop(),
                            confidence: findingsPane.hook.confidence,
                            description: findingsPane.hook.description
                        };

                        const localIsDuplicate = rule.signals.some(localM => localM.pattern === newHit.pattern);
                        if (!localIsDuplicate) {
                            rule.signals.push(newHit);
                        }

                        rule.confidence = Math.max(...rule.signals.map(localM => localM.confidence || 0));
                    }

                    Telemetry.performBackground(`[Background] Processed ${findings.length} hooks in batch for tab ${pageToken}`);

                } catch (failure) {
                    Telemetry.failure('BACKGROUND', '[Background] ERROR handling JS hook batch:', failure);
                } finally {
                    if (pageToken) {
batchLocks.set(pageToken, false);
                        Telemetry.performBackground(`[hookBatch] Batch complete for tab ${pageToken}, allowing finalization`);
                        checkAndCommitScan(pageToken);
                    }
                }
            })();
            return false; // No response needed for batches

    };
    localRegistry['PROBE_SIGNAL_BATCH'] = routeJsProbeScanBatch;

    const routeGlobalFindings = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Process window property detections from MAIN world
        (async () => {
            try {
                if (!localSender.tab || !localSender.tab.id) {
                    Telemetry.performWarn('BACKGROUND', '[GLOBAL_SIGNALS] No tab info in sender');
                    return;
                }

                const pageToken = localSender.tab.id;

if (cacheBackedTabs.has(pageToken)) {
                    Telemetry.performBackground(`[Background] Window Detections - Tab ${pageToken} using cache - discarding properties immediately`);
                    return;
                }

                const address = localSender.tab.url;
                const { detections: findings, executionTime: executionMoment } = inbound;

                if (!Array.isArray(findings)) {
                    Telemetry.performWarn('BACKGROUND', '[GLOBAL_SIGNALS] Invalid detections format:', typeof findings);
                    return;
                }

                const session = resolveOrComposeScanSession(pageToken, address);

                // Skip if cached results exist for this URL
                const memoizedPayload = await ScanEngine.resolveStoredScan(address);
                if (memoizedPayload) {
                    session.usedCache = true;
                    return;
                }

                Telemetry.performBackground(`[Background] Window property detections from tab ${pageToken}: ${findings.length} properties in ${executionMoment}ms`);

                if (findings.length > 0) {
                    Telemetry.performBackground(`[Background] Window property details:`);
                    findings.forEach(localDet => {
                        Telemetry.performBackground(`[Background]   - ${localDet.detectorName} (${localDet.detectorId}): window.${localDet.property.path}`);
                    });
                } else {
                    Telemetry.performBackground(`[Background] No window properties detected (none matched conditions)`);
                }

                // Validate state
                if (!session) {
                    Telemetry.failure('BACKGROUND', '[Background] Failed to get/create detection state for tab', pageToken);
                    return;
                }

                if (session.url !== address) {
                    Telemetry.performBackground(`[Background] URL changed during window props for tab ${pageToken}: ${address} → ${session.url} - skipping window props`);
                    return;
                }

                if (!Array.isArray(session.mainData)) {
                    Telemetry.performBackground('[Background] Initializing mainData array for tab', pageToken);
                    session.mainData = [];
                }

                for (const findingsPane of findings) {
                    if (!findingsPane || !findingsPane.detectorId) {
                        Telemetry.performWarn('BACKGROUND', '[GLOBAL_SIGNALS] Skipping invalid detection:', findingsPane);
                        continue;
                    }

                    let scanObj = session.mainData.find(localD => localD && (localD.detector?.id === findingsPane.detectorId || localD.id === findingsPane.detectorId));
                    if (!scanObj) {
                        const taxonomyLookup = findingsPane.category.toLowerCase().replace(/[^a-z0-9]/g, '');
                        const fullRule = ruleCatalog.resolveRule(taxonomyLookup, findingsPane.detectorId);
                        const localNormalizedDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
                            ? FindingMetrics.canonicalizeDifficulty(fullRule?.difficulty)
                            : null;
                        const baselineDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.baselineDifficultyForTaxonomy === 'function')
                            ? FindingMetrics.baselineDifficultyForTaxonomy(findingsPane.category || fullRule?.category)
                            : 'Medium';
                        const localDifficulty = localNormalizedDifficulty || baselineDifficulty;

                        scanObj = {
                            detected: true,
                            confidence: findingsPane.property.confidence,
                            difficulty: localDifficulty,
                            signals: [],
                            detectionMethods: [],
                            category: findingsPane.category,
                            detector: {
                                id: findingsPane.detectorId,
                                name: findingsPane.detectorName,
                                icon: fullRule?.icon,
                                color: fullRule?.color,
                                description: fullRule?.description,
                                difficulty: localDifficulty
                            }
                        };
                        session.mainData.push(scanObj);
                    }

                    const newHit = {
                        type: 'window',
                        pattern: findingsPane.property.path,
                        confidence: findingsPane.property.confidence,
                        description: findingsPane.property.description,
                        actualType: findingsPane.property.actualType,
                        condition: findingsPane.property.condition
                    };

                    const localIsDuplicate = scanObj.signals.some(localM =>
                        localM.type === 'window' && localM.pattern === newHit.pattern
                    );

                    if (!localIsDuplicate) {
                        scanObj.signals.push(newHit);
                        if (!scanObj.detectionMethods) {
                            scanObj.detectionMethods = [];
                        }
                        if (!scanObj.detectionMethods.includes('window')) {
                            scanObj.detectionMethods.push('window');
                        }
                        Telemetry.performBackground(`[Background] Added window property: ${findingsPane.property.path} for ${findingsPane.detectorName}`);
                    }

                    scanObj.confidence = Math.max(...scanObj.signals.map(localM => localM.confidence || 0));
                }

                Telemetry.performBackground(`[Background] Processed ${findings.length} window properties for tab ${pageToken}`);

            } catch (failure) {
                Telemetry.failure('BACKGROUND', '[Background] ERROR handling window property detections:', failure);
            }
        })();
        return false; // No response needed
    };
    localRegistry['GLOBAL_SIGNALS'] = routeGlobalFindings;

    const routeGlobalPropsFinished = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Mark window properties complete and check finalization
        (async () => {
            try {
                if (!localSender.tab || !localSender.tab.id) {
                    Telemetry.performWarn('BACKGROUND', '[GLOBAL_SIGNALS_COMPLETE] No tab info in sender');
                    return;
                }

                const pageToken = localSender.tab.id;

if (cacheBackedTabs.has(pageToken)) {
                    Telemetry.performBackground(`[Background] Window Props - Tab ${pageToken} using cache - discarding signal`);
                    sendReply({ status: 'cached', message: 'Tab using cached detection' });
                    return;
                }

                const address = inbound.url;

                Telemetry.performBackground(`[GLOBAL_SIGNALS_COMPLETE] Signal received for tab ${pageToken}`, {
                    detected: inbound.detectedCount,
                    checked: inbound.totalChecked,
                    elapsed: inbound.elapsedMs,
                    reason: inbound.reason
                });

                const session = resolveOrComposeScanSession(pageToken, address);

                // URL validation with normalization (trailing slashes, hash)
                const canonicalizeAddress = (localU) => {
                    try {
                        const decoded = new URL(localU);
                        return decoded.origin + decoded.pathname.replace(/\/$/, '') + decoded.search;
                    } catch (failure) {
                        return localU;
                    }
                };

                const normalizedSessionAddress = canonicalizeAddress(session.url);
                const normalizedInboundAddress = canonicalizeAddress(address);

                if (normalizedSessionAddress !== normalizedInboundAddress) {
                    Telemetry.performDebug('BACKGROUND', `[GLOBAL_SIGNALS_COMPLETE] URL mismatch, ignoring signal for tab ${pageToken}`, {
                        stateUrl: session.url,
                        requestUrl: address
                    });
                    sendReply({ status: 'url_changed' });
                    return;
                }

                session.windowPropertiesComplete = true;

                // Skip progress updates after finalization (onDetection already fired)
                if (!session.finalized) {
                    markPhaseFinished(pageToken, 'windowProperties');
                        Telemetry.performBackground(`[GLOBAL_SIGNALS_COMPLETE] Marked complete, checking finalization`);
                    checkAndCommitScan(pageToken);
                }

                sendReply({ status: 'success' });
            } catch (failure) {
                Telemetry.failure('BACKGROUND', '[GLOBAL_SIGNALS_COMPLETE] ERROR handling window props complete:', failure);
                sendReply({ status: 'error', error: failure.message });
            }
        })();
        return true; // Async response
    };
    localRegistry['GLOBAL_SIGNALS_COMPLETE'] = routeGlobalPropsFinished;

    const routeJsProbesFinished = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

            // Mark hooks complete and check finalization
            (async () => {
                try {
                    if (!localSender.tab || !localSender.tab.id) {
                        Telemetry.performWarn('BACKGROUND', '[PROBE_HOOKS_COMPLETE] No tab info in sender');
                        return;
                    }

                    const pageToken = localSender.tab.id;
                    const address = inbound.url;

                    Telemetry.performBackground(`[PROBE_HOOKS_COMPLETE] Signal received for tab ${pageToken}`, {
                        totalDetections: inbound.totalDetections,
                        uniqueHooks: inbound.uniqueHooks,
                        elapsed: inbound.completionTime,
                        reason: inbound.completionReason
                    });

                    const session = resolveOrComposeScanSession(pageToken, address);

                    const canonicalizeAddress = (localU) => {
                        try {
                            const decoded = new URL(localU);
                            return decoded.origin + decoded.pathname.replace(/\/$/, '') + decoded.search;
                        } catch (failure) {
                            return localU;
                        }
                    };

                    const normalizedSessionAddress = canonicalizeAddress(session.url);
                    const normalizedInboundAddress = canonicalizeAddress(address);

                    if (normalizedSessionAddress !== normalizedInboundAddress) {
                        Telemetry.performDebug('BACKGROUND', `[PROBE_HOOKS_COMPLETE] URL mismatch, ignoring signal for tab ${pageToken}`, {
                            stateUrl: session.url,
                            requestUrl: address
                        });
                        sendReply({ status: 'url_changed' });
                        return;
                    }

                    session.hooksComplete = true;
                    session.hooksTimedOut = false;
                    session.hooksCompletionReason = inbound.completionReason || session.hooksCompletionReason || null;
                    session.hooksCompletionTime = inbound.completionTime || session.hooksCompletionTime || null;
                    session.hooksUninstallStats = inbound.uninstallStats || session.hooksUninstallStats || null;

                    const debugStrategy = await ensureDebugStrategy(session);
                    if (debugStrategy && inbound.uninstallStats) {
                        Telemetry.performBackground(`[Background] Hook uninstall stats:`, inbound.uninstallStats);
                    }

                    if (!session.finalized) {
                        markPhaseFinished(pageToken, 'jsHooks');

                        Telemetry.performBackground(`[Background] Hooks marked complete`);
                        Telemetry.performBackground(`[Background] Current completion status: ${session.completedMethods.size}/7 methods`);
                        Telemetry.performBackground(`[Background] Completed methods: ${Array.from(session.completedMethods).join(', ')}`);

                        checkAndCommitScan(pageToken);
                    }

                    // 1s safety retry in case debounce missed the completion
                    setTimeout(() => {
                        const activeSession = scanSessions.resolve(pageToken);
                        if (activeSession && !activeSession.finalized && activeSession.completedMethods.has('jsHooks')) {
                            Telemetry.performDebug('BACKGROUND', `[PROBE_HOOKS_COMPLETE] Retry: not finalized after 1s, forcing check`);
                            checkAndCommitScan(pageToken);
                        }
                    }, 1000);

                    sendReply({ status: 'success' });
                } catch (failure) {
                    Telemetry.failure('BACKGROUND', '[Background] ERROR handling JS hooks complete:', failure);
                    sendReply({ status: 'error', error: failure.message });
                }
            })();
            return true; // Async response
    };
    localRegistry['PROBE_HOOKS_COMPLETE'] = routeJsProbesFinished;

    const routeResolveCatalog = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Load detectors with retry for slow service worker startup
        (async () => {
            try {
                const beginMoment = Date.now();
                Telemetry.performBackground('[Background] READ_RULE_CATALOG request received');
                let localRetries = RuntimePolicy.DETECTOR_LOAD_MAX_RETRIES;
                const limitRetries = localRetries;

                while (localRetries > 0) {
                    await ensureRuleCoordinatorStarted();

                    const allCatalog = ruleCatalog.resolveAllCatalog();
                    const hasCatalog = allCatalog && Object.keys(allCatalog).length > 0;

                    if (hasCatalog) {
                        const localElapsed = Date.now() - beginMoment;
                        const ruleTotal = Object.values(allCatalog).reduce((localSum, localCat) =>
                            localSum + Object.keys(localCat).length, 0
                        );
                        const localAttempts = limitRetries - localRetries + 1;
                        Telemetry.performBackground(`[Background] Detectors loaded successfully in ${localElapsed}ms (${localAttempts} attempts)`);
                        Telemetry.performBackground(`[Background] Sending ${ruleTotal} detectors across ${Object.keys(allCatalog).length} categories`);

                        sendReply({
                            detectors: allCatalog
                        });
                        return;
                    }

                    const localAttemptsLeft = localRetries - 1;
                    const localElapsedSoFar = Date.now() - beginMoment;
                    Telemetry.performDebug('BACKGROUND', `[READ_RULE_CATALOG] Waiting for detectors (${localElapsedSoFar}ms elapsed, ${localAttemptsLeft} retries left)`);

                    // Diagnostic logging on first attempt
                    if (localRetries === limitRetries) {
                        Telemetry.performBackground('[Background] Initial diagnostic: DetectorManager state:', {
                            exists: !!ruleCatalog,
                            initialized: ruleCatalog?.started,
                            detectorCount: ruleCatalog ? Object.keys(ruleCatalog.resolveAllCatalog() || {}).length : 0,
                            categoryManagerExists: !!taxonomy
                        });

                        chrome.storage.local.get(['scrapeless_detectors', 'scrapeless_categories'], (unprocessedRepository) => {
                            Telemetry.performBackground('[Background] DIAGNOSTIC: Raw chrome.storage.local contents:', {
                                hasDetectorsKey: !!unprocessedRepository.scrapeless_detectors,
                                hasCategoriesKey: !!unprocessedRepository.scrapeless_categories,
                                detectorsTimestamp: unprocessedRepository.scrapeless_detectors?.timestamp,
                                detectorsDataKeys: unprocessedRepository.scrapeless_detectors?.detectors ? Object.keys(unprocessedRepository.scrapeless_detectors.detectors) : [],
                                categoriesDataKeys: unprocessedRepository.scrapeless_categories?.categories ? Object.keys(unprocessedRepository.scrapeless_categories.categories) : []
                            });

                            if (unprocessedRepository.scrapeless_detectors?.detectors) {
                                const ruleTaxonomies = Object.keys(unprocessedRepository.scrapeless_detectors.detectors);
                                Telemetry.performBackground('[Background] DIAGNOSTIC: Storage detector categories:', ruleTaxonomies);

                                for (const localCat of ruleTaxonomies) {
                                    const ruleNames = Object.keys(unprocessedRepository.scrapeless_detectors.detectors[localCat] || {});
                                    Telemetry.performBackground(`[Background] DIAGNOSTIC: Storage category "${localCat}": ${ruleNames.length} detectors`);
                                }
                            }

                            if (ruleCatalog) {
                                const coordinatorTaxonomies = Object.keys(ruleCatalog.resolveAllCatalog());
                                Telemetry.performBackground('[Background] DIAGNOSTIC: RuleCatalog categories:', coordinatorTaxonomies);

                                if (coordinatorTaxonomies.length === 0 && unprocessedRepository.scrapeless_detectors?.detectors) {
                                    Telemetry.failure('BACKGROUND', '[READ_RULE_CATALOG] MISMATCH: storage has rules but RuleCatalog is empty (repository read failed)');
                                }
                            }
                        });
                    }

                    if ((limitRetries - localRetries) % 5 === 0 && localRetries < limitRetries) {
                        const localProgress = Math.round(((limitRetries - localRetries) / limitRetries) * 100);
                        Telemetry.performBackground(`[Background] Progress: ${localProgress}% (waiting for JSON files to load...)`);
                    }

                    localRetries--;
                    if (localRetries > 0) {
                        await new Promise(localResolve => setTimeout(localResolve, RuntimePolicy.DETECTOR_LOAD_RETRY_DELAY));
                    }
                }

                const localElapsed2 = Date.now() - beginMoment;
                Telemetry.failure('BACKGROUND', `[READ_RULE_CATALOG] Failed to load detectors after ${localElapsed2}ms (${limitRetries} retries)`, {
                    detectorManagerExists: !!ruleCatalog,
                    initialized: ruleCatalog?.started,
                    categoriesCount: ruleCatalog ? Object.keys(ruleCatalog.resolveAllCatalog() || {}).length : 0,
                    categoryManagerExists: !!taxonomy,
                    categoryManagerInitialized: taxonomy?.started,
                    categoriesLoaded: taxonomy?.started && taxonomy.taxonomies
                        ? Object.keys(taxonomy.taxonomies)
                        : null
                });

                sendReply({ detectors: {} });
            } catch (failure) {
                Telemetry.failure('BACKGROUND', '[READ_RULE_CATALOG] Error getting detectors:', failure);
                sendReply({ detectors: {} });
            }
        })();
        return true; // Will respond asynchronously
    };
    localRegistry['READ_RULE_CATALOG'] = routeResolveCatalog;

}
