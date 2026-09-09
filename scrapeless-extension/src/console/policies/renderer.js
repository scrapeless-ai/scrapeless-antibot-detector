/**
 * Rules Display Module
 *
 * Contains display/rendering methods for the Rules class:
 * - displayRules - Main entry point for displaying detector list
 * - renderDetectorsPage - Renders detector cards for current page
 * - setupDetectorCardListeners - Sets up click event listeners
 *
 * These methods are added to the Rules prototype and use `this` to access
 * the Rules instance properties (detectorManager, paginationManager, etc.)
 */

// ============================================
// Main Display Method
// ============================================

/**
 * Display rules (main entry point)
 */
CatalogPresenter.prototype.presentPolicies = async function() {
  Telemetry.performUi('displayRules called');

  if (!this.started) {
    await this.start();
  }

  const policiesCollection = document.querySelector('#rulesList');
  const catalogEmpty = document.querySelector('#detectorsEmpty');

  if (!policiesCollection) {
    Telemetry.failure('UI', 'Rules list element not found - HTML may not be loaded yet');
    return;
  }

  Telemetry.performUi('Rules list found:', policiesCollection);

  const ruleSet = this.ruleCatalog.resolveAllCatalog();

  if (!ruleSet || Object.keys(ruleSet).length === 0) {
    if (catalogEmpty) {
      catalogEmpty.style.display = 'block';
    }
    if (policiesCollection) {
      policiesCollection.innerHTML = '';
    }
    return;
  }

  if (catalogEmpty) {
    catalogEmpty.style.display = 'none';
  }

  this.allDetectors = [];
  for (const [taxonomy, taxonomyCatalog] of Object.entries(ruleSet)) {
    if (!taxonomyCatalog || Object.keys(taxonomyCatalog).length === 0) continue;

    for (const [ruleLabel, rule] of Object.entries(taxonomyCatalog)) {
      const ruleWithBaselines = {
        ...rule,
        displayName: rule.name || ruleLabel,
        detection: rule.detection || {
          urls: [],
          headers: [],
          cookies: [],
          content: [],
          dom: []
        }
      };

      this.allDetectors.push({
        category: taxonomy,
        detectorName: ruleLabel,
        detector: ruleWithBaselines
      });
    }
  }

  // Sort by: enabled status, then date (newest first), then category priority
  const taxonomyPriority = { antibot: 0, captcha: 1, fingerprint: 2 };

  this.allDetectors.sort((leftValue, rightValue) => {
    const aActive = leftValue.detector.enabled !== false;
    const bActive = rightValue.detector.enabled !== false;
    if (aActive !== bActive) return aActive ? -1 : 1;

    const localATimestamp = this.resolveSortTimestamp(leftValue.detector.lastUpdated);
    const localBTimestamp = this.resolveSortTimestamp(rightValue.detector.lastUpdated);
    if (localATimestamp !== localBTimestamp) return localBTimestamp - localATimestamp;

    const localAPriority = taxonomyPriority[leftValue.category] ?? 99;
    const localBPriority = taxonomyPriority[rightValue.category] ?? 99;
    if (localAPriority !== localBPriority) return localAPriority - localBPriority;

    const aLabel = (leftValue.detector.displayName || leftValue.detectorName || '').toLowerCase();
    const bLabel = (rightValue.detector.displayName || rightValue.detectorName || '').toLowerCase();
    return aLabel.localeCompare(bLabel);
  });

  this.filteredDetectors = [...this.allDetectors];

  if (this.pageCursor) {
    this.pageCursor.assignEntries(this.filteredDetectors);
  }
};

// ============================================
// Page Rendering Methods
// ============================================

/**
 * Render detectors for current page
 * @param {Array} detectors - Detectors to render for current page
 */
CatalogPresenter.prototype.paintCatalogSheet = function(ruleSet) {
  const policiesCollection = document.querySelector('#rulesList');
  if (!policiesCollection) return;

  let policiesMarkup = '';

  ruleSet.forEach(({ category: taxonomy, detectorName: ruleLabel, detector: rule }, cardIndex) => {
    const ruleGlyph = this.resolveRuleGlyph(rule, taxonomy);
    const taxonomyDetail = this.taxonomy.resolveTaxonomyDetail(taxonomy);
    const taxonomyPalette = taxonomyDetail?.colour || '#9B8AF7';

    const scanPhases = this.resolveScanPhases(rule);
    const localFormattedLastUpdated = this.encodeLastUpdated(rule.lastUpdated);
    const taxonomyPhase = this.resolveTaxonomyPhase(taxonomy);
    const ruleAuthor = String(rule.author || 'Scrapeless');
    // The bundled rules are authored 'Scrapeless'; 'scrapeless' is still
    // recognised so a rule exported from an older build keeps its badge.
    const authorLookup = ruleAuthor.toLowerCase();
    const isUpstreamRule = authorLookup === 'scrapeless' || authorLookup === 'scrapeless';
    const presentAuthor = isUpstreamRule ? 'Scrapeless' : ruleAuthor;

    const localCatHex = taxonomyPalette.replace('#', '');
    const localCatR = parseInt(localCatHex.substring(0, 2), 16);
    const localCatG = parseInt(localCatHex.substring(2, 4), 16);
    const localCatB = parseInt(localCatHex.substring(4, 6), 16);

    const taxonomyBadge = `<span class="method-tag" style="background: rgba(${localCatR}, ${localCatG}, ${localCatB}, 0.2); color: ${taxonomyPalette}; border: 1px solid rgba(${localCatR}, ${localCatG}, ${localCatB}, 0.35);">${taxonomyPhase}</span>`;

    // The detector badge repeated the row's own title verbatim — "Audio
    // Fingerprint" under "Audio Fingerprint" — so the row spent a line saying
    // nothing. Only the category qualifies the name.
    const localTopBadges = taxonomyBadge;

    const isInactive = rule.enabled === false;
    const detectorNameId = `rules-detector-name-${cardIndex}`;
    policiesMarkup += `
      <div class="detector-card ${isInactive ? 'detector-disabled' : ''}" data-detector-id="${TextCodec.performEscapeAttr(ruleLabel)}" data-category="${TextCodec.performEscapeAttr(taxonomy)}">
        <div class="detector-header">
          <div class="detector-icon">${ruleGlyph}</div>
          <div class="detector-info">
            <div class="detector-name-row">
              <div class="detector-name" id="${detectorNameId}">${TextCodec.escapeMarkup(rule.displayName)}</div>
              <div class="detector-actions" data-stop-propagation="true">
                <button class="edit-btn" title="Edit Detector" data-detector-id="${TextCodec.performEscapeAttr(ruleLabel)}" data-category="${TextCodec.performEscapeAttr(taxonomy)}">
                  <svg width="14" height="14" viewBox="0 0 24 24">
                    <path d="M3,17.25V21h3.75L17.81,9.94l-3.75-3.75L3,17.25zM20.71,7.04c0.39-0.39,0.39-1.02,0-1.41l-2.34-2.34c-0.39-0.39-1.02-0.39-1.41,0l-1.83,1.83l3.75,3.75L20.71,7.04z" fill="currentColor"/>
                  </svg>
                </button>
                <button class="delete-btn" title="Delete Detector">
                  <svg width="14" height="14" viewBox="0 0 24 24">
                    <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="detection-methods">
              ${localTopBadges}
            </div>
          </div>
        </div>
        <div class="detector-scripts">
          <div class="detection-methods">
            ${scanPhases}
          </div>
          <div class="scripts-info">
            <div class="scripts-info-left">
              <div class="last-updated">
                <span class="last-updated-value">${localFormattedLastUpdated}</span>
              </div>
              <div class="detector-author">
                <span class="version-author">${TextCodec.escapeMarkup(rule.version || '1.0')} | ${TextCodec.escapeMarkup(presentAuthor)}</span>
                ${isUpstreamRule ? '<i class="fas fa-check-circle verified-badge" title="Official Scrapeless detector"></i>' : ''}
              </div>
            </div>
            <label class="toggle-switch-small" data-stop-propagation="true">
              <input type="checkbox" class="detector-toggle"
                     aria-labelledby="${detectorNameId}"
                     data-detector="${TextCodec.performEscapeAttr(ruleLabel)}"
                     data-category="${TextCodec.performEscapeAttr(taxonomy)}"
                     ${rule.enabled !== false ? 'checked' : ''}>
              <span class="toggle-slider-small"></span>
            </label>
          </div>
        </div>
      </div>
    `;
  });

  policiesCollection.innerHTML = policiesMarkup;

  // CSP-compliant: event delegation for stopPropagation and image fallback
  policiesCollection.querySelectorAll('[data-stop-propagation]').forEach(node => {
    node.addEventListener('click', (failure) => failure.stopPropagation());
  });

  policiesCollection.querySelectorAll('img[data-fallback]').forEach(localImg => {
    localImg.addEventListener('error', function() {
      this.src = this.dataset.fallback;
    }, { once: true });
  });

  this.wireRuleCardSubscriptions(ruleSet);
};

// ============================================
// Event Listener Setup
// ============================================

/**
 * Setup event listeners for detector cards
 * @param {Array} detectors - Array of detectors for current page
 */
CatalogPresenter.prototype.wireRuleCardSubscriptions = function(ruleSet) {
  const ruleCards = document.querySelectorAll('.detector-card');
  ruleCards.forEach((localCard, position) => {
    if (ruleSet[position]) {
      const { category: taxonomy, detectorName: ruleLabel, detector: rule } = ruleSet[position];

      localCard.addEventListener('click', (failure) => {
        if (!failure.target.closest('.detector-actions') && !failure.target.closest('.method-tag') && !failure.target.closest('.toggle-switch-small')) {
          const ruleToEdit = {
            ...rule,
            detection: rule.detection || {
              urls: [],
              headers: [],
              cookies: [],
              content: [],
              dom: []
            }
          };
          this.openEditDialog(ruleToEdit, taxonomy, ruleLabel, false);
        }
      });

      localCard.style.cursor = 'pointer';
    }
  });

  const editControls = document.querySelectorAll('.edit-btn');
  editControls.forEach((localBtn, position) => {
    if (ruleSet[position]) {
      const { category: taxonomy, detectorName: ruleLabel, detector: rule } = ruleSet[position];
      localBtn.addEventListener('click', (failure) => {
        failure.stopPropagation();
        const ruleToEdit = {
          ...rule,
          detection: rule.detection || {
            urls: [],
            headers: [],
            cookies: [],
            content: [],
            dom: []
          }
        };
        this.openEditDialog(ruleToEdit, taxonomy, ruleLabel, false);
      });
    }
  });

  const deleteControls = document.querySelectorAll('.delete-btn');
  deleteControls.forEach((localBtn, position) => {
    if (ruleSet[position]) {
      const { category: taxonomy, detectorName: ruleLabel, detector: rule } = ruleSet[position];
      localBtn.addEventListener('click', async (failure) => {
        failure.stopPropagation();
        await this.routeDeleteRule(taxonomy, ruleLabel, rule.displayName || ruleLabel);
      });
    }
  });
};
