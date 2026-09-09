/**
 * Background utility functions for initialization and detection data retrieval.
 */

async function ensureRuleCoordinatorStarted() {
    if (!ruleCatalog || !ruleCatalog.started) {
        if (!taxonomy) {
            taxonomy = new TaxonomyCatalog();
        }
        if (!ruleCatalog) {
            ruleCatalog = new RuleCatalog(taxonomy);
        }
        if (!ruleCatalog.started) {
            await ruleCatalog.start();
        }
    }
    return ruleCatalog;
}

async function resolveActivePageScanPayload() {
    try {
        const [page] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (page) {
            return await ScanEngine.resolveScanPayload(page.id);
        }
    } catch (failure) {
        Telemetry.failure('BACKGROUND', 'Scrapeless Background: Error getting current tab:', failure);
    }
    return null;
}

// ─── Animated loading badge (braille spinner) ───────────────────────────────
// Per-tab interval that cycles the toolbar badge through BADGE.SPINNER_FRAMES
// while a detection runs. It is SELF-TERMINATING: each tick checks whether the
// tab still has an in-flight detection and stops otherwise, so it can never
// override a finished/cleared badge or outlive the detection (even if a caller
// forgets to stop it). stopBadgeSpinner() also stops it immediately.
const localBadgeSpinnerTimers = new Map();

function beginBadgeSpinner(pageToken) {
    haltBadgeSpinner(pageToken);
    const localFrames = BadgeTokens.SPINNER_FRAMES;
    let cursor = 0;
    chrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.LOADING, tabId: pageToken }).catch(() => {});
    chrome.action.setBadgeText({ text: localFrames[0], tabId: pageToken }).catch(() => {});
    const localTimer = setInterval(() => {
        // Self-terminate once the tab no longer has an active detection.
        const session = (typeof scanSessions !== 'undefined') ? scanSessions.resolve(pageToken) : null;
        const running = (typeof runningScans !== 'undefined') ? runningScans.performHas(pageToken) : false;
        const localStillLoading = running || (session && !session.finalized);
        if (!localStillLoading) { haltBadgeSpinner(pageToken); return; }
        cursor = (cursor + 1) % localFrames.length;
        chrome.action.setBadgeText({ text: localFrames[cursor], tabId: pageToken }).catch(() => haltBadgeSpinner(pageToken));
    }, 120); // 120ms/frame; runs only during active detection (worker kept alive by keepalive)
    localBadgeSpinnerTimers.set(pageToken, localTimer);
}

function haltBadgeSpinner(pageToken) {
    const localTimer = localBadgeSpinnerTimers.get(pageToken);
    if (localTimer !== undefined) {
        clearInterval(localTimer);
        localBadgeSpinnerTimers.delete(pageToken);
    }
}

async function assignBadgeForFindings(pageToken, address, scanOutcomes) {
    haltBadgeSpinner(pageToken); // detection finished — stop the loading spinner before showing the result
    // Never paint a detection count while the extension is disabled. A detection
    // that was in-flight when the user toggled off — or a cached-result restore —
    // can reach this after disable; without this guard it overwrites the OFF badge
    // and the toolbar icon shows a detection count for a disabled extension.
    if (!(await isExtensionActive())) {
        await Promise.all([
            chrome.action.setBadgeText({ text: BadgeTokens.TEXT.DISABLED, tabId: pageToken }),
            chrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.DISABLED, tabId: pageToken })
        ]).catch(() => {});
        return;
    }
    try {
        const scanTotal = scanOutcomes.length;
        if (scanTotal > 0) {
            const localIsBlacklisted = address ? await ExtensionGateway.isAddressBlacklisted(address) : false;
            if (!localIsBlacklisted) {
                const palette = await TaxonomyCatalog.resolveBadgeTint(scanOutcomes, scanTotal, taxonomy);
                await Promise.all([
                    chrome.action.setBadgeText({ text: scanTotal.toString(), tabId: pageToken }),
                    chrome.action.setBadgeBackgroundColor({ color: palette, tabId: pageToken })
                ]);
            } else {
                await Promise.all([
                    chrome.action.setBadgeText({ text: BadgeTokens.TEXT.BLACKLISTED, tabId: pageToken }),
                    chrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.BLACKLISTED, tabId: pageToken })
                ]);
            }
        } else {
            await Promise.all([
                chrome.action.setBadgeText({ text: BadgeTokens.TEXT.CLEAN, tabId: pageToken }),
                chrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.CLEAN, tabId: pageToken })
            ]);
        }
    } catch (failure) {
        Telemetry.performBackground(`[Badge] Failed to set badge for tab ${pageToken}: ${failure.message}`);
    }
}

/**
 * Request detection for a specific tab from background lifecycle flows.
 * Uses DetectionEngineManager's manual request path for tabs that already have
 * the manifest content script active. Pre-existing tabs without the content
 * script need a page reload so hooks can run at document_start.
 */
async function inboundScanForPage(pageToken, choices = {}) {
    const origin = choices.source || 'background';
    const localSilent = choices.silent === true;

    try {
        const page = await chrome.tabs.get(pageToken);
        if (!ExtensionGateway.isAcceptedContentScriptPage(page)) {
            return false;
        }

        const scanSession = scanSessions.resolve(pageToken);
        let runningScan = runningScans.resolve(pageToken);
        if (runningScan?.pendingRequest &&
            Date.now() - runningScan.startTime > RuntimePolicy.REQUEST_DETECTION_PENDING_TIMEOUT) {
            runningScans.delete(pageToken);
            runningScan = null;
        }
        const hasInFlightScan = !!runningScan || (scanSession && !scanSession.finalized);
        if (hasInFlightScan) {
            return false;
        }

        let immediateReply = null;
        await ScanEngine.routeInboundScan(
            { tabId: pageToken, silent: localSilent, source: origin },
            (reply) => {
                immediateReply = reply;
            },
            {
                browserApi: chrome,
                extensionGateway: ExtensionGateway,
                recentScanRequests,
                runningScans
            }
        );

        if (immediateReply?.status === 'error' ||
            immediateReply?.status === 'skipped' ||
            immediateReply?.status === 'needs_reload') {
            return false;
        }

        Telemetry.performBackground(`[AutoDetect] Requested detection for tab ${pageToken} (source: ${origin})`);
        return true;
    } catch (failure) {
        Telemetry.performBackground(`[AutoDetect] Failed to request detection for tab ${pageToken}: ${failure.message}`);
        return false;
    }
}

var listenersAttached = false;
function startServices() {
    if (listenersAttached) return;
    listenersAttached = true;
    Telemetry.performBackground('Scrapeless Background: Initializing services...');

    wireHeaderCapture();
    wirePacketSubscriptions();
    wirePageSubscriptions();

    Telemetry.performBackground('Scrapeless Background: Services initialization complete');
}
