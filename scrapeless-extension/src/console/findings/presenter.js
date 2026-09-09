class FindingsPresenter {
  constructor(ruleCatalog, scanEvaluator, archivePane) {
    this.ruleCatalog = ruleCatalog;
    this.scanEvaluator = scanEvaluator;
    this.archivePane = archivePane;
    this.findings = [];
    this.filterText = '';
    this.started = false;
    this.initializingPromise = null;
    this.htmlLoaded = false;
    this.pageCursor = null;
    this.scanPhases = this.composeScanPhases();
    this.scanPhasePosition = 0;
    this.scanProgressTimer = null;
    this.loadingDeadline = null;
    this.loadingDeadlineMs = 10000; // 10 seconds timeout
    this.modalElements = null;
    this.activeModalIndex = null;
    this.handleModalKeyDown = null;
    this.debugStrategy = false;
    this.isRequestingScan = false; // Prevents duplicate requests
    this.isShowingAnalyzing = false; // Prevents UI flicker
    this.isShowingResults = false; // Prevents message listeners from overriding results
    this.isExtensionEnabled = true;
    this.observedTabId = null;
    this.observedTabAddress = null;
    this.memoCleared = false; // Refresh when tab becomes visible
    this.viewModes = (typeof FindingsViewModes !== 'undefined')
      ? FindingsViewModes
      : {
        EMPTY: 'empty',
        LOADING: 'loading',
        ANALYZING: 'analyzing',
        RESULTS: 'results',
        DISABLED: 'disabled'
      };
    this.viewState = (typeof FindingsViewState !== 'undefined')
      ? new FindingsViewState(this.viewModes.EMPTY)
      : null;

    // Setup listeners before init to catch early messages
    this.attachRuntimeDispatcher();

    chrome.storage.local.get(['scrapeless_enabled'])
      .then((outcome) => {
        this.assignExtensionActive(outcome.scrapeless_enabled !== false);
      })
      .catch((failure) => {
        Telemetry.failure('UI', 'Failed to read enabled state from storage; defaulting to enabled:', failure);
        this.assignExtensionActive(true);
      });
  }

  assignExtensionActive(active) {
    this.isExtensionEnabled = active !== false;
  }

  /**
   * Setup message listeners for background script communication
   * Called from constructor to ensure listeners are active even before tab initialization
   */
  attachRuntimeDispatcher() {
    if (this._messageListenersAttached) return;
    this._messageListenersAttached = true;
    // Listen for tab navigation; show analyzing state
    chrome.tabs.onUpdated.addListener((pageToken, changeDetail, page) => {
      if (this.observedTabId !== null && pageToken !== this.observedTabId) {
        return;
      }
      if (changeDetail.status === 'loading' && changeDetail.url) {
        if (this.debugStrategy) Telemetry.performUi('[Detection] Tab navigated to:', changeDetail.url);
        chrome.action.getBadgeText({ tabId: pageToken }, (badgeCopy) => {
          if (badgeCopy && badgeCopy.endsWith('%')) {
            if (this.debugStrategy) Telemetry.performUi('[Detection] Navigation detected, badge shows progress, transitioning to analyzing state');
            if (!this.wasInterrupted && !this.isShowingResults && this.isExtensionEnabled !== false) {
              this.presentScanningState();
            }
          }
        });
      }
    });

    // Listen for real-time detection progress
    chrome.runtime.onMessage.addListener((packet, localSender, sendReply) => {
      if (packet.type === 'RUNTIME_POWER_CHANGED') {
        this.assignExtensionActive(packet.enabled !== false);
        if (!this.isExtensionEnabled) {
          this.presentDisabledState();
        }
        return false;
      }

      if (packet.type === 'DETECTION_PROGRESS') {
        if (!this.isExtensionEnabled) {
          return false;
        }
        if (this.observedTabId !== null && packet.tabId !== this.observedTabId) {
          return false;
        }
        if (this.debugStrategy) Telemetry.performUi('[Detection] Received progress update:', packet.progress);

        // Transition to analyzing if not already showing results
        const loadingSession = document.querySelector('#loadingState');
        if (!loadingSession || loadingSession.style.display === 'none') {
          if (this.debugStrategy) Telemetry.performUi('[Detection] Progress received but not in analyzing state - transitioning now');
          if (!this.wasInterrupted && !this.isShowingResults) {
            this.presentScanningState();
          }
        }

        this.refreshRealProgress(packet.progress);
      }

      // Listen for detection completion
      if (packet.type === 'NEW_DETECTION_DATA') {
        if (!this.isExtensionEnabled) {
          return false;
        }
        if (this.observedTabId !== null && packet.tabId !== this.observedTabId) {
          return false;
        }
        if (window.popupInstance) {
          return false;
        }
        if (this.debugStrategy) Telemetry.performUi('[Detection] Received detection completion for tab:', packet.tabId);

        // Guard: Don't auto-refresh if we just cleared cache and are showing empty state
        if (this.justClearedCache) {
          Telemetry.performUi('[Detection] Ignoring NEW_DETECTION_DATA - showing empty state after cache clear');
          // Reset the flag after 5.5 seconds to allow future updates (after re-detection starts)
          if (!this.clearCacheResetTimer) {
            this.clearCacheResetTimer = setTimeout(() => {
              this.justClearedCache = false;
              this.clearCacheResetTimer = null;
            }, 5500);
          }
          return;
        }

        // Clear loading timeout and stop progress animation
        this.purgeLoadingDeadline();
        this.haltAnalysisProgress({ markComplete: true });

        // Request the completed detection data and display it
        chrome.tabs.query({ active: true, currentWindow: true }, async (pages) => {
          if (pages[0] && pages[0].id === packet.tabId) {
            if (this.debugStrategy) Telemetry.performUi('[Detection] Fetching completed detection data...');

            chrome.runtime.sendMessage(
              { type: 'READ_SCAN_PAYLOAD', tabId: packet.tabId },
              async (reply) => {
                if (chrome.runtime.lastError) {
                  Telemetry.failure('UI', '[Detection] Error fetching completed data:', chrome.runtime.lastError);
                  if (!this.isShowingResults || this.findings.length === 0) {
                    this.presentEmptyState();
                  }
                  return;
                }

                if (reply && reply.data) {
                  // Process and display the completed detection
                  await FindingsPresenter.acceptPageSnapshot(
                    {
                      detection: this,
                      detectionEngine: this.scanEvaluator,
                      detectorManager: this.ruleCatalog,
                      history: this.archivePane
                    },
                    reply.data
                  );
                } else {
                  if (this.debugStrategy) Telemetry.performDebug('UI', '[Detection] No data in completion response');
                  if (!this.isShowingResults || this.findings.length === 0) {
                    this.presentEmptyState();
                  }
                }
              }
            );
          }
        });
      }

      // Listen for cache scope changes from Settings
      if (packet.type === 'SCAN_PURGE_MEMO') {
        (async () => {
          Telemetry.performUi('[Detection] Cache scope changed - checking for cached data with new scope');

          // Clear current results display
          this.findings = [];

          // Clear pagination
          if (this.pageCursor) {
            this.pageCursor.assignEntries([]);
          }

          // Clear result cards from DOM
          const scanOutcomes = document.querySelector('#detectionResults');
          if (scanOutcomes) {
            scanOutcomes.innerHTML = '';
          }

          // Set flags to prevent auto-detection
          this.justClearedCache = true;
          this.memoCleared = true;

          // Update cache info display to reflect new cache scope from settings
          this.refreshMemoDetail();

          // Check if there's cached detection data for the new scope
          try {
            const pages = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!pages[0]) return;

            // Request detection data with new cache scope
            chrome.runtime.sendMessage(
              { type: 'READ_SCAN_PAYLOAD', tabId: pages[0].id },
              async (reply) => {
                if (chrome.runtime.lastError) {
                  Telemetry.performUi('[Detection] No cached data for new scope - showing empty state');
                  this.presentEmptyState();
                  // Set badge to CLR (cleared)
                  try {
                    await chrome.action.setBadgeText({ text: BadgeTokens.TEXT.CLEARED, tabId: pages[0].id });
                    await chrome.action.setBadgeBackgroundColor({
                      color: BadgeTokens.COLORS.CLEARED,
                      tabId: pages[0].id
                    });
                  } catch (failure) { /* Tab may be closed */ }
                  return;
                }

                if (reply && reply.data) {
                  // Found cached data for new scope - display it
                  Telemetry.performUi('[Detection] Found cached data for new scope - displaying');

                  // Route the refreshed snapshot through the active Console shell.
                  if (window.popupInstance) {
                    await window.popupInstance.acceptPageSnapshot(reply.data);
                  } else {
                    // Fallback: display directly
                    await this.paintFindings(reply.data.detections);
                  }
                } else {
                  // No cached data for new scope - show empty state
                  Telemetry.performUi('[Detection] No cached data for new scope - showing empty state');
                  this.presentEmptyState();
                  // Set badge to CLR (cleared)
                  try {
                    await chrome.action.setBadgeText({ text: BadgeTokens.TEXT.CLEARED, tabId: pages[0].id });
                    await chrome.action.setBadgeBackgroundColor({
                      color: BadgeTokens.COLORS.CLEARED,
                      tabId: pages[0].id
                    });
                  } catch (failure2) { /* Tab may be closed */ }
                }
              }
            );
          } catch (failure) {
            if (this.debugStrategy) Telemetry.performDebug('UI', '[Detection] Error checking for cached data:', failure);
            this.presentEmptyState();
          }

          if (sendReply) {
            sendReply({ success: true });
          }
        })();

        return true; // Keep message channel open for async response
      }
    });
  }

  /**
   * Extract badge status helper
   * Consolidates 6+ duplicate badge checking logic blocks into single helper
   * Returns object with status and additional metadata for easier state management
   * FIX: Now distinguishes between cleared cache (gray ✕) and interrupted detection (other ✕)
   */
  static async resolveBadgeCondition(...operands) {
    return await FindingsQuery.resolveBadgeCondition.apply(this, operands);
  }
  composeScanPhases(...operands) {
    return FindingsRenderer.composeScanPhases.apply(this, operands);
  }
  presentLoadingState(...operands) {
    return FindingsRenderer.presentLoadingState.apply(this, operands);
  }
  paintAnalysisSteps(...operands) {
    return FindingsRenderer.paintAnalysisSteps.apply(this, operands);
  }
  beginAnalysisProgress(...operands) {
    return FindingsRenderer.beginAnalysisProgress.apply(this, operands);
  }
  refreshAnalysisStepSessions(...operands) {
    return FindingsRenderer.refreshAnalysisStepSessions.apply(this, operands);
  }
  refreshAnalysisPercent(...operands) {
    return FindingsRenderer.refreshAnalysisPercent.apply(this, operands);
  }
  haltAnalysisProgress(...operands) {
    return FindingsRenderer.haltAnalysisProgress.apply(this, operands);
  }
  refreshRealProgress(...operands) {
    return FindingsRenderer.refreshRealProgress.apply(this, operands);
  }
  refreshPhaseCondition(...operands) {
    return FindingsRenderer.refreshPhaseCondition.apply(this, operands);
  }
  routeLoadingDeadline(...operands) {
    return FindingsRenderer.routeLoadingDeadline.apply(this, operands);
  }
  purgeLoadingDeadline(...operands) {
    return FindingsRenderer.purgeLoadingDeadline.apply(this, operands);
  }
  dismissLoadingSession(...operands) {
    return FindingsRenderer.dismissLoadingSession.apply(this, operands);
  }
  presentScanningState(...operands) {
    return FindingsRenderer.presentScanningState.apply(this, operands);
  }
  presentEmptyState(...operands) {
    return FindingsRenderer.presentEmptyState.apply(this, operands);
  }
  refreshEmptySessionI18N(...operands) {
    return FindingsRenderer.refreshEmptySessionI18N.apply(this, operands);
  }
  refreshScanSessionI18N(...operands) {
    return FindingsRenderer.refreshScanSessionI18N.apply(this, operands);
  }
  presentDisabledState(...operands) {
    return FindingsRenderer.presentDisabledState.apply(this, operands);
  }
  async paintFindings(...operands) {
    return await FindingsRenderer.paintFindings.apply(this, operands);
  }
  refreshFindingStats(...operands) {
    return FindingsRenderer.refreshFindingStats.apply(this, operands);
  }
  refreshFindingTotals(...operands) {
    return FindingsRenderer.refreshFindingTotals.apply(this, operands);
  }
  refreshAddressPresent(...operands) {
    return FindingsRenderer.refreshAddressPresent.apply(this, operands);
  }
  refreshMemoDetail(...operands) {
    return FindingsRenderer.refreshMemoDetail.apply(this, operands);
  }
  encodeExpiryRemaining(...operands) {
    return FindingsRenderer.encodeExpiryRemaining.apply(this, operands);
  }
  assignCopyableDatum(...operands) {
    return FindingsRenderer.assignCopyableDatum.apply(this, operands);
  }
  async copyCopyableDatum(...operands) {
    return await FindingsRenderer.copyCopyableDatum.apply(this, operands);
  }
  async purgeMemo(...operands) {
    return await FindingsCommands.purgeMemo.apply(this, operands);
  }
  async uploadFindingsToPaste(...operands) {
    return await FindingsCommands.uploadFindingsToPaste.apply(this, operands);
  }
  restorePurgeMemoControl(...operands) {
    return FindingsCommands.restorePurgeMemoControl.apply(this, operands);
  }
  async performAddToBlacklist(...operands) {
    return await FindingsCommands.performAddToBlacklist.apply(this, operands);
  }
  presentBlacklistSession(...operands) {
    return FindingsCommands.presentBlacklistSession.apply(this, operands);
  }
  async performRemoveFromBlacklist(...operands) {
    return await FindingsCommands.performRemoveFromBlacklist.apply(this, operands);
  }
  paintFindingsSheet(...operands) {
    return FindingsRenderer.paintFindingsSheet.apply(this, operands);
  }
  resolveTaxonomyBadges(...operands) {
    return FindingsRenderer.resolveTaxonomyBadges.apply(this, operands);
  }
  resolvePhaseBadges(...operands) {
    return FindingsRenderer.resolvePhaseBadges.apply(this, operands);
  }
  copyScan(...operands) {
    return FindingDialog.copyScan.apply(this, operands);
  }
  async copyScanOverview(...operands) {
    return await FindingDialog.copyScanOverview.apply(this, operands);
  }
  copyPhaseDatum(...operands) {
    return FindingDialog.copyPhaseDatum.apply(this, operands);
  }
  resolveScanByPosition(...operands) {
    return FindingDialog.resolveScanByPosition.apply(this, operands);
  }
  resolveGlobalScanPosition(...operands) {
    return FindingDialog.resolveGlobalScanPosition.apply(this, operands);
  }
  startDialogNodes(...operands) {
    return FindingDialog.startDialogNodes.apply(this, operands);
  }
  openScanDialog(...operands) {
    return FindingDialog.openScanDialog.apply(this, operands);
  }
  closeScanDialog(...operands) {
    return FindingDialog.closeScanDialog.apply(this, operands);
  }
  paintScanDialogContent(...operands) {
    return FindingDialog.paintScanDialogContent.apply(this, operands);
  }
  attachDialogPhaseRoutes(...operands) {
    return FindingDialog.attachDialogPhaseRoutes.apply(this, operands);
  }
  resolveFilteredOutcomes(...operands) {
    return FindingsRenderer.resolveFilteredOutcomes.apply(this, operands);
  }
  sortFindingsByTaxonomy(...operands) {
    return FindingsRenderer.sortFindingsByTaxonomy.apply(this, operands);
  }
  routeFilter(...operands) {
    return FindingsRenderer.routeFilter.apply(this, operands);
  }
  async performRefreshAnalysis(...operands) {
    return await FindingsCommands.performRefreshAnalysis.apply(this, operands);
  }
  resolveRuleGlyph(...operands) {
    return FindingsRenderer.resolveRuleGlyph.apply(this, operands);
  }
  async start() {
    if (this.started) {
      return;
    }

    if (this.initializingPromise) {
      await this.initializingPromise;
      return;
    }

    this.initializingPromise = (async () => {
      await this.hydrateMarkup();
      this.wirePaging();
      this.bindShellEvents();
      this.started = true;

      // Load debug mode from settings
      try {
        const preferencePane = await ExtensionGateway.resolvePreferences();
        this.debugStrategy = preferencePane.diagnosticMode || false;
      } catch (failure) {
        this.debugStrategy = false;
      }

      // Expose copy function globally for onclick handlers
      window.scrapelessDetection = this;
    })();

    try {
      await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
    }
  }

  /**
   * Setup pagination manager
   */
  wirePaging() {
    this.pageCursor = new PageCursor('detectionPagination', {
      // Two per page was sized for the old card layout, where one card was
      // roughly a third of the panel. A Console row is a fraction of that, so
      // two left most of the panel empty and pushed 12 findings onto 6 pages.
      itemsPerPage: 10,
      onPageChange: (sheet, entries) => {
        this.paintFindingsSheet(entries);
      }
    });
  }

  /**
   * Load HTML template into detection tab
   */
  async hydrateMarkup() {
    try {
      const reply = await fetch(chrome.runtime.getURL('src/console/findings/pane.html'));
      const markup = await reply.text();

      const scanPage = document.querySelector('#detectionTab');
      if (scanPage) {
        scanPage.innerHTML = markup;
        this.htmlLoaded = true;
        if (typeof LocaleRuntime !== 'undefined') {
          LocaleRuntime.performApply(scanPage);
        }
        this.paintAnalysisSteps();
        const loadingSession = document.querySelector('#loadingState');
        if (loadingSession && loadingSession.style.display !== 'none') {
          // Initialize UI for real progress updates (not old step-animation)
          this.haltAnalysisProgress();
          this.purgeLoadingDeadline();
          this.scanPhasePosition = 0;
          this.refreshAnalysisStepSessions();
          this.refreshAnalysisPercent(0);
          this.loadingDeadline = setTimeout(() => {
            this.routeLoadingDeadline();
          }, this.loadingDeadlineMs);

          // Sync popup progress with current badge percentage
          chrome.tabs.query({ active: true, currentWindow: true }, async (pages) => {
            if (pages[0]) {
              try {
                const badgeCopy = await chrome.action.getBadgeText({ tabId: pages[0].id });
                // Badge percentage sync removed - no longer showing percentages in badge
              } catch (failure) {
                if (this.debugStrategy) Telemetry.performDebug('UI', '[Detection] Could not read badge text:', failure);
              }
            }
          });
        }
      } else {
        this.htmlLoaded = false;
      }
    } catch (failure) {
      this.htmlLoaded = false;
      Telemetry.failure('UI', 'Failed to load detection HTML:', failure);
    }
  }

  /**
   * Setup event listeners after HTML is loaded
   */
  bindShellEvents() {
    // NOTE: no `listenersAttached` short-circuit here — loadHTML() rebuilds the
    // detection tab's innerHTML (destroying old element listeners), and the
    // re-show path re-calls this to re-bind. Per-target dataset guards (e.g.
    // copyValueHandlerBound) prevent any genuine double-binding instead.
    // Reset modal elements to ensure they are properly initialized
    this.modalElements = null;

    // Setup search functionality
    const filterField = document.querySelector('#detectionSearch');
    if (filterField) {
      filterField.addEventListener('input', (failure) => {
        this.routeFilter(failure.target.value);
      });
    }

    const scanOutcomes = document.querySelector('#detectionResults');
    if (scanOutcomes && scanOutcomes.dataset.copyValueHandlerBound !== 'true') {
      scanOutcomes.dataset.copyValueHandlerBound = 'true';
      scanOutcomes.addEventListener('click', (failure) => {
        FindingsRenderer.routeCopyableDatumClick.call(this, failure);
      }, true);
      scanOutcomes.addEventListener('keydown', (failure) => {
        FindingsRenderer.routeCopyableDatumLookupDown.call(this, failure);
      }, true);
    }

    // Setup upload-to-paste button
    const localUploadPasteBtn = document.querySelector('#uploadPasteBtn');
    if (localUploadPasteBtn) {
      localUploadPasteBtn.addEventListener('click', async (failure) => {
        failure.stopPropagation();
        await this.uploadFindingsToPaste();
      });
    }

    // Setup clear cache button
    const purgeMemoBtn = document.querySelector('#clearCacheBtn');
    if (purgeMemoBtn) {
      purgeMemoBtn.addEventListener('click', () => {
        this.purgeMemo();
      });
    }

    // Setup copy overview button
    const localCopyOverviewBtn = document.querySelector('#copyOverviewBtn');
    if (localCopyOverviewBtn) {
      localCopyOverviewBtn.addEventListener('click', async (failure) => {
        failure.stopPropagation();
        await this.copyScanOverview();
      });
    }

    // Setup add to blacklist button
    const localAddToBlacklistBtn = document.querySelector('#addToBlacklistBtn');
    if (localAddToBlacklistBtn) {
      localAddToBlacklistBtn.addEventListener('click', () => {
        this.performAddToBlacklist();
      });
    }

    // Reload button removed - users should manually reload the page

    // Setup remove from blacklist button
    const localRemoveFromBlacklistBtn = document.querySelector('#removeFromBlacklistBtn');
    if (localRemoveFromBlacklistBtn) {
      localRemoveFromBlacklistBtn.addEventListener('click', async () => {
        const localBlacklistDomain = document.querySelector('#blacklistDomain');
        const localDomain = localBlacklistDomain ? localBlacklistDomain.textContent : '';
        if (localDomain) {
          await this.performRemoveFromBlacklist(localDomain);
        }
      });
    }

    // Setup disabled state blacklist button - removes current domain from blacklist
    const inactiveBlacklistBtn = document.querySelector('#disabledBlacklistBtn');
    if (inactiveBlacklistBtn) {
      inactiveBlacklistBtn.addEventListener('click', async () => {
        try {
          const [page] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (page && page.url) {
            const address = new URL(page.url);
            await this.performRemoveFromBlacklist(address.hostname);
            // Hide the button after removing
            inactiveBlacklistBtn.classList.remove('visible');
          }
        } catch (failure) {
          Telemetry.failure('UI', 'Failed to remove from blacklist:', failure);
          const localRemoveErrMsg = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime.performTr('failedRemoveBlacklist', 'Failed to remove from blacklist') : 'Failed to remove from blacklist';
          Toasts.failure(localRemoveErrMsg);
        }
      });
    }

    // NOTE: Message listeners are now set up in setupMessageListeners() called from constructor
    // This ensures they're active even before tab initialization

    this.startDialogNodes();
  }

  // ============================================================================
  // Static Methods (Background & Popup Context)
  // ============================================================================

  /**
   * Request detection data for current tab
   * @param {object} context - {detection, Utils, processDetectionDataCallback}
   */
  static async requestFocusedTabScan(...operands) {
    return await FindingsQuery.requestFocusedTabScan.apply(this, operands);
  }
  static async acceptPageSnapshot(...operands) {
    return await FindingsQuery.acceptPageSnapshot.apply(this, operands);
  }
  static async resolveBadgeCopy(...operands) {
    return await FindingsQuery.resolveBadgeCopy.apply(this, operands);
  }
  static async resolveBadgeBackgroundPalette(...operands) {
    return await FindingsQuery.resolveBadgeBackgroundPalette.apply(this, operands);
  }
  async purgeBadgeForEmptySession(...operands) {
    return await FindingsRenderer.purgeBadgeForEmptySession.apply(this, operands);
  }
  performHexToRgb(...operands) {
    return FindingsRenderer.performHexToRgb.apply(this, operands);
  }
  resolveDifficultyDetail(...operands) {
    return FindingsRenderer.resolveDifficultyDetail.apply(this, operands);
  }
}

if (typeof window !== 'undefined') {
  window.FindingsPresenter = FindingsPresenter;
}
