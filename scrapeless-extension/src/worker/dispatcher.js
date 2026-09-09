/**
 * Background message routing and handlers.
 * Dispatcher-based registry implementation.
 */

let routeTable = null;
let workerScope = null;

function assemblePacketRouteContext() {
    return {
        chrome,
        Telemetry,
        ExtensionGateway,
        PreferencesPresenter,
        TaxonomyCatalog,
        ScanArchivePresenter,
        ScanEngine,
        traceCollector: typeof traceCollector !== 'undefined' ? traceCollector : undefined,
        // Live getters: the registry/context may now be built before initialize()
        // creates the managers (listeners register synchronously at SW startup),
        // so resolve these lazily at dispatch time instead of snapshotting null.
        get taxonomy() { return typeof taxonomy !== 'undefined' ? taxonomy : undefined; },
        get ruleCatalog() { return typeof ruleCatalog !== 'undefined' ? ruleCatalog : undefined; },
        recentScanRequests: typeof recentScanRequests !== 'undefined' ? recentScanRequests : undefined,
        cancelledScans: typeof cancelledScans !== 'undefined' ? cancelledScans : undefined,
        scanSessions: typeof scanSessions !== 'undefined' ? scanSessions : undefined,
        responseHeaderCache: typeof responseHeaderCache !== 'undefined' ? responseHeaderCache : undefined,
        requestHeaderCache: typeof requestHeaderCache !== 'undefined' ? requestHeaderCache : undefined,
        setCookieCache: typeof setCookieCache !== 'undefined' ? setCookieCache : undefined,
        requestBodyCache: typeof requestBodyCache !== 'undefined' ? requestBodyCache : undefined,
        requestUrlCache: typeof requestUrlCache !== 'undefined' ? requestUrlCache : undefined,
        runningScans: typeof runningScans !== 'undefined' ? runningScans : undefined,
        cacheBackedTabs: typeof cacheBackedTabs !== 'undefined' ? cacheBackedTabs : undefined,
        ensureRuleCoordinatorStarted: typeof ensureRuleCoordinatorStarted !== 'undefined' ? ensureRuleCoordinatorStarted : undefined,
        ingestScanPayload: typeof ingestScanPayload !== 'undefined' ? ingestScanPayload : undefined,
        checkAndCommitScan: typeof checkAndCommitScan !== 'undefined' ? checkAndCommitScan : undefined,
        markPhaseFinished: typeof markPhaseFinished !== 'undefined' ? markPhaseFinished : undefined
    };
}

function wirePacketSubscriptions() {
    if (!workerScope) {
        workerScope = assemblePacketRouteContext();
    }
    if (!routeTable) {
        routeTable = assemblePacketRouteRegistry(workerScope);
    }

    chrome.runtime.onMessage.addListener((inbound, localSender, sendReply) => {
        if (!inbound || !inbound.type) {
            sendReply({ status: 'error', error: 'Invalid message' });
            return false;
        }

        const route = routeTable[inbound.type];
        if (!route) {
            Telemetry.performBackground('Scrapeless Background: Unknown message type:', inbound.type);
            return sendUnknownPacketReply(sendReply);
        }

        try {
            const outcome = route({
                request: inbound,
                sender: localSender,
                sendResponse: sendReply,
                context: workerScope
            });
            return outcome === true;
        } catch (failure) {
            Telemetry.failure('BACKGROUND', '[Router] Unhandled message handler error:', failure);
            return sendFailureReply(sendReply, failure);
        }
    });
}
