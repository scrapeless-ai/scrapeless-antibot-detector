
class ScanArchivePresenter {
  constructor(ruleCatalog) {
    this.ruleCatalog = ruleCatalog;
    this.archiveEntries = [];
    this.filterText = '';
    this.started = false;
    this.listenersAttached = false;
    this.pageCursor = null;
    this.archiveCeiling = 0; // 0 = unlimited (matches settings default)
    this.detailDialogTrigger = null;
    this.detailDialogPreviousOverflow = '';
    this.detailDialogInertSiblings = [];
    this.currentArchiveEntry = null;
  }

  /**
   * Display history items from storage
   */
  async presentArchive() {
    Telemetry.performUi('History.displayHistory called');

    // Ensure HTML is loaded
    if (!this.started) {
      await this.start();
    }

    await this.refreshArchiveLimit();

    try {
      await this.readArchiveFromRepository();
      this.paintArchive();
    } catch (failure) {
      Telemetry.performWarn('UI', '[History] Failed to display history', failure);
      this.presentEmptyState();
    }
  }

  /**
   * Load history from Chrome storage
   */
  async readArchiveFromRepository() {
    try {
      const outcome = await chrome.storage.local.get(['scrapeless_history']);

      if (outcome.scrapeless_history) {
        const archivePayload = JSON.parse(outcome.scrapeless_history);
        this.archiveEntries = ExtensionStore.openRecord(archivePayload, 'entries', 'items') || [];
        if (this.archiveCeiling > 0 && this.archiveEntries.length > this.archiveCeiling) {
          this.archiveEntries = this.archiveEntries.slice(0, this.archiveCeiling);
        }
        Telemetry.performUi('Loaded history items:', this.archiveEntries.length);
      } else {
        this.archiveEntries = [];
      }
    } catch (failure) {
      Telemetry.performWarn('UI', '[History] Storage load failed', failure);
      this.archiveEntries = [];
    }
  }

  /**
   * Save history to Chrome storage
   */
  async persistArchiveToRepository() {
    try {
      const archivePayload = ExtensionStore.sealRecord('entries', this.archiveEntries);

      await chrome.storage.local.set({
        'scrapeless_history': JSON.stringify(archivePayload, null, 2)
      });

      Telemetry.performUi('History saved to storage');
    } catch (failure) {
      Telemetry.performWarn('UI', '[History] Storage save failed', failure);
    }
  }

  /**
   * Render history items in the UI
   */
  paintArchive() {
    if (this.archiveEntries.length === 0) {
      this.presentEmptyState();
      return;
    }

    const archiveEmpty = document.querySelector('#historyEmpty');
    if (archiveEmpty) archiveEmpty.style.display = 'none';

    const entriesToPresent = this.filterText
      ? this.resolveFilteredEntries()
      : this.archiveEntries;

    if (this.pageCursor) {
      this.pageCursor.assignEntries(entriesToPresent);
    }

    const archivePaging = document.querySelector('#historyPagination');
    if (archivePaging && entriesToPresent.length > 0) {
      archivePaging.style.display = 'flex';
    }
  }

  /**
   * Render history page items (called by pagination manager)
   * @param {Array} items - History items for current page
   */
  paintArchiveSheet(entries) {
    const archiveCollection = document.querySelector('#historyList');
    if (!archiveCollection) {
      Telemetry.performWarn('UI', '[History] List element not found');
      return;
    }

    archiveCollection.style.display = 'block';

    const assembleArchiveEntryMarkup = (entry) => {
      // The list gutter is 48px wide, so it takes the compact form. The detail
      // modal below still uses the full "x ago", where there is room for it
      // beside the absolute date.
      const momentAgo = this.resolveCompactMomentAgo(new Date(entry.timestamp));
      const localDomain = this.resolveDomainFromAddress(entry.url);
      const localRawTitle = entry.title || 'Untitled';
      const localSafeTitle = TextCodec.escapeMarkup(localRawTitle);
      const localSafeTitleAttribute = TextCodec.performEscapeAttr(localRawTitle);
      const safeAddress = TextCodec.performEscapeAttr(entry.url || '');
      const localSafeDomain = TextCodec.escapeMarkup(localDomain);
      const safeEntryToken = TextCodec.performEscapeAttr(entry.id || '');
      const safeOpenLabel = TextCodec.performEscapeAttr(`Open scan details for ${entry.title || localDomain || 'this page'}`);

      const sitemarkSrc = WebAddress.resolvePresentSitemark(entry.favicon, entry.url || entry.hostname);

      return `
        <div class="history-item" data-history-id="${safeEntryToken}">
          <button type="button" class="history-item-open" aria-label="${safeOpenLabel}"></button>
          <div class="history-item-top">
            <div class="history-item-content">
              <div class="history-header-info">
                <img src="${sitemarkSrc}" alt="" aria-hidden="true" class="history-favicon" data-fallback="${chrome.runtime.getURL('brand/toolbar-16.png')}">
                <div class="history-url" title="${safeAddress}">${localSafeDomain}</div>
              </div>
              <div class="history-title" title="${localSafeTitleAttribute}">${localSafeTitle}</div>
            </div>
            <div class="history-item-right">
              <div class="history-item-actions">
                <button class="history-item-action-btn history-clear-cache-btn" data-action="clear-cache" title="Clear cache" aria-label="Clear cache for this entry">
                  <!-- A broom, not the bin: clear cache sits next to delete and the two must not share a glyph. -->
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19.36,2.72L20.78,4.14L15.06,9.85C16.13,11.39 16.28,13.24 15.38,14.44L9.06,8.12C10.26,7.22 12.11,7.37 13.65,8.44L19.36,2.72M5.93,17.57C3.92,15.56 2.69,13.16 2.35,10.92L7.23,8.83L14.67,16.27L12.58,21.15C10.34,20.81 7.94,19.58 5.93,17.57Z" fill="currentColor"/>
                  </svg>
                </button>
                <button class="history-item-action-btn history-copy-btn" data-action="copy" title="Copy data" aria-label="Copy detection data for this entry">
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" fill="currentColor"/>
                  </svg>
                </button>
                <button class="history-item-action-btn history-export-btn" data-action="export" title="Export item" aria-label="Export this history entry as JSON">
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20M12,19L8,15H10.5V12H13.5V15H16L12,19Z" fill="currentColor"/>
                  </svg>
                </button>
                <button class="history-item-action-btn history-blacklist-btn" data-action="blacklist" title="Add to blacklist" aria-label="Add this domain to the blacklist">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M4.93 4.93l14.14 14.14"/>
                  </svg>
                </button>
                <button class="history-item-action-btn history-delete-btn" data-action="delete" title="Delete item" aria-label="Delete this history entry">
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
          ${this.paintArchiveStats(entry)}
          <div class="history-item-bottom">
            <div class="history-detections">
              ${this.paintArchiveFindings(entry.detections || [], entry.id)}
            </div>
            <div class="history-timestamp">${momentAgo}</div>
          </div>
        </div>
      `;
    };

    const commitPaint = () => {
      if (paintToken !== this._historyRenderToken) {
        return;
      }

      // CSP-compliant image error fallback
      archiveCollection.querySelectorAll('img[data-fallback]').forEach(localImg => {
        localImg.addEventListener('error', function() {
          this.src = this.dataset.fallback;
        }, { once: true });
      });

      // Add click handlers for history items
      this.wireArchiveEntryRoutes();
      this.wireOverflowBadgeRoutes();
    };

    this._historyRenderToken = (this._historyRenderToken || 0) + 1;
    const paintToken = this._historyRenderToken;
    const shouldBatchPaint = entries.length > 40;

    if (!shouldBatchPaint) {
      let archiveMarkup = '';
      entries.forEach(entry => {
        archiveMarkup += assembleArchiveEntryMarkup(entry);
      });
      archiveCollection.innerHTML = archiveMarkup;
      commitPaint();
      return;
    }

    archiveCollection.innerHTML = '';
    const batchCapacity = 10;
    let localOffset = 0;

    const paintBatch = () => {
      if (paintToken !== this._historyRenderToken) {
        return;
      }

      const localSlice = entries.slice(localOffset, localOffset + batchCapacity);
      let batchMarkup = '';
      localSlice.forEach(entry => {
        batchMarkup += assembleArchiveEntryMarkup(entry);
      });
      archiveCollection.insertAdjacentHTML('beforeend', batchMarkup);
      localOffset += batchCapacity;

      if (localOffset < entries.length) {
        requestAnimationFrame(paintBatch);
      } else {
        commitPaint();
      }
    };

    paintBatch();
  }

  /**
   * Render detection tags for a history item
   * @param {Array} detections - Array of detections
   * @returns {string} HTML string for detection tags
   */
  paintArchiveFindings(findings, entryToken) {
    // What you want from a visit while scanning is the shape of what was found
    // — how much of each kind — not which six of twenty detectors happened to
    // fit on one line. Six arbitrary glyphs and a "+7" answered neither
    // question: you could not tell an entry that was all fingerprinting from
    // one guarded by a WAF without opening it.
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;

    if (!findings || findings.length === 0) {
      const localNone = TextCodec.escapeMarkup(localTr('historyNoDetections', 'No detections'));
      return `<span class="history-breakdown-empty">${localNone}</span>`;
    }

    const localBucketOf = (taxonomy) => {
      const localCat = String(taxonomy || '').toLowerCase();
      if (localCat.includes('antibot') || localCat.includes('anti-bot') || localCat.includes('waf')) return 'antibot';
      if (localCat.includes('captcha')) return 'captcha';
      if (localCat.includes('fingerprint')) return 'fingerprint';
      return 'other';
    };

    const localBuckets = [
      { key: 'antibot', i18n: 'categoryAntibot', fallback: 'Anti-Bot' },
      { key: 'captcha', i18n: 'categoryCaptcha', fallback: 'CAPTCHA' },
      { key: 'fingerprint', i18n: 'categoryFingerprint', fallback: 'Fingerprint' },
      { key: 'other', i18n: 'categoryOther', fallback: 'Other' }
    ];

    const localCounts = new Map();
    findings.forEach((findingsPane) => {
      const lookupKey = localBucketOf(findingsPane?.category);
      localCounts.set(lookupKey, (localCounts.get(lookupKey) || 0) + 1);
    });

    return localBuckets
      .filter((localBucket) => localCounts.get(localBucket.key))
      .map((localBucket) => {
        const localLabel = TextCodec.escapeMarkup(localTr(localBucket.i18n, localBucket.fallback));
        return `<span class="history-breakdown-part" data-category="${localBucket.key}">`
          + `<span class="history-breakdown-count">${localCounts.get(localBucket.key)}</span>`
          + `<span class="history-breakdown-label">${localLabel}</span>`
          + `</span>`;
      })
      .join('');
  }

  /**
   * Calculate stats for a history item
   * @param {Array} detections - Array of detections
   * @returns {object} Stats object with totalDetections, avgConfidence, difficulty, difficultyColor
   */
  deriveArchiveStats(findings) {
    const aggregateFindings = findings?.length || 0;

    // Calculate average confidence
    let avgEvidence = 0;
    if (aggregateFindings > 0) {
      const aggregateEvidence = findings.reduce((localSum, localD) => localSum + (localD.confidence || 0), 0);
      avgEvidence = Math.round(aggregateEvidence / aggregateFindings);
    }

    const difficultyDetail = this.resolveDifficultyDetail(findings || [], avgEvidence);
    return { totalDetections: aggregateFindings, avgConfidence: avgEvidence, difficulty: difficultyDetail.difficulty, difficultyColor: difficultyDetail.difficultyColor };
  }

  /**
   * Compute difficulty for a set of detections.
   * Escalates difficulty when multiple Anti-Bot/CAPTCHA detections appear,
   * or when high-tier providers are present (Shape Security, hCaptcha, Arkose Labs).
   * @param {Array} detections
   * @param {number} avgConfidence
   * @returns {{difficulty: string, difficultyColor: string}}
   */
  resolveDifficultyDetail(findings = [], avgEvidence = 0) {
    return FindingMetrics.resolveDifficultyDetail(findings, avgEvidence);
  }

  /**
   * Render stats row for a history item
   * @param {Object} item - History item with detections and memoScope
   * @returns {string} HTML string for stats row
   */
  paintArchiveStats(entry) {
    const findings = entry.detections || [];
    const localStats = this.deriveArchiveStats(findings);

    // Cache scope display names — resolve via i18n so they match the user's locale.
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const boundaryLookupByDatum = {
      'domain': 'scopeDomain',
      'path': 'scopePath',
      'url': 'scopeFullUrl',
      'full': 'scopeFullUrl',
      'full_url': 'scopeFullUrl'
    };
    const boundaryFallback = { 'domain': 'Domain', 'path': 'Path', 'url': 'Full URL', 'full': 'Full URL', 'full_url': 'Full URL' };
    const memoBoundary = String(entry.memoScope || 'domain').toLowerCase();
    const boundaryLookup = boundaryLookupByDatum[memoBoundary] || 'scopeDomain';
    const memoBoundaryPresent = localTr(boundaryLookup, boundaryFallback[memoBoundary] || 'Domain');

    // Translated stat labels (CSS renders them uppercase via text-transform).
    const lblFindings = localTr('statDetections', 'Detections');
    const lblEvidence = localTr('statConfidence', 'Confidence');
    const localLblDifficulty = localTr('statDifficulty', 'Difficulty');
    const lblBoundary = localTr('statCacheScope', 'Scope');

    // Translated difficulty value (Low/Medium/High → localized).
    const difficultyLookupByDatum = { 'Low': 'difficultyLow', 'Medium': 'difficultyMedium', 'High': 'difficultyHigh' };
    const difficultyLookup = difficultyLookupByDatum[localStats.difficulty];
    const difficultyPresent = difficultyLookup ? localTr(difficultyLookup, localStats.difficulty || '') : (localStats.difficulty || '');

    return `
      <div class="history-stats-line" data-difficulty="${String(localStats.difficulty || '').toLowerCase()}">
        <div class="history-stat-inline history-stat-detections">
          <div class="history-stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <div class="history-stat-content">
            <div class="history-stat-label">${lblFindings}</div>
            <div class="history-stat-value">${localStats.totalDetections}</div>
          </div>
        </div>
        <div class="history-stat-inline history-stat-confidence">
          <div class="history-stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div class="history-stat-content">
            <div class="history-stat-label">${lblEvidence}</div>
            <div class="history-stat-value">${localStats.avgConfidence}%</div>
          </div>
        </div>
        <div class="history-stat-inline history-stat-difficulty">
          <div class="history-stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div class="history-stat-content">
            <div class="history-stat-label">${localLblDifficulty}</div>
            <div class="history-stat-value" data-difficulty="${String(localStats.difficulty || '').toLowerCase()}">${difficultyPresent}</div>
          </div>
        </div>
        <div class="history-stat-inline history-stat-cache-scope">
          <div class="history-stat-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M2 12h20"/>
              <path d="M12 2a15 15 0 0 1 0 20" opacity="0.7"/>
              <path d="M12 2a15 15 0 0 0 0 20" opacity="0.7"/>
            </svg>
          </div>
          <div class="history-stat-content">
            <div class="history-stat-label">${lblBoundary}</div>
            <div class="history-stat-value">${memoBoundaryPresent}</div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Setup click handlers for overflow badges
   */
  wireOverflowBadgeRoutes() {
    const localBadges = document.querySelectorAll('.more-detections');
    localBadges.forEach(localBadge => {
      localBadge.addEventListener('click', (failure) => {
        failure.stopPropagation(); // Prevent history item card click
        const archiveEntryToken = localBadge.dataset.historyItemId;
        const entry = this.archiveEntries.find(localH => localH.id === archiveEntryToken);
        if (entry) {
          this.presentArchiveEntryDetails(entry, localBadge);  // Open same modal as card click
        }
      });
    });
  }

  /**
   * Attach click handlers to detection cards in detail modal
   */
  attachDetailDialogClickRoutes() {
    const localCards = document.querySelectorAll('#historyModalContent .history-modal-detection-card.has-methods');

    localCards.forEach(localCard => {
      const localToggle = localCard.querySelector('.history-modal-detection-toggle');
      const detailsToken = localToggle?.getAttribute('aria-controls');
      const localDetails = detailsToken
        ? document.getElementById(detailsToken)
        : localCard.querySelector('.history-modal-detection-details');

      if (!localToggle || !localDetails) return;

      localToggle.addEventListener('click', () => {
        const localIsExpanded = localToggle.getAttribute('aria-expanded') === 'true';
        localToggle.setAttribute('aria-expanded', String(!localIsExpanded));
        localDetails.hidden = localIsExpanded;
        if (localIsExpanded) {
          localCard.classList.remove('expanded');
        } else {
          localCard.classList.add('expanded');
        }
      });
    });
  }

  /**
   * Show empty state when no history items exist
   */
  presentEmptyState() {
    const archiveCollection = document.querySelector('#historyList');
    const archiveEmpty = document.querySelector('#historyEmpty');
    const archivePaging = document.querySelector('#historyPagination');

    if (archiveCollection) archiveCollection.style.display = 'none';
    if (archiveEmpty) archiveEmpty.style.display = 'flex';
    if (archivePaging) archivePaging.style.display = 'none';
  }

  /**
   * Clear all history items
   */
  async purgeArchive() {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;
    try {
      this.archiveEntries = [];
      await chrome.storage.local.remove(['scrapeless_history']);
      this.presentEmptyState();
      Telemetry.performUi('History cleared');
      Toasts.completion(localTr('notificationHistoryCleared', 'History cleared'));
    } catch (failure) {
      Telemetry.performWarn('UI', '[History] Clear failed', failure);
      Toasts.failure(localFmt('notificationClearHistoryFailedFmt', 'Failed to clear history: ' + failure.message, failure.message));
    }
  }

  /**
   * Handle search functionality
   * @param {string} query - Search query
   */
  routeFilter(filter) {
    this.filterText = filter.toLowerCase().trim();
    this.paintArchive();
  }

  /**
   * Get filtered history items based on search query
   * @returns {Array} Filtered history items
   */
  resolveFilteredEntries() {
    if (!this.filterText) return this.archiveEntries;

    return this.archiveEntries.filter(entry => {
      const address = (entry.url || '').toLowerCase();
      const localTitle = (entry.title || '').toLowerCase();
      const scanNames = (entry.detections || [])
        .map(localD => (localD.detector?.name || localD.detector || '').toLowerCase())
        .join(' ');

      return address.includes(this.filterText) ||
             localTitle.includes(this.filterText) ||
             scanNames.includes(this.filterText);
    });
  }

  /**
   * Setup click handlers for history items
   */
  wireArchiveEntryRoutes() {
    // Handle action button clicks (clear cache/copy/export/blacklist/delete)
    document.querySelectorAll('.history-item-action-btn').forEach(localBtn => {
      localBtn.addEventListener('click', (failure) => {
        failure.stopPropagation();
        const localAction = failure.currentTarget.dataset.action;
        const archiveEntry = failure.currentTarget.closest('.history-item');
        const archiveToken = archiveEntry.dataset.historyId;
        const entry = this.archiveEntries.find(localH => localH.id === archiveToken);

        if (!entry) return;

        if (localAction === 'clear-cache') {
          this.purgeArchiveEntryMemo(entry);
        } else if (localAction === 'copy') {
          this.copyArchiveEntry(entry);
        } else if (localAction === 'export') {
          this.exportArchiveEntry(entry);
        } else if (localAction === 'blacklist') {
          this.addArchiveEntryToBlacklist(entry);
        } else if (localAction === 'delete') {
          this.deleteArchiveEntry(entry);
        }
      });
    });

    // Keep the row opener separate from its adjacent action buttons so both
    // remain valid native controls with independent keyboard focus.
    document.querySelectorAll('.history-item-open').forEach(localOpener => {
      localOpener.addEventListener('click', (failure) => {
        const archiveToken = failure.currentTarget.closest('.history-item')?.dataset.historyId;
        const archiveEntry = this.archiveEntries.find(localH => localH.id === archiveToken);

        if (archiveEntry) {
          this.presentArchiveEntryDetails(archiveEntry, failure.currentTarget);
        }
      });
    });
  }

  /**
   * Show detailed view of a history item
   * @param {object} historyItem - History item object
   */
  presentArchiveEntryDetails(archiveEntry, invoker = document.activeElement) {
    Telemetry.performUi('Showing details for history item:', archiveEntry);

    const dialog = document.querySelector('#historyDetailModal');
    if (!dialog) {
      Telemetry.performWarn('UI', '[History] Detail modal not found');
      return;
    }

    // Populate modal header
    const sitemark = document.querySelector('#historyModalFavicon');
    const localTitle = document.querySelector('#historyModalTitle');
    const address = document.querySelector('#historyModalUrl');
    const localTimestamp = document.querySelector('#historyModalTimestamp');
    const dialogStats = document.querySelector('#historyModalStats');
    const localContent = document.querySelector('#historyModalContent');
    const localResultCount = document.querySelector('#historyModalResultCount');
    const localFooterCount = document.querySelector('#historyModalFooterCount');

    this.currentArchiveEntry = archiveEntry;
    this.detailDialogTrigger = invoker;

    if (sitemark) {
      const sitemarkAddress = WebAddress.resolvePresentSitemark(archiveEntry.favicon, archiveEntry.url || archiveEntry.hostname);
      sitemark.src = sitemarkAddress;
      sitemark.onerror = () => {
        sitemark.src = chrome.runtime.getURL('brand/toolbar-16.png');
      };
    }
    if (localTitle) localTitle.textContent = archiveEntry.title || 'Untitled';
    if (address) {
      const localRawAddress = typeof archiveEntry.url === 'string' ? archiveEntry.url.trim() : '';
      const localSafeAddress = this.resolveSafeArchiveAddress(localRawAddress);
      address.textContent = localRawAddress || archiveEntry.hostname || 'Unknown address';
      if (localSafeAddress) {
        address.href = localSafeAddress;
        address.removeAttribute('aria-disabled');
        address.tabIndex = 0;
      } else {
        address.removeAttribute('href');
        address.setAttribute('aria-disabled', 'true');
        address.tabIndex = -1;
      }
    }
    if (localTimestamp) {
      const momentAgo = this.resolveMomentAgo(new Date(archiveEntry.timestamp));
      const localFullDate = new Date(archiveEntry.timestamp).toLocaleString();
      localTimestamp.innerHTML = `<span class="time-ago">${TextCodec.escapeMarkup(momentAgo)}</span><span class="time-full">(${TextCodec.escapeMarkup(localFullDate)})</span>`;
    }
    if (dialogStats) {
      dialogStats.innerHTML = this.paintArchiveStats(archiveEntry);
    }

    // Render detections in modal
    if (localContent) {
      localContent.innerHTML = this.paintScanDetails(archiveEntry.detections || []);
      localContent.scrollTop = 0;
    }
    const aggregateFindings = archiveEntry.detections?.length || 0;
    if (localResultCount) localResultCount.textContent = String(aggregateFindings);
    if (localFooterCount) localFooterCount.textContent = String(aggregateFindings);

    this.attachDetailDialogClickRoutes();

    // Show modal
    this.detailDialogPreviousOverflow = document.body.style.overflow;
    dialog.style.display = 'flex';
    dialog.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    this.detailDialogInertSiblings = Array.from(dialog.parentElement?.children || [])
      .filter((localSibling) => localSibling !== dialog)
      .map((localSibling) => ({ localSibling, wasInert: Boolean(localSibling.inert) }));
    this.detailDialogInertSiblings.forEach(({ localSibling }) => {
      localSibling.inert = true;
    });

    // Setup close handlers
    this.wireDialogCloseRoutes();

    // Setup copy handlers for individual method items
    this.wirePhaseCopyRoutes();

    document.querySelector('#historyModalClose')?.focus();
  }

  /**
   * Copy history item data to clipboard
   * @param {object} historyItem - History item to copy
   */
  async copyArchiveEntry(archiveEntry) {
    const detailsCopy = this.encodeArchiveEntryCopy(archiveEntry);
    await TextCodec.performCopyToClipboard(detailsCopy);
  }

  /**
   * Format history item as text
   * @param {object} historyItem - History item
   * @returns {string} Formatted text
   */
  encodeArchiveEntryCopy(archiveEntry, includeMoments = true) {
    let copy = `URL: ${archiveEntry.url}\n`;
    copy += `Title: ${archiveEntry.title || 'Untitled'}\n`;
    if (includeMoments) {
      copy += `Timestamp: ${new Date(archiveEntry.timestamp).toLocaleString()}\n`;
    }
    copy += `\nDetections (${archiveEntry.detections?.length || 0}):\n`;
    copy += '─'.repeat(50) + '\n\n';

    (archiveEntry.detections || []).forEach((findingsPane, position) => {
      const label = findingsPane.detector?.name || findingsPane.detector || 'Unknown';
      const taxonomy = findingsPane.category || '';
      const evidence = findingsPane.confidence || 0;

      copy += `${position + 1}. ${label}\n`;
      copy += `   Category: ${taxonomy}\n`;
      copy += `   Confidence: ${evidence}%\n`;

      if (findingsPane.signals && findingsPane.signals.length > 0) {
        copy += `   Detection Methods:\n`;
        findingsPane.signals.forEach(hit => {
          const phaseKind = (hit.type || 'unknown').replace(/_/g, ' ').toUpperCase();
          const datum = hit.fullUrl || hit.value || hit.name || hit.selector || hit.pattern || 'unknown';
          copy += `     - ${phaseKind}: ${datum} (${hit.confidence || 0}%)\n`;
        });
      }
      copy += '\n';
    });

    return copy;
  }

  /**
   * Export single history item to JSON file
   * @param {object} historyItem - History item to export
   */
  async exportArchiveEntry(archiveEntry) {
    const archivePreferences = await ExtensionGateway.resolveArchivePreferences();
    const encoded = this.encodeArchiveExport(
      [archiveEntry],
      archivePreferences?.exportEncoding,
      archivePreferences?.includeMoments ?? true
    );

    const localBlob = new Blob([encoded.body], { type: encoded.mediaType });

    const address = URL.createObjectURL(localBlob);
    const leftValue = document.createElement('a');
    const localDomain = this.resolveDomainFromAddress(archiveEntry.url);
    const localTimestamp = new Date(archiveEntry.timestamp).toISOString().split('T')[0];
    leftValue.href = address;
    leftValue.download = `scrapeless-history-${localDomain}-${localTimestamp}.${encoded.extension}`;
    leftValue.click();

    URL.revokeObjectURL(address);
    const localT1 = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    Toasts.completion((localT1 && localT1.resolve('notificationHistoryItemExported')) || 'History item exported');
  }

  /**
   * Clear cached detection data for a history item URL while keeping the entry.
   * @param {Object} historyItem - History item whose cache should be cleared
   */
  async purgeArchiveEntryMemo(archiveEntry) {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;
    try {
      const localDomain = this.resolveDomainFromAddress(archiveEntry.url);
      const localConfirmed = await Toasts.performConfirm({
        title: localTr('dialogClearCacheTitle', 'Clear Cache'),
        message: localFmt('dialogClearCacheMessageFmt', `Clear cached detection data for ${localDomain}? The history entry will be kept.`, localDomain),
        type: 'warning',
        confirmText: localTr('buttonClearCache', 'Clear Cache'),
        cancelText: localTr('btnCancel', 'Cancel'),
        emphasizeAction: true
      });

      if (!localConfirmed) return;

      const unprocessedBoundary = String(archiveEntry.memoScope || 'domain').toLowerCase();
      const mappedBoundary = unprocessedBoundary === 'url' ? 'full' : unprocessedBoundary;
      const memoBoundary = ['domain', 'path', 'full'].includes(mappedBoundary) ? mappedBoundary : 'domain';

      const inbound = {
        type: 'ARCHIVE_PURGE_MEMO',
        url: archiveEntry.url,
        memoScope: memoBoundary
      };

      const pages = await chrome.tabs.query({ active: true, currentWindow: true });
      const runningPage = pages[0];
      if (runningPage && typeof runningPage.id === 'number' && runningPage.url) {
        const runningHash = WebAddress.hashAddress(runningPage.url, memoBoundary);
        const destinationHash = WebAddress.hashAddress(archiveEntry.url, memoBoundary);
        if (runningHash === destinationHash) {
          inbound.tabId = runningPage.id;
        }
      }

      const reply = await chrome.runtime.sendMessage(inbound);

      if (reply?.status === 'cleared') {
        Toasts.completion(localTr('notificationCacheCleared', 'Cache cleared'));
      } else if (reply?.status === 'not_found') {
        Toasts.detail(localTr('notificationCacheAlreadyCleared', 'Cache already cleared'));
      } else {
        Toasts.failure(localTr('notificationClearCacheFailed', 'Failed to clear cache'));
      }
    } catch (failure) {
      Telemetry.performWarn('UI', '[History] Cache clear failed', failure);
      Toasts.failure(localTr('notificationClearCacheFailed', 'Failed to clear cache'));
    }
  }

  /**
   * Add the history item's domain to blacklist.
   * @param {Object} historyItem - History item whose domain should be blacklisted
   */
  async addArchiveEntryToBlacklist(archiveEntry) {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;
    try {
      if (!archiveEntry?.url) {
        Toasts.failure(localTr('invalidUrl', 'Invalid URL'));
        return;
      }

      const localDomain = this.resolveDomainFromAddress(archiveEntry.url);
      if (!localDomain || localDomain === 'Unknown') {
        Toasts.failure(localTr('invalidDomain', 'Invalid domain'));
        return;
      }

      const localConfirmed = await Toasts.performConfirm({
        title: localTr('addBlacklistTitle', 'Add to Blacklist'),
        message: localFmt('addBlacklistMsgFmt', `Domain "${localDomain}" will be excluded from all future detections. You can remove it later in Settings.`, localDomain),
        confirmText: localTr('addBlacklistBtn', 'Add to Blacklist'),
        cancelText: localTr('btnCancel', 'Cancel'),
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
        Toasts.detail(localFmt('alreadyBlacklistedFmt', `Domain "${localDomain}" is already blacklisted`, localDomain));
        return;
      }

      preferencePane.scanning.skippedDomains.push(localDomain);
      const persisted = typeof ExtensionStore !== 'undefined' && typeof ExtensionStore.persistPreferences === 'function'
        ? await ExtensionStore.persistPreferences(preferencePane)
        : false;
      if (!persisted) {
        throw new Error('Failed to save settings');
      }

      Toasts.completion(localFmt('notificationDomainBlacklistedFmt', `Added "${localDomain}" to blacklist`, localDomain));
    } catch (failure) {
      Telemetry.performWarn('UI', '[History] Blacklist add failed', failure);
      Toasts.failure(localTr('notificationBlacklistFailed', 'Failed to add to blacklist'));
    }
  }

  /**
   * Delete a single history item
   * @param {Object} historyItem - History item to delete
   */
  async deleteArchiveEntry(archiveEntry) {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;
    try {
      const localDomain = this.resolveDomainFromAddress(archiveEntry.url);
      const localConfirmed = await Toasts.performConfirm({
        title: localTr('dialogDeleteHistoryTitle', 'Delete History Item'),
        message: localFmt('dialogDeleteHistoryMessageFmt', `Are you sure you want to delete this detection from ${localDomain}?`, localDomain),
        type: 'danger',
        confirmText: localTr('btnDelete', 'Delete'),
        cancelText: localTr('btnCancel', 'Cancel'),
        emphasizeAction: true
      });

      if (!localConfirmed) return;

      // Remove from array
      const position = this.archiveEntries.findIndex(localH => localH.id === archiveEntry.id);
      if (position > -1) {
        this.archiveEntries.splice(position, 1);

        // Save updated history to storage
        const archivePayload = ExtensionStore.sealRecord('entries', this.archiveEntries);
        await chrome.storage.local.set({
          'scrapeless_history': JSON.stringify(archivePayload)
        });

        // Re-render the history
        this.paintArchive();

        Toasts.completion(localTr('notificationHistoryItemDeleted', 'History item deleted'));
        Telemetry.performUi('History: Item deleted successfully');
      }
    } catch (failure) {
      Telemetry.performWarn('UI', '[History] Delete failed', failure);
      Toasts.failure(localTr('notificationDeleteHistoryItemFailed', 'Failed to delete history item'));
    }
  }

  /**
   * Render detection details for modal
   * @param {Array} detections - Array of detection objects
   * @returns {string} HTML string
   */
  paintScanDetails(findings) {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;
    if (!findings || findings.length === 0) {
      return `<div class="history-modal-empty">${localTr('historyNoDetectionsFound', 'No detections found')}</div>`;
    }

    const taxonomyConfiguration = {
      antibot: { lookup: 'categoryAntibot', fallback: 'Anti-Bot' },
      captcha: { lookup: 'categoryCaptcha', fallback: 'Captcha' },
      fingerprint: { lookup: 'categoryFingerprint', fallback: 'Fingerprint' },
      other: { lookup: 'categoryOther', fallback: 'Other' }
    };
    const taxonomyOrder = ['antibot', 'captcha', 'fingerprint', 'other'];
    const normalizeTaxonomy = (taxonomy) => {
      const localTaxonomy = String(taxonomy || '').toLowerCase().replace(/[^a-z]/g, '');
      if (localTaxonomy === 'antibot' || localTaxonomy === 'waf') return 'antibot';
      if (localTaxonomy === 'captcha') return 'captcha';
      if (localTaxonomy.includes('fingerprint')) return 'fingerprint';
      return 'other';
    };
    const groupedFindings = new Map(taxonomyOrder.map((taxonomy) => [taxonomy, []]));
    findings.forEach((finding, sourcePosition) => {
      groupedFindings.get(normalizeTaxonomy(finding.category)).push({ finding, sourcePosition });
    });

    const paintFinding = ({ finding: findingsPane, sourcePosition }, normalizedTaxonomy) => {
      const label = findingsPane.detector?.name || findingsPane.detector || localTr('unknownDetection', 'Unknown');
      const safeLabel = TextCodec.escapeMarkup(label);
      const taxonomy = findingsPane.category || normalizedTaxonomy;
      const taxonomyConfig = taxonomyConfiguration[normalizedTaxonomy];
      const translatedTaxonomy = localTr(taxonomyConfig.lookup, taxonomyConfig.fallback);
      const safeTaxonomy = TextCodec.escapeMarkup(translatedTaxonomy);
      const evidence = Math.max(0, Math.min(100, Number(findingsPane.confidence) || 0));
      const hasPhases = Array.isArray(findingsPane.signals) && findingsPane.signals.length > 0;

      let ruleObj = null;
      if (this.ruleCatalog && taxonomy && label !== 'Unknown') {
        ruleObj = this.ruleCatalog.resolveRuleByLabel(taxonomy, label);
      }
      const isFingerprintTaxonomy = normalizedTaxonomy === 'fingerprint';

      let ruleGlyphMarkup = '';
      if (ruleObj && ruleObj.icon) {
        const glyphLabel = ruleObj.icon.toLowerCase();
        const fingerprintGlyph = typeof FingerprintGlyphs !== 'undefined'
          ? FingerprintGlyphs.resolve(glyphLabel)
          : '';
        if (fingerprintGlyph) {
          ruleGlyphMarkup = `<div class="modal-detector-icon-svg fingerprint-icon fingerprint-icon-shell" aria-hidden="true">${fingerprintGlyph}</div>`;
        } else if (typeof BrandGlyphs !== 'undefined' && BrandGlyphs.performHas(glyphLabel)) {
          ruleGlyphMarkup = `<div class="modal-detector-icon-svg vendor-icon vendor-icon-shell" aria-hidden="true">${BrandGlyphs.resolve(glyphLabel)}</div>`;
        } else {
          const glyphAddress = chrome.runtime.getURL(`detectors/icons/${ruleObj.icon}`);
          if (isFingerprintTaxonomy) {
            ruleGlyphMarkup = `<div class="modal-detector-icon-svg fingerprint-icon fingerprint-icon-shell" aria-hidden="true"><img src="${glyphAddress}" alt="" class="fingerprint-icon-image fingerprint-icon-image--builtin history-modal-fingerprint-image"></div>`;
          } else {
            ruleGlyphMarkup = `<img src="${glyphAddress}" alt="" aria-hidden="true" class="modal-detector-icon">`;
          }
        }
      } else {
        const consoleGlyphAddress = chrome.runtime.getURL('brand/toolbar-32.png');
        if (isFingerprintTaxonomy) {
          ruleGlyphMarkup = `<div class="modal-detector-icon-svg fingerprint-icon fingerprint-icon-shell" aria-hidden="true"><img src="${consoleGlyphAddress}" alt="" class="fingerprint-icon-image fingerprint-icon-image--default history-modal-fingerprint-image"></div>`;
        } else {
          ruleGlyphMarkup = `<img src="${consoleGlyphAddress}" alt="" aria-hidden="true" class="modal-detector-icon">`;
        }
      }

      let evidenceClass = 'confidence-low';
      if (evidence >= 90) evidenceClass = 'confidence-high';
      else if (evidence >= 70) evidenceClass = 'confidence-medium';

      const phasesMarkup = this.paintScanPhases(findingsPane.signals || []);
      const hitTotal = findingsPane.signals?.length || 0;
      const phaseKindBadges = this.paintPhaseKindBadges(findingsPane.signals || []);
      const matchCount = hitTotal === 1
        ? localTr('historyOneMatch', '1 match')
        : localFmt('historyMatchCountFmt', `${hitTotal} matches`, hitTotal);
      const toggleToken = `historyDetectionToggle-${sourcePosition}`;
      const detailsToken = `historyDetectionDetails-${sourcePosition}`;
      const confidenceLabel = TextCodec.performEscapeAttr(`${localTr('statConfidence', 'Confidence')}: ${evidence}%`);

      const rowContents = `
        ${ruleGlyphMarkup}
        <span class="history-modal-detection-content">
          <span class="history-modal-detection-name">${safeLabel}</span>
          <span class="history-modal-detection-summary">
            <span>${safeTaxonomy}</span>
            <span aria-hidden="true">·</span>
            <span>${TextCodec.escapeMarkup(matchCount)}</span>
          </span>
        </span>
        <span class="history-modal-detection-right">
          <span class="history-modal-confidence ${evidenceClass}" aria-label="${confidenceLabel}">${evidence}%</span>
          <span class="history-modal-confidence-meter" aria-hidden="true"><span style="width: ${evidence}%"></span></span>
          ${hasPhases ? '<span class="history-modal-expand-icon" aria-hidden="true">⌄</span>' : ''}
        </span>
      `;

      return `
        <div class="history-modal-detection-card ${hasPhases ? 'has-methods' : ''}" data-category="${normalizedTaxonomy}" data-detection-index="${sourcePosition}" role="listitem">
          ${hasPhases
            ? `<button type="button" class="history-modal-detection-toggle" id="${toggleToken}" aria-expanded="false" aria-controls="${detailsToken}">${rowContents}</button>`
            : `<div class="history-modal-detection-toggle history-modal-detection-toggle--static">${rowContents}</div>`}
          ${hasPhases ? `
            <div id="${detailsToken}" class="history-modal-detection-details" role="region" aria-labelledby="${toggleToken}" hidden>
              <div class="history-modal-detection-meta">
                <span class="history-modal-badge">${safeTaxonomy}</span>
                ${phaseKindBadges ? `<span class="history-modal-method-types">${phaseKindBadges}</span>` : ''}
                <span class="history-modal-match-count">${TextCodec.escapeMarkup(matchCount)}</span>
              </div>
              <div class="history-modal-detection-methods">
                ${phasesMarkup}
              </div>
            </div>
          ` : ''}
        </div>
      `;
    };

    return taxonomyOrder.map((normalizedTaxonomy) => {
      const groupFindings = groupedFindings.get(normalizedTaxonomy);
      if (!groupFindings.length) return '';
      const taxonomyConfig = taxonomyConfiguration[normalizedTaxonomy];
      const taxonomyLabel = TextCodec.escapeMarkup(localTr(taxonomyConfig.lookup, taxonomyConfig.fallback));
      const groupHeadingToken = `historyDetectionGroup-${normalizedTaxonomy}`;
      return `
        <section class="history-modal-group" data-category="${normalizedTaxonomy}" aria-labelledby="${groupHeadingToken}">
          <div class="history-modal-group-header">
            <span class="history-modal-group-rail" aria-hidden="true"></span>
            <h5 id="${groupHeadingToken}">${taxonomyLabel}</h5>
            <span class="history-modal-group-count" aria-hidden="true">${groupFindings.length}</span>
          </div>
          <div class="history-modal-group-list" role="list">
            ${groupFindings.map((entry) => paintFinding(entry, normalizedTaxonomy)).join('')}
          </div>
        </section>
      `;
    }).join('');
  }

  /**
   * Get unique method types from matches
   * @param {Array} matches - Array of match objects
   * @returns {Array} Array of unique method type keys (lowercase)
   */
  resolveUniquePhaseTypes(hits) {
    if (!hits || hits.length === 0) return [];
    const localTypes = [];
    const localSeen = new Set();
    hits.forEach((hit) => {
      const kindLookup = String(hit.type || 'unknown').toLowerCase();
      if (!localSeen.has(kindLookup)) {
        localSeen.add(kindLookup);
        localTypes.push(kindLookup);
      }
    });
    return localTypes;
  }

  /**
   * Render method type badges for modal meta row
   * @param {Array} matches - Array of match objects
   * @returns {string} HTML string
   */
  paintPhaseKindBadges(hits) {
    const kindLookups = this.resolveUniquePhaseTypes(hits);
    if (!kindLookups.length) return '';

    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const phaseLabelLookup = {
      url: 'methodLabelUrl', header: 'methodLabelHeader', cookie: 'methodLabelCookie',
      content: 'methodLabelContent', dom: 'methodLabelDom', js_hooks: 'methodLabelJsHooks',
      window: 'methodLabelWindow', payload: 'methodLabelPayload'
    };

    const localVisibleTypes = kindLookups.slice(0, 4);
    const overflowTotal = kindLookups.length - localVisibleTypes.length;

    const badgesMarkup = localVisibleTypes.map(kindLookup => {
      const localFallbackLabel = kindLookup.replace(/_/g, ' ').toUpperCase();
      const localLabel = phaseLabelLookup[kindLookup] ? localTr(phaseLabelLookup[kindLookup], localFallbackLabel) : localFallbackLabel;

      // Get tag color (use original key for lookup)
      let tagPalette = '#666666';
      const taxonomyCoordinator = this.ruleCatalog?.resolveTaxonomyCoordinator?.();
      if (taxonomyCoordinator) {
        tagPalette = taxonomyCoordinator.resolveTagTone(kindLookup) || '#666666';
      }
      const localTagRgb = this.performHexToRgb(tagPalette);
      const localBadgeStyle = localTagRgb
        ? `background: rgba(${localTagRgb.r}, ${localTagRgb.g}, ${localTagRgb.b}, 0.18); color: ${tagPalette}; border: 1px solid rgba(${localTagRgb.r}, ${localTagRgb.g}, ${localTagRgb.b}, 0.35);`
        : 'background: #666666; color: white; border: 1px solid #777777;';

      return `<span class="history-modal-method-type-badge" style="${localBadgeStyle}">${TextCodec.escapeMarkup(localLabel)}</span>`;
    }).join('');

    const overflowMarkup = overflowTotal > 0
      ? `<span class="history-modal-method-type-badge history-modal-method-type-overflow">+${overflowTotal}</span>`
      : '';

    return badgesMarkup + overflowMarkup;
  }

  /**
   * Render detection methods for modal
   * @param {Array} matches - Array of match objects
   * @returns {string} HTML string
   */
  paintScanPhases(hits) {
    if (!hits || hits.length === 0) {
      return '<div class="history-modal-no-methods">No detection methods</div>';
    }

    return hits.map(hit => {
      const priorKind = String(hit.type || 'unknown');
      const phaseKind = priorKind.replace(/_/g, ' ').toUpperCase();
      const safePhaseKind = TextCodec.escapeMarkup(phaseKind);
      const evidence = Math.max(0, Math.min(100, Number(hit.confidence) || 0));

      // Determine display value based on method type
      let presentDatum = '';
      switch (priorKind.toLowerCase()) {
        case 'cookie':
        case 'cookies':
          presentDatum = hit.value || hit.name || 'unknown';
          break;
        case 'header':
        case 'headers':
          presentDatum = hit.value || hit.name || 'unknown';
          break;
        case 'content':
        case 'script':
          presentDatum = hit.content || hit.value || hit.pattern || 'unknown';
          break;
        case 'url':
        case 'urls':
          presentDatum = hit.fullUrl || hit.value || hit.pattern || 'unknown';
          break;
        case 'dom':
          presentDatum = hit.value || hit.selector || hit.pattern || 'unknown';
          break;
        default:
          presentDatum = hit.value || hit.name || hit.selector || hit.pattern || 'unknown';
      }

      // Get tag color (use originalType to preserve underscores for lookup)
      let tagPalette = '#666666';
      const taxonomyCoordinator = this.ruleCatalog?.resolveTaxonomyCoordinator?.();
      if (taxonomyCoordinator) {
        tagPalette = taxonomyCoordinator.resolveTagTone(priorKind.toLowerCase()) || '#666666';
      }
      const localTagRgb = this.performHexToRgb(tagPalette);
      const localBadgeStyle = localTagRgb
        ? `background: rgba(${localTagRgb.r}, ${localTagRgb.g}, ${localTagRgb.b}, 0.15); color: ${tagPalette}; border: 1px solid rgba(${localTagRgb.r}, ${localTagRgb.g}, ${localTagRgb.b}, 0.3);`
        : 'background: #666666; color: white; border: 1px solid #777777;';

      // Confidence class
      let evidenceClass = 'confidence-low';
      if (evidence >= 90) evidenceClass = 'confidence-high';
      else if (evidence >= 70) evidenceClass = 'confidence-medium';

      const localCopyPayload = JSON.stringify({
        rawValue: presentDatum,
        methodType: phaseKind,
        confidence: evidence
      });

      const safePresentDatum = TextCodec.escapeMarkup(presentDatum);
      const safeCopyLabel = TextCodec.performEscapeAttr(`Copy ${phaseKind} evidence at ${evidence}% confidence`);

      return `
        <button type="button" class="history-modal-method-item" data-copy-payload="${encodeURIComponent(localCopyPayload)}" title="Click to copy" aria-label="${safeCopyLabel}">
          <span class="history-modal-method-badge" style="${localBadgeStyle}">${safePhaseKind}</span>
          <span class="history-modal-method-value">${safePresentDatum}</span>
          <span class="history-modal-method-confidence ${evidenceClass}">${evidence}%</span>
        </button>
      `;
    }).join('');
  }

  /**
   * Close the history detail dialog and restore the page state it replaced.
   */
  closeArchiveEntryDetails() {
    const dialog = document.querySelector('#historyDetailModal');
    if (!dialog) return;

    dialog.style.display = 'none';
    dialog.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = this.detailDialogPreviousOverflow;

    this.detailDialogInertSiblings.forEach(({ localSibling, wasInert }) => {
      localSibling.inert = wasInert;
    });
    this.detailDialogInertSiblings = [];

    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
      this.escHandler = null;
    }

    const localTrigger = this.detailDialogTrigger;
    this.detailDialogTrigger = null;
    this.currentArchiveEntry = null;
    if (localTrigger && localTrigger.isConnected !== false && typeof localTrigger.focus === 'function') {
      localTrigger.focus();
    } else {
      document.querySelector('[data-tab="history"]')?.focus();
    }
  }

  /**
   * Setup modal close and keyboard-containment handlers.
   */
  wireDialogCloseRoutes() {
    const dialog = document.querySelector('#historyDetailModal');
    const localCloseBtn = document.querySelector('#historyModalClose');
    const localDoneBtn = document.querySelector('#historyModalDone');
    const localOverlay = dialog?.querySelector('.history-modal-overlay');

    if (!dialog) return;
    const closeDialog = () => this.closeArchiveEntryDetails();

    if (localCloseBtn) {
      localCloseBtn.onclick = closeDialog;
    }
    if (localDoneBtn) {
      localDoneBtn.onclick = closeDialog;
    }

    if (localOverlay) {
      localOverlay.onclick = (failure) => {
        failure.stopPropagation();
        closeDialog();
      };
    }

    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
    }
    this.escHandler = (failure) => {
      if (failure.key === 'Escape' && dialog.style.display === 'flex') {
        failure.preventDefault();
        closeDialog();
        return;
      }
      if (failure.key !== 'Tab' || dialog.style.display !== 'flex') {
        return;
      }

      const localFocusable = Array.from(dialog.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((localNode) => (
        !localNode.hidden &&
        localNode.getAttribute?.('aria-hidden') !== 'true' &&
        !localNode.closest?.('[hidden], [aria-hidden="true"]')
      ));
      if (!localFocusable.length) {
        failure.preventDefault();
        dialog.querySelector('.history-modal-container')?.focus();
        return;
      }

      const firstFocusable = localFocusable[0];
      const lastFocusable = localFocusable[localFocusable.length - 1];
      if (failure.shiftKey && document.activeElement === firstFocusable) {
        failure.preventDefault();
        lastFocusable.focus();
      } else if (!failure.shiftKey && document.activeElement === lastFocusable) {
        failure.preventDefault();
        firstFocusable.focus();
      }
    };
    document.addEventListener('keydown', this.escHandler);
  }

  /**
   * Setup per-method copy handlers inside modal
   */
  wirePhaseCopyRoutes() {
    const phaseEntries = document.querySelectorAll('.history-modal-method-item[data-copy-payload]');
    if (!phaseEntries.length) {
      return;
    }

    phaseEntries.forEach((entry) => {
      const localPayloadEncoded = entry.getAttribute('data-copy-payload');
      if (!localPayloadEncoded) {
        return;
      }

      let localPayload = null;
      try {
        localPayload = JSON.parse(decodeURIComponent(localPayloadEncoded));
      } catch (failure) {
        Telemetry.performWarn('UI', 'History: Failed to parse method copy payload', failure);
      }

      const routeCopy = (signal) => {
        signal.stopPropagation();
        const datum = localPayload?.rawValue || '';
        if (!datum) {
          return;
        }

        const copyToCopy = `[${localPayload.methodType || 'METHOD'}] ${datum}`;
        TextCodec.performCopyToClipboard(copyToCopy, {
          element: entry,
          notificationMessage: 'Copied',
          inlineMessage: '✓ Copied!'
        });

        entry.classList.add('copy-feedback');
        setTimeout(() => entry.classList.remove('copy-feedback'), 800);
      };

      entry.addEventListener('click', routeCopy);
    });
  }

  /**
   * Get domain from URL
   * @param {string} url - Full URL
   * @returns {string} Domain name
   */
  resolveDomainFromAddress(address) {
    if (!address) return 'Unknown';
    try {
      return new URL(address).hostname;
    } catch {
      return address;
    }
  }

  /**
   * Permit only ordinary web destinations in the stored History link.
   * Imported History is untrusted and may contain executable URL schemes.
   * @param {string} address - Candidate URL from a history record
   * @returns {string} Normalized HTTP(S) URL, or an empty string
   */
  resolveSafeArchiveAddress(address) {
    if (!address || typeof address !== 'string') return '';
    try {
      const localAddress = new URL(address);
      return localAddress.protocol === 'http:' || localAddress.protocol === 'https:'
        ? localAddress.href
        : '';
    } catch (failure) {
      return '';
    }
  }

  /**
   * Get human-readable time ago string
   * @param {Date} date - Date object
   * @returns {string} Time ago string
   */
  resolveMomentAgo(localDate) {
    return TextCodec.resolveMomentAgo(localDate.getTime ? localDate.getTime() : localDate);
  }

  resolveCompactMomentAgo(localDate) {
    return TextCodec.resolveCompactMomentAgo(localDate.getTime ? localDate.getTime() : localDate);
  }

  /**
   * Export history to JSON file
   */
  /**
   * Quote one CSV field per RFC 4180: always quoted, internal quotes doubled.
   * @param {*} cell - Value to encode
   * @returns {string} Quoted field
   */
  encodeCsvCell(cell) {
    return `"${String(cell ?? '').replace(/"/g, '""')}"`;
  }

  /**
   * Render entries as CSV, one row per detection.
   *
   * The grain is the detection rather than the entry because that is what the
   * sheet is for: filtering by detector or category is the reason to leave
   * JSON. An entry that detected nothing still gets a row, so the count of
   * pages visited survives the export.
   *
   * @param {Array} archiveEntries - History entries
   * @param {boolean} includeMoments - Whether to emit the timestamp column
   * @returns {string} CSV document
   */
  encodeArchiveCsv(archiveEntries, includeMoments = true) {
    const columns = ['url', 'hostname', 'title', 'detector', 'category', 'confidence', 'methods'];
    const header = includeMoments ? ['timestamp', ...columns] : columns;
    const rows = [header.map((cell) => this.encodeCsvCell(cell)).join(',')];

    for (const archiveEntry of archiveEntries || []) {
      const moment = archiveEntry.timestamp ? new Date(archiveEntry.timestamp).toISOString() : '';
      const shared = [archiveEntry.url, archiveEntry.hostname, archiveEntry.title];
      const findings = archiveEntry.detections?.length ? archiveEntry.detections : [null];

      for (const finding of findings) {
        const label = finding ? (finding.detector?.name || finding.detector || '') : '';
        const methods = (finding?.signals || []).map((hit) => hit.type || 'unknown').join(' ');
        const cells = [
          ...shared,
          label,
          finding?.category || '',
          finding ? (finding.confidence ?? 0) : '',
          methods
        ];
        const row = includeMoments ? [moment, ...cells] : cells;
        rows.push(row.map((cell) => this.encodeCsvCell(cell)).join(','));
      }
    }

    return rows.join('\r\n');
  }

  /**
   * Serialize entries in the format the Export Format preference names.
   *
   * That preference, and Include Timestamps beside it, were both read, saved
   * and canonicalized while every export path hardcoded pretty-printed JSON —
   * two controls that looked like settings and changed nothing.
   *
   * @param {Array} archiveEntries - History entries
   * @param {string} exportEncoding - json | csv | txt
   * @param {boolean} includeMoments - Whether timestamps travel with the rows
   * @returns {{body: string, mediaType: string, extension: string}} Blob parts
   */
  encodeArchiveExport(archiveEntries, exportEncoding, includeMoments = true) {
    const entries = archiveEntries || [];

    if (exportEncoding === 'csv') {
      return {
        body: this.encodeArchiveCsv(entries, includeMoments),
        mediaType: 'text/csv;charset=utf-8',
        extension: 'csv'
      };
    }

    if (exportEncoding === 'txt') {
      return {
        body: entries
          .map((archiveEntry) => this.encodeArchiveEntryCopy(archiveEntry, includeMoments))
          .join(`\n${'='.repeat(50)}\n\n`),
        mediaType: 'text/plain;charset=utf-8',
        extension: 'txt'
      };
    }

    // Anything unrecognized lands here too: JSON is the format that keeps the
    // whole record, so it is the safe answer to a preference we cannot read.
    const exportPayload = ExtensionStore.sealRecord('entries', entries, { total: entries.length });
    return {
      body: JSON.stringify(exportPayload, null, 2),
      mediaType: 'application/json',
      extension: 'json'
    };
  }

  async exportArchive() {
    const archivePreferences = await ExtensionGateway.resolveArchivePreferences();
    const encoded = this.encodeArchiveExport(
      this.archiveEntries,
      archivePreferences?.exportEncoding,
      archivePreferences?.includeMoments ?? true
    );

    const localBlob = new Blob([encoded.body], { type: encoded.mediaType });

    const address = URL.createObjectURL(localBlob);
    const leftValue = document.createElement('a');
    const localTimestamp = new Date().toISOString().split('T')[0];
    leftValue.href = address;
    leftValue.download = `scrapeless-history-${localTimestamp}.${encoded.extension}`;
    leftValue.click();

    URL.revokeObjectURL(address);
    const localT2 = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    Toasts.completion((localT2 && localT2.encode('notificationHistoryExportedFmt', this.archiveEntries.length)) || `Exported ${this.archiveEntries.length} history items`);
  }

  /**
   * Handle import of history from file
   * @param {Event} event - File change event
   */
  async routeImport(signal) {
    const resource = signal.target.files[0];
    if (!resource) return;

    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;

    try {
      const copy = await resource.text();
      const payload = JSON.parse(copy);

      const inboundEntries = ExtensionStore.openRecord(payload, 'entries', 'items');
      if (!inboundEntries || !Array.isArray(inboundEntries)) {
        throw new Error('Invalid history file format');
      }

      const localShouldMerge = await Toasts.performConfirm({
        title: localTr('importHistoryTitle', 'Import History'),
        message: localFmt('importHistoryMessageFmt', `Import ${inboundEntries.length} history items? Current history has ${this.archiveEntries.length} items.`, inboundEntries.length, this.archiveEntries.length),
        type: 'info',
        confirmText: localTr('mergeOption', 'Merge'),
        cancelText: localTr('replaceOption', 'Replace')
      });

      if (localShouldMerge) {
        const retainedIds = new Set(this.archiveEntries.map(entry => entry.id));
        const newEntries = inboundEntries.filter(entry => !retainedIds.has(entry.id));
        this.archiveEntries = [...newEntries, ...this.archiveEntries];

        this.archiveEntries.sort((leftValue, rightValue) => new Date(rightValue.timestamp) - new Date(leftValue.timestamp));

        if (this.archiveCeiling > 0 && this.archiveEntries.length > this.archiveCeiling) {
          this.archiveEntries = this.archiveEntries.slice(0, this.archiveCeiling);
        }

        Toasts.completion(localFmt('notificationHistoryMergedFmt', `Merged ${newEntries.length} new history items`, newEntries.length));
      } else {
        this.archiveEntries = this.archiveCeiling > 0
          ? inboundEntries.slice(0, this.archiveCeiling)
          : inboundEntries;
        Toasts.completion(localFmt('notificationHistoryReplacedFmt', `Replaced history with ${this.archiveEntries.length} items`, this.archiveEntries.length));
      }

      await this.persistArchiveToRepository();
      this.paintArchive();
    } catch (failure) {
      Toasts.failure(localFmt('notificationImportHistoryFailedFmt', 'Failed to import history: ' + failure.message, failure.message));
    }

    signal.target.value = '';
  }

  /**
   * Initialize history section with event listeners
   */
  async start() {
    if (!this.started) {
      try {
        await this.refreshArchiveLimit();
      } catch (failure) {
        Telemetry.performWarn('UI', '[History] History limit read failed, defaulting to unlimited', failure);
        this.archiveCeiling = 0; // 0 = unlimited
      }

      await this.hydrateMarkup();
      this.wirePaging();
      this.bindShellEvents();
      this.registerPreferencesSubscription();
      this.started = true;
    }
  }

  async refreshArchiveLimit() {
    try {
      const preferencePane = await ExtensionGateway.resolveArchivePreferences();
      const decodedLimit = parseInt(preferencePane.archiveCeiling, 10);
      const localNewLimit = Number.isFinite(decodedLimit) && decodedLimit >= 0 ? decodedLimit : 0; // 0 = unlimited

      if (localNewLimit !== this.archiveCeiling) {
        Telemetry.performUi(`History: Updating history limit from ${this.archiveCeiling} to ${localNewLimit}`);
        this.archiveCeiling = localNewLimit;
      }
    } catch (failure) {
      Telemetry.performWarn('UI', '[History] Limit refresh failed, keeping current value', failure);
    }
  }

  registerPreferencesSubscription() {
    if (this._settingsListenerAttached) return;
    this._settingsListenerAttached = true;
    chrome.runtime.onMessage.addListener((packet) => {
      if (!packet || packet.type !== 'PREFERENCES_UPDATED') {
        return;
      }

      this.refreshArchiveLimit()
        .then(() => this.readArchiveFromRepository())
        .then(() => this.paintArchive())
        .catch(failure => {
          Telemetry.performWarn('UI', '[History] Refresh after settings update failed', failure);
        });
    });
  }

  /**
   * Setup pagination manager
   */
  wirePaging() {
    this.pageCursor = new PageCursor('historyPagination', {
      itemsPerPage: 20,
      onPageChange: (sheet, entries) => {
        this.paintArchiveSheet(entries);
      }
    });
  }

  /**
   * Load HTML template into history tab
   */
  async hydrateMarkup() {
    try {
      const reply = await fetch(chrome.runtime.getURL('src/console/archive/pane.html'));
      const markup = await reply.text();

      const archivePage = document.querySelector('#historyTab');
      if (archivePage) {
        archivePage.innerHTML = markup;
      }
    } catch (failure) {
      Telemetry.failure('UI', '[History] HTML load failed', failure);
    }
  }

  /**
   * Setup event listeners after HTML is loaded
   */
  bindShellEvents() {
    // Guard against duplicate listener attachment
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    // Setup search functionality
    const filterField = document.querySelector('#historySearch');
    if (filterField) {
      filterField.addEventListener('input', (failure) => {
        this.routeFilter(failure.target.value);
      });
    }

    // Setup clear history button
    const purgeBtn = document.querySelector('#clearHistoryBtn');
    if (purgeBtn) {
      purgeBtn.addEventListener('click', async () => {
        const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
        const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
        const localConfirmed = await Toasts.performConfirm({
          title: localTr('dialogClearHistoryTitle', 'Clear History'),
          message: localTr('dialogClearHistoryMessage', 'Are you sure you want to clear all history? This action cannot be undone.'),
          type: 'danger',
          confirmText: localTr('buttonClearAll', 'Clear All'),
          cancelText: localTr('btnCancel', 'Cancel'),
          emphasizeAction: true
        });

        if (localConfirmed) {
          this.purgeArchive();
        }
      });
    }

    // Setup export button
    const localExportBtn = document.querySelector('#exportHistoryBtn');
    if (localExportBtn) {
      localExportBtn.addEventListener('click', () => this.exportArchive());
    }

    // Setup import button and file input
    const localImportBtn = document.querySelector('#importHistoryBtn');
    const importResource = document.querySelector('#importHistoryFile');
    if (localImportBtn && importResource) {
      localImportBtn.addEventListener('click', () => importResource.click());
      importResource.addEventListener('change', (failure) => this.routeImport(failure));
    }
  }

  /**
   * Normalize URL/hostname into duplicate-comparison key.
   * @param {string} url - URL candidate
   * @param {string} hostname - Hostname fallback
   * @param {string} scope - Duplicate scope: domain|path|full_url
   * @returns {string|null} Normalized key or null if unavailable
   */
  static canonicalizeDuplicateLookup(address, localHostname, boundary = 'full_url') {
    const duplicateBoundary = ['domain', 'path', 'full_url'].includes(boundary) ? boundary : 'full_url';
    const unprocessedAddress = typeof address === 'string' ? address.trim() : '';
    const unprocessedHostname = typeof localHostname === 'string' ? localHostname.trim() : '';

    const canonicalizeHostname = (hostDatum) => {
      if (!hostDatum || typeof hostDatum !== 'string') {
        return '';
      }
      const localNormalized = hostDatum.trim().toLowerCase();
      return (localNormalized && localNormalized !== 'unknown') ? localNormalized : '';
    };

    let decodedAddress = null;
    if (unprocessedAddress) {
      try {
        decodedAddress = new URL(unprocessedAddress);
      } catch (failure) {
        Telemetry.performDebug('UI', `[History] normalizeDuplicateKey parse failed for scope "${duplicateBoundary}", using hostname fallback`);
      }
    }

    const localFallbackHostname = canonicalizeHostname(unprocessedHostname)
      || canonicalizeHostname(unprocessedAddress ? WebAddress.resolveHostnameFromAddress(unprocessedAddress) : '');

    if (duplicateBoundary === 'domain') {
      const hostnameLookup = decodedAddress ? canonicalizeHostname(decodedAddress.hostname) : localFallbackHostname;
      return hostnameLookup || null;
    }

    if (duplicateBoundary === 'path') {
      if (decodedAddress) {
        return `${decodedAddress.origin}${decodedAddress.pathname}`;
      }
      return localFallbackHostname || null;
    }

    if (decodedAddress) {
      return decodedAddress.href;
    }

    return localFallbackHostname || null;
  }

  /**
   * Check whether a history array already contains a duplicate key in the time window.
   * @param {Array} history - History items
   * @param {string} normalizedKey - Candidate duplicate key
   * @param {number} cutoffTime - Minimum timestamp (ms) to consider
   * @param {string} scope - Duplicate scope: domain|path|full_url
   * @returns {boolean} True if duplicate exists
   */
  static isDuplicateArchiveEntry(archivePane, normalizedLookup, cutoffMoment, boundary = 'full_url') {
    if (!Array.isArray(archivePane) || !normalizedLookup) {
      return false;
    }

    return archivePane.some((entry) => {
      if (!entry) {
        return false;
      }

      const unprocessedTimestamp = typeof entry.timestamp === 'string'
        ? new Date(entry.timestamp).getTime()
        : Number(entry.timestamp);
      const entryTimestamp = Number.isFinite(unprocessedTimestamp) ? unprocessedTimestamp : 0;

      if (entryTimestamp < cutoffMoment) {
        return false;
      }

      const entryLookup = this.canonicalizeDuplicateLookup(entry.url, entry.hostname, boundary);
      return !!entryLookup && entryLookup === normalizedLookup;
    });
  }

  /**
   * Check if detection should be saved to history based on duplicate prevention settings
   * @param {string} url - URL to check
   * @param {Object} settings - History settings from Utils.getHistorySettings()
   * @param {Object} chrome - Chrome API object
   * @returns {Promise<boolean>} True if should save, false if duplicate
   */
  static async shouldPersistToArchive(address, preferencePane, localChrome) {
    try {
      // If duplicate prevention is disabled, always save
      if (!preferencePane.repeatGuardActive) {
        return true;
      }

      // Get existing history
      const outcome = await localChrome.storage.local.get(['scrapeless_history']);
      let archivePane = [];

      if (outcome.scrapeless_history) {
        if (typeof outcome.scrapeless_history === 'string') {
          try {
            const decoded = JSON.parse(outcome.scrapeless_history);
            archivePane = ExtensionStore.openRecord(decoded, 'entries', 'items') || [];
          } catch (parseFailure) {
            Telemetry.performWarn('UI', '[History] JSON parse failed in duplicate check', parseFailure);
            return true; // On error, allow save
          }
        } else if (Array.isArray(outcome.scrapeless_history)) {
          archivePane = outcome.scrapeless_history;
        } else if (ExtensionStore.openRecord(outcome.scrapeless_history, 'entries', 'items')) {
          archivePane = ExtensionStore.openRecord(outcome.scrapeless_history, 'entries', 'items') || [];
        }
      }

      if (!Array.isArray(archivePane) || archivePane.length === 0) {
        return true; // No history, always save
      }

      const duplicateBoundary = preferencePane.repeatScope || 'full_url';
      const localDuplicateDuration = Number.isFinite(parseInt(preferencePane.repeatDuration, 10))
        ? parseInt(preferencePane.repeatDuration, 10)
        : 1;
      const localDuplicateUnit = preferencePane.repeatUnit || 'hours';

      const localDurationMs = TextCodec.performConvertToMilliseconds(
        localDuplicateDuration,
        localDuplicateUnit
      );

      const localNow = Date.now();
      const cutoffMoment = localNow - localDurationMs;
      const normalizedLookup = this.canonicalizeDuplicateLookup(address, null, duplicateBoundary);
      if (!normalizedLookup) {
        Telemetry.performDebug('UI', `[History] Duplicate pre-check could not normalize key (scope: ${duplicateBoundary}), allowing save`);
        return true;
      }

      const localIsDuplicate = this.isDuplicateArchiveEntry(archivePane, normalizedLookup, cutoffMoment, duplicateBoundary);

      if (localIsDuplicate) {
        Telemetry.performUi(`History: Skipping duplicate URL within ${localDuplicateDuration} ${localDuplicateUnit} (scope: ${duplicateBoundary}, source: precheck): ${normalizedLookup}`);
        return false;
      }

      return true;
    } catch (failure) {
      Telemetry.performWarn('UI', '[History] Duplicate check failed', failure);
      return true; // On error, allow save
    }
  }

  /**
   * Save detection results to history (called from src/entry/worker.js)
   * @param {number} tabId - Tab ID
   * @param {Object} pageData - Page data
   * @param {Array} detectionResults - Detection results
   * @param {Object} chrome - Chrome API object
   * @param {Object} options - Save options
   * @param {Object} options.historySettings - Optional preloaded history settings
   * @param {string} options.source - Save source context (e.g., finalize, cache_hit)
   * @returns {Promise<boolean>} Success status
   */
  static persistScanToArchive(pageToken, sheetPayload, scanOutcomes, localChrome, choices = {}) {
    // Serialize all writes: each call awaits the previous, eliminating the
    // get-modify-set race that could lose history entries when two detections
    // finish back-to-back.
    if (!ScanArchivePresenter._persistQueue) ScanArchivePresenter._persistQueue = Promise.resolve();
    const localWork = ScanArchivePresenter._persistQueue
      .catch(() => undefined)
      .then(() => ScanArchivePresenter._doPersistScanToArchive(pageToken, sheetPayload, scanOutcomes, localChrome, choices));
    ScanArchivePresenter._persistQueue = localWork.catch(() => undefined);
    return localWork;
  }

  static async _doPersistScanToArchive(pageToken, sheetPayload, scanOutcomes, localChrome, choices = {}) {
    const {
      historySettings: archivePreferences = null,
      source: origin = 'unknown'
    } = choices || {};

    try {
      // Get existing history
      const outcome = await localChrome.storage.local.get(['scrapeless_history']);
      let archivePane = [];

      // Handle different storage formats for backward compatibility
      if (outcome.scrapeless_history) {
        if (typeof outcome.scrapeless_history === 'string') {
          // DetectionHistory stores a JSON string with { items: [], lastUpdated: ... }.
          try {
            const decoded = JSON.parse(outcome.scrapeless_history);
            archivePane = ExtensionStore.openRecord(decoded, 'entries', 'items') || [];
            Telemetry.performUi('History: Parsed history from JSON string format');
          } catch (parseFailure) {
            Telemetry.performWarn('UI', '[History] JSON parse failed', parseFailure);
            archivePane = [];
          }
        } else if (Array.isArray(outcome.scrapeless_history)) {
          // Direct array format
          archivePane = outcome.scrapeless_history;
        } else if (ExtensionStore.openRecord(outcome.scrapeless_history, 'entries', 'items')) {
          // Object with items array
          archivePane = ExtensionStore.openRecord(outcome.scrapeless_history, 'entries', 'items') || [];
        } else {
          Telemetry.performWarn('UI', 'History: Unknown history format, starting fresh');
          archivePane = [];
        }
      }

      // Ensure history is an array
      if (!Array.isArray(archivePane)) {
        Telemetry.performWarn('UI', 'History: History is not an array, resetting');
        archivePane = [];
      }

      const preferencePane = archivePreferences || await ExtensionGateway.resolveArchivePreferences();
      const duplicateBoundary = preferencePane.repeatScope || 'full_url';
      const localDuplicateDuration = Number.isFinite(parseInt(preferencePane.repeatDuration, 10))
        ? parseInt(preferencePane.repeatDuration, 10)
        : 1;
      const localDuplicateUnit = preferencePane.repeatUnit || 'hours';

      if (preferencePane.repeatGuardActive) {
        const localDurationMs = TextCodec.performConvertToMilliseconds(localDuplicateDuration, localDuplicateUnit);
        const cutoffMoment = Date.now() - localDurationMs;
        const normalizedLookup = this.canonicalizeDuplicateLookup(sheetPayload.url, sheetPayload.hostname, duplicateBoundary);

        if (!normalizedLookup) {
          Telemetry.performDebug('UI', `[History] Duplicate save-check could not normalize key (scope: ${duplicateBoundary}, source: ${origin}), allowing save`);
        } else if (this.isDuplicateArchiveEntry(archivePane, normalizedLookup, cutoffMoment, duplicateBoundary)) {
          Telemetry.performUi(`History: Skipping duplicate history save within ${localDuplicateDuration} ${localDuplicateUnit} (scope: ${duplicateBoundary}, source: ${origin}): ${normalizedLookup}`);
          return false;
        }
      }

      const archiveLimit = Number.isFinite(parseInt(preferencePane.archiveCeiling, 10))
        ? parseInt(preferencePane.archiveCeiling, 10)
        : 0; // 0 = unlimited
      // Get current cache scope setting
      const memoBoundary = await ExtensionGateway.resolveMemoBoundary();
      const normalizedSitemark = WebAddress.canonicalizeSitemarkForRepository(
        sheetPayload.favicon,
        sheetPayload.url || sheetPayload.hostname
      );

      // Create history entry
      const entryAddress = sheetPayload.url || '';
      const localEntryHostname = sheetPayload.hostname || WebAddress.resolveHostnameFromAddress(entryAddress);
      const archiveEntry = {
        id: `detection_${Date.now()}_${pageToken}`,
        url: entryAddress,
        hostname: localEntryHostname,
        title: sheetPayload.tabTitle || sheetPayload.title || 'Untitled',
        favicon: normalizedSitemark,
        timestamp: Date.now(),
        detections: scanOutcomes,
        detectionCount: scanOutcomes.length,
        categories: [...new Set(scanOutcomes.map(localD => localD.category))],
        memoScope: memoBoundary
      };

      // Add to history (newest first)
      archivePane.unshift(archiveEntry);

      // Apply rolling window limit (remove oldest items)
      if (archiveLimit > 0 && archivePane.length > archiveLimit) {
        archivePane = archivePane.slice(0, archiveLimit);
      }

      // Seal it like every other writer. This is the hot path - it runs on each
      // detection - so an unsealed write here would quietly strip the version
      // and savedAt stamp off the record again on the next page load.
      const archivePayload = ExtensionStore.sealRecord('entries', archivePane);

      await localChrome.storage.local.set({
        scrapeless_history: JSON.stringify(archivePayload, null, 2)
      });

      Telemetry.performUi(`History: Saved detection to history for ${sheetPayload.url}`);
      return true;
    } catch (failure) {
      Telemetry.failure('UI', '[History] Detection save failed', failure);
      return false;
    }
  }

  /**
   * Convert hex color to RGB object
   * @param {string} hex - Hex color value (e.g., "#FF5733" or "FF5733")
   * @returns {Object|null} RGB object {r, g, b} or null if invalid
   */
  performHexToRgb(localHex) {
    if (!localHex || typeof localHex !== 'string') {
      return null;
    }
    const outcome = localHex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    return outcome ? {
      r: parseInt(outcome[1], 16),
      g: parseInt(outcome[2], 16),
      b: parseInt(outcome[3], 16)
    } : null;
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.ScanArchivePresenter = ScanArchivePresenter;
}
