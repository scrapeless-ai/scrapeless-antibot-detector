/**
 * Background initialization and scheduled update checks.
 * Extracted from src/entry/worker.js to keep startup flow isolated.
 */

async function start(localReason = 'startup', priorVersion = null) {
    // Reuse existing initialization promise if already in progress
    if (startupPending && startupTask) {
        return await startupTask;
    }

    startupPending = true;
    startupTask = (async () => {
        try {

        // Anything this install wrote under the retired storage namespace is
        // carried over first — the catalogs below read from storage, and a
        // pre-rename install would otherwise look empty and re-seed itself.
        await ExtensionStore.migrateStoredRecords();

        // Create CategoryManager and DetectorManager instances
        taxonomy = new TaxonomyCatalog();
        ruleCatalog = new RuleCatalog(taxonomy);

        // Initialize the detector manager (loads from storage or JSON files)
        const initBeginMoment = Date.now();
        await ruleCatalog.start();
        const localInitDuration = Date.now() - initBeginMoment;

        let ruleTotal = ruleCatalog.resolveRuleTotal();
        let hasCatalog = ruleTotal > 0;

        // Retry detector loading with exponential backoff
        if (!hasCatalog) {
            const limitRetries = RuntimePolicy.DETECTOR_LOAD_MAX_RETRIES;
            let localRetries = limitRetries;

            while (localRetries > 0 && !hasCatalog) {
                await new Promise(localResolve => setTimeout(localResolve, RuntimePolicy.DETECTOR_LOAD_RETRY_DELAY));
                ruleTotal = ruleCatalog.resolveRuleTotal();
                hasCatalog = ruleTotal > 0;

                if (hasCatalog) {
                    break;
                }

                localRetries--;
            }
        }

        if (!hasCatalog) {
            Telemetry.failure('BACKGROUND', 'CRITICAL: No detectors loaded - extension will not work. Remove and re-add the extension, then refresh all tabs.');
        }

        // Initialize keepalive manager
        workerLeases = new WorkerLeaseRegistry();
        Telemetry.performBackground('[WorkerKeepaliveManager] Initialized');

        // Set disabled badge if extension is disabled
        const isActive = await isExtensionActive();
        const pages = await chrome.tabs.query({});

        if (!isActive) {
            for (const page of pages) {
                chrome.action.setBadgeText({ text: BadgeTokens.TEXT.DISABLED, tabId: page.id }).catch(() => {});
                chrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.DISABLED, tabId: page.id }).catch(() => {});
            }
        } else {
            for (const page2 of pages) {
                chrome.action.setBadgeText({ text: BadgeTokens.TEXT.EMPTY, tabId: page2.id }).catch(() => {});
            }
        }

        // NOTE: listeners (webRequest/onMessage/tabs) are now registered
        // synchronously at the end of src/entry/worker.js so MV3 cold-start events are
        // not dropped. initialize() only loads detectors / sets badges.
        startupPending = false;
        return true;
        } catch (failure) {
            Telemetry.failure('BACKGROUND', 'Failed to initialize detector system:', failure);

            startupPending = false;
            return false;
        } finally {
            startupTask = null;
        }
    })();

    return await startupTask;
}

chrome.runtime.onInstalled.addListener(async (localDetails) => {
    scanSessions.purge();

    if (localDetails.reason === 'install' || localDetails.reason === 'update') {
        await start(localDetails.reason, localDetails.previousVersion);
        // Check for detector updates after installation/update
        CatalogUpdater.performScheduleCheck();
    }

});

// Register periodic update alarm listener once during init
CatalogUpdater.wireAlarmSubscription();


chrome.runtime.onStartup.addListener(async () => {
    await start('startup');
    CatalogUpdater.performScheduleCheck();
});

// Initialize when service worker starts/restarts from idle
(async () => {
    if (!ruleCatalog || !ruleCatalog.started) {
        await start('startup');
    }
})().catch((failure) => {
    // Last-resort guard: a throw here would be an invisible unhandled SW
    // rejection that leaves detectors uninitialized. Logger may not be ready.
    try { Telemetry.failure('BACKGROUND', '[init] Startup initialization failed:', failure); } catch (local) {
        console.error('[Scrapeless] Fatal startup error:', failure);
    }
});
