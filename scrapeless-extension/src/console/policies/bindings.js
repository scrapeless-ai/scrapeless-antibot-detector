/**
 * Rules extension methods - Modal event listener wiring.
 * Dependencies: rules.js, rules-modal-lifecycle.js, all modal/helper files
 */

CatalogPresenter.prototype.wireDialogSignalSubscriptions = function() {
    // Close modal events
    const localCloseBtn = document.querySelector('#closeRuleModal');
    const localCancelBtn = document.querySelector('#cancelRuleEdit');
    const localBackdrop = document.querySelector('.rule-modal-backdrop');

    if (localCloseBtn) {
      localCloseBtn.addEventListener('click', () => this.closeEditDialog());
    }
    if (localCancelBtn) {
      localCancelBtn.addEventListener('click', () => this.closeEditDialog());
    }
    if (localBackdrop) {
      localBackdrop.addEventListener('click', () => this.closeEditDialog());
    }

    // Save button
    const persistBtn = document.querySelector('#saveRuleEdit');
    if (persistBtn) {
      persistBtn.addEventListener('click', () => this.persistPolicy());
    }

    // Category change - update icon styling
    const taxonomySelect = document.querySelector('#detectorCategorySelect');
    if (taxonomySelect) {
      taxonomySelect.addEventListener('change', (failure) => {
        const localIsFingerprint = failure.target.value.toLowerCase() === 'fingerprint';
        document.querySelectorAll('.current-icon, .icon-preview').forEach(activeGlyphRegion => {
          if (localIsFingerprint) {
            activeGlyphRegion.classList.add('fingerprint-icon');
          } else {
            activeGlyphRegion.classList.remove('fingerprint-icon');
          }
        });

        const glyphImg = document.querySelector('#currentDetectorIcon');
        if (!glyphImg) return;

        if (localIsFingerprint) {
          if (
            !glyphImg.classList.contains('fingerprint-icon-image--builtin') &&
            !glyphImg.classList.contains('fingerprint-icon-image--custom') &&
            !glyphImg.classList.contains('fingerprint-icon-image--default')
          ) {
            this.assignActiveRuleGlyphOriginClass?.('default');
          }
        } else {
          glyphImg.classList.remove(
            'fingerprint-icon-image',
            'fingerprint-icon-image--builtin',
            'fingerprint-icon-image--custom',
            'fingerprint-icon-image--default'
          );
        }
      });
    }

    // Method helper modal for all detection types (event delegation)
    document.addEventListener('click', (signal) => {
      const control = signal.target.closest('.method-help-btn[data-method-help]');
      if (control) {
        signal.stopPropagation();
        this.openPhaseHelpDialog(control.dataset.methodHelp);
      }
    });

    // Icon picker trigger (icon preview button)
    const glyphPickerTrigger = document.querySelector('#openIconPickerBtn');
    if (glyphPickerTrigger) {
      glyphPickerTrigger.addEventListener('click', () => this.openGlyphPicker());
    }

    // Setup all modals
    this.wirePhasePreferencesDialog();
    this.wireMatcherFieldSizing();
    this.wireTaxonomyTint();
    this.wireDomSupportDialog();
    this.wireGlobalSupportDialog();
    this.wireRegexSupportDialog();
    this.wireWholeWordSupportDialog();
    this.wireCaseSensitiveSupportDialog();
    this.wireExplanationDialogs();
    this.wirePhaseHelpDialog();

    // Setup HTTP method color for network request modal dropdown
    const networkPhase = document.querySelector('#networkMethod');
    if (networkPhase) {
      this.refreshHttpPhasePalette(networkPhase);
      networkPhase.addEventListener('change', () => this.refreshHttpPhasePalette(networkPhase));
    }
  };
