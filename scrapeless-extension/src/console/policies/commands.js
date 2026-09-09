/**
 * Rules Handlers Module
 *
 * Contains event handler methods for the Rules class:
 * - Import/Export handlers
 * - Update management handlers
 * - CRUD operation handlers
 * - Search functionality
 *
 * These methods are added to the Rules prototype and use `this` to access
 * the Rules instance properties (detectorManager, paginationManager, etc.)
 */

// ============================================
// Import/Export Handlers
// ============================================

/**
 * Handle import of detector rules
 * @param {Event} event - File input change event
 */
CatalogPresenter.prototype.routeImport = async function(signal) {
  const resource = signal.target.files[0];
  if (!resource) return;

  const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
  const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
  const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;

  try {
    const copy = await resource.text();
    const payload = JSON.parse(copy);

    const localMerge = await Toasts.performConfirm({
      title: localTr('importDetectorsTitle', 'Import Detectors'),
      message: localTr('importMergeQuestion', 'Do you want to merge with existing detectors?'),
      confirmText: localTr('mergeOption', 'Merge'),
      cancelText: localTr('replaceAllOption', 'Replace All'),
      type: 'info'
    });

    const completion = await this.ruleCatalog.ingestCatalogPayload(payload, localMerge);
    if (completion) {
      Toasts.completion(localTr('detectorsImported', 'Detectors imported'));
      this.presentPolicies();
    } else {
      Toasts.failure(localTr('failedImportDetectors', 'Failed to import detectors. Check the file format.'));
    }
  } catch (failure) {
    Toasts.failure(localFmt('errorReadingFileFmt', 'Error reading file: ' + failure.message, failure.message));
  }

  signal.target.value = '';
};

/**
 * Handle export of detector rules
 */
CatalogPresenter.prototype.routeExport = function() {
  const payload = this.ruleCatalog.composeCatalogExport();
  const localJson = JSON.stringify(payload, null, 2);
  const localBlob = new Blob([localJson], { type: 'application/json' });

  // Create download link
  const address = URL.createObjectURL(localBlob);
  const leftValue = document.createElement('a');
  const localTimestamp = new Date().toISOString().split('T')[0];
  leftValue.href = address;
  leftValue.download = `scrapeless-detectors-${localTimestamp}.json`;
  leftValue.click();

  URL.revokeObjectURL(address);
};

// ============================================
// Update Management Handlers
// ============================================

/**
 * Check for pending updates and update badge
 */
CatalogPresenter.prototype.checkQueuedUpdates = async function() {
  try {
    if (typeof CatalogUpdater === 'undefined') {
      Telemetry.performDebug('UI', 'UpdateManager not available');
      return;
    }

    // Get stored pending updates count and show badge
    const total = await CatalogUpdater.resolveQueuedUpdatesTotal();
    this.refreshUpdatesBadge(total);
  } catch (failure) {
    Telemetry.failure('UI', 'Error checking pending updates', failure);
    this.refreshUpdatesBadge(0);
  }
};

/**
 * Handle Update button click
 * If updates are pending, apply them. Otherwise check for new updates.
 */
CatalogPresenter.prototype.routeCheckUpdates = async function() {
  const localBtn = document.querySelector('#checkUpdatesBtn');
  const btnCopy = document.querySelector('#checkUpdatesBtnText');

  if (!localBtn) {
    Telemetry.performDebug('UI', 'Update button not found');
    return;
  }

  const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
  const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
  const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;

  if (typeof CatalogUpdater === 'undefined') {
    Telemetry.performWarn('UI', '[Rules] UpdateManager not available');
    if (typeof Toasts !== 'undefined') {
      Toasts.failure(localTr('updateServiceNotAvailable', 'Update service not available'));
    }
    return;
  }

  const queuedTotal = await CatalogUpdater.resolveQueuedUpdatesTotal();

  if (queuedTotal > 0) {
    localBtn.classList.add('checking');

    try {
      const outcome = await CatalogUpdater.performApplyUpdates();

      if (outcome.success && outcome.count > 0) {
        this.refreshUpdatesBadge(0);
        if (typeof Toasts !== 'undefined') {
          Toasts.completion(localFmt('detectorsUpdatedFmt', `${outcome.count} detectors updated`, outcome.count));
        }
        await this.presentPolicies();
      } else if (outcome.failed > 0 && outcome.count === 0) {
        this.refreshUpdatesBadge(0);
        if (typeof Toasts !== 'undefined') {
          Toasts.caution(localTr('couldNotFetchUpdates', 'Could not fetch updates from server'));
        }
      } else {
        this.refreshUpdatesBadge(0);
      }
    } catch (failure) {
      Telemetry.failure('UI', 'Error applying updates', failure);
      if (typeof Toasts !== 'undefined') {
        Toasts.failure(localTr('errorApplyingUpdates', 'Error applying updates'));
      }
    } finally {
      localBtn.classList.remove('checking');
    }
  } else {
    localBtn.classList.add('checking');

    try {
      const outcome2 = await CatalogUpdater.performCheckForUpdates(true);

      if (outcome2.error) {
        if (typeof Toasts !== 'undefined') {
          Toasts.failure(localTr('failedCheckForUpdates', 'Failed to check for updates'));
        }
      } else if (outcome2.available && outcome2.updates.length > 0) {
        this.refreshUpdatesBadge(outcome2.updates.length);
        if (typeof Toasts !== 'undefined') {
          Toasts.detail(localFmt('updatesAvailableClickToApplyFmt', `${outcome2.updates.length} updates available - click again to apply`, outcome2.updates.length));
        }
      } else {
        this.refreshUpdatesBadge(0);
        if (typeof Toasts !== 'undefined') {
          Toasts.completion(localTr('allDetectorsUpToDate', 'All detectors are up to date'));
        }
      }
    } catch (failure2) {
      Telemetry.failure('UI', 'Error checking for updates', failure2);
      if (typeof Toasts !== 'undefined') {
        Toasts.failure(localTr('errorCheckingForUpdates', 'Error checking for updates'));
      }
    } finally {
      localBtn.classList.remove('checking');
    }
  }
};

/**
 * Update the updates badge count
 * @param {number} count - Number of pending updates
 */
CatalogPresenter.prototype.refreshUpdatesBadge = function(total) {
  const localBadge = document.querySelector('#updatesBadge');
  const localBtn = document.querySelector('#checkUpdatesBtn');

  if (localBadge) {
    if (total > 0) {
      localBadge.textContent = total;
      localBadge.style.display = 'flex';
      if (localBtn) localBtn.classList.add('has-updates');
    } else {
      localBadge.style.display = 'none';
      if (localBtn) localBtn.classList.remove('has-updates');
    }
  }
};

// ============================================
// CRUD Operation Handlers
// ============================================

/**
 * Handle clearing all detectors
 */
CatalogPresenter.prototype.routePurge = async function() {
  const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
  const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
  const localConfirmed = await Toasts.performConfirm({
    title: localTr('clearAllDetectorsTitle', 'Clear All Detectors'),
    message: localTr('clearAllDetectorsMessage', 'This will remove ALL detectors. Are you sure?'),
    confirmText: localTr('buttonClearAll', 'Clear All'),
    cancelText: localTr('btnCancel', 'Cancel'),
    type: 'danger'
  });

  if (!localConfirmed) {
    return;
  }

  const localLoader = Toasts.performLoading(localTr('clearingAllDetectors', 'Clearing all detectors...'));
  const completion = await this.ruleCatalog.purgeCatalog();
  localLoader.close();

  if (completion) {
    Toasts.completion(localTr('allDetectorsCleared', 'All detectors cleared'));
    this.presentPolicies();
  } else {
    Toasts.failure(localTr('failedClearDetectors', 'Failed to clear detectors'));
  }
};

/**
 * Handle deleting a detector
 * @param {string} category - Category name
 * @param {string} detectorName - Detector name
 * @param {string} displayName - Display name for confirmation
 */
CatalogPresenter.prototype.routeDeleteRule = async function(taxonomy, ruleLabel, presentLabel) {
  const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
  const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
  const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;
  const localConfirmed = await Toasts.performConfirm({
    title: localTr('deleteDetectorTitle', 'Delete Detector'),
    message: localFmt('deleteDetectorMessageFmt', `Are you sure you want to delete "${presentLabel}"?`, presentLabel),
    confirmText: localTr('btnDelete', 'Delete'),
    cancelText: localTr('btnCancel', 'Cancel'),
    type: 'danger'
  });

  if (!localConfirmed) {
    return;
  }

  try {
    const completion = await this.ruleCatalog.removeRule(taxonomy, ruleLabel);
    if (completion) {

      chrome.runtime.sendMessage({ type: 'RELOAD_RULE_CATALOG' }, (reply) => {
        Telemetry.performUi('Detectors reloaded in background after delete:', reply);
      });

      Toasts.completion(localFmt('detectorDeletedFmt', `Deleted "${presentLabel}"`, presentLabel));

      this.presentPolicies();
    } else {
      Toasts.failure(localTr('detectorNotFound', 'Detector not found'));
    }
  } catch (failure) {
    Telemetry.failure('UI', 'Failed to delete detector:', failure);
    Toasts.failure(localTr('failedDeleteDetector', 'Failed to delete detector'));
  }
};

/**
 * Handle adding a new detector
 */
CatalogPresenter.prototype.routeAddRule = function() {
  // Get current timestamp in local time
  const localNow = new Date();
  const localYear = localNow.getFullYear();
  const localMonth = String(localNow.getMonth() + 1).padStart(2, '0');
  const localDay = String(localNow.getDate()).padStart(2, '0');
  const localHours = String(localNow.getHours()).padStart(2, '0');
  const localMinutes = String(localNow.getMinutes()).padStart(2, '0');
  const localSeconds = String(localNow.getSeconds()).padStart(2, '0');
  const localTimestamp = `${localYear}-${localMonth}-${localDay} ${localHours}:${localMinutes}:${localSeconds}`;

  // Create a new empty detector
  const newRule = {
    id: `custom-${Date.now()}`,
    name: 'New Detector',
    displayName: 'New Detector',
    category: 'antibot',
    difficulty: 'Medium',
    icon: 'default',
    color: '#3b82f6',
    description: 'Custom detector',
    lastUpdated: localTimestamp,
    detection: {
      urls: [],
      headers: [],
      cookies: [],
      content: [],
      dom: []
    }
  };

  // Open edit modal with the new detector - pass isNew as true
  this.openEditDialog(newRule, 'antibot', newRule.id, true);
};

// ============================================
// Search Functionality
// ============================================

/**
 * Handle search functionality
 * @param {string} query - Search query
 */
CatalogPresenter.prototype.routeFilter = function(filter) {
  if (!filter.trim()) {
    this.filteredDetectors = [...this.allDetectors];
  } else {
    // Simple search focused on name, category, and description only
    // Avoid searching detection pattern content to prevent false positives
    const filterTerm = filter.toLowerCase().trim();
    this.filteredDetectors = this.allDetectors.filter(({ detector: rule, category: taxonomy }) => {
      // Search in detector name, category, description only
      const searchableCopy = [
        rule.displayName,
        rule.name,
        taxonomy,
        rule.description
      ].filter(Boolean).join(' ').toLowerCase();

      // Check for basic text match first
      if (searchableCopy.includes(filterTerm)) {
        return true;
      }

      // Also allow searching by detection method TYPE names (COOKIE, HEADER, DOM, etc.)
      if (rule.detection) {
        const phaseTypes = Object.keys(rule.detection)
          .filter(lookupKey => Array.isArray(rule.detection[lookupKey]) && rule.detection[lookupKey].length > 0)
          .map(lookupKey => lookupKey.toUpperCase().replace(/_/g, ' '))
          .join(' ')
          .toLowerCase();

        if (phaseTypes.includes(filterTerm)) {
          return true;
        }
      }

      return false;
    });
  }

  // Update pagination with filtered results
  if (this.pageCursor) {
    this.pageCursor.assignEntries(this.filteredDetectors);
  }
};
