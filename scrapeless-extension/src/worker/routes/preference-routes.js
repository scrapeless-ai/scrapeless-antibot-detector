/**
 * registerSettingsHandlers registration.
 * Extracted from message-router switch cases for maintainability.
 */
function registerPreferencesRoutes(localRegistry, localContext) {
    void localContext;

    const routeExtensionToggleChanged = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        (async () => {
            try {
                const active = inbound.enabled;
                Telemetry.performBackground(`[Background] Extension toggle changed to: ${active ? 'ENABLED' : 'DISABLED'}`);
                await PreferencesPresenter.applyEnabledChange(active, {
                    ScanEngine,
                    TaxonomyCatalog,
                    categoryManager: taxonomy
                });

                sendReply({ status: 'success' });
            } catch (failure) {
                Telemetry.failure('BACKGROUND', '[Background] Error handling toggle change:', failure);
                sendReply({ status: 'error', error: failure.message });
            }
        })();
        return true; // Async response
    };
    localRegistry['RUNTIME_POWER_CHANGED'] = routeExtensionToggleChanged;

    const routeSyncTaxonomyPalette = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        (async () => {
            try {
                Telemetry.performBackground('Scrapeless Background: Syncing category colors from Settings...');
                const localSynced = await ruleCatalog.taxonomy.syncPaletteFromPreferences();
                Telemetry.performBackground('Scrapeless Background: Category colors synced:', localSynced);
                sendReply({ status: 'synced', success: localSynced });
            } catch (failure) {
                Telemetry.failure('BACKGROUND', 'Scrapeless Background: Error syncing category colors:', failure);
                sendReply({ status: 'error', error: failure.message });
            }
        })();
        return true; // Will respond asynchronously
    };
    localRegistry['SYNC_TAXONOMY_PALETTE'] = routeSyncTaxonomyPalette;

    const routePreferencesUpdated = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        (async () => {
            await PreferencesPresenter.routePreferencesUpdated({
                taxonomy
            }, sendReply);
        })();
        return true; // Will respond asynchronously
    };
    localRegistry['PREFERENCES_UPDATED'] = routePreferencesUpdated;

    const routeMemoBoundaryChanged = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Clear URL hash cache and update badge for new cache scope
        WebAddress.purgeAddressHashMemo();
        (async () => {
            try {
                const pages = await chrome.tabs.query({ active: true, currentWindow: true });
                if (pages && pages[0]) {
                    const page = pages[0];

                    const storedPayload = await ScanEngine.resolveStoredScan(page.url);

                    // Treat cache scope change like explicit cache clear
                    purgedTabs.add(page.id);

                    // Clear stale activeDetections to prevent false "pending" status
                    runningScans.delete(page.id);
                    Telemetry.performBackground(`[Background] Cleared activeDetections for tab ${page.id} (cache scope changed)`);

                    setTimeout(() => purgedTabs.delete(page.id), RuntimePolicy.RECENTLY_CLEARED_TAB_TIMEOUT);
                    Telemetry.performBackground(`[Background] Added tab ${page.id} to recentlyClearedTabs`);

                    if (storedPayload && storedPayload.detectionCount > 0) {
                        const findings = Array.isArray(storedPayload.detectionResults) ? storedPayload.detectionResults : [];
                        await assignBadgeForFindings(page.id, page.url, findings);
                        Telemetry.performBackground(`[Background] Badge updated with cached data: ${storedPayload.detectionCount} detections (scope change)`);
                    } else {
                        await chrome.action.setBadgeText({ text: BadgeTokens.TEXT.CLEARED, tabId: page.id });
                        await chrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.CLEARED, tabId: page.id });
                        Telemetry.performBackground('[Background] Badge: cleared state - no cached data with new scope');
                    }
                }

                if (sendReply) {
                    sendReply({ success: true });
                }
            } catch (failure) {
                // Expected: tab may have closed
                if (failure.message && failure.message.includes('No tab with id')) {
                    Telemetry.performBackground('[Background] Tab closed during cache scope change, skipping');
                    if (sendReply) sendReply({ success: true });
                } else {
                    Telemetry.failure('BACKGROUND', '[Background] Error updating badge on cache scope change:', failure);
                    if (sendReply) {
                        sendReply({ success: false, error: failure.message });
                    }
                }
            }
        })();

        return true; // Async response
    };
    localRegistry['MEMO_SCOPE_CHANGED'] = routeMemoBoundaryChanged;

    const routeReloadCatalog = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        (async () => {
            try {
                Telemetry.performBackground('Scrapeless Background: Reloading detectors from storage...');

                // Clear pattern cache so rule changes take effect immediately
                if (typeof ScanEngine !== 'undefined' && ScanEngine.matcherMemo) {
                    Telemetry.performBackground('Scrapeless Background: Clearing PatternCache (rules changed)');
                    ScanEngine.matcherMemo.purge();
                }

                ruleCatalog.started = false;
                await ruleCatalog.start();
                Telemetry.performBackground('Scrapeless Background: Detectors reloaded successfully');
                sendReply({ status: 'reloaded', detectorCount: ruleCatalog.resolveRuleTotal() });
            } catch (failure) {
                Telemetry.failure('BACKGROUND', 'Scrapeless Background: Error reloading detectors:', failure);
                sendReply({ status: 'error', error: failure.message });
            }
        })();
        return true; // Will respond asynchronously
    };
    localRegistry['RELOAD_RULE_CATALOG'] = routeReloadCatalog;

}
