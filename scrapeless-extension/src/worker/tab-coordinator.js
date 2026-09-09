/**
 * Background tab event listeners.
 * Extracted from src/entry/worker.js to keep tab lifecycle logic isolated.
 */

function wirePageSubscriptions() {
    // Clear all data stores and detection state for closed tab
    chrome.tabs.onRemoved.addListener((pageToken) => {
        Telemetry.performBackground(`Scrapeless Background: Tab ${pageToken} closed, clearing headers, cookies, payloads, and network URLs`);
        responseHeaderCache.delete(pageToken);
        requestHeaderCache.delete(pageToken);
        setCookieCache.delete(pageToken);
        requestBodyCache.delete(pageToken);
        requestUrlCache.delete(pageToken);

if (cacheBackedTabs.has(pageToken)) {
            cacheBackedTabs.delete(pageToken);
            Telemetry.performBackground(`[TabCleanup] Removed tab ${pageToken} from cache tracking`);
        }

        if (workerLeases) {
            workerLeases.endOperationsForPage(pageToken);
        }

        haltBadgeSpinner(pageToken);

        scanSessions.delete(pageToken);
        runningScans.delete(pageToken);
        cancelledScans.delete(pageToken);

if (finalizeTimers.has(pageToken)) {
clearTimeout(finalizeTimers.get(pageToken));
            finalizeTimers.delete(pageToken);
        }

        batchLocks.delete(pageToken);

        chrome.action.setBadgeText({
            text: BadgeTokens.TEXT.EMPTY,
            tabId: pageToken
        }).catch((failure) => {
            // Expected: Tab might already be closed
            Telemetry.performBackground(`[Cleanup] Failed to clear badge for removed tab ${pageToken}:`, failure.message);
        });
    });

    chrome.tabs.onUpdated.addListener(async (pageToken, changeDetail, page) => {
        if (changeDetail.status === 'loading' && !await isExtensionActive()) {
            Telemetry.performBackground(`[TabUpdate] Extension is disabled - setting OFF badge for tab ${pageToken}`);
            chrome.action.setBadgeText({ text: BadgeTokens.TEXT.DISABLED, tabId: pageToken }).catch((failure) => {
                Telemetry.performBackground(`[TabUpdate] Failed to set disabled badge for tab ${pageToken}:`, failure.message);
            });
            chrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.DISABLED, tabId: pageToken }).catch((failure) => {
                Telemetry.performBackground(`[TabUpdate] Failed to set badge color for tab ${pageToken}:`, failure.message);
            });
        }

        // URL change: abort active detection, clear cache tracking
        if (changeDetail.url) {
            const newAddress = changeDetail.url;
            Telemetry.performBackground(`[TabUpdate] URL change detected for tab ${pageToken}: ${newAddress}`);

            // Only clear cache tracking on URL change, not F5 refresh
if (cacheBackedTabs.has(pageToken)) {
                cacheBackedTabs.delete(pageToken);
                Telemetry.performBackground(`[TabUpdate] URL changed - cleared cache tracking for tab ${pageToken}`);
            }

            if (runningScans.performHas(pageToken)) {
                const runningDetail = runningScans.resolve(pageToken);
                const oldAddress = runningDetail.url;

                Telemetry.performBackground(`[TabUpdate] Tab ${pageToken} had active detection for ${oldAddress} - ABORTING (navigated to ${newAddress})`);

                if (runningDetail.abortController) {
                    runningDetail.abortController.abort();
                    Telemetry.performBackground(`[TabUpdate] Aborted detection for tab ${pageToken} (URL changed)`);
                }

                runningScans.delete(pageToken);
                const scanSession = scanSessions.resolve(pageToken);
                if (scanSession && scanSession.url === oldAddress) {
                    scanSession.interrupted = true;
                    scanSession.error = 'url_changed';
                    Telemetry.performBackground(`[TabUpdate] Marked detection state as interrupted for tab ${pageToken}`);
                }

                chrome.action.setBadgeText({ text: BadgeTokens.TEXT.EMPTY, tabId: pageToken }).catch((failure) => {
                    Telemetry.performBackground(`[TabUpdate] Failed to clear badge for tab ${pageToken}:`, failure.message);
                });
            }

        }

    });

    chrome.tabs.onActivated.addListener(async (runningDetail) => {
        const newPageToken = runningDetail.tabId;
        Telemetry.performBackground(`[TabSwitch] Tab activated: ${newPageToken}, previous: ${focusedTabId}`);

        // Clear stale interrupted state when user returns to tab
        if (cancelledScans.performHas(newPageToken)) {
            Telemetry.performBackground(`[TabSwitch] User returned to tab ${newPageToken} - clearing any stale interrupted state`);
            cancelledScans.delete(newPageToken);
        }

        if (focusedTabId !== null && runningScans.performHas(focusedTabId)) {
            const priorPageToken = focusedTabId;

            // Only interrupt if new tab is a content tab (skip popup/devtools/chrome://)
            try {
                const newPage = await chrome.tabs.get(newPageToken);
                if (!newPage || !newPage.url || newPage.url.startsWith('chrome://') || newPage.url.startsWith('chrome-extension://')) {
                    Telemetry.performBackground(`[TabSwitch] New tab ${newPageToken} is not a valid content tab (url: ${newPage?.url || 'none'}) - skipping interruption`);
                    focusedTabId = newPageToken;
                    return;
                }
            } catch (failure) {
                Telemetry.performBackground(`[TabSwitch] Failed to validate new tab ${newPageToken}:`, failure.message);
                focusedTabId = newPageToken;
                return;
            }

            // Detections continue in background; Chrome tabs keep executing when unfocused
            Telemetry.performBackground(`[TabSwitch] Tab ${priorPageToken} detection will continue in background`);
        }
        // Restore badge from cache, or trigger detection for uncached activated tabs.
        try {
            const page = await chrome.tabs.get(newPageToken);
            if (!page || !page.url) {
                focusedTabId = newPageToken;
                return;
            }

            const address = page.url;
            if (!ExtensionGateway.isAcceptedContentScriptAddress(address)) {
                focusedTabId = newPageToken;
                return;
            }

            if (!await isExtensionActive()) {
                focusedTabId = newPageToken;
                return;
            }

            const scanSession = scanSessions.resolve(newPageToken);
            let runningScan = runningScans.resolve(newPageToken);
            if (runningScan?.pendingRequest &&
                Date.now() - runningScan.startTime > RuntimePolicy.REQUEST_DETECTION_PENDING_TIMEOUT) {
                runningScans.delete(newPageToken);
                runningScan = null;
            }
            const hasInFlightScan = !!runningScan || (scanSession && !scanSession.finalized);

            const memoizedPayload = await ScanEngine.resolveScanPayload(newPageToken);
            if (memoizedPayload) {
                const scanOutcomes = memoizedPayload.detectionResults || [];
                await assignBadgeForFindings(newPageToken, address, scanOutcomes);
                Telemetry.performBackground(`[TabSwitch] Badge restored for tab ${newPageToken}: ${scanOutcomes.length} detection(s)`);
} else if (!hasInFlightScan && !purgedTabs.has(newPageToken)) {
                const localRequested = await inboundScanForPage(newPageToken, {
                    source: 'tab_activated',
                    silent: false
                });

                if (localRequested) {
                    Telemetry.performBackground(`[TabSwitch] Triggered detection for uncached tab ${newPageToken}`);
                } else {
                    const badgeCopy = await chrome.action.getBadgeText({ tabId: newPageToken }).catch(() => '');
                    if (badgeCopy === BadgeTokens.TEXT.DISABLED || isLoadingBadgeCopy(badgeCopy)) {
                        await chrome.action.setBadgeText({ text: BadgeTokens.TEXT.EMPTY, tabId: newPageToken }).catch(() => {});
                    }
                }
            } else if (!hasInFlightScan) {
                const badgeCopy2 = await chrome.action.getBadgeText({ tabId: newPageToken }).catch(() => '');
                if (badgeCopy2 === BadgeTokens.TEXT.DISABLED || isLoadingBadgeCopy(badgeCopy2)) {
                    await chrome.action.setBadgeText({ text: BadgeTokens.TEXT.EMPTY, tabId: newPageToken }).catch(() => {});
                }
            }
        } catch (failure2) {
            // Expected: tab may have closed during async operations
            Telemetry.performBackground(`[TabSwitch] Badge sync skipped for tab ${newPageToken}: ${failure2.message}`);
        }

        // Update current active tab
        focusedTabId = newPageToken;

    });
}
