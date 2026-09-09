/**
 * Detection user action methods (cache/blacklist/refresh).
 * Dependencies: `Detection` class must be loaded first.
 */
const FindingsCommands = (typeof self !== 'undefined' && self.FindingsCommands) ? self.FindingsCommands : {};

const scanActionsTr = (lookupKey, localFallback) => (
  typeof LocaleRuntime !== 'undefined' ? LocaleRuntime.performTr(lookupKey, localFallback) : localFallback
);

const scanActionsEncode = (lookupKey, localFallback, ...operands) => {
  if (typeof LocaleRuntime !== 'undefined' && typeof LocaleRuntime.encode === 'function') {
    const localFormatted = LocaleRuntime.encode(lookupKey, ...operands);
    if (localFormatted !== null) return localFormatted;
  }
  let localMsg = localFallback;
  for (let cursor = 0; cursor < operands.length; cursor++) {
    localMsg = localMsg.split('{' + cursor + '}').join(String(operands[cursor]));
  }
  return localMsg;
};

FindingsCommands.purgeMemo = async function() {
    const purgeMemoBtn = document.querySelector('#clearCacheBtn');
    let priorCopy = '';

    try {
      const localConfirmed = await Toasts.performConfirm({
        title: scanActionsTr('clearCacheConfirmTitle', 'Clear Cache'),
        message: scanActionsTr('clearCacheConfirmMsg', 'This will remove cached detection data for this domain and trigger a fresh analysis.'),
        confirmText: scanActionsTr('clearCacheConfirmBtn', 'Clear Cache'),
        cancelText: scanActionsTr('btnCancel', 'Cancel'),
        type: 'warning',
        emphasizeAction: true
      });

      if (!localConfirmed) return;

      if (purgeMemoBtn) {
        const copySpan = purgeMemoBtn.querySelector('span');
        if (copySpan) {
          priorCopy = copySpan.textContent;
          copySpan.textContent = scanActionsTr('clearingMsg', 'Clearing...');
        }
        purgeMemoBtn.disabled = true;
      }

      const pages = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!pages[0]) {
        if (purgeMemoBtn && priorCopy) {
          const copySpan2 = purgeMemoBtn.querySelector('span');
          if (copySpan2) {
            copySpan2.textContent = priorCopy;
          }
          purgeMemoBtn.disabled = false;
        }
        return;
      }

      const address = pages[0].url;

      await chrome.runtime.sendMessage({
        type: 'SCAN_PURGE_MEMO',
        url: address,
        tabId: pages[0].id
      });

      if (purgeMemoBtn) {
        const copySpan3 = purgeMemoBtn.querySelector('span');
        if (copySpan3) {
          copySpan3.textContent = scanActionsTr('clearedSuccessMsg', '✓ Cleared!');
        }
      }

      Toasts.completion(scanActionsTr('cacheClearedToast', 'Cache cleared'));

      try {
        await chrome.action.setBadgeText({ text: BadgeTokens.TEXT.CLEARED, tabId: pages[0].id });
        await chrome.action.setBadgeBackgroundColor({
          color: BadgeTokens.COLORS.CLEARED,
          tabId: pages[0].id
        });
      } catch (failure) {
        if (this.debugStrategy) Telemetry.performDebug('UI', 'Could not set badge:', failure);
      }

      this.findings = [];
      this.justClearedCache = true;
      this.presentEmptyState();
    } catch (failure2) {
      Telemetry.failure('UI', 'Failed to clear cache:', failure2);
      Toasts.failure(scanActionsTr('failedToClearCacheToast', 'Failed to clear cache'));

      if (purgeMemoBtn && priorCopy) {
        const copySpan4 = purgeMemoBtn.querySelector('span');
        if (copySpan4) {
          copySpan4.textContent = priorCopy;
        }
        purgeMemoBtn.disabled = false;
      }
    }
};

FindingsCommands.restorePurgeMemoControl = function() {
    const purgeMemoBtn = document.querySelector('#clearCacheBtn');
    if (purgeMemoBtn) {
      const copySpan = purgeMemoBtn.querySelector('span');
      if (copySpan) {
        copySpan.textContent = scanActionsTr('detectionTitleClearCache', 'Clear Cache');
      }
      purgeMemoBtn.disabled = false;
    }
};

FindingsCommands.performAddToBlacklist = async function() {
    try {
      const pages = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!pages[0]) {
        Toasts.failure(scanActionsTr('unableGetCurrentPage', 'Unable to get current page'));
        return;
      }

      const address = new URL(pages[0].url);
      const localDomain = address.hostname;

      if (!localDomain) {
        Toasts.failure(scanActionsTr('invalidDomain', 'Invalid domain'));
        return;
      }

      const localConfirmed = await Toasts.performConfirm({
        title: scanActionsTr('addBlacklistTitle', 'Add to Blacklist'),
        message: scanActionsEncode(
          'addBlacklistMsgFmt',
          'Domain "{0}" will be excluded from all future detections. You can remove it later in Settings.',
          localDomain
        ),
        confirmText: scanActionsTr('addBlacklistBtn', 'Add to Blacklist'),
        cancelText: scanActionsTr('btnCancel', 'Cancel'),
        type: 'danger',
        emphasizeAction: true
      });

      if (!localConfirmed) return;

      const preferencePane = await ExtensionGateway.resolvePreferences();

      if (!preferencePane.scanning) {
        preferencePane.scanning = {};
      }

      if (!Array.isArray(preferencePane.scanning.skippedDomains)) {
        preferencePane.scanning.skippedDomains = [];
      }

      if (preferencePane.scanning.skippedDomains.includes(localDomain)) {
        Toasts.detail(scanActionsEncode(
          'alreadyBlacklistedFmt',
          'Domain "{0}" is already blacklisted',
          localDomain
        ));
        return;
      }

      preferencePane.scanning.skippedDomains.push(localDomain);

      const persisted = typeof ExtensionStore !== 'undefined' && typeof ExtensionStore.persistPreferences === 'function'
        ? await ExtensionStore.persistPreferences(preferencePane)
        : false;
      if (!persisted) {
        throw new Error(scanActionsTr('failedReadSettings', 'Could not save settings'));
      }

      Toasts.completion(scanActionsEncode(
        'addedToBlacklistFmt',
        'Added "{0}" to blacklist',
        localDomain
      ));

      this.presentBlacklistSession(localDomain);
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to add to blacklist:', failure);
      Toasts.failure(scanActionsEncode(
        'failedAddBlacklistFmt',
        'Failed to add to blacklist: {0}',
        failure.message
      ));
    }
};

FindingsCommands.presentBlacklistSession = function(localDomain) {
    this.assignExtensionActive(true);
    this.dismissLoadingSession();

    const blacklistCaution = document.querySelector('#blacklistWarning');
    const localBlacklistDomain = document.querySelector('#blacklistDomain');
    const emptySession = document.querySelector('#emptyState');
    const scanOutcomes = document.querySelector('#detectionResults');
    const inactiveSession = document.querySelector('#disabledState');
    const interruptedSession = document.querySelector('#interruptedState');
    const scanPaging = document.querySelector('#detectionPagination');

    if (localBlacklistDomain) {
      localBlacklistDomain.textContent = localDomain;
    }

    if (blacklistCaution) blacklistCaution.style.display = 'flex';
    if (emptySession) emptySession.style.display = 'none';
    if (scanOutcomes) scanOutcomes.style.display = 'none';
    if (inactiveSession) inactiveSession.style.display = 'none';
    if (interruptedSession) interruptedSession.style.display = 'none';
    if (scanPaging) scanPaging.style.display = 'none';

    chrome.tabs.query({ active: true, currentWindow: true }, (pages) => {
      if (pages[0]) {
        chrome.action.setBadgeText({ text: BadgeTokens.TEXT.BLACKLISTED, tabId: pages[0].id }).catch((failure) => {
          if (this.debugStrategy) Telemetry.performUi('Failed to set blacklist badge:', failure.message);
        });
        chrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.BLACKLISTED, tabId: pages[0].id }).catch((failure) => {
          if (this.debugStrategy) Telemetry.performUi('Failed to set badge color:', failure.message);
        });
      }
    });
};

FindingsCommands.performRemoveFromBlacklist = async function(localDomain) {
    try {
      const preferencePane = await ExtensionGateway.resolvePreferences();

      if (preferencePane.scanning?.skippedDomains) {
        preferencePane.scanning.skippedDomains = preferencePane.scanning.skippedDomains.filter(localD => localD !== localDomain);

        const persisted = typeof ExtensionStore !== 'undefined' && typeof ExtensionStore.persistPreferences === 'function'
          ? await ExtensionStore.persistPreferences(preferencePane)
          : false;
        if (!persisted) {
          throw new Error(scanActionsTr('failedReadSettings', 'Could not save settings'));
        }

        Toasts.completion(scanActionsEncode(
          'removedFromBlacklistFmt',
          'Removed "{0}" from blacklist',
          localDomain
        ));

        const blacklistCaution = document.querySelector('#blacklistWarning');
        if (blacklistCaution) blacklistCaution.style.display = 'none';

        const [page] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (page) {
          this.presentScanningState();

          chrome.runtime.sendMessage(
            { type: 'READ_SCAN_PAYLOAD', tabId: page.id },
            async (reply) => {
              if (chrome.runtime.lastError) {
                Telemetry.failure('UI', 'Detection: Error getting cached data:', chrome.runtime.lastError);
                this.performRefreshAnalysis();
                return;
              }

              if (reply && reply.data) {
                if (this.debugStrategy) Telemetry.performUi('Detection: Using cached data after blacklist removal');
                this.scanEvaluator.assignCatalog(this.ruleCatalog.resolveAllCatalog());
                const findings = this.scanEvaluator.detectOnSheet(reply.data);
                this.paintFindings(findings);

                if (findings.length > 0) {
                  chrome.action.setBadgeText({ text: findings.length.toString(), tabId: page.id }).catch((failure) => {
                    if (this.debugStrategy) Telemetry.performUi('Failed to update badge after blacklist removal:', failure.message);
                  });
                  const palette = await TaxonomyCatalog.resolveBadgeTint(findings, findings.length);
                  chrome.action.setBadgeBackgroundColor({ color: palette, tabId: page.id }).catch((failure) => {
                    if (this.debugStrategy) Telemetry.performUi('Failed to set badge color:', failure.message);
                  });
                }
              } else {
                if (this.debugStrategy) Telemetry.performUi('Detection: No cached data, requesting fresh detection');
                this.performRefreshAnalysis();
              }
            }
          );
        }
      }
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to remove from blacklist:', failure);
      Toasts.failure(scanActionsEncode(
        'failedRemoveBlacklistFmt',
        'Failed to remove from blacklist: {0}',
        failure.message
      ));
    }
};

FindingsCommands.performRefreshAnalysis = async function() {
    if (this.debugStrategy) Telemetry.performUi('Refreshing detection analysis...');

    try {
      this.presentScanningState();

      const [page] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!page) {
        throw new Error('No active tab found');
      }

      chrome.runtime.sendMessage(
        { type: 'REQUEST_SCAN', tabId: page.id },
        (reply) => {
          if (chrome.runtime.lastError) {
            Telemetry.failure('UI', 'Detection: Error requesting fresh detection:', chrome.runtime.lastError);
            this.dismissLoadingSession();
            this.presentEmptyState();
            return;
          }

          if (this.debugStrategy) Telemetry.performUi('Detection: Fresh detection requested:', reply);

          setTimeout(() => {
            chrome.runtime.sendMessage(
              { type: 'READ_SCAN_PAYLOAD', tabId: page.id },
              async (payloadReply) => {
                if (chrome.runtime.lastError) {
                  Telemetry.failure('UI', 'Detection: Error getting detection data:', chrome.runtime.lastError);
                  this.dismissLoadingSession();
                  this.presentEmptyState();
                  return;
                }

                if (payloadReply && payloadReply.data) {
                  this.scanEvaluator.assignCatalog(this.ruleCatalog.resolveAllCatalog());
                  const findings = this.scanEvaluator.detectOnSheet(payloadReply.data);
                  if (this.debugStrategy) Telemetry.performUi(`Detection: Found ${findings.length} detections after refresh`);

                  this.paintFindings(findings);
                } else {
                  if (this.debugStrategy) Telemetry.performUi('Detection: No data received after refresh');
                  this.dismissLoadingSession();
                  this.presentEmptyState();
                }
              }
            );
          }, 2000);
        }
      );

    } catch (failure) {
      Telemetry.failure('UI', 'Failed to refresh analysis:', failure);
      this.dismissLoadingSession();
      this.presentEmptyState();
    }
};

// Keyless, unlisted paste endpoint — no API key, link-only (anyone with the URL).
FindingsCommands.PERFORM_PASTE_ENDPOINT = 'https://dpaste.com/api/v2/';
FindingsCommands.PERFORM_PASTE_BANNER = [
  '============================================',
  'Made by Scrapeless',
  '============================================'
].join('\n');

// Host the paste URL must belong to before we ever hand it to the browser.
FindingsCommands.PASTE_ADDRESS_PREFIX = 'https://dpaste.com/';

/**
 * Strip query string + fragment from a URL — those can carry OAuth codes,
 * reset tokens, session ids, etc. that must not leave the browser.
 * @returns {string|null} origin + pathname, or null if unparseable
 */
FindingsCommands._sanitizeAddressForPaste = function(unprocessed) {
    if (!unprocessed) return null;
    try {
      const localU = new URL(unprocessed);
      return `${localU.origin}${localU.pathname}`;
    } catch {
      return null;
    }
};

/**
 * Build the paste body: the Scrapeless banner, a blank line, then the
 * detections serialized as pretty JSON. Emits only non-sensitive metadata —
 * never raw cookie/header values (those live in match.value).
 * @returns {{ content: string, count: number }}
 */
FindingsCommands.assembleFindingsPasteContent = function() {
    const findings = Array.isArray(this.findings) ? this.findings : [];

    const siteAddressNode = document.querySelector('#siteUrl');
    const unprocessedAddress = (this.cacheMetadata?.url || siteAddressNode?.title || '').trim();
    const localHost = (siteAddressNode?.textContent || '').trim();
    const safeAddress = FindingsCommands._sanitizeAddressForPaste(unprocessedAddress);

    const avgEvidence = FindingMetrics.measureAverageEvidence(findings);
    const { difficulty: localDifficulty } = this.resolveDifficultyDetail(findings, avgEvidence);

    // Per detection, emit method counts (cookie/header/url/...) — NOT the
    // matched values, which carry live secrets like __cf_bm / datadome tokens.
    const cleanedFindings = this.sortFindingsByTaxonomy(findings).map((localD) => {
      const phaseCounts = {};
      const hits = Array.isArray(localD?.signals) ? localD.signals : [];
      for (const localM of hits) {
        const kind = localM?.type ? String(localM.type) : 'unknown';
        phaseCounts[kind] = (phaseCounts[kind] || 0) + 1;
      }
      return {
        name: localD?.detector?.name || localD?.detector || localD?.name || 'Unknown',
        category: localD?.category || localD?.detector?.category || null,
        confidence: typeof localD?.confidence === 'number' ? localD.confidence : null,
        methods: phaseCounts
      };
    });

    const localPayload = {
      source: 'Scrapeless',
      url: safeAddress || localHost || null,
      host: localHost || null,
      generatedAt: new Date().toISOString(),
      summary: {
        detections: findings.length,
        confidence: avgEvidence,
        difficulty: localDifficulty
      },
      detections: cleanedFindings
    };

    const localContent = `${FindingsCommands.PERFORM_PASTE_BANNER}\n\n${JSON.stringify(localPayload, null, 2)}\n`;
    return { content: localContent, count: findings.length };
};

/**
 * Upload the current detections to a keyless, unlisted paste and hand the
 * user a shareable link (copied to clipboard + opened in a new tab). Asks for
 * confirmation first, since the paste is publicly readable.
 */
FindingsCommands.uploadFindingsToPaste = async function() {
    const localBtn = document.querySelector('#uploadPasteBtn');

    if (!Array.isArray(this.findings) || this.findings.length === 0) {
      Toasts.caution(scanActionsTr('pasteNoDetectionsToast', 'No detections to upload'));
      return;
    }

    const localConfirmed = await Toasts.performConfirm({
      title: scanActionsTr('pasteConfirmTitle', 'Upload detections?'),
      message: scanActionsTr('pasteConfirmMsg', 'This uploads a summary of this page’s detections to a public paste (dpaste.com, unlisted, expires in 30 days). Anyone with the link can view it. The URL query string and cookie/header values are not included.'),
      confirmText: scanActionsTr('pasteConfirmBtn', 'Upload'),
      cancelText: scanActionsTr('btnCancel', 'Cancel'),
      type: 'warning',
      emphasizeAction: true
    });
    if (!localConfirmed) return;

    if (localBtn) localBtn.disabled = true;

    try {
      const { content: localContent } = FindingsCommands.assembleFindingsPasteContent.call(this);

      const localBody = new URLSearchParams();
      localBody.set('content', localContent);
      localBody.set('syntax', 'json');
      localBody.set('title', 'Scrapeless detections');
      localBody.set('expiry_days', '30');

      const localResp = await fetch(FindingsCommands.PERFORM_PASTE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: localBody.toString(),
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer'
      });

      if (!localResp.ok) {
        throw new Error(`Paste service responded ${localResp.status}`);
      }

      // dpaste returns the snippet URL in the body (sometimes quoted); the
      // Location header is the fallback.
      const unprocessed = (await localResp.text()).trim().replace(/^["']|["']$/g, '');
      const localFromBody = /^https?:\/\//i.test(unprocessed) ? unprocessed : '';
      const pasteAddress = localFromBody || (localResp.headers.get('Location') || '');

      // Pin to the known paste host before opening — never hand an arbitrary
      // network-returned URL to chrome.tabs.create.
      if (pasteAddress.slice(0, FindingsCommands.PASTE_ADDRESS_PREFIX.length).toLowerCase() !== FindingsCommands.PASTE_ADDRESS_PREFIX) {
        throw new Error('Paste service returned an unexpected URL');
      }

      await TextCodec.performCopyToClipboard(pasteAddress, {
        notify: false,
        useMicroToast: false
      });
      Toasts.completion(scanActionsTr('pasteUploadSuccessToast', 'Link copied to clipboard'));

      try {
        await chrome.tabs.create({ url: pasteAddress });
      } catch (localOpenErr) {
        Telemetry.performDebug('UI', 'Could not open paste tab:', localOpenErr);
      }
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to upload detections to paste:', failure);
      Toasts.failure(scanActionsTr('pasteUploadFailedToast', 'Upload failed'));
    } finally {
      if (localBtn) localBtn.disabled = false;
    }
};

if (typeof self !== 'undefined') {
    self.FindingsCommands = FindingsCommands;
}
