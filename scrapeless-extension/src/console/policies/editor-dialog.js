/**
 * Rules extension methods.
 * Dependencies: `src/console/policies/presenter.js` must be loaded first.
 */

CatalogPresenter.prototype.assignActiveRuleGlyphOriginClass = function(originKind = 'default') {
    const glyphImg = document.querySelector('#currentDetectorIcon');
    if (!glyphImg) return;

    glyphImg.classList.remove(
      'fingerprint-icon-image',
      'fingerprint-icon-image--builtin',
      'fingerprint-icon-image--custom',
      'fingerprint-icon-image--default'
    );

    glyphImg.classList.add('fingerprint-icon-image');
    if (originKind === 'custom') {
      glyphImg.classList.add('fingerprint-icon-image--custom');
      return;
    }
    if (originKind === 'builtin') {
      glyphImg.classList.add('fingerprint-icon-image--builtin');
      return;
    }
    glyphImg.classList.add('fingerprint-icon-image--default');
  };

CatalogPresenter.prototype.openEditDialog = function(rule, taxonomy, ruleLabel, localIsNew = false) {
    const dialog = document.querySelector('#editRuleModal');

    if (!dialog) return;

    // The document is tinted by the rule it describes, so picking a category
    // finally has a visible consequence. The select re-applies it on change.
    dialog.setAttribute('data-category', String(taxonomy || 'other').toLowerCase());

    // Ensure detector has detection property before storing
    const ruleWithScan = {
      ...rule,
      detection: rule.detection || {
        urls: [],
        headers: [],
        cookies: [],
        content: [],
        dom: []
      }
    };

    // Store current detector data BEFORE populating modal
    // Explicitly set isNew based on the parameter, not previous state
    this.currentEditDetector = {
      detector: ruleWithScan,
      category: taxonomy,
      detectorName: ruleLabel,
      isNew: localIsNew
    };

    // Set dynamic title based on whether it's a new detector
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const actionLookup = this.currentEditDetector.isNew ? 'btnAdd' : 'ruleModalActionEdit';
    const localFallback = this.currentEditDetector.isNew ? 'Add' : 'Edit';
    const localAction = (localT && localT.resolve(actionLookup)) || localFallback;
    const localActionEl = document.querySelector('#editRuleModalAction');
    const labelEl = document.querySelector('#editRuleModalName');
    if (localActionEl) localActionEl.textContent = `${localAction} ${ruleWithScan.displayName || ruleLabel}`;
    if (labelEl) {
      labelEl.textContent = (localT && typeof localT.performTr === 'function')
        ? localT.performTr('rulesModalDetectorLabel', 'Detection Rule')
        : 'Detection Rule';
    }

    // Populate modal with detector data (now currentEditDetector is available)
    this.populateDialogPayload(ruleWithScan);

    // Store snapshot of detection AFTER populating form (includes defaults from form)
    // This ensures comparison matches what save will produce
    this.currentEditDetector.originalDetection = this._collectScanFromForm();

    // Show modal
    dialog.style.display = 'flex';
    document.body.style.overflow = 'hidden'; // Prevent background scrolling

    // A field measures as zero height while its modal is display:none, so the
    // first fit has to happen after the modal is shown.
    if (typeof this.fitAllPatternFields === 'function') {
      this.fitAllPatternFields();
    }
  };

CatalogPresenter.prototype.closeEditDialog = function() {
    const dialog = document.querySelector('#editRuleModal');
    if (dialog) {
      dialog.style.display = 'none';
      document.body.style.overflow = ''; // Restore scrolling
      this.currentEditDetector = null;
    }
  };

CatalogPresenter.prototype.populateDialogPayload = function(rule) {
    // Populate detector information fields
    const labelField = document.querySelector('#detectorNameInput');
    const taxonomySelect = document.querySelector('#detectorCategorySelect');
    const localDifficultySelect = document.querySelector('#detectorDifficultySelect');
    const versionField = document.querySelector('#detectorVersionInput');
    const glyphImg = document.querySelector('#currentDetectorIcon');
    const taxonomy = this.currentEditDetector?.category || rule.category || 'antibot';

    if (labelField) {
      labelField.value = rule.name || rule.displayName || '';
    }

    if (taxonomySelect) {
      Telemetry.performUi('Setting category:', taxonomy); // Debug log
      taxonomySelect.value = taxonomy;
    }

    if (localDifficultySelect) {
      const localNormalizedDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
        ? FindingMetrics.canonicalizeDifficulty(rule.difficulty)
        : null;
      const baselineDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.baselineDifficultyForTaxonomy === 'function')
        ? FindingMetrics.baselineDifficultyForTaxonomy(taxonomy)
        : 'Medium';
      localDifficultySelect.value = localNormalizedDifficulty || baselineDifficulty;
    }

    if (typeof ConsoleChoiceRails !== 'undefined') {
      [taxonomySelect, localDifficultySelect].filter(Boolean).forEach((select) => ConsoleChoiceRails.refresh(select));
    }

    if (versionField) {
      versionField.value = rule.version || '1.0';
      versionField.setAttribute('readonly', 'readonly');
      versionField.classList.add('form-input-readonly');
    }

    if (glyphImg) {
      // Default Scrapeless icon fallback
      const consoleGlyph = chrome.runtime.getURL('brand/toolbar-128.png');
      const activeGlyphRegion = glyphImg.parentElement;
      const isFingerprintTaxonomy = (taxonomy || '').toLowerCase() === 'fingerprint';
      let glyphOriginKind = 'default';

      // Add fingerprint-icon class for fingerprint category
      if (activeGlyphRegion) {
        if (isFingerprintTaxonomy) {
          activeGlyphRegion.classList.add('fingerprint-icon');
        } else {
          activeGlyphRegion.classList.remove('fingerprint-icon');
        }
      }

      // Set error handler to fallback to Scrapeless icon
      glyphImg.onerror = () => {
        glyphImg.onerror = null;
        glyphImg.src = consoleGlyph;
      };

      // Check for custom icon first
      if (rule.customIcon) {
        glyphImg.src = rule.customIcon;
        glyphOriginKind = 'custom';
      } else if (!rule.icon || rule.icon === 'default') {
        // Use Scrapeless icon for default or when no icon is set
        glyphImg.src = consoleGlyph;
        glyphOriginKind = 'default';
      } else if (rule.icon) {
        // Handle different icon types
        if (rule.icon.startsWith('http') || rule.icon.startsWith('/')) {
          glyphImg.src = rule.icon;
          glyphOriginKind = 'builtin';
        } else {
          const normalizedGlyph = rule.icon.trim().toLowerCase();
          const fingerprintGlyphOrigin = typeof FingerprintGlyphs !== 'undefined'
            ? FingerprintGlyphs.resolvePayloadAddress(normalizedGlyph)
            : '';
          const vendorGlyphOrigin = typeof BrandGlyphs !== 'undefined'
            ? BrandGlyphs.resolvePayloadAddress(normalizedGlyph)
            : '';

          if (fingerprintGlyphOrigin || vendorGlyphOrigin) {
            glyphImg.src = fingerprintGlyphOrigin || vendorGlyphOrigin;
            glyphOriginKind = 'builtin';
          } else if (normalizedGlyph.endsWith('.png') || normalizedGlyph.endsWith('.jpg') || normalizedGlyph.endsWith('.jpeg') || normalizedGlyph.endsWith('.svg') || normalizedGlyph.endsWith('.webp')) {
            glyphImg.src = chrome.runtime.getURL(`detectors/icons/${rule.icon}`);
            glyphOriginKind = normalizedGlyph.includes('_fingerprint.') ? 'builtin' : 'default';
          } else {
            // It's an emoji or text, create a data URL
            const localCanvas = document.createElement('canvas');
            localCanvas.width = 32;
            localCanvas.height = 32;
            const executionScope = localCanvas.getContext('2d');
            executionScope.font = '20px sans-serif';
            executionScope.textAlign = 'center';
            executionScope.textBaseline = 'middle';
            executionScope.fillText(rule.icon, 16, 16);
            glyphImg.src = localCanvas.toDataURL();
            glyphOriginKind = 'default';
          }
        }
      } else {
        // No icon specified, use Scrapeless icon
        glyphImg.src = consoleGlyph;
        glyphOriginKind = 'default';
      }

      if (isFingerprintTaxonomy) {
        this.assignActiveRuleGlyphOriginClass(glyphOriginKind);
      } else {
        glyphImg.classList.remove(
          'fingerprint-icon-image',
          'fingerprint-icon-image--builtin',
          'fingerprint-icon-image--custom',
          'fingerprint-icon-image--default'
        );
      }
    }

    // Populate author field
    const authorField = document.querySelector('#detectorAuthorInput');
    const localAuthorHelp = document.querySelector('#authorHelp');

    if (authorField) {
      // Set value (default to 'scrapeless' for new detectors)
      authorField.value = rule.author || 'scrapeless';
      // Always allow editing author
      authorField.removeAttribute('readonly');
      authorField.classList.remove('readonly-field');
      if (localAuthorHelp) {
        localAuthorHelp.textContent = (_t && typeof _t.performTr === 'function')
          ? _t.performTr('rulesAuthorHelpHint', 'Who created this detector')
          : 'Who created this detector';
      }
    }

    // Set the badge color from the taxonomy catalog, not the rule payload.
    if (this.colorManager && this.taxonomy) {
      const taxonomy2 = this.currentEditDetector?.category || 'antibot';
      const paletteToAssign = this.taxonomy.resolveTaxonomyPalette(taxonomy2) || '#3b82f6'; // Default to blue if no color
      Telemetry.performUi('Loading category color:', rule.name, 'Category:', taxonomy2, 'Color:', paletteToAssign);
      this.colorManager.assignPalette(paletteToAssign);

      // If it's a custom color, make sure it's stored on the rainbow picker
      const presetPalette = this.colorManager.resolvePresetPalette();
      if (!presetPalette.includes(paletteToAssign)) {
        const localRainbowPicker = document.querySelector('#rainbowPicker');
        if (localRainbowPicker) {
          localRainbowPicker.dataset.customColor = paletteToAssign;
        }
      }
    }

    // Populate detection methods
    this.populateScanPhases(rule);
  };
