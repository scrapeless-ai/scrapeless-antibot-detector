/**
 * Rules extension methods.
 * Dependencies: `src/console/policies/presenter.js` must be loaded first.
 */

CatalogPresenter.prototype.wirePhasePreferencesDialog = function() {
    // Prevent duplicate event listener registration. Use a DISTINCT flag from
    // rules.js setupEventListeners() — that function sets this.eventListenersSetup
    // = true BEFORE calling this (via setupModalEventListeners), so sharing the
    // flag made this bail out early and the method-section handlers (header
    // expand/collapse, add pattern, pagination, add value) were never attached.
    if (this.methodSettingsListenersSetup) {
      return;
    }
    this.methodSettingsListenersSetup = true;

    const dialog = document.querySelector('#methodSettingsModal');
    const localCloseBtn = document.querySelector('#closeMethodSettings');
    const localCancelBtn = document.querySelector('#cancelMethodSettings');
    const persistBtn = document.querySelector('#saveMethodSettings');
    const localBackdrop = dialog?.querySelector('.rule-modal-backdrop');
    const localSlider = document.querySelector('#confidenceSlider');
    const datumPresent = document.querySelector('#confidenceValue');

    // Close modal events
    if (localCloseBtn) {
      localCloseBtn.addEventListener('click', () => this.closePhasePreferencesDialog());
    }
    if (localCancelBtn) {
      localCancelBtn.addEventListener('click', () => this.closePhasePreferencesDialog());
    }
    if (localBackdrop) {
      localBackdrop.addEventListener('click', () => this.closePhasePreferencesDialog());
    }

    // Save button
    if (persistBtn) {
      persistBtn.addEventListener('click', () => this.persistPhasePreferences());
    }

    // Update confidence value display when slider changes
    if (localSlider && datumPresent) {
      const localPaint = () => {
        datumPresent.textContent = localSlider.value;
        // Chrome will not fill a range track on its own, so the fill is a
        // gradient stop the skin reads from this property.
        localSlider.style.setProperty('--conf-pct', `${localSlider.value}%`);
      };
      localSlider.addEventListener('input', localPaint);
      this.paintConfidenceSlider = localPaint;
    }

    // Setup HTTP method badge radio button listeners for .checked class toggle
    document.querySelectorAll('.http-method-badge input[type="radio"], .http-method-badge input[type="checkbox"]').forEach(field => {
      field.addEventListener('change', (failure) => {
        // For radio buttons, remove .checked from all badges in the same group first
        if (failure.target.type === 'radio') {
          const groupLabel = failure.target.name;
          document.querySelectorAll(`input[name="${groupLabel}"]`).forEach(localRadio => {
            const localBadge = localRadio.closest('.http-method-badge');
            if (localBadge) localBadge.classList.remove('checked');
          });
        }

        const localBadge = failure.target.closest('.http-method-badge');
        if (localBadge) {
          localBadge.classList.toggle('checked', failure.target.checked);
        }

        // Handle custom method - show/hide input field
        if (failure.target.id === 'payloadMethodCustom') {
          const customRegion = document.querySelector('#customMethodInputContainer');
          if (customRegion) {
            customRegion.style.display = failure.target.checked ? 'block' : 'none';
          }
        } else if (failure.target.name === 'payloadMethod') {
          // Hide custom input when selecting other methods
          const customRegion2 = document.querySelector('#customMethodInputContainer');
          if (customRegion2) {
            customRegion2.style.display = 'none';
          }
        }
      });
    });

    // Setup click handlers for settings buttons (using event delegation)
    document.addEventListener('click', (failure) => {
      if (failure.target.closest('.method-action-btn.settings')) {
        failure.stopPropagation();
        const control = failure.target.closest('.method-action-btn.settings');
        const localFieldActions = control.closest('.field-actions');
        const fieldKind = localFieldActions?.dataset.fieldType || 'name';
        const phaseEntry = control.closest('.method-item');
        if (phaseEntry) {
          const phaseLookup = this.resolvePhaseEntryKind(phaseEntry);
          if (phaseLookup === 'window' && fieldKind === 'value') {
            return;
          }
          this.openPhasePreferencesDialog(phaseEntry, fieldKind);
        }
      }

      // Handle inline condition dropdown trigger
      if (failure.target.closest('.condition-dropdown-trigger')) {
        failure.stopPropagation();
        const localTrigger = failure.target.closest('.condition-dropdown-trigger');
        const localDropdown = localTrigger.closest('.condition-dropdown');
        if (localDropdown) {
          document.querySelectorAll('.condition-dropdown.open').forEach(localOpenDropdown => {
            if (localOpenDropdown !== localDropdown) {
              localOpenDropdown.classList.remove('open');
            }
          });
          localDropdown.classList.toggle('open');
          localTrigger.setAttribute('aria-expanded', localDropdown.classList.contains('open') ? 'true' : 'false');
        }
        return;
      }

      // Handle inline condition option selection
      if (failure.target.closest('.condition-dropdown .condition-option')) {
        failure.stopPropagation();
        const choice = failure.target.closest('.condition-option');
        const localDropdown2 = choice.closest('.condition-dropdown');
          if (localDropdown2) {
            const datum = choice.dataset.value;
            const chosenCopy = localDropdown2.querySelector('.condition-selected-text');
            if (chosenCopy) {
              chosenCopy.textContent = datum;
            }
            localDropdown2.dataset.conditionValue = datum;
            localDropdown2.querySelectorAll('.condition-option').forEach(localOpt => {
              localOpt.classList.toggle('selected', localOpt === choice);
            });

          const hiddenField = localDropdown2.querySelector('.method-input.method-value');
          if (hiddenField) {
            hiddenField.value = datum;
            const phaseEntry2 = localDropdown2.closest('.method-item');
            if (phaseEntry2) {
              this.refreshPhaseIndicators(phaseEntry2);
              const localSection = phaseEntry2.closest('.method-section');
              if (localSection) {
                this.refreshPhaseSectionPaging(localSection);
              }
            }
          }

          // Handle wizard dropdown (window helper modal)
          const supportHidden = document.querySelector('#windowConditionSelect');
          if (supportHidden && localDropdown2.id === 'conditionDropdownContainer') {
            supportHidden.value = datum;
            this.refreshGlobalPolicyPreview?.();
          }

          localDropdown2.classList.remove('open');
          const localTrigger2 = localDropdown2.querySelector('.condition-dropdown-trigger');
          if (localTrigger2) localTrigger2.setAttribute('aria-expanded', 'false');
        }
        return;
      }

      // Close condition dropdowns when clicking outside
      if (!failure.target.closest('.condition-dropdown')) {
        document.querySelectorAll('.condition-dropdown.open').forEach(localOpenDropdown => {
          localOpenDropdown.classList.remove('open');
          const localTrigger = localOpenDropdown.querySelector('.condition-dropdown-trigger');
          if (localTrigger) localTrigger.setAttribute('aria-expanded', 'false');
        });
      }

      // Handle delete button
      if (failure.target.closest('.method-action-btn.delete')) {
        failure.stopPropagation();
        const control2 = failure.target.closest('.method-action-btn.delete');
        const localFieldActions2 = control2.closest('.field-actions');
        const fieldKind2 = localFieldActions2?.dataset.fieldType || 'name';
        const phaseEntry3 = control2.closest('.method-item');

        if (phaseEntry3) {
          if (fieldKind2 === 'value') {
            // Clear value input and hide value row
            const datumField = phaseEntry3.querySelector('.method-input.method-value');
            const datumRegion = phaseEntry3.querySelector('.value-field-container');
            const addDatumBtn = phaseEntry3.querySelector('.add-value-btn');
            const phaseLookup2 = phaseEntry3.querySelector('.method-input')?.dataset.methodKey || '';

            if (phaseLookup2 === 'window') {
              if (datumField) {
                datumField.value = 'exists';
                this.refreshPhaseIndicators(phaseEntry3);
              }
              if (datumRegion) datumRegion.style.display = 'flex';
              if (addDatumBtn) addDatumBtn.style.display = 'none';
              return;
            }

            if (datumField) {
              datumField.value = '';
              // Clear value-related settings
              phaseEntry3.dataset.valueRegex = 'false';
              phaseEntry3.dataset.valueWholeword = 'false';
              phaseEntry3.dataset.valueCase = 'false';
              // Update indicators
              this.refreshPhaseIndicators(phaseEntry3);
              // Update the settings button to remove highlight
              const datumPreferencesBtn = localFieldActions2.querySelector('.method-action-btn.settings');
              this.refreshPhaseSettingsAction?.(
                datumPreferencesBtn,
                phaseEntry3.dataset.confidence || 100,
                false,
                'value'
              );
            }
            // Hide value container and show "Add Value" button
            if (datumRegion) datumRegion.style.display = 'none';
            if (addDatumBtn) addDatumBtn.style.display = 'flex';
          } else {
            // Remove entire method item
            const localSection2 = phaseEntry3.closest('.method-section');
            phaseEntry3.remove();
            if (localSection2) {
              this.refreshPhaseSectionPaging(localSection2);
              this.refreshAddMatcherControlSession?.(localSection2);
            }
          }
        }
      }

      // Handle "Add Value" button
      if (failure.target.closest('.add-value-btn')) {
        failure.stopPropagation();
        const control3 = failure.target.closest('.add-value-btn');
        const phaseEntry4 = control3.closest('.method-item');

        if (phaseEntry4) {
          const datumRegion2 = phaseEntry4.querySelector('.value-field-container');
          const datumField2 = phaseEntry4.querySelector('.method-input.method-value');

          // Hide "Add Value" button and show value container
          control3.style.display = 'none';
          if (datumRegion2) datumRegion2.style.display = 'flex';
          // Focus the value input
          if (datumField2) datumField2.focus();
        }
      }

      // Handle method pagination controls
      if (failure.target.closest('.method-pagination-btn')) {
        failure.stopPropagation();
        const pagingBtn = failure.target.closest('.method-pagination-btn');
        const localSection3 = pagingBtn.closest('.method-section');
        if (localSection3) {
          const sheetDelta = pagingBtn.classList.contains('prev') ? -1 : 1;
          this.refreshPhaseSectionPaging(localSection3, { pageDelta: sheetDelta });
        }
        return;
      }

      // Handle add method button
      if (failure.target.closest('.add-method-btn')) {
        failure.stopPropagation();
        const control4 = failure.target.closest('.add-method-btn');
        if (control4.disabled) {
          return;
        }
        this.addNewPhaseEntry(control4);
      }

      // Method groups are native disclosure buttons. Keep their visual state,
      // pagination and accessibility state in one route.
      const localHeaderToggle = failure.target.closest('.method-header-toggle');
      if (localHeaderToggle) {
        failure.preventDefault();
        const localSection4 = localHeaderToggle.closest('.method-section');
        if (localSection4) {
          localSection4.classList.toggle('collapsed');
          const localIsExpanded = !localSection4.classList.contains('collapsed');
          localHeaderToggle.setAttribute('aria-expanded', localIsExpanded ? 'true' : 'false');
          this.refreshPhaseSectionPaging(localSection4);
        }
      }
    });

    // Keep filtered pagination in sync while editing method inputs.
    document.addEventListener('input', (failure) => {
      if (!failure.target.classList.contains('method-input')) return;

      const phaseEntry = failure.target.closest('.method-item');
      if (phaseEntry && failure.target.classList.contains('method-name') && failure.target.value.trim()) {
        phaseEntry.classList.remove('method-item-invalid');
        failure.target.classList.remove('method-input-invalid');
        failure.target.removeAttribute('aria-invalid');
      }

      const localSection = failure.target.closest('.method-section');
      if (!localSection) return;
      const phaseKind = this.resolvePhaseSectionKind?.(localSection);
      if (!phaseKind) return;
      const runningFilter = this.methodPaginationState?.[phaseKind]?.searchQuery;
      if (runningFilter) {
        this.refreshPhaseSectionPaging(localSection);
      }
      this.refreshAddMatcherControlSession?.(localSection);
    });
  };

CatalogPresenter.prototype.resolvePhaseEntryKind = function(phaseEntry) {
    const localSection = phaseEntry?.closest('.method-section');
    const sectionKind = typeof this.resolvePhaseSectionKind === 'function'
      ? this.resolvePhaseSectionKind(localSection)
      : localSection?.dataset?.methodType;
    const fieldKind = phaseEntry?.querySelector('.method-input')?.dataset.methodKey || '';
    const phaseKind = (sectionKind || fieldKind || '').toLowerCase();

    return phaseKind === 'js hooks' ? 'js_hooks' : phaseKind;
};

CatalogPresenter.prototype.encodePhasePreferencesPhaseLabel = function(phaseKind) {
    const localLabels = {
      url: 'URL',
      dom: 'DOM',
      js_hooks: 'JS Hooks',
      header: 'Header',
      cookie: 'Cookie',
      content: 'Content',
      window: 'Window',
      payload: 'Payload'
    };

    if (localLabels[phaseKind]) {
      return localLabels[phaseKind];
    }

    return phaseKind
      ? phaseKind.replace(/_/g, ' ').replace(/\b\w/g, localChar => localChar.toUpperCase())
      : 'Method';
};

CatalogPresenter.prototype.refreshPhasePreferencesTitle = function(phaseKind) {
    const localTitle = document.querySelector('#methodSettingsTitle');
    if (!localTitle) return;

    const rule = this.currentEditDetector?.detector || {};
    const runningLabel = document.querySelector('#detectorNameInput')?.value.trim();
    const ruleLabel = runningLabel || rule.displayName || rule.name || this.currentEditDetector?.detectorName || '';
    const phaseLabel = this.encodePhasePreferencesPhaseLabel(phaseKind);

    // The word "Settings" was hard-coded English in a popup that ships in
    // several languages, and the sheet's contents already say what it is.
    localTitle.textContent = ruleLabel
      ? `${phaseLabel} \u00b7 ${ruleLabel}`
      : phaseLabel;
};

CatalogPresenter.prototype.openPhasePreferencesDialog = function(phaseEntry, fieldKind = 'name') {
    const dialog = document.querySelector('#methodSettingsModal');
    if (!dialog) return;

    // Store reference to current method item and field type
    this.currentMethodItem = phaseEntry;
    this.currentFieldType = fieldKind;

    // Determine method type from the method item
    const phaseLookup = this.resolvePhaseEntryKind(phaseEntry);
    this.refreshPhasePreferencesTitle(phaseLookup);
    const isContentPhase = phaseLookup === 'content';

    // Load current settings from data attributes
    const evidence = phaseEntry.dataset.confidence || '100';
    const labelRegex = phaseEntry.dataset.nameRegex === 'true';
    const labelWholeword = phaseEntry.dataset.nameWholeword === 'true';
    const labelCase = phaseEntry.dataset.nameCase === 'true';
    const datumRegex = phaseEntry.dataset.valueRegex === 'true';
    const datumWholeword = phaseEntry.dataset.valueWholeword === 'true';
    const datumCase = phaseEntry.dataset.valueCase === 'true';
    const localCheckScripts = phaseEntry.dataset.checkScripts === 'true'; // Default: false (entire page)

    // Load scope settings from data attributes
    let labelBoundary = phaseEntry.dataset.nameScope || (phaseLookup === 'header' || phaseLookup === 'cookie' ? (phaseLookup === 'header' ? 'response' : 'request') : '');
    let datumBoundary = phaseEntry.dataset.valueScope || (phaseLookup === 'header' || phaseLookup === 'cookie' ? (phaseLookup === 'header' ? 'response' : 'request') : '');
    const copyBoundary = phaseEntry.dataset.textScope || 'all';

    if (phaseLookup === 'header') {
      labelBoundary = canonicalizeCookieHeaderBoundary(labelBoundary, 'response');
      datumBoundary = canonicalizeCookieHeaderBoundary(datumBoundary, 'response');
    } else if (phaseLookup === 'cookie') {
      labelBoundary = canonicalizeCookieHeaderBoundary(labelBoundary, 'request');
      datumBoundary = canonicalizeCookieHeaderBoundary(datumBoundary, 'request');
    }

    // Set values in modal
    const evidenceSlider = document.querySelector('#confidenceSlider');
    const evidenceDatum = document.querySelector('#confidenceValue');

    if (evidenceSlider) evidenceSlider.value = evidence;
    if (evidenceDatum) evidenceDatum.textContent = evidence;
    // Setting .value does not fire input, so the fill has to be repainted.
    if (typeof this.paintConfidenceSlider === 'function') {
      this.paintConfidenceSlider();
    }

    // Set checkboxes
    const assignCheckbox = (token, datum) => {
      const localCheckbox = document.querySelector(`#${token}`);
      if (localCheckbox) localCheckbox.checked = datum;
    };

    assignCheckbox('nameRegex', labelRegex);
    assignCheckbox('nameWholeWord', labelWholeword);
    assignCheckbox('nameCaseSensitive', labelCase);
    assignCheckbox('valueRegex', datumRegex);
    assignCheckbox('valueWholeWord', datumWholeword);
    assignCheckbox('valueCaseSensitive', datumCase);
    assignCheckbox('checkScripts', localCheckScripts);

    // Set scope dropdowns
    const labelBoundarySelect = document.querySelector('#nameScope');
    const datumBoundarySelect = document.querySelector('#valueScope');
    const copyBoundarySelect = document.querySelector('#textScope');

    if (labelBoundarySelect) labelBoundarySelect.value = labelBoundary;
    if (datumBoundarySelect) datumBoundarySelect.value = datumBoundary;
    if (copyBoundarySelect) copyBoundarySelect.value = copyBoundary;

    // Show only the relevant scope row based on field type
    const labelBoundaryRow = labelBoundarySelect?.closest('.setting-option') || null;
    const datumBoundaryRow = document.querySelector('#valueScopeRow');
    if (fieldKind === 'value') {
      if (labelBoundaryRow) labelBoundaryRow.style.display = 'none';
      if (datumBoundaryRow) datumBoundaryRow.style.display = 'flex';
    } else {
      if (labelBoundaryRow) labelBoundaryRow.style.display = 'flex';
      if (datumBoundaryRow) datumBoundaryRow.style.display = 'none';
    }

    // Load payload-specific settings from data attributes
    const payloadAddressMatcher = phaseEntry.dataset.payloadUrlPattern || '';
    const payloadAddressRegex = phaseEntry.dataset.payloadUrlRegex === 'true';
    const payloadAddressCaseSensitive = phaseEntry.dataset.payloadUrlCaseSensitive === 'true';
    const payloadPhases = phaseEntry.dataset.payloadMethods || ''; // Comma-separated: "POST,PUT"

    // Set payload URL pattern input
    const payloadAddressField = document.querySelector('#payloadUrlPattern');
    if (payloadAddressField) payloadAddressField.value = payloadAddressMatcher;

    // Set payload URL regex checkbox
    assignCheckbox('payloadUrlRegex', payloadAddressRegex);

    // Set payload URL case sensitive checkbox (if it exists)
    assignCheckbox('payloadUrlCaseSensitive', payloadAddressCaseSensitive);

    // Set payload HTTP method radio buttons (single selection)
    const chosenPhase = payloadPhases ? payloadPhases.split(',')[0] : ''; // Take first method only
    const standardPhases = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

    // Clear all checked states first
    document.querySelectorAll('.http-method-badge').forEach(localBadge => {
      localBadge.classList.remove('checked');
    });
    document.querySelectorAll('input[name="payloadMethod"]').forEach(localRadio => {
      localRadio.checked = false;
    });

    // Check if it's a standard method or custom
    const localIsCustom = chosenPhase && !standardPhases.includes(chosenPhase.toUpperCase());

    if (localIsCustom) {
      // Custom method
      const localCustomRadio = document.querySelector('#payloadMethodCustom');
      const customField = document.querySelector('#customMethodInput');
      const customRegion = document.querySelector('#customMethodInputContainer');
      if (localCustomRadio && customField && customRegion) {
        localCustomRadio.checked = true;
        customField.value = chosenPhase;
        customRegion.style.display = 'block';
        const localBadge = localCustomRadio.closest('.http-method-badge');
        if (localBadge) localBadge.classList.add('checked');
      }
    } else if (chosenPhase) {
      // Standard method
      const capitalizedPhase = chosenPhase.charAt(0).toUpperCase() + chosenPhase.slice(1).toLowerCase();
      const localRadio = document.querySelector(`#payloadMethod${capitalizedPhase}`);
      if (localRadio) {
        localRadio.checked = true;
        const localBadge2 = localRadio.closest('.http-method-badge');
        if (localBadge2) localBadge2.classList.add('checked');
      }
      // Hide custom container
      const customRegion2 = document.querySelector('#customMethodInputContainer');
      if (customRegion2) customRegion2.style.display = 'none';
    } else {
      const localAnyRadio = document.querySelector('#payloadMethodAny');
      if (localAnyRadio) {
        localAnyRadio.checked = true;
        const localBadge3 = localAnyRadio.closest('.http-method-badge');
        if (localBadge3) localBadge3.classList.add('checked');
      }
      const customRegion3 = document.querySelector('#customMethodInputContainer');
      if (customRegion3) customRegion3.style.display = 'none';
    }

    // Show/hide scope settings groups based on method type
    const contentBoundaryGroup = document.querySelector('#contentScopeGroup');
    const headerCookieBoundaryGroup = document.querySelector('#headerCookieScopeGroup');
    const addressBoundaryGroup = document.querySelector('#urlScopeGroup');
    const payloadBoundaryGroup = document.querySelector('#payloadScopeGroup');

    const localIsHeaderOrCookie = phaseLookup === 'header' || phaseLookup === 'cookie';
    const isAddress = phaseLookup === 'url';
    const localIsPayload = phaseLookup === 'payload';

    if (contentBoundaryGroup) {
      contentBoundaryGroup.style.display = isContentPhase ? 'block' : 'none';
    }
    if (headerCookieBoundaryGroup) {
      headerCookieBoundaryGroup.style.display = localIsHeaderOrCookie ? 'block' : 'none';
    }
    if (addressBoundaryGroup) {
      addressBoundaryGroup.style.display = isAddress ? 'block' : 'none';
    }
    if (payloadBoundaryGroup) {
      payloadBoundaryGroup.style.display = localIsPayload ? 'block' : 'none';
    }

    // Get field option groups
    const labelFieldGroup = document.querySelector('#nameFieldOptionsGroup');
    const datumFieldGroup = document.querySelector('#valueFieldOptionsGroup');
    const matcherChoicesTitle = document.querySelector('#patternOptionsTitle');

    // JS Hooks and Window have no pattern options — only show confidence
    const noMatcherChoices = phaseLookup === 'js_hooks' || phaseLookup === 'window';

    // Show/hide field groups based on which field's settings button was clicked
    if (noMatcherChoices) {
      // Hide all pattern option groups for js_hooks and window
      if (labelFieldGroup) labelFieldGroup.style.display = 'none';
      if (datumFieldGroup) datumFieldGroup.style.display = 'none';
    } else if (fieldKind === 'value') {
      // Show only value options
      if (labelFieldGroup) labelFieldGroup.style.display = 'none';
      if (datumFieldGroup) datumFieldGroup.style.display = 'block';
    } else {
      // Show only name options (default)
      if (labelFieldGroup) labelFieldGroup.style.display = 'block';
      if (datumFieldGroup) datumFieldGroup.style.display = 'none';

      if (matcherChoicesTitle) {
        const localTMS = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
        const localTrMS = (lookupKey, localFallback) => (localTMS && localTMS.resolve(lookupKey)) || localFallback;
        if (phaseLookup === 'urls' || phaseLookup === 'url') {
          matcherChoicesTitle.textContent = localTrMS('urlPatternMatching', 'URL Pattern Matching');
        } else if (phaseLookup === 'content') {
          matcherChoicesTitle.textContent = localTrMS('textWordMatching', 'Text/Word Matching');
        } else if (phaseLookup === 'dom') {
          matcherChoicesTitle.textContent = localTrMS('domSelectorMatching', 'DOM Selector Matching');
        } else if (phaseLookup === 'payload') {
          matcherChoicesTitle.textContent = localTrMS('payloadTextMatching', 'Payload Text Matching');
        } else {
          matcherChoicesTitle.textContent = localTrMS('nameFieldMatching', 'Name Field Matching');
        }
      }
    }

    // Hide entire Edit modal while Method Settings is open
    const editDialog = document.querySelector('#editRuleModal');
    if (editDialog) {
      editDialog.style.visibility = 'hidden';
    }

    // Show modal
    dialog.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  };

CatalogPresenter.prototype.refreshPhaseIndicators = function(phaseEntry) {
    const labelField = phaseEntry.querySelector('.method-input.method-name');
    const datumField = phaseEntry.querySelector('.method-input.method-value');

    if (labelField) {
      // Find indicator by data-for attribute (each input has its own badges in input-badges-row)
      const payloadForLabel = labelField.dataset.methodKey + '-' + labelField.dataset.itemIndex;
      const labelIndicator = phaseEntry.querySelector(`.input-indicators[data-for="name-${payloadForLabel}"]`);

      if (labelIndicator) {
        const localIndicators = [];

        const hasDatum = labelField.value.trim().length > 0;
        const hasPreferences = phaseEntry.dataset.nameRegex === 'true' ||
          phaseEntry.dataset.nameWholeword === 'true' ||
          phaseEntry.dataset.nameCase === 'true';

        if (hasDatum || hasPreferences) {
          if (phaseEntry.dataset.nameRegex === 'true') localIndicators.push('RX');
          if (phaseEntry.dataset.nameWholeword === 'true') localIndicators.push('WW');
          if (phaseEntry.dataset.nameCase === 'true') localIndicators.push('CS');
        }

        labelIndicator.innerHTML = localIndicators.map(localInd =>
          `<span class="indicator-badge" data-type="${localInd}">${localInd}</span>`
        ).join('');
      }
    }

    if (datumField) {
      // Find indicator by data-for attribute (each input has its own badges in input-badges-row)
      const payloadForDatum = datumField.dataset.methodKey + '-' + datumField.dataset.itemIndex;
      const datumIndicator = phaseEntry.querySelector(`.input-indicators[data-for="value-${payloadForDatum}"]`);

      if (datumIndicator) {
        const localIndicators2 = [];

        const hasDatum2 = datumField.value.trim().length > 0;
        const hasPreferences2 = phaseEntry.dataset.valueRegex === 'true' ||
          phaseEntry.dataset.valueWholeword === 'true' ||
          phaseEntry.dataset.valueCase === 'true';

        if (hasDatum2 || hasPreferences2) {
          if (phaseEntry.dataset.valueRegex === 'true') localIndicators2.push('RX');
          if (phaseEntry.dataset.valueWholeword === 'true') localIndicators2.push('WW');
          if (phaseEntry.dataset.valueCase === 'true') localIndicators2.push('CS');
        }

        datumIndicator.innerHTML = localIndicators2.map(localInd =>
          `<span class="indicator-badge" data-type="${localInd}">${localInd}</span>`
        ).join('');
      }
    }
  };

CatalogPresenter.prototype.closePhasePreferencesDialog = function() {
    const dialog = document.querySelector('#methodSettingsModal');
    if (dialog) {
      // Restore Edit modal visibility
      const editDialog = document.querySelector('#editRuleModal');
      if (editDialog) {
        editDialog.style.visibility = '';
      }

      dialog.style.display = 'none';
      document.body.style.overflow = '';
      this.currentMethodItem = null;
    }
  };

CatalogPresenter.prototype.persistPhasePreferences = function() {
    if (!this.currentMethodItem) return;

    // Get values from modal
    const evidence = parseInt(document.querySelector('#confidenceSlider')?.value || '100', 10);
    const labelRegex = document.querySelector('#nameRegex')?.checked || false;
    const labelWholeWord = document.querySelector('#nameWholeWord')?.checked || false;
    const labelCaseSensitive = document.querySelector('#nameCaseSensitive')?.checked || false;
    const datumRegex = document.querySelector('#valueRegex')?.checked || false;
    const datumWholeWord = document.querySelector('#valueWholeWord')?.checked || false;
    const datumCaseSensitive = document.querySelector('#valueCaseSensitive')?.checked || false;
    const localCheckScripts = document.querySelector('#checkScripts')?.checked || false; // Default: false (entire page)

    // Get scope values from modal
    let labelBoundary = document.querySelector('#nameScope')?.value || '';
    let datumBoundary = document.querySelector('#valueScope')?.value || '';
    const copyBoundary = document.querySelector('#textScope')?.value || 'all';

    const phaseKind = this.resolvePhaseEntryKind(this.currentMethodItem);
    if (phaseKind === 'header') {
      labelBoundary = canonicalizeCookieHeaderBoundary(labelBoundary, 'response');
      datumBoundary = canonicalizeCookieHeaderBoundary(datumBoundary, 'response');
    } else if (phaseKind === 'cookie') {
      labelBoundary = canonicalizeCookieHeaderBoundary(labelBoundary, 'request');
      datumBoundary = canonicalizeCookieHeaderBoundary(datumBoundary, 'request');
    }

    // Get payload-specific values from modal
    const payloadAddressMatcher = document.querySelector('#payloadUrlPattern')?.value || '';
    const payloadAddressRegex = document.querySelector('#payloadUrlRegex')?.checked || false;
    const payloadAddressCaseSensitive = document.querySelector('#payloadUrlCaseSensitive')?.checked || false;

    // Get selected HTTP method (single selection)
    let payloadPhases = '';
    const chosenRadio = document.querySelector('input[name="payloadMethod"]:checked');
    if (chosenRadio) {
      if (chosenRadio.value === 'CUSTOM') {
        // Get custom method from input
        const customField = document.querySelector('#customMethodInput');
        if (customField && customField.value.trim()) {
          payloadPhases = customField.value.trim().toUpperCase();
        }
      } else {
        payloadPhases = chosenRadio.value;
      }
    }

    // Save to data attributes
    this.currentMethodItem.dataset.confidence = evidence;
    this.currentMethodItem.dataset.nameRegex = labelRegex;
    this.currentMethodItem.dataset.nameWholeword = labelWholeWord;
    this.currentMethodItem.dataset.nameCase = labelCaseSensitive;
    this.currentMethodItem.dataset.valueRegex = datumRegex;
    this.currentMethodItem.dataset.valueWholeword = datumWholeWord;
    this.currentMethodItem.dataset.valueCase = datumCaseSensitive;
    this.currentMethodItem.dataset.checkScripts = localCheckScripts;
    this.currentMethodItem.dataset.nameScope = labelBoundary;
    this.currentMethodItem.dataset.valueScope = datumBoundary;
    this.currentMethodItem.dataset.textScope = copyBoundary;
    this.currentMethodItem.dataset.payloadUrlPattern = payloadAddressMatcher;
    this.currentMethodItem.dataset.payloadUrlRegex = payloadAddressRegex;
    this.currentMethodItem.dataset.payloadUrlCaseSensitive = payloadAddressCaseSensitive;
    this.currentMethodItem.dataset.payloadMethods = payloadPhases;

    // Add visual indicator if settings are configured
    // Get method type to check if content search scope settings apply

    // Update visual indicators for both name and value settings buttons
    const labelPreferencesBtn = this.currentMethodItem.querySelector('.field-actions[data-field-type="name"] .method-action-btn.settings');
    const datumPreferencesBtn = this.currentMethodItem.querySelector('.field-actions[data-field-type="value"] .method-action-btn.settings');

    // Check if name or value have custom settings
    const hasLabelCustomPreferences = labelRegex || labelWholeWord || labelCaseSensitive ||
      (phaseKind === 'content' && localCheckScripts === true);
    const hasDatumCustomPreferences = datumRegex || datumWholeWord || datumCaseSensitive;

    this.refreshPhaseSettingsAction?.(labelPreferencesBtn, evidence, hasLabelCustomPreferences, 'name');
    this.refreshPhaseSettingsAction?.(datumPreferencesBtn, evidence, hasDatumCustomPreferences, 'value');

    // Update input indicators
    this.refreshPhaseIndicators(this.currentMethodItem);

    // Close modal
    this.closePhasePreferencesDialog();
  };

CatalogPresenter.prototype.refreshHttpPhasePalette = function(selectNode) {
    if (!selectNode) return;

    // Remove all method classes
    selectNode.classList.remove('method-get', 'method-post', 'method-put', 'method-patch', 'method-delete');

    // Add appropriate class based on selected value
    const datum = selectNode.value.toLowerCase();
    if (datum) {
      selectNode.classList.add(`method-${datum}`);
    }
  };

/**
 * Re-tint the document when the rule's category changes. The hue is the only
 * thing in the editor that depends on a value rather than on structure, so it
 * has to follow the select rather than the value it was opened with.
 */
CatalogPresenter.prototype.wireTaxonomyTint = function() {
    if (this._categoryTintBound) {
      return;
    }
    this._categoryTintBound = true;

    document.addEventListener('change', (signal) => {
      if (!signal.target || signal.target.id !== 'detectorCategorySelect') {
        return;
      }
      const dialog = document.querySelector('#editRuleModal');
      if (dialog) {
        dialog.setAttribute('data-category', String(signal.target.value || 'other').toLowerCase());
      }
    });
};


/**
 * Pattern fields size themselves to their content.
 *
 * A pattern field is a textarea so a long value wraps instead of being cut —
 * a JS hook is identified by its tail, which is exactly what a single-line
 * input hides. Everything else about it stays single-line: Enter commits
 * rather than inserting a newline, and pasted newlines collapse to spaces.
 */
CatalogPresenter.prototype.wireMatcherFieldSizing = function() {
    if (this._patternSizingBound) {
      return;
    }
    this._patternSizingBound = true;

    const localFit = (node) => {
      if (!node) return;
      node.style.height = 'auto';
      node.style.height = `${node.scrollHeight}px`;
      localPaint(node);
    };

    /**
     * Paint the pattern's identifying tail.
     *
     * Every JS hook in a method reads `Something.prototype.something`, and the
     * shared middle is the widest part of the line — four patterns that differ
     * only past the last dot look like four copies of one string. The echo
     * sits under the field and prints the same text with the namespace dimmed,
     * so what is left bright is exactly what tells them apart.
     *
     * The field still holds the real value and is still the thing you type
     * into; the echo is decoration and is hidden from assistive tech. While
     * the field has focus the echo steps aside, so editing never fights a
     * second copy of the text.
     */
    const LOCAL_SEPARATORS = ['.', '/', ':', '\\'];
    const localSplitIdentity = (datum) => {
      const copy = String(datum == null ? '' : datum);
      let localCut = -1;
      for (const localSep of LOCAL_SEPARATORS) {
        const localAt = copy.lastIndexOf(localSep);
        if (localAt > localCut) localCut = localAt;
      }
      // Nothing to dim if there is no separator, if it is the first character,
      // or if it leaves no tail to emphasise.
      if (localCut <= 0 || localCut >= copy.length - 1) {
        return { head: '', tail: copy };
      }
      // A very short tail is a suffix, not an identity — splitting
      // challenges.cloudflare.com at the last dot would dim the host and
      // light up "com", which is the wrong way round. Leave those whole.
      const localTail = copy.slice(localCut + 1);
      if (localTail.length <= 3) {
        return { head: '', tail: copy };
      }
      return { head: copy.slice(0, localCut + 1), tail: localTail };
    };

    const localPaint = (node) => {
      if (!node) return;
      const localRow = node.parentElement;
      const localEcho = localRow && localRow.querySelector(':scope > .doc-echo');
      if (!localEcho) return;

      const { head: localHead, tail: localTail } = localSplitIdentity(node.value);
      localEcho.textContent = '';
      if (localHead) {
        const localHeadSpan = document.createElement('span');
        localHeadSpan.className = 'doc-echo-head';
        localHeadSpan.textContent = localHead;
        localEcho.appendChild(localHeadSpan);
      }
      const localTailSpan = document.createElement('span');
      localTailSpan.className = 'doc-echo-tail';
      localTailSpan.textContent = localTail;
      localEcho.appendChild(localTailSpan);
    };

    this.fitPatternField = localFit;
    this.paintPatternField = localPaint;

    document.addEventListener('input', (signal) => {
      const localField = signal.target.closest && signal.target.closest('textarea.method-input');
      if (!localField) return;
      if (localField.value.includes('\n')) {
        const localAt = localField.selectionStart;
        localField.value = localField.value.replace(/\s*\n+\s*/g, ' ');
        localField.setSelectionRange(localAt, localAt);
      }
      localFit(localField);
    });

    document.addEventListener('keydown', (signal) => {
      const localField = signal.target.closest && signal.target.closest('textarea.method-input');
      if (!localField || signal.key !== 'Enter' || signal.shiftKey) return;
      signal.preventDefault();
      localField.blur();
    });

    // The echo has to step aside while the field is being edited, or the two
    // copies of the text disagree on selection and caret position.
    document.addEventListener('focusin', (signal) => {
      const localField = signal.target.closest && signal.target.closest('textarea.method-input');
      if (localField) localField.classList.add('is-editing');
    });

    document.addEventListener('focusout', (signal) => {
      const localField = signal.target.closest && signal.target.closest('textarea.method-input');
      if (!localField) return;
      localField.classList.remove('is-editing');
      localPaint(localField);
    });

    // Fields rendered or paged in after load still need their first fit.
    this.fitAllPatternFields = () => {
      document.querySelectorAll('textarea.method-input').forEach(localFit);
    };
};
