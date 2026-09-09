function canonicalizeCookieHeaderBoundary(boundary, localFallback) {
  const localNormalized = typeof boundary === 'string' ? boundary.trim().toLowerCase() : '';
  if (localNormalized === 'all_with_storage') return 'all';
  if (localNormalized === 'storage') return localFallback;
  if (localNormalized === 'request' || localNormalized === 'response' || localNormalized === 'all') return localNormalized;
  return localFallback;
}

class CatalogPresenter {
  constructor(ruleCatalog) {
    this.ruleCatalog = ruleCatalog;
    this.taxonomy = ruleCatalog.resolveTaxonomyCoordinator();
    this.started = false;
    this.eventListenersSetup = false;
    this.pageCursor = null;
    this.colorManager = null;
    this.allDetectors = [];
    this.filteredDetectors = [];
  }

  /**
   * Initialize rules section
   */
  async start() {
    if (!this.started) {
      await this.hydrateMarkup();
      // Keep WINDOW condition dropdowns aligned with the shared condition language (no duplicated lists).
      this.refreshGlobalConditionWizardDropdown();
      this.wirePaging();
      this.startPaletteCoordinator();
      this.bindShellEvents();
      this.started = true;
    }
  }

  /**
   * Refresh the WINDOW helper modal condition dropdown menu content.
   * The base HTML provides a minimal fallback, but we prefer the shared condition language presets.
   */
  async hydrateMarkup() {
    try {
      const reply = await fetch(chrome.runtime.getURL('src/console/policies/pane.html'));
      const markup = await reply.text();

      const policiesPage = document.querySelector('#rulesTab');
      if (policiesPage) {
        policiesPage.innerHTML = markup;
      }
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to load rules HTML:', failure);
    }
  }

  /**
   * Setup pagination manager
   */
  wirePaging() {
    this.pageCursor = new PageCursor('rulesPagination', {
      // Two per page was sized for the old detector card. A register row is a
      // fraction of that height, and 45 detectors across 23 pages made the
      // panel unusable for finding one.
      itemsPerPage: 12,
      onPageChange: (sheet, entries) => {
        this.paintCatalogSheet(entries);
      }
    });
  }

  /**
   * Setup event listeners
   */
  bindShellEvents() {
    if (this.eventListenersSetup) {
      return;
    }

    this.eventListenersSetup = true;

    // Search functionality
    const filterField = document.querySelector('#rulesSearch');
    if (filterField) {
      filterField.addEventListener('input', (failure) => {
        this.routeFilter(failure.target.value);
      });
    }

    // Button event listeners
    this.wireControlSubscriptions();

    // Modal functionality
    this.wireDialogSignalSubscriptions();

    // Toggle switches - handle enable/disable
    document.addEventListener('change', (failure) => {
      if (failure.target.classList.contains('detector-toggle')) {
        const localToggle = failure.target;
        const ruleLabel = localToggle.dataset.detector;
        const taxonomy = localToggle.dataset.category;
        const active = localToggle.checked;

        if (ruleLabel && taxonomy) {
          this.refreshRuleActiveSession(taxonomy, ruleLabel, active);
        }
      }
    });
  }

  /**
   * Setup button event listeners
   */
  wireControlSubscriptions() {
    // Import button
    const localImportBtn = document.querySelector('#importRulesBtn');
    const importResource = document.querySelector('#importRulesFile');
    if (localImportBtn && importResource) {
      localImportBtn.addEventListener('click', () => importResource.click());
      importResource.addEventListener('change', (failure) => this.routeImport(failure));
    }

    // Export button
    const localExportBtn = document.querySelector('#exportRulesBtn');
    if (localExportBtn) {
      localExportBtn.addEventListener('click', () => this.routeExport());
    }

    // Clear button
    const purgeBtn = document.querySelector('#clearRulesBtn');
    if (purgeBtn) {
      purgeBtn.addEventListener('click', () => this.routePurge());
    }

    // Add button
    const localAddBtn = document.querySelector('#addDetectorBtn');
    if (localAddBtn) {
      localAddBtn.addEventListener('click', () => this.routeAddRule());
    }

    // Update button - checks for updates or applies pending ones
    const localCheckUpdatesBtn = document.querySelector('#checkUpdatesBtn');
    if (localCheckUpdatesBtn) {
      localCheckUpdatesBtn.addEventListener('click', () => this.routeCheckUpdates());
    }

    // Check for pending updates on load (shows badge if any)
    this.checkQueuedUpdates();
  }

  /**
   * Initialize color manager
   */
  startPaletteCoordinator() {
    this.colorManager = new ThemePalette();
    this.colorManager.start({
      onColorSelect: (palette) => {
        Telemetry.performUi('Color selected:', palette);
    // Colors belong to the taxonomy catalog, not individual rules.
      },
      onColorChange: (palette) => {
        Telemetry.performUi('Color changed:', palette);
      }
    });
  }

  async refreshRuleActiveSession(taxonomy, ruleLabel, active) {
    try {
      // Get the detector
      const rule = this.ruleCatalog.resolveRule(taxonomy, ruleLabel);
      if (rule) {
        // Update enabled state
        rule.enabled = active;

        // Save to storage
        await this.ruleCatalog.persistCatalogToRepository();

        // CRITICAL: Notify src/entry/worker.js to reload detectors
        // This ensures JS hooks use the updated enabled state on next page load
        chrome.runtime.sendMessage({ type: 'RELOAD_RULE_CATALOG' }, (reply) => {
          Telemetry.performUi(`Detectors reloaded in background after ${active ? 'enabling' : 'disabling'} ${ruleLabel}:`, reply);
        });

        Telemetry.performUi(`Detector ${ruleLabel} ${active ? 'enabled' : 'disabled'}`);

        // Update the visual appearance immediately
        const ruleCard = document.querySelector(`[data-detector-id="${ruleLabel}"][data-category="${taxonomy}"]`);
        if (ruleCard) {
          if (active) {
            ruleCard.classList.remove('detector-disabled');
          } else {
            ruleCard.classList.add('detector-disabled');
          }
        }
      }
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to update detector enabled state:', failure);
    }
  }
}

if (typeof window !== 'undefined') {
  window.CatalogPresenter = CatalogPresenter;
}
