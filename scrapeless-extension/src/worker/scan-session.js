/**
 * Background detection lifecycle helpers.
 * Extracted from src/entry/worker.js to keep the service worker entry thin.
 */

const PRIMARY_SCAN_PHASES = Object.freeze(['cookies', 'headers', 'url', 'dom', 'payload']);

function markPrimaryPhasesFinished(pageToken) {
    for (const phaseLabel of PRIMARY_SCAN_PHASES) {
        markPhaseFinished(pageToken, phaseLabel);
    }
}

function markPhaseFinished(pageToken, phaseLabel) {
    const session = scanSessions.resolve(pageToken);
    if (!session) {
        Telemetry.performDebug('BACKGROUND', `[markMethodComplete] No state for tab ${pageToken}, cannot mark ${phaseLabel} complete`);
        return;
    }

    // VALIDATION: Only allow valid method names from the official methodOrder
    const acceptedPhases = session.methodOrder || ['cookies', 'headers', 'url', 'dom', 'jsHooks', 'windowProperties', 'payload'];
    if (!acceptedPhases.includes(phaseLabel)) {
        Telemetry.performWarn('BACKGROUND', `[markMethodComplete] Invalid method name: "${phaseLabel}"`);
        return;
    }

    if (session.completedMethods.has(phaseLabel)) {
        return; // already marked complete; avoid duplicate progress events
    }

    session.completedMethods.add(phaseLabel);
    sendProgressRefresh(pageToken, phaseLabel, session.completedMethods);
}

function checkAndCommitScan(pageToken) {
    const session = scanSessions.resolve(pageToken);
    if (!session) {
        Telemetry.performDebug('BACKGROUND', `[checkAndFinalize] No state for tab ${pageToken}, aborting`);
        return;
    }

    // Prevent premature finalization on newly created state
    if (session.startTime && (Date.now() - session.startTime < RuntimePolicy.MIN_DETECTION_TIME)) {
        return;
    }

    // Skip finalization if batch processing is active
const batchRunning = batchLocks.get(pageToken) === true;
    if (batchRunning) {
        return;
    }

    // Debounce finalization checks (400ms = 2 window property polling cycles)
if (finalizeTimers.has(pageToken)) {
clearTimeout(finalizeTimers.get(pageToken));
    }

    const deadline = setTimeout(async () => {
        // Re-check state in case it was deleted during debounce
        const activeSession = scanSessions.resolve(pageToken);
        if (!activeSession) {
            Telemetry.performDebug('BACKGROUND', `[checkAndFinalize] No state for tab ${pageToken} after debounce, aborting`);
            finalizeTimers.delete(pageToken);
            return;
        }

        const finishedPhases = Array.from(activeSession.completedMethods || []);
        const finishedTotal = finishedPhases.length;
        const aggregatePhases = 7;
        const phaseOrder = ['cookies', 'headers', 'url', 'dom', 'jsHooks', 'windowProperties', 'payload'];
        const missingPhases = phaseOrder.filter(localM => !activeSession.completedMethods.has(localM));

if (batchLocks.get(pageToken) === true) {
            finalizeTimers.delete(pageToken);
            return;
        }

        // Wait for batch settle time after last batch arrival
        const momentSinceLastBatch = Date.now() - (activeSession.lastHookBatchTime || 0);
        if (activeSession.lastHookBatchTime > 0 && momentSinceLastBatch < RuntimePolicy.BATCH_SETTLE_TIME) {
            const localRemainingMs = RuntimePolicy.BATCH_SETTLE_TIME - momentSinceLastBatch;
            // Reschedule check - don't clear, just set new one
            const newDeadline = setTimeout(() => checkAndCommitScan(pageToken), localRemainingMs);
finalizeTimers.set(pageToken, newDeadline);
            return;
        }

        // Ensure minimum 500ms passed since detection started
        const momentSinceBegin = Date.now() - (activeSession.startTime || 0);
        if (activeSession.startTime && momentSinceBegin < RuntimePolicy.MIN_DETECTION_TIME && !activeSession.hooksComplete) {
            const localRemainingMs2 = RuntimePolicy.MIN_DETECTION_TIME - momentSinceBegin;
            Telemetry.performBackground(`[Finalize] Waiting ${localRemainingMs2}ms for minimum detection time (hooks not complete yet)`);
            const newDeadline2 = setTimeout(() => checkAndCommitScan(pageToken), localRemainingMs2);
finalizeTimers.set(pageToken, newDeadline2);
            return;
        }

        // Lenient finalization: 5 main methods instead of all 7
        const REQUIRED_PHASES = 5;
        const mainPhasesFinished = ['cookies', 'headers', 'url', 'dom', 'payload'].every(localM => activeSession.completedMethods.has(localM));

        // Check if we should finalize
        const shouldCommit =
            // Option 1: All 7 methods complete (ideal case)
            finishedTotal >= aggregatePhases ||
            // Option 2: Main 5 methods complete (fallback for signal issues)
            (mainPhasesFinished && finishedTotal >= REQUIRED_PHASES) ||
            // Option 3: We have detection data and main methods are done (quick finalization)
            (mainPhasesFinished && (activeSession.mainData?.length > 0 || activeSession.hooksData?.size > 0));

        if (shouldCommit) {
            const localNow = Date.now();
            const probesDeadline = await ensureProbesDeadline(activeSession);
            const debugStrategy = await ensureDebugStrategy(activeSession);

            if (!activeSession.hooksComplete && !activeSession.usedCache && localNow < probesDeadline) {
                if (debugStrategy) {
                    const localRemaining = probesDeadline - localNow;
                    Telemetry.performDebug('BACKGROUND', `[checkAndFinalize] Deferring for hooks: ${localRemaining}ms until deadline`);
                }
                const localRemainingMs3 = probesDeadline - localNow;
                const localDelay = Math.min(localRemainingMs3, 500);
                const newDeadline3 = setTimeout(() => checkAndCommitScan(pageToken), localDelay);
finalizeTimers.set(pageToken, newDeadline3);
                return;
            }

            if (!activeSession.hooksComplete && localNow >= probesDeadline) {
                activeSession.hooksTimedOut = true;
                activeSession.hooksComplete = true;
                activeSession.hooksCompletionReason = activeSession.hooksCompletionReason || 'deadline_timeout';
                activeSession.hooksCompletionTime = activeSession.hooksCompletionTime || (localNow - (activeSession.startTime || localNow));
                markPhaseFinished(pageToken, 'jsHooks');
                if (debugStrategy) {
                    Telemetry.performDebug('BACKGROUND', `[checkAndFinalize] Hooks deadline reached, marking jsHooks complete`);
                }
            }

            // Send final update - use actual completed count for accurate badge
            sendProgressRefresh(pageToken, 'complete', activeSession.completedMethods || new Set(), aggregatePhases);
            commitScan(pageToken, activeSession);
        } else {
            // Check if this detection is using cached data
            if (activeSession.usedCache) {
                // Mark as finalized to prevent retry logic from firing
                activeSession.finalized = true;

                finalizeTimers.delete(pageToken);
                return;
            }

            // Debug-only: log incomplete methods
            const localPercent = Math.round((finishedTotal / aggregatePhases) * 100);
            Telemetry.performDebug('BACKGROUND', `[checkAndFinalize] ${finishedTotal}/${aggregatePhases} methods (${localPercent}%)`, {
                completed: finishedPhases,
                missing: missingPhases,
                waiting: {
                    windowProperties: !activeSession.windowPropertiesComplete,
                    mainComplete: !activeSession.mainComplete,
                    hooks: !activeSession.hooksComplete
                }
            });
        }

        finalizeTimers.delete(pageToken);
    }, RuntimePolicy.FINALIZATION_CHECK_DELAY); // 2 window property polling cycles (200ms each)

finalizeTimers.set(pageToken, deadline);
}

async function commitScan(pageToken, session) {
    // Prevent progress updates from overriding the final badge
    session.finalized = true;

    // End keepalive for this detection
    if (workerLeases) {
        workerLeases.performEndOperation(`detection-${pageToken}`);
    }

    // Skip finalization if detection was interrupted; clean up to prevent zombie state
    if (session.interrupted || cancelledScans.performHas(pageToken)) {
        scanSessions.delete(pageToken);
        runningScans.delete(pageToken);
        Telemetry.performBackground(`[Finalize] Detection interrupted for tab ${pageToken}, cleaned up state`);
        return;
    }

    // Allow finalization if methods completed, even with empty results
    const hasProbesPayload = session.hooksData && session.hooksData.size > 0;
    const hasMainPayload = session.mainData && session.mainData.length > 0;
    const hasFinishedPhases = session.completedMethods && session.completedMethods.size > 0;

    if (!hasProbesPayload && !hasMainPayload && !hasFinishedPhases) {
        return; // Don't finalize with empty data AND no completed methods
    }

    // Merge hooks and main detection by detectorId
    const mergedFindings = new Map();

    for (const [ruleToken, rule] of session.hooksData.entries()) {
        mergedFindings.set(ruleToken, rule);
    }

    for (const rule2 of session.mainData) {
        const ruleToken2 = rule2.detector?.id || rule2.id;
        if (mergedFindings.has(ruleToken2)) {
            const retained = mergedFindings.get(ruleToken2);
            retained.signals = [...retained.signals, ...(rule2.signals || [])];

            const retainedPhases = retained.detectionMethods || [];
            const newPhases = rule2.detectionMethods || [];
            retained.detectionMethods = [...new Set([...retainedPhases, ...newPhases])];
        } else {
            if (!rule2.detectionMethods) {
                rule2.detectionMethods = [];
            }
            mergedFindings.set(ruleToken2, rule2);
        }
    }

    let finalOutcomes = Array.from(mergedFindings.values());
    const normalizedSitemark = WebAddress.canonicalizeSitemarkForRepository(session.favicon, session.url);

    // Store to cache
    const sheetPayload = {
        url: session.url,
        hostname: WebAddress.resolveHostnameFromAddress(session.url),
        favicon: normalizedSitemark
    };

    const storedPayloadWithExpiry = await ScanEngine.cacheScan(session.url, sheetPayload, finalOutcomes);
    const preservedRetainedMemo = storedPayloadWithExpiry?.preservedExisting === true;

    if (preservedRetainedMemo && storedPayloadWithExpiry.detectionResults?.length > 0) {
        finalOutcomes = storedPayloadWithExpiry.detectionResults;
        Telemetry.performBackground(`[Finalize] Preserved existing positive cache for tab ${pageToken}; suppressing empty re-detection result`);
    }

    // Update state with expiry info for immediate popup queries
    if (storedPayloadWithExpiry) {
        session.expiry = storedPayloadWithExpiry.expiry;
        session.timestamp = storedPayloadWithExpiry.timestamp;
        session.favicon = storedPayloadWithExpiry.favicon;
    }

    // Update badge with appropriate color
    await assignBadgeForFindings(pageToken, session.url, finalOutcomes);

    // Notify popup
    chrome.runtime.sendMessage({
        type: 'NEW_DETECTION_DATA',
        tabId: pageToken,
        url: session.url,
        favicon: session.favicon,
        detectionResults: finalOutcomes
    }).catch(() => {
        // Expected: Popup may not be open
    });

    // Notify content script for JS API event dispatch (onDetection)
    try {
        await chrome.tabs.sendMessage(pageToken, {
            type: 'DETECTION_COMPLETE',
            url: session.url,
            detections: finalOutcomes,
            detectionCount: finalOutcomes.length,
            timestamp: new Date().toISOString()
        });
    } catch (failure) {
        // Expected: Tab may have been closed or content script not ready
        Telemetry.performBackground(`[Finalize] Could not notify content script for JS API: ${failure.message}`);
    }

    // Save complete detections (includes hooks/fingerprints) to history
    if (finalOutcomes.length > 0 && !preservedRetainedMemo) {
        try {
            const sheetPayload2 = {
                url: session.url,
                hostname: WebAddress.resolveHostnameFromAddress(session.url),
                tabTitle: session.tabTitle,
                favicon: WebAddress.canonicalizeSitemarkForRepository(session.favicon, session.url)
            };

            const archivePreferences = await ExtensionGateway.resolveArchivePreferences();
            const shouldPersist = await ScanArchivePresenter.shouldPersistToArchive(session.url, archivePreferences, chrome);

            if (shouldPersist) {
                await ScanArchivePresenter.persistScanToArchive(pageToken, sheetPayload2, finalOutcomes, chrome, {
                    historySettings: archivePreferences,
                    source: 'finalize'
                });
            }
        } catch (failure2) {
            Telemetry.failure('DETECTION', '[Finalize] Error saving to history:', failure2);
        }
    }

    // Remove from active detections (detection completed successfully)
    if (runningScans.performHas(pageToken)) {
        runningScans.delete(pageToken);
    }

    // Also remove from interrupted detections if it was marked (user came back to tab)
    if (cancelledScans.performHas(pageToken)) {
        cancelledScans.delete(pageToken);
    }

    // Eagerly delete state (TTL would clean up eventually)
    scanSessions.delete(pageToken);

    // Clean up payloads after detection completes (they were stored for this detection)
    if (requestBodyCache.performHas(pageToken)) {
        requestBodyCache.delete(pageToken);
    }

    // Clean up network URLs after detection completes
    if (requestUrlCache.performHas(pageToken)) {
        requestUrlCache.delete(pageToken);
    }

    // Clean up headers after detection completes (free up memory like payloads)
    if (responseHeaderCache.performHas(pageToken)) {
        responseHeaderCache.delete(pageToken);
    }

    if (requestHeaderCache.performHas(pageToken)) {
        requestHeaderCache.delete(pageToken);
    }

    // Clean up cookies after detection completes
    if (setCookieCache.performHas(pageToken)) {
        setCookieCache.delete(pageToken);
    }

    // Cache flag persists across F5 to prevent race conditions; cleared on URL change only
}

function enrichSheetPayloadWithPageDetail(sheetPayload, page) {
    const sheetAddress = page.url || sheetPayload.url || sheetPayload.hostname;
    const sitemark = WebAddress.canonicalizeSitemarkForRepository(page.favIconUrl || sheetPayload.favicon, sheetAddress);

    return {
        ...sheetPayload,
        tabId: page.id,
        tabUrl: page.url,
        tabTitle: page.title,
        favicon: sitemark
    };
}

function preservePageDetailInSession(session, sheetPayload) {
    if (!session || !sheetPayload) return session;

    if (!session.tabTitle && sheetPayload.tabTitle) {
        session.tabTitle = sheetPayload.tabTitle;
    }
    if (sheetPayload.favicon) {
        session.favicon = sheetPayload.favicon;
    }

    return session;
}

/**
 * Process detection data from content script
 * @param {object} message - Message from content script
 * @param {object} sender - Sender information
 */
async function ingestScanPayload(packet, localSender) {
    if (!localSender.tab || !localSender.tab.id) {
        Telemetry.failure('BACKGROUND', 'Scrapeless Background: No tab information in sender');
        return;
    }

    // Check if extension is enabled
    if (!await isExtensionActive()) {
        return;
    }

    const pageToken = localSender.tab.id;
    const sheetPayload = enrichSheetPayloadWithPageDetail(packet.data, localSender.tab);

    // The main scan may finish before hook/window messages create their state.
    // Establish the shared session first so phase completion cannot be dropped.
    const preparedSession = resolveOrComposeScanSession(pageToken, sheetPayload.url);
    preservePageDetailInSession(preparedSession, sheetPayload);

    // Show progress indicator in badge and track as active detection
    try {
        beginBadgeSpinner(pageToken);

        // Create AbortController to allow cancellation if tab switch occurs
        const localAbortController = new AbortController();

        // Track this tab as having an active detection in progress
        runningScans.assign(pageToken, {
            url: sheetPayload.url,
            startTime: Date.now(),
            abortController: localAbortController
        });
    } catch (failure) {
        Telemetry.failure('BACKGROUND', 'Failed to set loading badge:', failure);
    }

    // Attach response headers (backward-compatible as pageData.headers)
    if (responseHeaderCache.performHas(pageToken)) {
        const headerPayload = responseHeaderCache.resolve(pageToken);

        // Only use headers if they're from the same URL (or close enough)
        if (headerPayload.url.includes(sheetPayload.hostname)) {
            sheetPayload.headers = headerPayload.headers; // Response headers (backward compatibility)
            sheetPayload.responseHeaders = headerPayload.headers; // Also store explicitly as responseHeaders

            // Eager delete after use
            responseHeaderCache.delete(pageToken);
        }
    }

    // Add request headers if available
    if (requestHeaderCache.performHas(pageToken)) {
        const inboundHeaderPayload = requestHeaderCache.resolve(pageToken);

        if (inboundHeaderPayload.url.includes(sheetPayload.hostname)) {
            sheetPayload.requestHeaders = inboundHeaderPayload.headers;

            requestHeaderCache.delete(pageToken);
        }
    }

    // Add response cookies if available (from Set-Cookie headers)
    if (setCookieCache.performHas(pageToken)) {
        const replyCookiePayload = setCookieCache.resolve(pageToken);

        if (replyCookiePayload.url.includes(sheetPayload.hostname)) {
            sheetPayload.responseCookies = replyCookiePayload.cookies;

            setCookieCache.delete(pageToken);
        }
    }

    // Attach request payloads (array of POST/PUT/PATCH bodies per tab)
    if (requestBodyCache.performHas(pageToken)) {
        const localPayloadsArray = requestBodyCache.resolve(pageToken);

        // Pass all payloads to detection engine (no filtering)
        const localRelevantPayloads = [];

        for (const payloadPayload of localPayloadsArray) {
            try {
                localRelevantPayloads.push({
                    method: payloadPayload.method,
                    url: payloadPayload.url,
                    data: payloadPayload.payload,
                    type: payloadPayload.type
                });
            } catch (failure2) {
                Telemetry.failure('BACKGROUND', 'Error processing payload:', failure2);
            }
        }

        // Pass all payloads for detection
        if (localRelevantPayloads.length > 0) {
            sheetPayload.payloads = localRelevantPayloads;

            // Don't delete yet - will delete after detection completes
            // payloadStore.delete(tabId);
        }
    }

    // Add network request URLs if available (for URL pattern detection)
    if (requestUrlCache.performHas(pageToken)) {
        const networkAddressesArray = requestUrlCache.resolve(pageToken);

        // No filtering - pass all URLs to detection engine
        const relevantAddresses = networkAddressesArray;

        if (relevantAddresses.length > 0) {
            sheetPayload.networkUrls = relevantAddresses;
        }
    }

    // Note: Request cookies are already in pageData.cookies (from document.cookie in content script)

    // Collect all cookies via chrome.cookies API (includes HttpOnly, Secure, domain-specific)
    try {
        const localAllCookies = await chrome.cookies.getAll({ url: sheetPayload.url });

        // Convert to same format as extractCookies() from content script
        sheetPayload.allCookies = localAllCookies.map(localCookie => ({
            name: localCookie.name,
            value: localCookie.value.substring(0, RuntimePolicy.COOKIE_VALUE_MAX_LENGTH),
            domain: localCookie.domain,
            httpOnly: localCookie.httpOnly,
            secure: localCookie.secure,
            sameSite: localCookie.sameSite
        }));

        // Log enhancement details
        if (typeof Telemetry !== 'undefined') {
            Telemetry.memo(`Enhanced cookie collection via chrome.cookies API`, {
                documentCookies: sheetPayload.cookies?.length || 0,
                allCookies: sheetPayload.allCookies.length,
                httpOnlyCount: sheetPayload.allCookies.filter(localC => localC.httpOnly).length,
                secureCount: sheetPayload.allCookies.filter(localC => localC.secure).length
            });
        }
    } catch (failure3) {
        if (typeof Telemetry !== 'undefined') {
            Telemetry.failure('CACHE', 'Failed to get cookies via chrome.cookies API', failure3);
        }
    }

    // Run detection analysis immediately
    let scanOutcomes = [];
    try {
        // Ensure DetectorManager is initialized (handles service worker restarts)
        await ensureRuleCoordinatorStarted();

        // Create detection engine if not exists
        if (!scanEvaluator) {
            scanEvaluator = new ScanEngine();
        }
        // Set detectors from detector manager
        scanEvaluator.assignCatalog(ruleCatalog.resolveAllCatalog());

        // Run detection with timeout (reduced from 30s to 10s - still plenty for slow pages)
        try {
            const beginMoment = Date.now();

            // LOG: Show all network URLs being passed to detection
            if (sheetPayload.networkUrls && sheetPayload.networkUrls.length > 0) {
                Telemetry.performBackground(`[Network URLs] Passing ${sheetPayload.networkUrls.length} URLs to detection engine:`);
                sheetPayload.networkUrls.forEach((addressObj, position) => {
                    Telemetry.performBackground(`  ${position + 1}. ${addressObj.url} | Type: ${addressObj.type} | Method: ${addressObj.method}`);
                });
            } else {
                Telemetry.performBackground(`[Network URLs] No network URLs available for detection!`);
            }

            const scanPromise = Promise.resolve(scanEvaluator.detectOnSheet(sheetPayload));
            const deadlinePromise = new Promise((local, localReject) =>
                setTimeout(() => localReject(new Error('Detection timeout')), RuntimePolicy.DETECTION_TIMEOUT)
            );
            scanOutcomes = await Promise.race([scanPromise, deadlinePromise]);

            const localElapsed = Date.now() - beginMoment;
            Telemetry.performBackground(`[processDetectionData] Main detection completed in ${localElapsed}ms: ${scanOutcomes.length} detectors found`);

            // Log what was detected
            if (scanOutcomes.length > 0) {
                scanOutcomes.forEach(localDet => {
                    const phases = localDet.signals?.map(localM => localM.type).filter((entryValue, cursor, leftValue) => leftValue.indexOf(entryValue) === cursor) || [];
                    Telemetry.performBackground(`[processDetectionData]   - ${localDet.detector?.name}: ${phases.join(', ')} (${localDet.signals?.length || 0} matches)`);
                });
            }
        } catch (failure4) {
            const failureKind = failure4.message.includes('timeout') ? 'TIMEOUT' : 'ERROR';
            Telemetry.failure('BACKGROUND', `[processDetectionData] Main detection ${failureKind} for tab ${pageToken}:`, failure4.message);
            Telemetry.failure('BACKGROUND', `[processDetectionData] Stack:`, failure4.stack);
            Telemetry.failure('BACKGROUND', `[processDetectionData] Continuing with empty results - only window props and hooks will be preserved`);
            scanOutcomes = []; // Continue with empty results - JS hooks and window props will still be preserved
        }

        // A failed or empty analysis still completed each primary inspection.
        // Marking outside the success branch prevents sessions from waiting forever.
        markPrimaryPhasesFinished(pageToken);
        Telemetry.performBackground(`[processDetectionData] Main methods marked complete for tab ${pageToken}`);

        Telemetry.performBackground(`Scrapeless Background: Detected ${scanOutcomes.length} security systems via main detection`);

        // Check if detection was aborted (tab switch occurred)
        const scanDetail = runningScans.resolve(pageToken);
        if (scanDetail && scanDetail.abortController.signal.aborted) {
            Telemetry.performBackground(`[Detection] Detection for tab ${pageToken} was aborted - skipping result storage`);
            return; // Don't store results or finalize
        }

        // Also check if tab is marked as interrupted
        if (cancelledScans.performHas(pageToken)) {
            Telemetry.performBackground(`[Detection] Detection for tab ${pageToken} is interrupted - skipping result storage`);
            return; // Don't store results or finalize
        }

        // Store main detection and check if ready to finalize
        Telemetry.performBackground(`[processDetectionData] Getting/creating state for tab ${pageToken}`);
        const session = resolveOrComposeScanSession(pageToken, sheetPayload.url);

        preservePageDetailInSession(session, sheetPayload);

        Telemetry.performBackground(`[processDetectionData] Current state before storing:`, {
            completedMethods: Array.from(session.completedMethods || []),
            completedCount: session.completedMethods?.size || 0,
            url: session.url,
            tabTitle: session.tabTitle
        });

        // URL validation: Ensure URL hasn't changed during detection
        if (session.url !== sheetPayload.url) {
            Telemetry.performBackground(`[Detection] URL changed during detection for tab ${pageToken}: ${sheetPayload.url} → ${session.url} - skipping result storage`);
            return; // Don't store results for the wrong URL
        }

        // Merge with existing mainData by detectorId (window properties may already exist)
        const retainedFindings = new Map();
        for (const retained of session.mainData) {
            const token = retained.detector?.id || retained.id;
            if (token) retainedFindings.set(token, retained);
        }

        // Add/merge main detection results
        for (const newScan of scanOutcomes) {
            const token2 = newScan.detector?.id || newScan.id;
            if (token2 && retainedFindings.has(token2)) {
                // Merge: combine matches, but check for duplicates by category
                const retained2 = retainedFindings.get(token2);
                const retainedHits = retained2.signals || [];
                const newHits = newScan.signals || [];

                // O(1) deduplication via Set
                const hitLookups = new Set();
                for (const hit of retainedHits) {
                    hitLookups.add(generateHitLookup(hit));
                }

                // Add new matches if not duplicate
                for (const newHit of newHits) {
                    const lookupKey = generateHitLookup(newHit);
                    if (!hitLookups.has(lookupKey)) {
                        retainedHits.push(newHit);
                        hitLookups.add(lookupKey);
                    }
                }

                retained2.signals = retainedHits;

                // Update confidence to highest
                retained2.confidence = Math.max(retained2.confidence || 0, newScan.confidence || 0);

                // Merge detectionMethods
                const retainedPhases = retained2.detectionMethods || [];
                const newPhases = newScan.detectionMethods || [];
                retained2.detectionMethods = [...new Set([...retainedPhases, ...newPhases])];
            } else {
                // New detector, add it
                retainedFindings.set(token2, newScan);
            }
        }

        // Update state.mainData with merged results
        session.mainData = Array.from(retainedFindings.values());
        session.mainComplete = true;

        Telemetry.performBackground(`[processDetectionData] Main detection complete: ${scanOutcomes.length} detectors`);

        // Final badge is set in finalizeDetection() after cache write

        // 5s safety timeout to force finalization if signals are stuck
        setTimeout(async () => {
            const activeSession = scanSessions.resolve(pageToken);
            if (!activeSession) {
                Telemetry.performBackground(`[5s Safety Timeout] Tab ${pageToken} state already cleaned up`);
                return;
            }

            if (activeSession.finalized) {
                Telemetry.performBackground(`[5s Safety Timeout] Tab ${pageToken} already finalized, no action needed`);
                return;
            }

            // Check if main detection has completed
            const mainPhasesFinished = ['cookies', 'headers', 'url', 'dom'].every(localM => activeSession.completedMethods.has(localM));

            if (!mainPhasesFinished) {
                Telemetry.performDebug('BACKGROUND', `[5s safety] Main detection incomplete`, {
                    completed: Array.from(activeSession.completedMethods)
                });
                return;
            }

            // Only force hook/window methods if main detection is done
            let forcedPhases = [];

            if (!activeSession.windowPropertiesComplete) {
                Telemetry.performDebug('BACKGROUND', `[5s safety] Forcing windowProperties completion`);
                markPhaseFinished(pageToken, 'windowProperties');
                activeSession.windowPropertiesComplete = true;
                forcedPhases.push('windowProperties');
            }

            if (!activeSession.hooksComplete) {
                const probesDeadline = await ensureProbesDeadline(activeSession);
                const localNow = Date.now();
                if (localNow < probesDeadline) {
                    Telemetry.performDebug('BACKGROUND', `[5s safety] Deferring jsHooks force; ${probesDeadline - localNow}ms until deadline`);
                } else {
                    Telemetry.performDebug('BACKGROUND', `[5s safety] Forcing jsHooks completion`);
                    markPhaseFinished(pageToken, 'jsHooks');
                    activeSession.hooksComplete = true;
                    activeSession.hooksTimedOut = true;
                    forcedPhases.push('jsHooks');
                }
            }

            // Check if detection data is already stored
            const storedPayload = await ScanEngine.resolveStoredScan(activeSession.url);
            if (storedPayload) {
                Telemetry.performBackground(`[5s safety] Detection already stored for tab ${pageToken}, finalizing`);
                await commitScan(pageToken, activeSession);
                return;
            }

            // If we forced any methods, trigger finalization
            if (forcedPhases.length > 0) {
                Telemetry.performDebug('BACKGROUND', `[5s safety] Forced: ${forcedPhases.join(', ')}`, {
                    completedMethods: Array.from(activeSession.completedMethods)
                });
                checkAndCommitScan(pageToken);
            }
        }, RuntimePolicy.SAFETY_TIMEOUT); // Give main detection time to complete

        // Check if all methods are done
        checkAndCommitScan(pageToken);

        Telemetry.findingsPane('[processDetectionData] Skipping early history save - will save complete data during finalization');
    } catch (failure5) {
        Telemetry.failure('BACKGROUND', 'Scrapeless Background: Error running detection:', failure5);
    }

    Telemetry.performBackground(`Scrapeless Background: Processed detection data for tab ${pageToken}`, {
        url: sheetPayload.url,
        cookies: sheetPayload.cookies?.length || 0,
        content: sheetPayload.content?.length || 0,
        externalContent: sheetPayload.externalContent?.length || 0,
        dom: sheetPayload.dom?.length || 0,
        headers: Object.keys(sheetPayload.headers || {}).length,
        detections: scanOutcomes.length
    });

    // Defer popup notification until finalization with complete results

    // Send webhook if enabled
    if (scanOutcomes.length > 0) {
        await PreferencesPresenter.sendWebhookIfActive(sheetPayload, scanOutcomes);
    }
}
