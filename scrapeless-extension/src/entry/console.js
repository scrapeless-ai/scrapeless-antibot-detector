// Popup script for Scrapeless Security Detection Extension

class ConsoleShell {
  constructor() {
    this.taxonomy = new TaxonomyCatalog();
    this.ruleCatalog = new RuleCatalog(this.taxonomy);
    this.scanEvaluator = new ScanEngine();
    this.currentTab = 'detection';
    // The stored default pane is restored asynchronously. If the reader
    // picks a tab before that read returns, their choice wins.
    this.paneChosenByUser = false;
    // #settingsBtn is painted long before the preferences module binds its
    // handler, so an early click has to be remembered rather than lost.
    this.settingsRequestedEarly = false;
    this.archivePane = new ScanArchivePresenter(this.ruleCatalog);
    this.findingsPane = new FindingsPresenter(this.ruleCatalog, this.scanEvaluator, this.archivePane);
    this.rules = new CatalogPresenter(this.ruleCatalog);
    this.preferences = new PreferencesPresenter(this.taxonomy);
    this.findingsEpoch = 0;
  }

  async start() {
    try {
      if (typeof Telemetry !== 'undefined') {
        Telemetry.performPopup('Logger initialized in POPUP context');
      }

      Toasts.start();

      // Set version from manifest
      const localManifest = chrome.runtime.getManifest();
      const versionNode = document.querySelector('#appVersion');
      if (versionNode && (localManifest.version_name || localManifest.version)) {
        versionNode.textContent = `v${localManifest.version_name || localManifest.version}`;
      }

      this.bindShellEvents();
      this.bindWorkerEvents();

      if (!this.ruleCatalog.started) {
        await this.ruleCatalog.start();
      }

      await this.preparePanes();

      // A Settings click that landed while the button was inert.
      if (this.settingsRequestedEarly) {
        this.settingsRequestedEarly = false;
        const localSheet = document.querySelector('#settingsModal');
        if (!localSheet || !localSheet.classList.contains('is-open')) {
          this.preferences.presentPreferences();
        }
      }

      // Load and show default tab from settings
      await this.restoreInitialPane();

    } catch (failure) {
      Telemetry.failure('UI', 'Failed to initialize popup:', failure);
    }
  }

  /**
   * Initialize all sections
   * Lazy loading - only initialize visible tab on startup
   */
  async preparePanes() {
    try {
      // Only initialize Settings (always needed for toggle)
      // Other sections will be lazy-loaded on first access
      await this.preferences.start();

      // Mark other sections as NOT initialized - they'll load on-demand
      this.findingsPane.started = false;
      this.archivePane.started = false;
      this.rules.started = false;
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to initialize sections:', failure);
    }
  }

  bindShellEvents() {
    // Tab navigation. Bind only the buttons that name a destination — the
    // strip also carries entries that leave the popup rather than switching
    // panes, and showPane(undefined) would blank the shell.
    document.querySelectorAll('.tab-btn[data-tab]').forEach(localBtn => {
      localBtn.addEventListener('click', (failure) => {
        const page = failure.currentTarget.dataset.tab;
        this.paneChosenByUser = true;
        this.showPane(page);
      });
    });

    // #settingsBtn is painted immediately, but the preferences module only
    // binds its own handler at the end of preferences.start() — after two
    // awaits, one of which fetches pane.html. That window is variable and can
    // run past three seconds on a slow profile, and for the whole of it the
    // button was visible, clickable and completely inert.
    //
    // Opening from here makes it work from the first paint. presentPreferences
    // only adds `is-open`, so this and the module's own handler cannot fight;
    // the worst case is the class being added twice.
    const localSettingsBtn = document.querySelector('#settingsBtn');
    if (localSettingsBtn) {
      localSettingsBtn.addEventListener('click', () => {
        // Always record the request. Opening now is not enough on its own:
        // preferences.start() hydrates pane.html into this very modal, which
        // discards `is-open` if it lands afterwards. The pass below re-asserts
        // it once the pane is built.
        this.settingsRequestedEarly = true;
        try {
          this.preferences.presentPreferences();
        } catch (failure) {
          // Not far enough along to render its body yet — the pass below opens
          // it as soon as the pane is ready.
        }
      });
    }

    // The analytics board needs far more width than a popup has, so it opens
    // as its own extension page.
    const localAnalyticsLink = document.querySelector('#analyticsLink');
    if (localAnalyticsLink) {
      localAnalyticsLink.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('analytics.html') });
        window.close();
      });
    }

    // Main enable/disable toggle
    const localEnableToggle = document.querySelector('#enableToggle');
    if (localEnableToggle) {
      // Load saved state or default to enabled
      this.restoreEnabledToggle();

      // Handle toggle changes
      localEnableToggle.addEventListener('change', (failure) => {
        this.applyEnabledChange(failure.target.checked);
      });
    } else {
      Telemetry.failure('UI', 'Popup: Enable toggle element NOT found (#enableToggle)');
    }
  }

  /**
   * Load and apply default tab from settings
   * Delegates to PreferencesPresenter.restoreInitialPane().
   */
  async restoreInitialPane() {
    await PreferencesPresenter.restoreInitialPane((page) => {
      // Reading the preference takes a moment, and the popup is interactive the
      // whole time. Without this, a tab clicked in that window was silently
      // undone a second or two after it landed.
      if (this.paneChosenByUser) {
        return;
      }
      // The Advanced tab was removed from the navigation. A profile that still
      // has it stored as its default would otherwise open on a pane with no
      // way back to it.
      const destination = document.querySelector(`.tab-btn[data-tab="${page}"]`)
        ? page
        : 'detection';
      this.showPane(destination);
    });
  }

  /**
   * Load toggle state from storage
   * Delegates to PreferencesPresenter.restoreEnabledToggle().
   */
  async restoreEnabledToggle() {
    const localToggle = document.querySelector('#enableToggle');
    await PreferencesPresenter.restoreEnabledToggle(localToggle);
    if (localToggle) {
      this.findingsPane.assignExtensionActive(localToggle.checked);
    }
  }

  /**
   * Handle enable toggle change
   * Delegates to PreferencesPresenter.applyEnabledChange().
   */
  async applyEnabledChange(active) {
    try {
      await PreferencesPresenter.applyEnabledChange(active);
      this.findingsPane.assignExtensionActive(active !== false);
      const inboundToken = this.advanceFindingsEpoch();

      // Immediately update Detection tab if it's currently visible
      if (this.currentTab === 'detection') {
        if (active) {
          // No fresh scan can run for pre-existing tabs (content script exited at document_start).
          // Render the truthful empty state now; transition to data only if cache happens to hit.
          this.findingsPane.presentEmptyState({ noCache: true, showBadges: false });
          chrome.tabs.query({ active: true, currentWindow: true }, (pages) => {
            if (pages[0] && this.ownsFindingsEpoch(inboundToken)) {
              chrome.runtime.sendMessage(
                { type: 'READ_SCAN_PAYLOAD', tabId: pages[0].id },
                async (reply) => {
                  if (!this.ownsFindingsEpoch(inboundToken)) {
                    return;
                  }
                  if (chrome.runtime.lastError) {
                    Telemetry.failure('UI', 'Popup: Error getting cached data:', chrome.runtime.lastError);
                    return;
                  }
                  if (reply?.data) {
                    await this.acceptPageSnapshot(reply.data);
                  }
                }
              );
            }
          });
        } else {
          // Extension disabled - show disabled state immediately
          this.findingsPane.presentDisabledState();
        }
      }
    } catch (failure) {
      Telemetry.failure('UI', 'Popup: Error handling toggle change:', failure);
      // Show error to user
      if (typeof Toasts !== 'undefined') {
        Toasts.failure(`Failed to ${active ? 'enable' : 'disable'} extension: ${failure.message}`);
      }
    }
  }

  advanceFindingsEpoch() {
    this.findingsEpoch += 1;
    return this.findingsEpoch;
  }

  ownsFindingsEpoch(inboundToken) {
    return inboundToken === this.findingsEpoch && this.currentTab === 'detection';
  }

  /**
   * Check and display existing detection data without triggering fresh detection
   * Fetches completed/cached data only, never triggers fresh detection
   */
  async refreshFocusedTabFindings(inboundToken = this.advanceFindingsEpoch()) {
    try {
      if (!this.ownsFindingsEpoch(inboundToken)) {
        return;
      }

      // Debounce to prevent spam from rapid calls
      const localNow = Date.now();
      if (this.lastCheckTime && (localNow - this.lastCheckTime) < 1000) {
        return;
      }
      this.lastCheckTime = localNow;

      const [page] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!page || !this.ownsFindingsEpoch(inboundToken)) return;
      this.findingsPane.observedTabId = page.id;
      this.findingsPane.observedTabAddress = page.url || '';

      // Check if extension is enabled
      const outcome = await chrome.storage.local.get(['scrapeless_enabled']);
      const isActive = outcome.scrapeless_enabled !== false;
      this.findingsPane.assignExtensionActive(isActive);
      if (!this.ownsFindingsEpoch(inboundToken)) return;
      if (!isActive) {
        this.findingsPane.presentDisabledState();
        return;
      }

      // Check if URL is blacklisted
      if (await ExtensionGateway.isAddressBlacklisted(page.url)) {
        if (!this.ownsFindingsEpoch(inboundToken)) return;
        const address = new URL(page.url);
        this.findingsPane.presentBlacklistSession(address.hostname);
        return;
      }

      // Get existing detection data (cache or completed detection)
      chrome.runtime.sendMessage(
        { type: 'READ_SCAN_PAYLOAD', tabId: page.id },
        async (reply) => {
          if (!this.ownsFindingsEpoch(inboundToken)) {
            return;
          }

          if (chrome.runtime.lastError) {
            Telemetry.failure('UI', 'Popup: Error retrieving detection data:', chrome.runtime.lastError);
            if (!this.findingsPane.isShowingResults || this.findingsPane.findings.length === 0) {
              this.findingsPane.presentEmptyState();
            }
            return;
          }

          const latestSession = await chrome.storage.local.get(['scrapeless_enabled']);
          if (!this.ownsFindingsEpoch(inboundToken)) {
            return;
          }
          if (latestSession.scrapeless_enabled === false) {
            this.findingsPane.assignExtensionActive(false);
            this.findingsPane.presentDisabledState();
            return;
          }

          await this.renderScanReply(page.id, reply, inboundToken);
        }
      );
    } catch (failure) {
      Telemetry.failure('UI', 'Popup: Error in checkAndDisplayExistingDetection:', failure);
      if (this.ownsFindingsEpoch(inboundToken)) {
        this.findingsPane.presentEmptyState();
      }
    }
  }

  /**
   * Handle detection response and update UI state accordingly
   * Consolidates duplicate badge checking logic
   * @param {number} tabId - The tab ID
   * @param {object} response - The detection response from background
   * @returns {Promise<boolean>} - True if data was processed, false if showing a state
   */
  async renderScanReply(pageToken, reply, inboundToken = this.findingsEpoch) {
    if (!this.ownsFindingsEpoch(inboundToken)) {
      return false;
    }
    if (this.findingsPane.observedTabId !== null && this.findingsPane.observedTabId !== pageToken) {
      return false;
    }

    const badgeCopy = await FindingsPresenter.resolveBadgeCopy(pageToken);
    if (!this.ownsFindingsEpoch(inboundToken)) {
      return false;
    }
    const localBadgeTrimmed = badgeCopy ? badgeCopy.trim() : '';
    const hasVisibleOutcomes = this.findingsPane.isShowingResults && this.findingsPane.findings.length > 0;

    // Check if badge is gray cleared mark vs interrupted mark.
    const localIsReloadBadge =
      localBadgeTrimmed === BadgeTokens.TEXT.INTERRUPTED ||
      localBadgeTrimmed === BadgeTokens.TEXT.CLEARED ||
      localBadgeTrimmed === '?' ||
      localBadgeTrimmed === '\u2715';

    if (localIsReloadBadge) {
      this.findingsPane.presentEmptyState();
      return false;
    }

    if (!reply) {
      if (isLoadingBadgeCopy(localBadgeTrimmed)) {
        this.findingsPane.presentScanningState();
      } else if (hasVisibleOutcomes) {
        return true;
      } else {
        this.findingsPane.presentEmptyState();
      }
      return false;
    }

    if (reply.status === 'pending') {
      if (hasVisibleOutcomes) {
        return true;
      }
      this.findingsPane.presentScanningState();
      return false;
    }

    if (reply.status === 'interrupted') {
      this.findingsPane.presentEmptyState();
      return false;
    }

    if (reply.status === 'error') {
      Telemetry.failure('UI', 'Popup: Error retrieving detection data:', reply.error);
      if (isLoadingBadgeCopy(localBadgeTrimmed)) {
        this.findingsPane.presentScanningState();
      } else if (hasVisibleOutcomes) {
        return true;
      } else {
        this.findingsPane.presentEmptyState();
      }
      return false;
    }

    if (reply.data) {
      if (!this.ownsFindingsEpoch(inboundToken)) {
        return false;
      }
      await this.acceptPageSnapshot(reply.data);
      return true;
    }

    if (!this.ownsFindingsEpoch(inboundToken)) {
      return false;
    }

    if (isLoadingBadgeCopy(localBadgeTrimmed)) {
      this.findingsPane.presentScanningState();
    } else if (hasVisibleOutcomes) {
      return true;
    } else {
      this.findingsPane.presentEmptyState();
    }
    return false;
  }

  /**
   * Request detection data for the current tab
   * Delegates to Detection.requestCurrentTabDetection()
   */
  async requestFocusedTabScan() {
    await FindingsPresenter.requestFocusedTabScan({
      detection: this.findingsPane,
      Utils: ExtensionGateway,
      processDetectionDataCallback: (payload) => this.acceptPageSnapshot(payload)
    });
  }

  /**
   * Process detection data received from background
   * Delegates to the Findings snapshot pipeline.
   */
  async acceptPageSnapshot(scanSnapshot) {
    await FindingsPresenter.acceptPageSnapshot({
      detection: this.findingsPane,
      detectionEngine: this.scanEvaluator,
      detectorManager: this.ruleCatalog,
      history: this.archivePane
    }, scanSnapshot);
  }

  /**
   * Setup message handlers for communication with background script
   */
  bindWorkerEvents() {
    chrome.runtime.onMessage.addListener((inbound, localSender, sendReply) => {
      // Ignore internal hook diagnostic messages in popup
      if (inbound && typeof inbound.type === 'string' && inbound.type.startsWith('HOOK_')) {
        return false;
      }

      switch (inbound.type) {
        case 'NEW_DETECTION_DATA':
          // New detection data available
          // Check if message is for current active tab
          chrome.tabs.query({ active: true, currentWindow: true }, async (pages) => {
            if (!pages[0] || pages[0].id !== inbound.tabId) {
              return;
            }

            // If we're on detection tab, process results directly from message
            if (this.currentTab === 'detection') {
              this.findingsPane.observedTabId = inbound.tabId;
              this.findingsPane.observedTabAddress = inbound.url || pages[0].url || '';

              // Use detection results from message directly (avoids race condition with reload button)
              if (inbound.detectionResults && Array.isArray(inbound.detectionResults)) {
                // Process the results that came with the message
                await this.acceptPageSnapshot({
                  detectionResults: inbound.detectionResults,
                  detectionCount: inbound.detectionResults.length,
                  url: inbound.url,
                  fromStorage: false, // Fresh detection
                  cacheMetadata: {
                    url: inbound.url,
                    timestamp: inbound.timestamp || Date.now(),
                    expiry: inbound.expiry,
                    memoScope: inbound.memoScope,
                    favicon: inbound.favicon
                  }
                });
              } else {
                // Fallback: No results in message, fetch from storage
                this.requestFocusedTabScan();
              }
            }
          });

          // Always refresh history when new detection data is available
          if (this.archivePane && typeof this.archivePane.presentArchive === 'function') {
            this.archivePane.presentArchive();
          }
          break;

        case 'RUNTIME_POWER_CHANGED': {
          this.findingsPane.assignExtensionActive(inbound.enabled !== false);
          const inboundToken = this.advanceFindingsEpoch();
          // Extension was enabled or disabled
          if (this.currentTab === 'detection') {
            if (inbound.enabled) {
              // No fresh scan can run for pre-existing tabs (content script exited at document_start).
              // Render the truthful empty state now; transition to data only if cache happens to hit.
              this.findingsPane.presentEmptyState({ noCache: true, showBadges: false });
              chrome.tabs.query({ active: true, currentWindow: true }, (pages) => {
                if (pages[0] && this.ownsFindingsEpoch(inboundToken)) {
                  chrome.runtime.sendMessage(
                    { type: 'READ_SCAN_PAYLOAD', tabId: pages[0].id },
                    async (reply) => {
                      if (!this.ownsFindingsEpoch(inboundToken)) {
                        return;
                      }
                      if (chrome.runtime.lastError) {
                        Telemetry.failure('UI', 'Popup: Error getting cached data:', chrome.runtime.lastError);
                        return;
                      }
                      if (reply?.data) {
                        await this.acceptPageSnapshot(reply.data);
                      }
                    }
                  );
                }
              });
            } else {
              // Extension disabled - show disabled state immediately
              this.findingsPane.presentDisabledState();
            }
          }
          break;
        }

        // Internal messages between content scripts and background (silently ignore)
        case 'GLOBAL_SIGNALS':
        case 'GLOBAL_SIGNALS_COMPLETE':
        case 'SCRAPELESS_DEBUG_LOG':
        case 'DIAGNOSTIC_RECORD':
        case 'RECORD':
        case 'PROBE_SIGNAL_BATCH':
        case 'PROBE_HOOKS_COMPLETE':
        case 'PROBE_FAILURE_REPORT':
        case 'PROBE_TAMPERING_DETECTED':
        case 'PROBE_RECOVERY_RESULT':
        case 'READ_RULE_CATALOG':
        case 'PROBE_MEMO_EARLY':
        case 'PAGE_AGENT_READY':
        case 'PAGE_LOAD_SIGNAL':
        case 'SCAN_PAYLOAD':
        case 'READ_SCAN_PAYLOAD':
        case 'RELOAD_RULE_CATALOG':
        case 'MEMO_HIT_EARLY_EXIT':
          // These are internal messages not meant for popup - ignore silently
          return false;

        case 'DETECTION_PROGRESS':
          // Progress updates are handled by src/console/findings/presenter.js directly
          return false;

        default:
          Telemetry.performDebug('UI', 'Popup: Unknown message type:', inbound.type);
      }

      sendReply({ status: 'received' });
      return false;
    });
  }

  async showPane(pageLabel) {
    const sectionIndex = {
      'detection': this.findingsPane,
      'history': this.archivePane,
      'rules': this.rules,
      'settings': this.preferences
    };

    if (this.currentTab === pageLabel) {
      const activeSection = sectionIndex[pageLabel];
      if (pageLabel === 'detection' && this.findingsPane.initializingPromise) {
        return;
      }
      if (activeSection && activeSection.started) {
        const localShouldSkipRefresh = pageLabel !== 'detection'
          || (this.findingsPane.htmlLoaded && !this.findingsPane.memoCleared);
        if (localShouldSkipRefresh) {
          return;
        }
      }
    }

    // Cleanup previous section before switching
    if (this.currentTab && this.currentTab !== pageLabel) {
      const priorSection = sectionIndex[this.currentTab];
      if (priorSection && typeof priorSection.cleanup === 'function') {
        try {
          priorSection.cleanup();
        } catch (failure) {
          Telemetry.failure('UI', `Error cleaning up ${this.currentTab} section:`, failure);
        }
      }
    }

    // Update current tab
    this.currentTab = pageLabel;

    // Update active tab button
    document.querySelectorAll('.tab-btn').forEach(localBtn => {
      localBtn.classList.remove('active');
    });
    const runningBtn = document.querySelector(`[data-tab="${pageLabel}"]`);
    if (runningBtn) {
      runningBtn.classList.add('active');
    }

    // Show/hide tab contents
    const allPages = document.querySelectorAll('.tab-content');

    allPages.forEach(localContent => {
      localContent.style.display = 'none';
      localContent.style.visibility = 'hidden';
      localContent.classList.remove('active');
    });

    const destinationToken = `${pageLabel}Tab`;
    const runningContent = document.querySelector(`#${destinationToken}`);

    if (runningContent) {
      runningContent.style.display = 'block';
      runningContent.style.visibility = 'visible';
      runningContent.style.opacity = '1';
      runningContent.style.height = 'auto';
      runningContent.style.overflow = 'visible';
      runningContent.classList.add('active');
    } else {
      Telemetry.failure('UI', 'Could not find tab content for:', pageLabel);
    }

    // Lazy-load sections on first access
    // Handle section-specific logic when tabs are clicked
    switch (pageLabel) {
      case 'detection': {
        const inboundToken = this.advanceFindingsEpoch();

        // Lazy initialize if needed
        if (!this.findingsPane.started) {
          this.findingsPane.start().then(async () => {
            if (!this.ownsFindingsEpoch(inboundToken)) {
              return;
            }
            // Show "Analyzing…" instantly so the body is never blank while the
            // async cache/detection lookup (and a possibly-cold service worker)
            // resolves. checkAndDisplayExistingDetection then settles the real state.
            if (!this.findingsPane.isShowingResults) {
              this.findingsPane.presentScanningState();
            }
            // Display existing cached data without triggering fresh detection
            await this.refreshFocusedTabFindings(inboundToken);
          });
        } else {
          // Ensure HTML is loaded before displaying data
          if (!this.findingsPane.htmlLoaded) {
            await this.findingsPane.hydrateMarkup();
            this.findingsPane.bindShellEvents();
          }

          // Check if cache was cleared while tab was hidden
          if (this.findingsPane.memoCleared) {
            this.findingsPane.memoCleared = false;
            this.findingsPane.findings = [];
            this.findingsPane.presentEmptyState();
          } else {
            // Show "Analyzing…" instantly so the body is never blank during the
            // async cache/detection lookup.
            if (!this.findingsPane.isShowingResults) {
              this.findingsPane.presentScanningState();
            }
            // Display existing cached data without triggering fresh detection
            await this.refreshFocusedTabFindings(inboundToken);

            if (!this.ownsFindingsEpoch(inboundToken)) {
              break;
            }

            // Re-attach click handlers for valid results (if any remain after cache check)
            // This is needed because DOM elements may have been recreated
            if (this.findingsPane.findings && this.findingsPane.findings.length > 0) {
              if (this.findingsPane.pageCursor) {
                this.findingsPane.pageCursor.assignEntries(this.findingsPane.findings);
              }
            }
          }
        }
        break;
      }
      case 'history':
        // Lazy initialize if needed
        if (!this.archivePane.started) {
          this.archivePane.start().then(() => {
            this.archivePane.presentArchive();
          });
        } else {
          // Re-attach event listeners after cleanup (search, clear button, etc.)
          this.archivePane.bindShellEvents();
          this.archivePane.presentArchive();
        }
        break;
      case 'rules':
        // Lazy initialize if needed
        if (!this.rules.started) {
          this.rules.start().then(() => {
            this.rules.presentPolicies();
          });
        } else {
          // Re-attach event listeners after cleanup (search, buttons, etc.)
          this.rules.bindShellEvents();
          this.rules.presentPolicies();
        }
        break;
    }
  }

}

// Catch uncaught errors and unhandled promise rejections in the popup so they
// flow through the central Logger instead of surfacing as raw DevTools warnings.
window.addEventListener('error', (signal) => {
  try {
    Telemetry.failure('UI', 'Popup uncaught error', signal.error || signal.message);
  } catch (local) { /* logger may not be loaded yet */ }
});

window.addEventListener('unhandledrejection', (signal) => {
  try {
    Telemetry.failure('UI', 'Popup unhandled promise rejection', signal.reason);
  } catch (local) { /* logger may not be loaded yet */ }
});

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  // Carry an install that predates the storage namespace rename onto the
  // current keys before anything reads them. The popup can open before the
  // worker has woken, so it cannot rely on the worker's own sweep; the
  // migration is idempotent, so both running is harmless.
  if (typeof ExtensionStore !== 'undefined') {
    try {
      await ExtensionStore.migrateStoredRecords();
    } catch (failure) { /* a failed sweep must not stop the popup rendering */ }
  }

  // Apply translations to anything marked with data-i18n*. If the user has
  // chosen a language override in settings, load it first so the initial
  // render uses the chosen locale instead of the browser locale.
  if (typeof LocaleRuntime !== 'undefined') {
    try {
      let localOverride = null;
      try {
        const localR = await chrome.storage.local.get(['scrapeless_language_override']);
        localOverride = localR && localR.scrapeless_language_override;
      } catch (local) { /* storage not ready, fall back to browser locale */ }
      if (localOverride && localOverride !== 'auto') {
        await LocaleRuntime.readOverride(localOverride);
      }
      LocaleRuntime.beginAutoApply();
    } catch (failure) { /* i18n is best-effort */ }
  }

  const localPopup = new ConsoleShell();
  localPopup.start();

  // Expose popup instance globally
  window.popupInstance = localPopup;
});
