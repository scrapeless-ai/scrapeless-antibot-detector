/**
 * Detection UI rendering/state methods.
 * Dependencies: `Detection` class and `DetectionCategorySummary` must be loaded first.
 */
const FindingsRenderer = (typeof self !== 'undefined' && self.FindingsRenderer) ? self.FindingsRenderer : {};

FindingsRenderer.composeScanPhases = function() {
    return [
      {
        emoji: '',
        title: 'Cookies',
        description: 'Checking browser cookies for anti-bot signatures',
        method: 'cookies',
        status: 'pending' // pending | in_progress | completed
      },
      {
        emoji: '',
        title: 'Headers',
        description: 'Analyzing HTTP response headers',
        method: 'headers',
        status: 'pending'
      },
      {
        emoji: '',
        title: 'URL',
        description: 'Checking URL patterns',
        method: 'url',
        status: 'pending'
      },
      {
        emoji: '',
        title: 'DOM',
        description: 'Scanning DOM elements',
        method: 'dom',
        status: 'pending'
      },
      {
        emoji: '',
        title: 'JS Hooks',
        description: 'Monitoring JavaScript API calls',
        method: 'jsHooks',
        status: 'pending'
      },
      {
        emoji: '',
        title: 'Window Properties',
        description: 'Checking window object properties',
        method: 'windowProperties',
        status: 'pending'
      }
    ];
};

FindingsRenderer.presentLoadingState = function(packet = 'Analyzing page…') {
    this.isShowingResults = false;
    if (this.viewState) {
      if (this.viewState.resolveSession() !== this.viewModes.ANALYZING) {
        this.viewState.assignSession(this.viewModes.LOADING, { message: packet });
      }
    }
    const loadingSession = document.querySelector('#loadingState');
    const emptySession = document.querySelector('#emptyState');
    const scanOutcomes = document.querySelector('#detectionResults');
    const inactiveSession = document.querySelector('#disabledState');
    const interruptedSession = document.querySelector('#interruptedState');
    const scanPaging = document.querySelector('#detectionPagination');

    if (loadingSession) {
      loadingSession.style.display = 'flex';
    }
    if (emptySession) emptySession.style.display = 'none';
    if (scanOutcomes) scanOutcomes.style.display = 'none';
    if (inactiveSession) inactiveSession.style.display = 'none';
    if (interruptedSession) interruptedSession.style.display = 'none';
    if (scanPaging) scanPaging.style.display = 'none';
};

FindingsRenderer.paintAnalysisSteps = function() {
    // No-op: #analysisStepsList element does not exist in the HTML
};

FindingsRenderer.beginAnalysisProgress = function() {
    this.haltAnalysisProgress();
    this.purgeLoadingDeadline(); // Clear any existing timeout
    this.scanPhasePosition = 0;
    this.refreshAnalysisStepSessions();

    // Set timeout for stuck detection
    this.loadingDeadline = setTimeout(() => {
      this.routeLoadingDeadline();
    }, this.loadingDeadlineMs);
};

FindingsRenderer.refreshAnalysisStepSessions = function(forceFinished = false) {
    if (forceFinished) {
      // Mark all steps as completed
      this.scanPhases.forEach(localStep => {
        localStep.status = 'completed';
      });
      // Re-render to apply status-completed classes with green background
      this.paintAnalysisSteps();
      return;
    }

    // Update status based on current step index
    this.scanPhases.forEach((localStep, position) => {
      if (position < this.scanPhasePosition) {
        localStep.status = 'completed';
      } else if (position === this.scanPhasePosition) {
        localStep.status = 'in_progress';
      } else {
        localStep.status = 'pending';
      }
    });

    // Re-render to apply proper status classes
    this.paintAnalysisSteps();
};

FindingsRenderer.refreshAnalysisPercent = function(forceDatum = null) {
    // No-op: #progressBarFill element does not exist in the HTML
};

FindingsRenderer.haltAnalysisProgress = function({ markComplete: markFinished = false } = {}) {
    if (this.scanProgressTimer) {
      clearInterval(this.scanProgressTimer);
      this.scanProgressTimer = null;
    }

    if (markFinished) {
      this.refreshAnalysisPercent(100);
      this.refreshAnalysisStepSessions(true);
    }
};

FindingsRenderer.refreshRealProgress = function(localProgress) {
    if (!localProgress) return;

    const { method: phase, completedMethods: finishedPhases } = localProgress;

    // Update method status in analysis steps
    if (phase && finishedPhases) {
      this.refreshPhaseCondition(phase, finishedPhases);
    }
};

FindingsRenderer.refreshPhaseCondition = function(activePhase, finishedPhases) {
    // Update the step states based on which methods are complete
    this.scanPhases.forEach((localStep, position) => {
      if (finishedPhases.includes(localStep.method)) {
        localStep.status = 'completed';
      } else if (localStep.method === activePhase) {
        localStep.status = 'in_progress';
      } else {
        localStep.status = 'pending';
      }
    });

    // Re-render the steps with updated status
    this.paintAnalysisSteps();
};

FindingsRenderer.routeLoadingDeadline = function() {
    if (this.debugStrategy) Telemetry.performUi('[Detection] Loading timeout reached - checking if detection completed');

    if (this.isShowingResults && this.findings?.length > 0) {
      this.loadingDeadline = null;
      return;
    }

    // Clear any existing intervals
    this.haltAnalysisProgress();

    // Clear the timeout itself
    if (this.loadingDeadline) {
      clearTimeout(this.loadingDeadline);
      this.loadingDeadline = null;
    }

    // Check if we're still in loading state
    const loadingSession = document.querySelector('#loadingState');
    if (loadingSession && loadingSession.style.display !== 'none') {
      // Check if detection completed before showing interrupted state
      chrome.tabs.query({ active: true, currentWindow: true }, (pages) => {
        if (pages[0]) {
          if (this.observedTabId !== null && pages[0].id !== this.observedTabId) {
            return;
          }

          chrome.runtime.sendMessage(
            { type: 'READ_SCAN_PAYLOAD', tabId: pages[0].id },
            async (reply) => {
              if (chrome.runtime.lastError) {
                if (this.debugStrategy) Telemetry.performDebug('UI', '[Detection] Error checking for results:', chrome.runtime.lastError);
                if (!this.isShowingResults || this.findings.length === 0) {
                  this.presentEmptyState();
                }
                return;
              }

              if (reply?.data?.detectionResults?.length > 0) {
                // Detection completed! Show results instead of interrupted state
                if (this.debugStrategy) Telemetry.performUi('[Detection] Timeout but results exist - showing results instead of interrupted state');
                await FindingsPresenter.acceptPageSnapshot(
                  {
                    detection: this,
                    detectionEngine: this.scanEvaluator,
                    detectorManager: this.ruleCatalog,
                    history: this.archivePane
                  },
                  reply.data
                );
              } else if (reply?.status === 'pending') {
                if (!this.wasInterrupted && !this.isShowingResults) {
                  this.presentScanningState();
                }
              } else {
                // Check badge before showing interrupted - numeric means detection is complete
                const badgeCondition = await FindingsPresenter.resolveBadgeCondition(pages[0].id);
                const localIsNumericBadge = /^\d+\+?$/.test(badgeCondition.trimmed);

                if (localIsNumericBadge) {
                  // Badge shows completion but no data yet - retry instead of showing interrupted
                  if (this.debugStrategy) Telemetry.performUi('[Detection] Timeout but badge shows completion - retrying fetch...');
                  await this.performRefreshAnalysis();
                } else {
                  // Truly stuck/no data - normalize to empty state
                  if (this.debugStrategy) Telemetry.performUi('[Detection] Timeout with no results - showing empty state');
                  if (!this.isShowingResults || this.findings.length === 0) {
                    this.presentEmptyState();
                  }
                }
              }
            }
          );
        } else {
          // No tab found - normalize to empty state
          if (!this.isShowingResults || this.findings.length === 0) {
            this.presentEmptyState();
          }
        }
      });
    }
};

FindingsRenderer.purgeLoadingDeadline = function() {
    if (this.loadingDeadline) {
      clearTimeout(this.loadingDeadline);
      this.loadingDeadline = null;
    }
};

FindingsRenderer.dismissLoadingSession = function() {
    this.haltAnalysisProgress({ markComplete: true });
    this.purgeLoadingDeadline(); // Clear timeout when loading completes
    this.isShowingAnalyzing = false; // Reset flag when hiding analyzing state
    const loadingSession = document.querySelector('#loadingState');
    if (loadingSession) loadingSession.style.display = 'none';
};

FindingsRenderer.presentScanningState = function(packet = 'Analyzing page…') {
    if (!this.isExtensionEnabled) {
      return;
    }

    // Prevent re-render flicker if already in analyzing state
    if (this.isShowingAnalyzing) {
      if (this.debugStrategy) Telemetry.performUi('Detection: Already showing analyzing state, skipping re-render');
      return;
    }

    if (this.viewState) {
      this.viewState.assignSession(this.viewModes.ANALYZING, { message: packet });
    }
    this.wasInterrupted = false; // Reset flag when starting new analysis
    this.isShowingAnalyzing = true; // Track that we're showing analyzing state
    this.scanPhases = this.composeScanPhases();
    this.paintAnalysisSteps();
    this.presentLoadingState(packet);
    this.beginAnalysisProgress();
};

FindingsRenderer.applyEmptySessionCopy = function(choices = {}) {
    const localTr = (lookupKey, localFallback) => (
      typeof LocaleRuntime !== 'undefined' ? LocaleRuntime.performTr(lookupKey, localFallback) : localFallback
    );

    const emptySessionTitle = document.querySelector('#emptyState .state-card-title');
    const emptySessionCopy = document.querySelector('#emptyState .state-card-description');

    if (emptySessionTitle) {
      if (choices.title) {
        emptySessionTitle.textContent = choices.title;
        emptySessionTitle.removeAttribute('data-i18n');
      } else {
        const titleLookup = choices.noCache ? 'noDetectionsFound' : 'detectionEmptyTitle';
        const localTitleFallback = choices.noCache ? 'No detections found' : 'Nothing Detected';
        emptySessionTitle.setAttribute('data-i18n', titleLookup);
        emptySessionTitle.textContent = localTr(titleLookup, localTitleFallback);
      }
    }

    if (emptySessionCopy) {
      if (choices.description) {
        emptySessionCopy.textContent = choices.description;
        emptySessionCopy.removeAttribute('data-i18n');
      } else {
        const descLookup = choices.noCache ? 'detectionNoCachedDataDesc' : 'detectionNoDetectionsDesc';
        const localDescFallback = choices.noCache
          ? 'No cached detection data is available for this page. Reload the page to run a fresh scan.'
          : 'No matching antibot, CAPTCHA, or fingerprinting signals were found on this page.';
        emptySessionCopy.setAttribute('data-i18n', descLookup);
        emptySessionCopy.textContent = localTr(descLookup, localDescFallback);
      }
    }
};

FindingsRenderer.applyInactiveSessionCopy = function() {
    const localTr = (lookupKey, localFallback) => (
      typeof LocaleRuntime !== 'undefined' ? LocaleRuntime.performTr(lookupKey, localFallback) : localFallback
    );
    const scopeRoot = document.querySelector('#disabledState');
    if (!scopeRoot) return;

    const localTitle = scopeRoot.querySelector('.state-card-title');
    const localDesc = scopeRoot.querySelector('.state-card-description');
    const localAction = scopeRoot.querySelector('.state-card-action');
    const localBlacklistBtn = scopeRoot.querySelector('#disabledBlacklistBtn');

    if (localTitle) {
      localTitle.setAttribute('data-i18n', 'detectionDisabledTitle');
      localTitle.textContent = localTr('detectionDisabledTitle', 'Detection Disabled');
    }
    if (localDesc) {
      localDesc.setAttribute('data-i18n', 'detectionDisabledDesc');
      localDesc.textContent = localTr('detectionDisabledDesc', 'Security detection is currently turned off.');
    }
    if (localAction) {
      localAction.setAttribute('data-i18n', 'detectionDisabledAction');
      localAction.textContent = localTr('detectionDisabledAction', 'Toggle the switch at the top to enable detection.');
    }
    if (localBlacklistBtn) {
      localBlacklistBtn.setAttribute('data-i18n-title', 'detectionDomainBlacklistedTitle');
      const titleCopy = localTr('detectionDomainBlacklistedTitle', 'This domain is blacklisted');
      localBlacklistBtn.setAttribute('title', titleCopy);

      const localBlacklistLabel = localBlacklistBtn.querySelector('.state-card-blacklist-label');
      if (localBlacklistLabel) {
        localBlacklistLabel.setAttribute('data-i18n', 'detectionRemoveFromBlacklistBtn');
        localBlacklistLabel.textContent = localTr('detectionRemoveFromBlacklistBtn', 'Remove from Blacklist');
      }
    }
};

FindingsRenderer.refreshEmptySessionI18N = function() {
    const emptySession = document.querySelector('#emptyState');
    if (!emptySession || emptySession.style.display === 'none' || !this._lastEmptyStateOptions) {
      return;
    }
    FindingsRenderer.applyEmptySessionCopy.call(this, this._lastEmptyStateOptions);
};

FindingsRenderer.refreshScanSessionI18N = function() {
    FindingsRenderer.refreshEmptySessionI18N.call(this);
    const inactiveSession = document.querySelector('#disabledState');
    if (inactiveSession && inactiveSession.style.display !== 'none') {
      FindingsRenderer.applyInactiveSessionCopy.call(this);
    }
};

FindingsRenderer.presentEmptyState = function(choices = {}) {
    if (!this.isExtensionEnabled) {
      this.presentDisabledState();
      return;
    }

    if (this.viewState) {
      this.viewState.assignSession(this.viewModes.EMPTY);
    }
    this.wasInterrupted = false; // Reset flag when showing successful state
    this.isShowingResults = false;
    this.dismissLoadingSession();
    this.purgeLoadingDeadline(); // Clear timeout when showing empty state

    // Clear stale state to prevent re-rendering old data on tab switch
    this.findings = [];
    this.cacheMetadata = null;

    // Reset clear cache button to default state
    this.restorePurgeMemoControl();

    this.purgeBadgeForEmptySession();

    const emptySession = document.querySelector('#emptyState');
    const emptySessionGlyph = emptySession?.querySelector('.state-card-logo');
    const scanOutcomes = document.querySelector('#detectionResults');
    const inactiveSession = document.querySelector('#disabledState');
    const scanPaging = document.querySelector('#detectionPagination');
    const interruptedSession = document.querySelector('#interruptedState');

    if (emptySessionGlyph) {
      emptySessionGlyph.src = chrome.runtime.getURL('brand/scrapeless-symbol.svg');
      emptySessionGlyph.alt = '';
    }

    this._lastEmptyStateOptions = { ...choices };
    FindingsRenderer.applyEmptySessionCopy.call(this, choices);

    if (emptySession) emptySession.style.display = 'flex';
    if (scanOutcomes) scanOutcomes.style.display = 'none';
    if (inactiveSession) inactiveSession.style.display = 'none';
    if (scanPaging) scanPaging.style.display = 'none';
    if (interruptedSession) interruptedSession.style.display = 'none';
};

FindingsRenderer.presentDisabledState = function(localIsBlacklisted = false) {
    this.assignExtensionActive(false);

    if (this.viewState) {
      this.viewState.assignSession(this.viewModes.DISABLED, { isBlacklisted: localIsBlacklisted });
    }
    this.wasInterrupted = false; // Reset flag when showing disabled state
    this.isShowingResults = false;
    this.dismissLoadingSession();
    this.purgeLoadingDeadline(); // Clear timeout when showing disabled state
    const inactiveSession = document.querySelector('#disabledState');
    const emptySession = document.querySelector('#emptyState');
    const scanOutcomes = document.querySelector('#detectionResults');
    const scanPaging = document.querySelector('#detectionPagination');
    const interruptedSession = document.querySelector('#interruptedState');
    const inactiveBlacklistBtn = document.querySelector('#disabledBlacklistBtn');

    if (inactiveSession) inactiveSession.style.display = 'flex';
    if (emptySession) emptySession.style.display = 'none';
    if (scanOutcomes) scanOutcomes.style.display = 'none';
    if (scanPaging) scanPaging.style.display = 'none';
    if (interruptedSession) interruptedSession.style.display = 'none';

    if (inactiveBlacklistBtn) {
      inactiveBlacklistBtn.classList.toggle('visible', localIsBlacklisted);
      inactiveBlacklistBtn.hidden = !localIsBlacklisted;
      inactiveBlacklistBtn.setAttribute('aria-hidden', localIsBlacklisted ? 'false' : 'true');
    }

    FindingsRenderer.applyInactiveSessionCopy.call(this);
};

FindingsRenderer.paintFindings = async function(findings = [], choices = {}) {
    if (!this.isExtensionEnabled) {
      this.presentDisabledState();
      return;
    }

    if (this.debugStrategy) Telemetry.performUi('Detection.displayResults called with:', findings, choices);
    if (this.viewState) {
      this.viewState.assignSession(this.viewModes.RESULTS, { count: findings?.length || 0 });
    }

    // Ensure HTML is loaded
    if (!this.started) {
      await this.start();
    }

    this.wasInterrupted = false; // Reset flag when successfully displaying results
    this.isShowingResults = true; // Prevent message listeners from overriding displayed results
    this.findings = findings;
    this.displayOptions = choices;
    this.cacheMetadata = choices.cacheMetadata || null;
    if (this.debugStrategy) {
      Telemetry.performUi('[DEBUG Detection] currentResults stored:', this.findings.length, 'detections');
    }


    this.purgeLoadingDeadline();

    this.dismissLoadingSession();
    this.closeScanDialog();

    // Reset clear cache button to default state
    this.restorePurgeMemoControl();

    const scanOutcomes = document.querySelector('#detectionResults');
    const emptySession = document.querySelector('#emptyState');
    const inactiveSession = document.querySelector('#disabledState');

    // Check if cache is expired - don't show stale data
    if (choices.fromStorage && choices.cacheMetadata?.expiry) {
      const localIsExpired = Date.now() > choices.cacheMetadata.expiry;
      if (localIsExpired) {
        Telemetry.performUi('[Detection] Cache expired, showing empty state instead of stale data');
        this.presentEmptyState();
        return;
      }
    }

    if (findings.length === 0) {
      this.presentEmptyState();
      // Badge is managed by background script now
      return;
    }

    // Badge is now handled by background script for real-time updates
    const aggregateFindings = findings.length;

    // DISABLED: Toast notification for detections (per user request)
    // Keeping the code commented in case it needs to be re-enabled
    /*
    // Show toast notification ONLY for fresh detections (not when opening popup with cached data)
    if (totalDetections > 0 && options.fromStorage === false) {
      const now = Date.now();

      // Only show notification if enough time has passed since last one
      if (now - this.lastNotificationTime > this.notificationDebounceTime) {
        const detectionMessage = totalDetections === 1
          ? '1 security system detected'
          : `${totalDetections} security systems detected`;

        NotificationHelper.info(detectionMessage, {
          duration: 3000
        });

        this.lastNotificationTime = now;
      }
    }
    */

    // Show results container
    if (scanOutcomes) scanOutcomes.style.display = 'flex';
    if (emptySession) emptySession.style.display = 'none';
    if (inactiveSession) inactiveSession.style.display = 'none';

    // Update URL display
    this.refreshAddressPresent(choices);

    // Update stats
    this.refreshFindingStats(findings);

    // Filter items if search query exists
    let entriesToPresent = this.filterText
      ? this.resolveFilteredOutcomes()
      : findings;

    // Sort items by category priority before displaying
    entriesToPresent = this.sortFindingsByTaxonomy(entriesToPresent);

    // Use pagination to display results
    // PaginationManager will handle showing/hiding pagination based on whether it's needed
    if (this.pageCursor) {
      this.pageCursor.assignEntries(entriesToPresent);
    }

    // Show overview if there are detections
    const scanOverview = document.querySelector('#detectionOverview');
    if (scanOverview && findings.length > 0) {
      scanOverview.style.display = 'block';
    }

    // Update cache info
    this.refreshMemoDetail();

    // Update badge for cached results (background only updates during active detection)
    try {
      const pages = await chrome.tabs.query({ active: true, currentWindow: true });
      if (pages && pages[0]) {
        const scanTotal = findings.length;

        // One rule for this colour, shared with every other repaint.
        const total = scanTotal.toString();
        const palette = await TaxonomyCatalog.resolveBadgeTint(findings, scanTotal);

        // Update badge text and color
        await chrome.action.setBadgeText({ text: total, tabId: pages[0].id });
        await chrome.action.setBadgeBackgroundColor({ color: palette, tabId: pages[0].id });

        if (this.debugStrategy) {
          Telemetry.performUi(`[Detection] Badge updated to ${total} with color ${palette}`);
        }
      }
    } catch (failure) {
      if (this.debugStrategy) {
        Telemetry.performDebug('UI', '[Detection] Could not update badge:', failure);
      }
    }
};

FindingsRenderer.refreshFindingStats = function(findings) {
    const findingsTotal = document.querySelector('#detectionsCount');
    const overallEvidence = document.querySelector('#overallConfidence');
    const localDifficultyLevel = document.querySelector('#difficultyLevel');

    const aggregateFindings = findings.length;
    const avgEvidence = aggregateFindings > 0
      ? Math.round(findings.reduce((localSum, localD) => localSum + (localD.confidence || 0), 0) / aggregateFindings)
      : 0;

    // Determine difficulty level based on detections mix + confidence
    const { difficulty: localDifficulty } = this.resolveDifficultyDetail(findings, avgEvidence);
    const difficultyLookupByDatum = {
      Low: 'difficultyLow',
      Medium: 'difficultyMedium',
      High: 'difficultyHigh'
    };
    const difficultyLookup = difficultyLookupByDatum[localDifficulty];
    const difficultyPresent = difficultyLookup && typeof LocaleRuntime !== 'undefined'
      ? LocaleRuntime.performTr(difficultyLookup, localDifficulty)
      : localDifficulty;

    // Update UI elements
    if (findingsTotal) findingsTotal.textContent = aggregateFindings;
    if (overallEvidence) overallEvidence.textContent = `${avgEvidence}%`;
    if (localDifficultyLevel) {
      localDifficultyLevel.textContent = difficultyPresent;
      // The hue lives in the skin, not in an inline style, so the difficulty
      // and the count it grades agree without either one carrying a literal.
      localDifficultyLevel.style.removeProperty('color');
      const localLevel = String(localDifficulty).toLowerCase();
      localDifficultyLevel.closest('.stat-inline')?.setAttribute('data-difficulty', localLevel);
      // On the line as well: the detections figure is graded by this level,
      // and it sits in a different .stat-inline.
      localDifficultyLevel.closest('.stats-line')?.setAttribute('data-difficulty', localLevel);
    }

    this.refreshFindingTotals(findings);

    this.assignCopyableDatum(findingsTotal?.closest('.stat-inline') || findingsTotal, String(aggregateFindings), 'detections');
    this.assignCopyableDatum(overallEvidence?.closest('.stat-inline') || overallEvidence, `${avgEvidence}%`, 'confidence');
    this.assignCopyableDatum(localDifficultyLevel?.closest('.stat-inline') || localDifficultyLevel, difficultyPresent, 'difficulty');
};

FindingsRenderer.refreshFindingTotals = function(findings) {
    const taxonomyCounts = FindingTotals.countDetectionsByCategory(findings);
    const totalNodeTokenByTaxonomy = {
      antibot: 'antibotDetectionCount',
      captcha: 'captchaDetectionCount',
      fingerprint: 'fingerprintDetectionCount',
      other: 'otherDetectionCount'
    };

    for (const [taxonomyLookup, totalNodeToken] of Object.entries(totalNodeTokenByTaxonomy)) {
      const totalNode = document.querySelector(`#${totalNodeToken}`);
      if (totalNode) {
        totalNode.textContent = taxonomyCounts[taxonomyLookup];
      }
    }

    const otherTaxonomySummary = document.querySelector('#otherDetectionCategorySummary');
    if (otherTaxonomySummary) {
      otherTaxonomySummary.hidden = taxonomyCounts.other === 0;
    }
};

FindingsRenderer.refreshAddressPresent = function(choices = {}) {
    const siteSitemark = document.querySelector('#siteFavicon');
    const siteAddress = document.querySelector('#siteUrl');

    if (!siteSitemark || !siteAddress) {
      return;
    }

    // Try to get URL from various sources
    let address = '';
    let sitemark = '';
    const baselineSitemark = WebAddress.resolveBaselineSitemarkAddress();
    const presentSitemark = (candidate, sheetAddress) => {
      siteSitemark.onerror = () => {
        siteSitemark.onerror = null;
        siteSitemark.src = baselineSitemark;
      };
      siteSitemark.src = WebAddress.resolvePresentSitemark(candidate, sheetAddress, 32)
        || baselineSitemark;
    };

    if (choices.cacheMetadata) {
      address = choices.cacheMetadata.url || '';
      sitemark = choices.cacheMetadata.favicon || '';
    }

    // If no URL yet, try to get from current tab
    if (!address) {
      chrome.tabs.query({ active: true, currentWindow: true }, (pages) => {
        if (pages[0]) {
          address = pages[0].url || '';
          sitemark = pages[0].favIconUrl || '';

          // Update display
          if (address) {
            try {
              const addressObj = new URL(address);
              siteAddress.textContent = addressObj.hostname;
              siteAddress.title = address;
              this.assignCopyableDatum(siteAddress, address, 'URL');
            } catch (failure) {
              siteAddress.textContent = address;
              siteAddress.title = address;
              this.assignCopyableDatum(siteAddress, address, 'URL');
            }
          }

          presentSitemark(sitemark, address);
        }
      });
    } else {
      // We have URL from cache metadata
      try {
        const addressObj = new URL(address);
        siteAddress.textContent = addressObj.hostname;
        siteAddress.title = address;
        this.assignCopyableDatum(siteAddress, address, 'URL');
      } catch (failure) {
        siteAddress.textContent = address;
        siteAddress.title = address;
        this.assignCopyableDatum(siteAddress, address, 'URL');
      }

      // Set favicon if available
      if (sitemark) {
        presentSitemark(sitemark, address);
      } else {
        // Try to get favicon from Chrome tab API as fallback
        chrome.tabs.query({ active: true, currentWindow: true }, (pages) => {
          if (pages[0] && pages[0].favIconUrl) {
            presentSitemark(pages[0].favIconUrl, address);
          } else {
            presentSitemark('', address);
          }
        });
      }
    }
};

FindingsRenderer.refreshMemoDetail = function() {
    const memoExpiry = document.querySelector('#cacheExpiry');
    const memoBoundaryPresent = document.querySelector('#memoScopeDisplay');

    if (!memoExpiry) {
      return;
    }

    // Update cache expiry time
    if (this.cacheMetadata && this.cacheMetadata.expiry) {
      const localExpiryDate = new Date(this.cacheMetadata.expiry);
      const localNow = new Date();
      const localDiff = localExpiryDate - localNow;

      if (localDiff > 0) {
        memoExpiry.textContent = this.encodeExpiryRemaining(localDiff);
      } else {
        memoExpiry.textContent = (typeof LocaleRuntime !== 'undefined')
          ? LocaleRuntime.performTr('cacheExpiredLabel', 'Expired')
          : 'Expired';
      }
    } else {
      memoExpiry.textContent = '-';
    }
    this.assignCopyableDatum(memoExpiry.closest('.stat-inline') || memoExpiry, memoExpiry.textContent, 'cache expiration');

    // Update cache scope display
    if (memoBoundaryPresent) {
      const boundaryTr = (lookupKey, localFallback) => (
        typeof LocaleRuntime !== 'undefined' ? LocaleRuntime.performTr(lookupKey, localFallback) : localFallback
      );
      const boundaryPresentNames = {
        'domain': boundaryTr('scopeDomain', 'Domain'),
        'path': boundaryTr('scopePath', 'Path'),
        'full': boundaryTr('scopeFullUrl', 'Full URL')
      };

      if (this.cacheMetadata && this.cacheMetadata.memoScope) {
        // Map scope values to user-friendly display names
        memoBoundaryPresent.textContent = boundaryPresentNames[this.cacheMetadata.memoScope] || boundaryPresentNames.path;
        this.assignCopyableDatum(memoBoundaryPresent.closest('.stat-inline') || memoBoundaryPresent, memoBoundaryPresent.textContent, 'cache scope');
      } else {
        // Fallback: read current setting from storage
        ExtensionGateway.resolvePreferences().then((preferencePane) => {
          const memoBoundary = preferencePane.memoScope || preferencePane.scanning?.memoScope || 'path';

          memoBoundaryPresent.textContent = boundaryPresentNames[memoBoundary] || boundaryPresentNames.path;
          this.assignCopyableDatum(memoBoundaryPresent.closest('.stat-inline') || memoBoundaryPresent, memoBoundaryPresent.textContent, 'cache scope');
        }).catch(() => {});
      }
    }
};

FindingsRenderer.encodeExpiryRemaining = function(localMsRemaining) {
    const localMs = Number(localMsRemaining);
    if (!Number.isFinite(localMs) || localMs <= 0) return 'Expired';

    const LOCAL_MINUTE = 60 * 1000;
    const LOCAL_HOUR = 60 * LOCAL_MINUTE;
    const LOCAL_DAY = 24 * LOCAL_HOUR;
    const LOCAL_MONTH = 30 * LOCAL_DAY; // Approximation is fine for TTL display
    const LOCAL_YEAR = 365 * LOCAL_DAY;

    // Prefer large units when applicable:
    // - >= 1 year: y + mo
    // - >= 1 month: mo + d
    // - >= 1 day: d + h
    // - >= 1 hour: h + m
    // - otherwise: m (or <1m)
    let localRemaining = localMs;

    const localParts = [];
    const localPush = (datum, localLabel) => {
      if (datum > 0) localParts.push(`${datum}${localLabel}`);
    };

    if (localRemaining >= LOCAL_YEAR) {
      const localYears = Math.floor(localRemaining / LOCAL_YEAR);
      localRemaining -= localYears * LOCAL_YEAR;
      localPush(localYears, 'y');

      const localMonths = Math.floor(localRemaining / LOCAL_MONTH);
      localPush(localMonths, 'mo');
      return localParts.length ? localParts.slice(0, 2).join(' ') : '0m';
    }

    if (localRemaining >= LOCAL_MONTH) {
      const localMonths2 = Math.floor(localRemaining / LOCAL_MONTH);
      localRemaining -= localMonths2 * LOCAL_MONTH;
      localPush(localMonths2, 'mo');

      const localDays = Math.floor(localRemaining / LOCAL_DAY);
      localPush(localDays, 'd');
      return localParts.length ? localParts.slice(0, 2).join(' ') : '0m';
    }

    if (localRemaining >= LOCAL_DAY) {
      const localDays2 = Math.floor(localRemaining / LOCAL_DAY);
      localRemaining -= localDays2 * LOCAL_DAY;
      localPush(localDays2, 'd');

      const localHours = Math.floor(localRemaining / LOCAL_HOUR);
      localPush(localHours, 'h');
      return localParts.length ? localParts.slice(0, 2).join(' ') : '0m';
    }

    if (localRemaining >= LOCAL_HOUR) {
      const localHours2 = Math.floor(localRemaining / LOCAL_HOUR);
      localRemaining -= localHours2 * LOCAL_HOUR;
      localPush(localHours2, 'h');

      const localMinutes = Math.floor(localRemaining / LOCAL_MINUTE);
      localPush(localMinutes, 'm');
      return localParts.length ? localParts.slice(0, 2).join(' ') : '0m';
    }

    if (localRemaining < LOCAL_MINUTE) return '<1m';
    const localMinutes2 = Math.floor(localRemaining / LOCAL_MINUTE);
    return `${localMinutes2}m`;
};

FindingsRenderer.assignCopyableDatum = function(node, datum, localLabel = 'value') {
    if (!node) {
      return;
    }

    const copyDatum = String(datum ?? '').trim();
    if (!copyDatum || copyDatum === '-') {
      node.classList.remove('copyable-value');
      node.removeAttribute('data-copy-value');
      node.removeAttribute('data-copy-label');
      node.removeAttribute('role');
      node.removeAttribute('tabindex');
      node.removeAttribute('aria-label');
      return;
    }

    node.classList.add('copyable-value');
    node.dataset.copyValue = copyDatum;
    node.dataset.copyLabel = localLabel;
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', `Copy ${localLabel}`);
    node.title = node.id === 'siteUrl' ? copyDatum : `Copy ${localLabel}: ${copyDatum}`;
};

FindingsRenderer.copyCopyableDatum = async function(node) {
    const datum = node?.dataset?.copyValue;
    if (!datum) {
      return;
    }

    const localCopied = await TextCodec.performCopyToClipboard(datum, {
      notify: true,
      notificationMessage: 'Copied',
      element: null
    });

    if (!localCopied) {
      return;
    }

    node.classList.add('copy-feedback-active');
    if (node._copyFeedbackTimer) {
      clearTimeout(node._copyFeedbackTimer);
    }
    node._copyFeedbackTimer = setTimeout(() => {
      node.classList.remove('copy-feedback-active');
      node._copyFeedbackTimer = null;
    }, 900);
};

FindingsRenderer.routeCopyableDatumClick = function(signal) {
    const signalDestination = signal.target instanceof Element ? signal.target : signal.target?.parentElement;
    const destination = signalDestination?.closest('[data-copy-value]');
    const region = document.querySelector('#detectionResults');
    if (!destination || !region || !region.contains(destination)) {
      return;
    }

    signal.preventDefault();
    signal.stopPropagation();
    this.copyCopyableDatum(destination);
};

FindingsRenderer.routeCopyableDatumLookupDown = function(signal) {
    if (signal.key !== 'Enter' && signal.key !== ' ') {
      return;
    }

    const signalDestination = signal.target instanceof Element ? signal.target : signal.target?.parentElement;
    const destination = signalDestination?.closest('[data-copy-value]');
    const region = document.querySelector('#detectionResults');
    if (!destination || !region || !region.contains(destination)) {
      return;
    }

    signal.preventDefault();
    signal.stopPropagation();
    this.copyCopyableDatum(destination);
};

FindingsRenderer.paintFindingsSheet = function(findings) {
    Telemetry.performUi(`[renderDetectionsPage] Called with ${findings?.length || 0} detections`);
    const outcomesCollection = document.querySelector('#resultsList');
    if (!outcomesCollection) {
      Telemetry.failure('UI', '[renderDetectionsPage] resultsList not found!');
      return;
    }
    Telemetry.performUi('[renderDetectionsPage] resultsList found, rendering...');

    const aggregateEntries = this.pageCursor?.filteredItems?.length ?? findings.length;
    const localShouldUseExpandedLayout = aggregateEntries === 2;
    outcomesCollection.classList.toggle('expanded-results', localShouldUseExpandedLayout);

    // Check if we're displaying only 1 detection result for enhanced styling
    const isSingleOutcome = findings.length === 1;

    // Band and zebra state live across batches, so a batched render produces
    // exactly the same grouping as a single-pass one.
    let bandTaxonomy = null;
    let localRowOrdinal = 0;

    const assembleCardMarkup = (findingsPane, position) => {
      const evidence = findingsPane.confidence || 0;
      let evidenceClass = 'confidence-low';
      if (evidence >= 90) evidenceClass = 'confidence-high';
      else if (evidence >= 70) evidenceClass = 'confidence-medium';

      const ruleGlyph = this.resolveRuleGlyph(findingsPane);
      const ruleLabel = findingsPane.detector?.name || findingsPane.detector || 'Unknown';
      const safeRuleLabel = TextCodec.escapeMarkup(ruleLabel);
      const copyRuleLabel = TextCodec.performEscapeAttr(ruleLabel);
      const copyEvidence = TextCodec.performEscapeAttr(`${evidence}%`);

      // Get category badges
      const taxonomyBadges = this.resolveTaxonomyBadges(findingsPane);

      const globalPosition = this.resolveGlobalScanPosition(findingsPane, position);

      // The Console skin draws the category rail and the confidence bar from
      // these two hooks, so the bar can never disagree with the figure beside it.
      const taxonomyLookup = TextCodec.performEscapeAttr(String(findingsPane.category || 'other').toLowerCase());
      const evidenceWidth = Math.max(0, Math.min(100, Number(evidence) || 0));

      // Console groups findings under a category band and alternates row tone.
      // The tone is an explicit class rather than :nth-child so the bands
      // cannot throw the count off.
      let bandMarkup = '';
      if (taxonomyLookup !== bandTaxonomy) {
        bandTaxonomy = taxonomyLookup;
        const localBandLabel = TextCodec.escapeMarkup(
          findingsPane.category ? String(findingsPane.category) : 'Other'
        );
        bandMarkup = `<div class="detection-band" data-category="${taxonomyLookup}">${localBandLabel}</div>`;
      }
      const localZebraClass = (localRowOrdinal++ % 2) ? 'row-alt' : 'row-base';

      return `
        ${bandMarkup}
        <div class="detection-card ${localZebraClass} ${isSingleOutcome ? 'single-result' : ''}" data-detection-index="${globalPosition}" data-category="${taxonomyLookup}" style="--conf:${evidenceWidth}%">
          <div class="card-header">
            <div class="card-icon-section">
              ${ruleGlyph}
            </div>
            <div class="card-info">
              <h3 class="detector-name copyable-value" data-copy-value="${copyRuleLabel}" data-copy-label="detector name" role="button" tabindex="0" title="Copy detector name: ${copyRuleLabel}">${safeRuleLabel}</h3>
              <div class="category-badges">
                ${taxonomyBadges}
              </div>
            </div>
            <div class="card-actions">
              <span class="confidence-display ${evidenceClass} copyable-value" data-copy-value="${copyEvidence}" data-copy-label="confidence" role="button" tabindex="0" title="Copy confidence: ${copyEvidence}">${evidence}%</span>
              <button class="copy-btn" data-detection-index="${globalPosition}" title="Copy detection details">
                <svg width="14" height="14" viewBox="0 0 24 24">
                  <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      `;
    };

    const commitPaint = () => {
      if (paintToken !== this._detectionsRenderToken) {
        return;
      }

      // Add click handlers for expandable cards
      const localCards = document.querySelectorAll('.detection-card');
      Telemetry.performUi(`[renderDetectionsPage] Found ${localCards.length} detection cards`);

      localCards.forEach(localCard => {
        localCard.addEventListener('click', (failure) => {
          Telemetry.performUi('[renderDetectionsPage] Card clicked');
          if (failure.target.closest('.copy-btn') || failure.target.closest('[data-copy-value]')) {
            return;
          }

          const positionAttr = localCard.getAttribute('data-detection-index');
          const decodedPosition = parseInt(positionAttr, 10);
          Telemetry.performUi('[renderDetectionsPage] Opening modal for index', decodedPosition);
          if (!Number.isNaN(decodedPosition)) {
            this.openScanDialog(decodedPosition);
          }
        });
      });

      // Add click handlers for copy buttons
      document.querySelectorAll('.copy-btn').forEach(localBtn => {
        localBtn.addEventListener('click', (failure) => {
          failure.stopPropagation();
          const position = parseInt(localBtn.getAttribute('data-detection-index'));
          this.copyScan(position, localBtn);
        });
      });
    };

    this._detectionsRenderToken = (this._detectionsRenderToken || 0) + 1;
    const paintToken = this._detectionsRenderToken;

    // Order the page by category so each band covers one contiguous run.
    // Sort is stable, so the existing order survives inside each group, and
    // the modal index is resolved by identity rather than position.
    const taxonomyRank = (findingsPane) => {
      const lookupKey = String(findingsPane?.category || '').toLowerCase();
      const localRank = { antibot: 0, 'anti-bot': 0, waf: 1, captcha: 2 };
      return lookupKey in localRank ? localRank[lookupKey] : 3;
    };
    const localOrdered = [...findings].sort((leftValue, rightValue) => taxonomyRank(leftValue) - taxonomyRank(rightValue));

    const shouldBatchPaint = localOrdered.length > 20;

    if (!shouldBatchPaint) {
      let outcomesMarkup = '';
      localOrdered.forEach((findingsPane, position) => {
        outcomesMarkup += assembleCardMarkup(findingsPane, position);
      });
      outcomesCollection.innerHTML = outcomesMarkup;
      commitPaint();
      return;
    }

    outcomesCollection.innerHTML = '';
    const batchCapacity = 8;
    let localOffset = 0;

    const paintBatch = () => {
      if (paintToken !== this._detectionsRenderToken) {
        return;
      }

      const localSlice = localOrdered.slice(localOffset, localOffset + batchCapacity);
      let batchMarkup = '';
      localSlice.forEach((findingsPane, position) => {
        batchMarkup += assembleCardMarkup(findingsPane, localOffset + position);
      });
      outcomesCollection.insertAdjacentHTML('beforeend', batchMarkup);
      localOffset += batchCapacity;

      if (localOffset < localOrdered.length) {
        requestAnimationFrame(paintBatch);
      } else {
        commitPaint();
      }
    };

    paintBatch();
};

FindingsRenderer.resolveTaxonomyBadges = function(findingsPane) {
    const localBadges = [];

    // Main category badge with dynamic color from storage (muted style)
    if (findingsPane.category) {
      const taxonomyDetail = this.ruleCatalog.resolveTaxonomyDetail(findingsPane.category.toLowerCase());
      const taxonomyPalette = taxonomyDetail?.colour || '#666666';
      const taxonomyLabel = findingsPane.category.charAt(0).toUpperCase() + findingsPane.category.slice(1);
      const safeTaxonomyLabel = TextCodec.escapeMarkup(taxonomyLabel);
      const copyTaxonomyLabel = TextCodec.performEscapeAttr(taxonomyLabel);
      const localRgb = this.performHexToRgb(taxonomyPalette);
      // In the rgb branch categoryColor passed hexToRgb so it is a valid hex.
      // In the fallback branch use a constant — never interpolate an
      // unvalidated color into the style attribute.
      const localBgStyle = localRgb
        ? `background: rgba(${localRgb.r}, ${localRgb.g}, ${localRgb.b}, 0.2); color: ${taxonomyPalette}; border: 1px solid rgba(${localRgb.r}, ${localRgb.g}, ${localRgb.b}, 0.35);`
        : `background: #666666; color: white;`;
      // Tagged so the skin can set the category apart from the method badges:
      // the category qualifies the title, the methods are evidence beneath it.
      localBadges.push(`<span class="badge badge-category copyable-value" style="${localBgStyle}" data-copy-value="${copyTaxonomyLabel}" data-copy-label="category" role="button" tabindex="0" title="Copy category: ${copyTaxonomyLabel}">${safeTaxonomyLabel}</span>`);
    }

    // Add detection method badges based on actual matches (with counts)
    if (findingsPane.signals && findingsPane.signals.length > 0) {
      // Count matches per type instead of just collecting unique types
      const phaseCounts = new Map();
      findingsPane.signals.forEach(hit => {
        if (hit.type) {
          phaseCounts.set(hit.type, (phaseCounts.get(hit.type) || 0) + 1);
        }
      });

    // Convert phase kinds to badges with taxonomy-driven colors.
      phaseCounts.forEach((total, kind) => {
        const kindLabel = kind.toLowerCase();
        const phaseLabel = kindLabel.replace(/_/g, ' ').toUpperCase();
        const presentCopy = total > 1 ? `${phaseLabel} (${total})` : phaseLabel;
        const tagPalette = this.ruleCatalog.resolveTaxonomyCoordinator().resolveTagTone(kindLabel);

        if (tagPalette && tagPalette !== '#666666') {
          // Use muted/transparent background with colored text
          const localRgb = this.performHexToRgb(tagPalette);
          const localBgStyle = localRgb
            ? `background: rgba(${localRgb.r}, ${localRgb.g}, ${localRgb.b}, 0.15); color: ${tagPalette}; border: 1px solid rgba(${localRgb.r}, ${localRgb.g}, ${localRgb.b}, 0.3);`
            : `background: ${tagPalette}; color: white;`;
          const safePresentCopy = TextCodec.escapeMarkup(presentCopy);
          localBadges.push(`<span class="badge" style="${localBgStyle}">${safePresentCopy}</span>`);
        } else {
          // Fallback to CSS class (use typeName for CSS class)
          const phaseClass = `badge-${kindLabel}`;
          const safePresentCopy2 = TextCodec.escapeMarkup(presentCopy);
          localBadges.push(`<span class="badge ${phaseClass}">${safePresentCopy2}</span>`);
        }
      });
    }

    return localBadges.join('');
};

FindingsRenderer.resolvePhaseBadges = function(hits) {
    if (!hits || hits.length === 0) {
      return '<div class="method-item-card">Unknown method</div>';
    }

    // Show all methods as individual cards
    const localBadges = hits.map((hit, position) => {
      let phaseKind = (hit.type || 'unknown').toLowerCase();
      phaseKind = phaseKind.replace(/_/g, ' ').toUpperCase();
      const evidence = hit.confidence || 0;

      // Format the display value based on type
      let presentDatum = '';
      let copyDatum = '';

      const hitKind = (hit.type || '').toLowerCase();

      switch (hitKind) {
        case 'cookie':
        case 'cookies':
          // Show: name=value format if available, otherwise just name
          presentDatum = hit.value || hit.name || 'unknown';
          copyDatum = presentDatum;
          break;

        case 'header':
        case 'headers':
          // Show: name: value format if available, otherwise just name
          presentDatum = hit.value || hit.name || 'unknown';
          copyDatum = presentDatum;
          break;

        case 'content':
        case 'script':
          // Show: pattern first (e.g., "recaptcha"), then value (location)
          presentDatum = hit.pattern || hit.content || hit.value || 'unknown';
          copyDatum = presentDatum;
          break;

        case 'url':
        case 'urls':
          // Show: full URL inline (like cookie format)
          presentDatum = hit.fullUrl || hit.value || hit.pattern || 'unknown';
          copyDatum = presentDatum;
          break;

        case 'dom':
          // Show: selector=text format if available, otherwise just selector
          presentDatum = hit.value || hit.selector || hit.pattern || 'unknown';
          copyDatum = presentDatum;
          break;

        default:
          presentDatum = hit.pattern || hit.name || hit.value || hit.selector || 'unknown';
          copyDatum = presentDatum;
      }

      // Resolve the tag tone using the original phase kind (preserves underscores).
      const tagPalette = this.ruleCatalog.resolveTaxonomyCoordinator().resolveTagTone(hitKind);

      // Use muted/transparent background with colored text
      const effectivePalette = (tagPalette && tagPalette !== '#666666') ? tagPalette : '#666666';
      const localRgb = this.performHexToRgb(effectivePalette);
      const localBadgeStyle = localRgb
        ? `style="background: rgba(${localRgb.r}, ${localRgb.g}, ${localRgb.b}, 0.15); color: ${effectivePalette}; border: 1px solid rgba(${localRgb.r}, ${localRgb.g}, ${localRgb.b}, 0.3);"`
        : `style="background: ${effectivePalette}; color: white; border: none;"`;

      // Confidence badge color
      let evidenceClass = 'confidence-low';
      if (evidence >= 90) evidenceClass = 'confidence-high';
      else if (evidence >= 70) evidenceClass = 'confidence-medium';

      // Normalize method type for CSS class using original matchType (preserves underscores/hyphens)
      // Replace underscores with hyphens for CSS compatibility, then handle plural to singular
      const phaseClass = hitKind.replace(/_/g, '-').replace(/s$/, ''); // js_hooks -> js-hooks, cookies -> cookie

      const encodedDatum = encodeURIComponent(copyDatum);
      const safePresentDatum = TextCodec.escapeMarkup(presentDatum);
      const safeFullDatum = TextCodec.escapeMarkup(copyDatum);

      return `
        <div class="method-item-card method-${phaseClass}" data-copy-value="${encodedDatum}" data-method-type="${phaseKind}" title="Click to copy">
          <span class="method-type-badge" ${localBadgeStyle}>${phaseKind}</span>
          <button type="button" class="method-value-btn" data-copy-target="value" title="${safeFullDatum}">${safePresentDatum}</button>
          <span class="method-confidence ${evidenceClass}">${evidence}%</span>
        </div>
      `;
    });

    return localBadges.join('');
};

FindingsRenderer.resolveFilteredOutcomes = function() {
    if (!this.filterText) return this.findings;

    const localFiltered = this.findings.filter(findingsPane => {
      const label = (findingsPane.detector?.name || findingsPane.detector || '').toLowerCase();
      const taxonomy = (findingsPane.category || '').toLowerCase();
      const localDescription = (findingsPane.detector?.description || '').toLowerCase();

      return label.includes(this.filterText) ||
             taxonomy.includes(this.filterText) ||
             localDescription.includes(this.filterText);
    });

    // Sort filtered results by category priority
    return this.sortFindingsByTaxonomy(localFiltered);
};

FindingsRenderer.sortFindingsByTaxonomy = function(findings) {
    const taxonomyPriority = {
      'antibot': 1,
      'anti-bot': 1,
      'captcha': 2,
      'fingerprint': 3,
      'fingerprinting': 3
    };

    return [...findings].sort((leftValue, rightValue) => {
      const taxonomyA = (leftValue.category || '').toLowerCase();
      const taxonomyB = (rightValue.category || '').toLowerCase();

      const localPriorityA = taxonomyPriority[taxonomyA] || 999;
      const localPriorityB = taxonomyPriority[taxonomyB] || 999;

      // Sort by priority (lower number = higher priority)
      if (localPriorityA !== localPriorityB) {
        return localPriorityA - localPriorityB;
      }

      // If same category, sort by confidence (higher first)
      return (rightValue.confidence || 0) - (leftValue.confidence || 0);
    });
};

FindingsRenderer.routeFilter = function(filter) {
    this.filterText = filter.toLowerCase().trim();

    // Filter items if search query exists
    const entriesToPresent = this.filterText
      ? this.resolveFilteredOutcomes()
      : this.findings;

    // Update pagination with filtered results
    if (this.pageCursor) {
      this.pageCursor.assignEntries(entriesToPresent);
    }
};

FindingsRenderer.resolveRuleGlyph = function(findingsPane) {
    const localEscapeAlt = (copy) => TextCodec.performEscapeAttr(copy || 'Icon');
    const normalizedTaxonomy = String(findingsPane?.category || findingsPane?.detector?.category || '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    const isFingerprintTaxonomy = normalizedTaxonomy === 'fingerprint' || normalizedTaxonomy.includes('fingerprint');


    const localWrapFingerprintImage = (localSrc, localAlt, originKind) => (
      `<div class="detector-icon detector-icon-svg fingerprint-icon fingerprint-icon-shell"><img src="${TextCodec.performEscapeAttr(localSrc)}" alt="${localAlt}" class="detector-icon fingerprint-icon-image fingerprint-icon-image--${originKind}" /></div>`
    );

    // Check for custom uploaded icon first
    if (findingsPane.detector?.customIcon) {
      if (isFingerprintTaxonomy) {
        return localWrapFingerprintImage(findingsPane.detector.customIcon, localEscapeAlt(findingsPane.detector.name), 'custom');
      }
      return `<img src="${TextCodec.performEscapeAttr(findingsPane.detector.customIcon)}" alt="${localEscapeAlt(findingsPane.detector.name)}" class="detector-icon" />`;
    }

    // Try to get real icon from detector data
    if (findingsPane.detector?.icon) {
      if (typeof findingsPane.detector.icon === 'string') {
        const lowerGlyph = findingsPane.detector.icon.toLowerCase();
        if (lowerGlyph === 'default') {
          const consoleGlyph = chrome.runtime.getURL('brand/toolbar-128.png');
          if (isFingerprintTaxonomy) {
            return localWrapFingerprintImage(consoleGlyph, localEscapeAlt(findingsPane.detector.name), 'default');
          }
          return `<img src="${consoleGlyph}" alt="${localEscapeAlt(findingsPane.detector.name)}" class="detector-icon" />`;
        }
        if (lowerGlyph === 'custom' || lowerGlyph === 'custom.png') {
          const consoleGlyph2 = chrome.runtime.getURL('brand/toolbar-128.png');
          if (isFingerprintTaxonomy) {
            return localWrapFingerprintImage(consoleGlyph2, localEscapeAlt(findingsPane.detector.name), 'default');
          }
          return `<img src="${consoleGlyph2}" alt="${localEscapeAlt(findingsPane.detector.name)}" class="detector-icon" />`;
        }

        const fingerprintGlyph = typeof FingerprintGlyphs !== 'undefined'
          ? FingerprintGlyphs.resolve(lowerGlyph)
          : '';
        if (fingerprintGlyph) {
          return `<div class="detector-icon detector-icon-svg fingerprint-icon fingerprint-icon-shell">${fingerprintGlyph}</div>`;
        }

        if (typeof BrandGlyphs !== 'undefined' && BrandGlyphs.performHas(lowerGlyph)) {
          return `<div class="detector-icon detector-icon-svg vendor-icon vendor-icon-shell">${BrandGlyphs.resolve(lowerGlyph)}</div>`;
        }
      }
      // Check if it's an emoji (not a file name)
      if (!findingsPane.detector.icon.includes('.png') &&
          !findingsPane.detector.icon.includes('.jpg') &&
          !findingsPane.detector.icon.includes('.svg') &&
          !findingsPane.detector.icon.includes('http')) {
        // It's an emoji or text — escape before it lands in innerHTML.
        return TextCodec.escapeMarkup(findingsPane.detector.icon);
      }

      // It's a file, build path to icon in detectors/icons folder
      const glyphRoute = chrome.runtime.getURL(`detectors/icons/${findingsPane.detector.icon}`);
      if (isFingerprintTaxonomy) {
        return localWrapFingerprintImage(glyphRoute, localEscapeAlt(findingsPane.detector.name), 'builtin');
      }
      return `<img src="${glyphRoute}" alt="${localEscapeAlt(findingsPane.detector.name)}" class="detector-icon" />`;
    }

    // No icon specified, use default custom.png
    const consoleGlyph3 = chrome.runtime.getURL('brand/toolbar-128.png');
    if (isFingerprintTaxonomy) {
      return localWrapFingerprintImage(consoleGlyph3, localEscapeAlt(findingsPane.detector?.name), 'default');
    }
    return `<img src="${consoleGlyph3}" alt="${localEscapeAlt(findingsPane.detector?.name)}" class="detector-icon" />`;
};

FindingsRenderer.purgeBadgeForEmptySession = async function() {
    try {
      const pages = await chrome.tabs.query({ active: true, currentWindow: true });
      if (pages && pages[0]) {
        await chrome.action.setBadgeText({ text: '', tabId: pages[0].id });
      }
    } catch (failure) {
      // Silently fail if tab no longer exists
    }
};

FindingsRenderer.performHexToRgb = function(localHex) {
    const outcome = localHex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    return outcome ? {
      r: parseInt(outcome[1], 16),
      g: parseInt(outcome[2], 16),
      b: parseInt(outcome[3], 16)
    } : null;
};

FindingsRenderer.resolveDifficultyDetail = function(findings = [], avgEvidence = 0) {
    return FindingMetrics.resolveDifficultyDetail(findings, avgEvidence);
};

if (typeof self !== 'undefined') {
    self.FindingsRenderer = FindingsRenderer;
}
