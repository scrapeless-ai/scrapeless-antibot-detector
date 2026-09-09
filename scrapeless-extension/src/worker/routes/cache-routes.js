/**
 * registerCacheHandlers registration.
 * Extracted from message-router switch cases for maintainability.
 */
function registerMemoRoutes(localRegistry, localContext) {
    void localContext;

    const routeCheckMemoEarly = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        (async () => {
            try {
                const { url: address } = inbound;
                Telemetry.performBackground('[Background] [Early Cache] Checking cache for:', address);
                const memoizedPayload = await ScanEngine.resolveStoredScan(address);

                if (memoizedPayload) {
                    Telemetry.performBackground('[Background] [Early Cache] HIT - returning cached data');
                    if (localSender.tab?.id) {
                        cacheBackedTabs.add(localSender.tab.id);
                        Telemetry.performBackground(`[Background] [Early Cache] Marked tab ${localSender.tab.id} as using cache`);
                    }
                    sendReply({
                        cacheHit: true,
                        detectionData: memoizedPayload
                    });
                } else {
                    Telemetry.performBackground('[Background] [Early Cache] MISS - detection needed');
                    if (localSender.tab?.id) {
                        cacheBackedTabs.delete(localSender.tab.id);
                    }
                    sendReply({
                        cacheHit: false
                    });
                }
            } catch (failure) {
                Telemetry.failure('BACKGROUND', '[Background] [Early Cache] Error checking cache:', failure);
                sendReply({
                    cacheHit: false,
                    error: failure.message
                });
            }
        })();
        return true; // Will respond asynchronously
    };
    localRegistry['PROBE_MEMO_EARLY'] = routeCheckMemoEarly;

    const routeMemoHitEarlyExit = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Update badge from cached detection data
        (async () => {
            try {
                const { url: address, detectionData: scanSnapshot } = inbound;
                const pageToken = localSender.tab?.id;

                Telemetry.performBackground('[Background] [Early Cache] Content script exited early due to cache hit for:', address);

                if (scanSnapshot && pageToken) {
                    const scanTotal = scanSnapshot.detectionCount || 0;
                    const findings = Array.isArray(scanSnapshot.detectionResults) ? scanSnapshot.detectionResults : [];

                    if (scanTotal > 0) {
                        const total = scanTotal.toString();
                        const palette = await TaxonomyCatalog.resolveBadgeTint(findings, scanTotal, taxonomy);

                        await chrome.action.setBadgeText({
                            text: total,
                            tabId: pageToken
                        });
                        await chrome.action.setBadgeBackgroundColor({
                            color: palette,
                            tabId: pageToken
                        });
                        Telemetry.performBackground(`[Background] [Early Cache] Badge updated: ${scanTotal} detections from cache`);
                    } else {
                        await chrome.action.setBadgeText({
                            text: BadgeTokens.TEXT.CLEAN,
                            tabId: pageToken
                        });
                        await chrome.action.setBadgeBackgroundColor({
                            color: BadgeTokens.COLORS.CLEAN,
                            tabId: pageToken
                        });
                        Telemetry.performBackground('[Background] [Early Cache] Badge: clean page (no detections)');
                    }
                }

                sendReply({ status: 'acknowledged' });
            } catch (failure) {
                // Expected: tab may have closed
                if (failure.message && failure.message.includes('No tab with id')) {
                    Telemetry.performBackground('[Background] [Early Cache] Tab closed, skipping badge update');
                    sendReply({ status: 'acknowledged' }); // Still acknowledge
                } else {
                    Telemetry.failure('BACKGROUND', '[Background] [Early Cache] Error updating badge:', failure);
                    sendReply({ status: 'error', error: failure.message });
                }
            }
        })();
        return true; // Will respond asynchronously
    };
    localRegistry['MEMO_HIT_EARLY_EXIT'] = routeMemoHitEarlyExit;

    const routePurgeScanMemo = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Clear both storage and in-memory caches
        (async () => {
            await ScanEngine.routePurgeScanMemo(inbound, sendReply, manualCacheKeys);

            if (inbound.tabId) {
                if (scanSessions.performHas(inbound.tabId)) {
                    scanSessions.delete(inbound.tabId);
                    Telemetry.performBackground(`[Background] Cleared detectionStates for tab ${inbound.tabId}`);
                }

                if (runningScans.performHas(inbound.tabId)) {
                    runningScans.delete(inbound.tabId);
                    Telemetry.performBackground(`[Background] Cleared activeDetections for tab ${inbound.tabId}`);
                }

                responseHeaderCache.delete(inbound.tabId);
                requestHeaderCache.delete(inbound.tabId);
                setCookieCache.delete(inbound.tabId);
                requestBodyCache.delete(inbound.tabId);
                requestUrlCache.delete(inbound.tabId);
                cacheBackedTabs.delete(inbound.tabId);

                purgedTabs.add(inbound.tabId);
                setTimeout(() => {
                    purgedTabs.delete(inbound.tabId);
                    Telemetry.performBackground(`[Background] Tab ${inbound.tabId} removed from recently cleared list`);
                }, RuntimePolicy.RECENTLY_CLEARED_TAB_TIMEOUT);

                try {
                    await chrome.action.setBadgeText({ text: BadgeTokens.TEXT.CLEARED, tabId: inbound.tabId });
                    await chrome.action.setBadgeBackgroundColor({
                        color: BadgeTokens.COLORS.CLEARED,
                        tabId: inbound.tabId
                    });
                    Telemetry.performBackground(`[Background] Badge set to CLR for tab ${inbound.tabId}`);
                } catch (badgeFailure) {
                    Telemetry.performWarn('BACKGROUND', `[Background] Could not update badge for tab ${inbound.tabId}:`, badgeFailure);
                }

                Telemetry.performBackground(`[Background] Complete cache clear for tab ${inbound.tabId} - all memory and storage cleared`);
            }
        })();
        return true; // Async response
    };
    localRegistry['SCAN_PURGE_MEMO'] = routePurgeScanMemo;
    localRegistry['ARCHIVE_PURGE_MEMO'] = routePurgeScanMemo;

}
