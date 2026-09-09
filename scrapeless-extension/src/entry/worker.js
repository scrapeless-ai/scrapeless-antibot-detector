/**
 * Background service worker bootstrap.
 * Loads all scripts in dependency order via importScripts().
 */

// ─── Manager References ─────────────────────────────────────────────────────
// Manager references declared before importScripts() due to temporal dead zone

var ruleCatalog = null;
var taxonomy = null;
var scanEvaluator = null;
var workerLeases = null;
var startupPending = false;
var startupTask = null;

importScripts(
    // Core utilities
    '../foundation/telemetry.js',
    '../foundation/runtime-policy.js',
    '../foundation/badge-tokens.js',
    '../foundation/diagnostic-buffer.js',
    '../foundation/expiring-index.js',
    '../foundation/text-codec.js',
    '../foundation/web-address.js',
    '../scanning/finding-metrics.js',
    '../foundation/extension-gateway.js',
    '../scanning/compiled-pattern-pool.js',
    '../foundation/extension-store.js',
    // Detection engine
    '../scanning/taxonomy-catalog.js',
    '../scanning/rule-catalog.js',
    '../scanning/evidence-scorer.js',
    '../scanning/method-plan.js',
    '../scanning/page-snapshot.js',
    '../scanning/signal-matcher.js',
    '../scanning/probe-batch-relay.js',
    '../scanning/scan-engine.js',
    // UI and settings
    '../console/shared/toast-center.js',
    '../foundation/catalog-updater.js',
    '../worker/worker-lease-registry.js',
    '../console/archive/presenter.js',
    '../console/preferences/runtime-service.js',
    // Background runtime modules
    '../worker/network-observer.js',
    '../worker/worker-support.js',
    '../worker/scan-session.js',
    '../worker/route-replies.js',
    '../worker/routes/telemetry-routes.js',
    '../worker/routes/scan-routes.js',
    '../worker/routes/cache-routes.js',
    '../worker/routes/preference-routes.js',
    '../worker/routes/diagnostic-routes.js',
    '../worker/route-table.js',
    '../worker/dispatcher.js',
    '../worker/tab-coordinator.js',
    '../worker/startup.js'
);

Telemetry.performBackground('Logger initialized in BACKGROUND context');

// ─── Network Data Stores ────────────────────────────────────────────────────

const responseHeaderCache = new ExpiringIndex(RuntimePolicy.NETWORK_DATA_TTL);
const requestHeaderCache = new ExpiringIndex(RuntimePolicy.NETWORK_DATA_TTL);
const setCookieCache = new ExpiringIndex(RuntimePolicy.NETWORK_DATA_TTL);
const requestBodyCache = new ExpiringIndex(RuntimePolicy.NETWORK_DATA_TTL);
const requestUrlCache = new ExpiringIndex(RuntimePolicy.NETWORK_DATA_TTL);

// ─── Detection Tracking ─────────────────────────────────────────────────────

const recentScanRequests = new ExpiringIndex(RuntimePolicy.NETWORK_DATA_TTL, RuntimePolicy.RECENT_REQUESTS_MAX_SIZE);
const runningScans = new ExpiringIndex(RuntimePolicy.ACTIVE_DETECTION_TTL, RuntimePolicy.DETECTION_MAP_MAX_SIZE);
const cancelledScans = new ExpiringIndex(RuntimePolicy.NETWORK_DATA_TTL, RuntimePolicy.DETECTION_MAP_MAX_SIZE);
const scanSessions = new ExpiringIndex(RuntimePolicy.NETWORK_DATA_TTL, RuntimePolicy.DETECTION_MAP_MAX_SIZE);

// ─── Finalization Control ────────────────────────────────────────────────────

const finalizeTimers = new Map();
const batchLocks = new Map();

// ─── Tab Tracking ────────────────────────────────────────────────────────────

let focusedTabId = null;

// ─── Cache Tracking ─────────────────────────────────────────────────────────

const cacheBackedTabs = new Set();
const purgedTabs = new Set();
const manualCacheKeys = new Set();


// ─── Extension Enabled State Cache ──────────────────────────────────────────

let enabledSnapshot = { value: true, timestamp: 0 };

async function isExtensionActive() {
    const localNow = Date.now();
    if (localNow - enabledSnapshot.timestamp < RuntimePolicy.ENABLED_CACHE_TTL) {
        return enabledSnapshot.value;
    }
    const outcome = await chrome.storage.local.get(['scrapeless_enabled']);
    enabledSnapshot = {
        value: outcome.scrapeless_enabled !== false,
        timestamp: localNow
    };
    return enabledSnapshot.value;
}

chrome.storage.onChanged.addListener((localChanges, localNamespace) => {
    if (localNamespace === 'local' && localChanges.scrapeless_enabled) {
        enabledSnapshot = {
            value: localChanges.scrapeless_enabled.newValue !== false,
            timestamp: Date.now()
        };
    }
});

// ─── Detection State Constants & Helpers ────────────────────────────────────


async function ensureProbesDeadline(session) {
    if (!session) return Date.now() + RuntimePolicy.DEFAULT_HOOKS_MAX_DETECTION_MS + RuntimePolicy.HOOKS_DEADLINE_BUFFER_MS;
    if (session.hooksDeadline) {
        return session.hooksDeadline;
    }

    const beginMoment = session.startTime || Date.now();
    session.hooksMaxMs = RuntimePolicy.DEFAULT_HOOKS_MAX_DETECTION_MS;
    session.hooksDeadline = beginMoment + RuntimePolicy.DEFAULT_HOOKS_MAX_DETECTION_MS + RuntimePolicy.HOOKS_DEADLINE_BUFFER_MS;
    session.hooksDeadlineSource = 'default';
    return session.hooksDeadline;
}

async function ensureDebugStrategy(session) {
    if (!session) return false;
    if (typeof session.diagnosticMode === 'boolean') return session.diagnosticMode;
    try {
        const preferencePane = await ExtensionGateway.resolvePreferences(chrome);
        session.diagnosticMode = preferencePane?.diagnosticMode || false;
    } catch (failure) {
        session.diagnosticMode = false;
    }
    return session.diagnosticMode;
}

function generateHitLookup(hit) {
    const hitKind = (hit.type || '').toLowerCase();

    switch (hitKind) {
        case 'cookie':
            return `cookie:${hit.name}:${hit.value}`;
        case 'header':
            return `header:${hit.name}:${hit.value}`;
        case 'content':
        case 'script':
            return `${hitKind}:${hit.pattern || hit.content}`;
        case 'url':
            return `url:${hit.pattern || hit.value}`;
        case 'dom':
            return `dom:${hit.selector || hit.pattern}`;
        case 'window':
            return `window:${hit.pattern}`;
        case 'js_hooks':
            return `js_hooks:${hit.pattern}`;
        default:
            return `${hitKind}:${hit.pattern || hit.value || ''}`;
    }
}

function resolveOrComposeScanSession(pageToken, address) {
    const retainedSession = scanSessions.resolve(pageToken);

    if (retainedSession && retainedSession.url !== address) {
        if (runningScans.performHas(pageToken)) {
            const runningDetail = runningScans.resolve(pageToken);
            if (runningDetail.abortController) {
                runningDetail.abortController.abort();
            }
            runningScans.delete(pageToken);
        }

        if (workerLeases) {
            workerLeases.endOperationsForPage(pageToken);
        }

        retainedSession.interrupted = true;
        retainedSession.error = 'url_changed';

if (finalizeTimers.has(pageToken)) {
clearTimeout(finalizeTimers.get(pageToken));
            finalizeTimers.delete(pageToken);
        }

        scanSessions.delete(pageToken);
    }

    if (!scanSessions.performHas(pageToken)) {
        const beginMoment = Date.now();
        const newSession = {
            url: address,
            tabTitle: null,
            hooksData: new Map(),
            mainData: [],
            completedMethods: new Set(),
            methodOrder: ['cookies', 'headers', 'url', 'dom', 'jsHooks', 'windowProperties', 'payload'],
            hooksComplete: false,
            mainComplete: false,
            windowPropertiesComplete: false,
            lastHookBatchTime: 0,
            startTime: beginMoment,
            hooksDeadline: beginMoment + RuntimePolicy.DEFAULT_HOOKS_MAX_DETECTION_MS + RuntimePolicy.HOOKS_DEADLINE_BUFFER_MS,
            hooksMaxMs: RuntimePolicy.DEFAULT_HOOKS_MAX_DETECTION_MS,
            hooksDeadlineSource: 'default',
            hooksTimedOut: false,
            hooksCompletionReason: null,
            hooksCompletionTime: null,
            hooksUninstallStats: null
        };

        scanSessions.assign(pageToken, newSession);

        if (workerLeases) {
            workerLeases.beginOperation(`detection-${pageToken}`, {
                tabId: pageToken,
                reason: 'page_detection'
            });
        }
    }
    return scanSessions.resolve(pageToken);
}

function sendProgressRefresh(pageToken, phaseLabel, finishedPhases) {
    try {
        const session = scanSessions.resolve(pageToken);
        if (!session || session.finalized) {
            return;
        }

        const progressPacket = {
            type: 'DETECTION_PROGRESS',
            tabId: pageToken,
            progress: {
                method: phaseLabel,
                completedMethods: Array.from(finishedPhases),
                message: `Checked ${phaseLabel}`
            }
        };

        chrome.runtime.sendMessage(progressPacket).catch(() => {});
        chrome.tabs.sendMessage(pageToken, progressPacket).catch(() => {});
    } catch (failure) {
        Telemetry.failure('DETECTION', '[Progress] Error sending update:', failure);
    }
}

// ─── Synchronous Listener Registration (MV3 cold-start safety) ───────────────
// Register webRequest / runtime.onMessage / tabs listeners synchronously during
// the first turn of the service worker, so an event that revives a terminated
// worker is never dropped. Heavy detector initialization stays lazy: it runs via
// onInstalled / onStartup / the startup IIFE in init.js, and message handlers
// call ensureDetectorManagerInitialized() before using managers. Guarded by
// `servicesInitialized` so it is safe even if invoked more than once.
startServices();
