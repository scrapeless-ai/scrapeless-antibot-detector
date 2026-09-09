/**
 * Window-rule helper modal extension methods.
 * Dependencies: `src/console/policies/presenter.js` must be loaded first.
 */

const policiesSupportTr = (lookupKey, localFallback) => (
  typeof LocaleRuntime !== 'undefined' ? LocaleRuntime.performTr(lookupKey, localFallback) : localFallback
);

const policiesSupportEncode = (lookupKey, localFallback, ...operands) => {
  if (typeof LocaleRuntime !== 'undefined' && typeof LocaleRuntime.encode === 'function') {
    const localFormatted = LocaleRuntime.encode(lookupKey, ...operands);
    if (localFormatted !== null) return localFormatted;
  }
  let localMsg = localFallback;
  for (let cursor = 0; cursor < operands.length; cursor++) {
    localMsg = localMsg.split('{' + cursor + '}').join(String(operands[cursor]));
  }
  return localMsg;
};

CatalogPresenter.prototype.openConditionSupportDialog = function(phaseEntry, fieldPosition) {
  // Store reference to current method item
  this.currentConditionMethodItem = phaseEntry;

  // Hide parent modal backdrop to prevent blur stacking
  const localEditBackdrop = document.querySelector('#editRuleModal .rule-modal-backdrop');
  if (localEditBackdrop) localEditBackdrop.style.display = 'none';

  const localDescribeCondition = (datum) => {
    const entryValue = (datum || '').trim();
    if (!entryValue) return 'Truthy (default)';
    if (entryValue === 'exists' || entryValue === '!== undefined' || entryValue === 'not undefined') return 'Property is defined (not undefined)';
    if (entryValue === '=== undefined') return 'Property is undefined';
    if (entryValue === '!== null' || entryValue === 'not null') return 'Property is not null';
    if (entryValue === '=== null') return 'Property is null';
    if (entryValue === 'truthy') return 'Property is truthy';
    if (entryValue === 'falsy') return 'Property is falsy';
    if (entryValue.startsWith('typeof ')) return `Type check: ${entryValue}`;
    if (entryValue === 'array') return 'Property is an array';
    if (entryValue === 'non-empty array') return 'Array has items';
    if (entryValue === 'empty array') return 'Array is empty';
    if (entryValue === 'has keys') return 'Object has at least one key';
    if (entryValue === 'empty object') return 'Object has no keys';
    if (entryValue === 'has length') return 'Value has a numeric length';
    if (entryValue.startsWith('length ')) return `Length comparison: ${entryValue}`;
    if (/^(>=|<=|>|<|===|!==)\\s*-?\\d/.test(entryValue)) return `Numeric comparison: ${entryValue}`;
    return 'Condition';
  };

  // Condition examples for WINDOW method (prefer shared language presets)
  const localLang = globalThis.PropertyPredicateLanguage;
  const data = (localLang && typeof localLang.getPresetValues === 'function')
    ? localLang.getPresetValues()
    // Fallback must mirror PRESET_GROUPS in window-condition-language.js
    : [
        'typeof object',
        'typeof function',
        'typeof string',
        'typeof number',
        'typeof boolean',
        'typeof symbol',
        'typeof bigint',
        'exists',
        'truthy',
        'falsy',
        '!== undefined',
        '=== undefined',
        '!== null',
        '=== null',
        'array',
        'non-empty array',
        'empty array',
        'has length',
        'has keys',
        'empty object',
        '> 0',
        '>= 0',
        '=== 0',
        '!== 0',
        '> 1',
        '>= 1',
        'length > 0',
        'length === 0',
        '=== true',
        '=== false'
      ];

  const localConditionExamples = data.map((datum) => ({ value: datum, description: localDescribeCondition(datum) }));

  // Create modal using DOM methods
  const dialogRegion = document.createElement('div');
  dialogRegion.classList.add('condition-helper-modal-container');

  const dialog = document.createElement('div');
  dialog.className = 'condition-helper-modal';
  dialog.style.cssText = 'display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; align-items: center; justify-content: center; backdrop-filter: blur(2px);';

  const localContent = document.createElement('div');
  localContent.className = 'condition-helper-content';
  localContent.style.cssText = 'background: var(--bg-primary); border-radius: 12px; padding: 24px; max-width: 500px; max-height: 80vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.5);';

  const localTitle = document.createElement('h3');
  localTitle.textContent = policiesSupportTr('rulesWindowConditionExamplesTitle', 'Window Condition Examples');
  localTitle.style.cssText = 'margin: 0 0 16px 0; font-size: 16px; color: var(--text-primary);';

  const localDescription = document.createElement('p');
  localDescription.textContent = policiesSupportTr('rulesWindowConditionExamplesHint', 'Click on an example to use it:');
  localDescription.style.cssText = 'margin: 0 0 16px 0; font-size: 12px; color: var(--text-secondary);';

  const examplesRegion = document.createElement('div');
  examplesRegion.className = 'condition-examples';
  examplesRegion.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;';

  // Create example elements
  localConditionExamples.forEach(localExample => {
    const localExampleDiv = document.createElement('div');
    localExampleDiv.className = 'condition-example';
    localExampleDiv.dataset.value = localExample.value;
    localExampleDiv.style.cssText = 'cursor: pointer; padding: 10px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; transition: all 0.2s;';

    const datumDiv = document.createElement('div');
    datumDiv.textContent = localExample.value;
    datumDiv.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--accent); margin-bottom: 2px; font-family: Monaco, Courier New, monospace;';

    const localDescDiv = document.createElement('div');
    localDescDiv.textContent = localExample.description;
    localDescDiv.style.cssText = 'font-size: 11px; color: var(--text-muted);';

    localExampleDiv.appendChild(datumDiv);
    localExampleDiv.appendChild(localDescDiv);
    examplesRegion.appendChild(localExampleDiv);

    // Add hover and click handlers
    localExampleDiv.addEventListener('mouseenter', () => {
      localExampleDiv.style.borderColor = 'var(--accent)';
      localExampleDiv.style.background = 'var(--bg-tertiary)';
      localExampleDiv.style.transform = 'translateX(4px)';
    });
    localExampleDiv.addEventListener('mouseleave', () => {
      localExampleDiv.style.borderColor = 'var(--border)';
      localExampleDiv.style.background = 'var(--bg-secondary)';
      localExampleDiv.style.transform = 'translateX(0)';
    });
    localExampleDiv.addEventListener('click', () => {
      const conditionDatum = localExampleDiv.dataset.value;
      if (this.currentConditionMethodItem) {
        const datumField = this.currentConditionMethodItem.querySelector('.method-input.method-value');
        if (datumField) {
          datumField.value = conditionDatum;
        }
        this.performSyncInlineConditionDropdown?.(this.currentConditionMethodItem);
        this.refreshPhaseIndicators?.(this.currentConditionMethodItem);
      }
      document.body.removeChild(dialogRegion);
      this.currentConditionMethodItem = null;
      // Restore parent modal backdrop
      const localEditBackdrop = document.querySelector('#editRuleModal .rule-modal-backdrop');
      if (localEditBackdrop) localEditBackdrop.style.display = '';
    });
  });

  const localCloseBtn = document.createElement('button');
  localCloseBtn.id = 'closeConditionHelper';
  localCloseBtn.textContent = policiesSupportTr('btnClose', 'Close');
  localCloseBtn.style.cssText = 'width: 100%; padding: 10px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;';
  localCloseBtn.addEventListener('click', () => {
    document.body.removeChild(dialogRegion);
    this.currentConditionMethodItem = null;
    // Restore parent modal backdrop
    const localEditBackdrop = document.querySelector('#editRuleModal .rule-modal-backdrop');
    if (localEditBackdrop) localEditBackdrop.style.display = '';
  });

  // Assemble modal
  localContent.appendChild(localTitle);
  localContent.appendChild(localDescription);
  localContent.appendChild(examplesRegion);
  localContent.appendChild(localCloseBtn);
  dialog.appendChild(localContent);
  dialogRegion.appendChild(dialog);

  // Close on backdrop click
  dialog.addEventListener('click', (failure) => {
    if (failure.target === dialog) {
      document.body.removeChild(dialogRegion);
      this.currentConditionMethodItem = null;
      // Restore parent modal backdrop
      const localEditBackdrop = document.querySelector('#editRuleModal .rule-modal-backdrop');
      if (localEditBackdrop) localEditBackdrop.style.display = '';
    }
  });

  document.body.appendChild(dialogRegion);
};

// ============================================
// Window Helper Modal
// ============================================

CatalogPresenter.prototype.wireGlobalSupportDialog = function() {
  const dialog = document.querySelector('#windowHelperModal');
  const localCloseBtn = document.querySelector('#closeWindowHelper');
  const localCancelBtn = document.querySelector('#cancelWindowHelper');
  const localUseBtn = document.querySelector('#useWindowProperty');
  const localBackBtn = document.querySelector('#backWindowHelper');
  const localBackdrop = dialog?.querySelector('.rule-modal-backdrop');
  const keywordField = document.querySelector('#windowKeywordInput');
  const customField = document.querySelector('#windowCustomInput');

  // Close modal events
  if (localCloseBtn) {
    localCloseBtn.addEventListener('click', () => this.closeGlobalSupportDialog());
  }
  if (localCancelBtn) {
    localCancelBtn.addEventListener('click', () => this.closeGlobalSupportDialog());
  }
  if (localBackdrop) {
    localBackdrop.addEventListener('click', () => this.closeGlobalSupportDialog());
  }

  // Back button
  if (localBackBtn) {
    localBackBtn.addEventListener('click', () => this.goBackGlobalSupport());
  }

  // Use property button
  if (localUseBtn) {
    localUseBtn.addEventListener('click', () => this.useGlobalSignal());
  }

  // Custom input - update preview on change
  if (customField) {
    customField.addEventListener('input', () => this.refreshGlobalPolicyPreview());
  }

  // Keyword input for filtering suggestions
  if (keywordField) {
    keywordField.addEventListener('input', (failure) => {
      const localKeyword = failure.target.value.trim();
      this.presentGlobalSuggestions(localKeyword);
      this.refreshGlobalSupportSteps(localKeyword.length > 0 ? 2 : 1);
    });
  }

  // Setup click handlers for suggestions (using event delegation)
  document.addEventListener('click', (failure) => {
    if (failure.target.closest('.window-suggestion')) {
      failure.stopPropagation();
      const localSuggestion = failure.target.closest('.window-suggestion');
      const signal = localSuggestion.dataset.property;
      const customField = document.querySelector('#windowCustomInput');
      if (signal && customField) {
        customField.value = signal;
        // Advance to step 3 (condition selection)
        this.refreshGlobalSupportSteps(3);
      }
    }
  });
};

CatalogPresenter.prototype.refreshGlobalSupportSteps = function(runningStep) {
  const stepsRegion = document.querySelector('#windowHelperModal .dom-helper-steps');
  const localStep1 = document.querySelector('#windowStep1');
  const localStep2 = document.querySelector('#windowStep2');
  const localStep3 = document.querySelector('#windowStep3');
  const localConditionSection = document.querySelector('#windowConditionSection');
  const localBackBtn = document.querySelector('#backWindowHelper');
  const localUseBtn = document.querySelector('#useWindowProperty');

  if (localStep1 && localStep2 && localStep3 && stepsRegion) {
    // Update progress indicator
    stepsRegion.setAttribute('data-progress', runningStep);

    // Step 1
    localStep1.classList.toggle('active', runningStep === 1);
    localStep1.classList.toggle('completed', runningStep > 1);

    // Step 2
    localStep2.classList.toggle('active', runningStep === 2);
    localStep2.classList.toggle('completed', runningStep > 2);

    // Step 3
    localStep3.classList.toggle('active', runningStep === 3);
    localStep3.classList.remove('completed'); // Last step never shows completed

    // Show/hide condition section
    if (localConditionSection) {
      localConditionSection.style.display = runningStep === 3 ? 'block' : 'none';
    }

    // Update back button visibility
    if (localBackBtn) {
      localBackBtn.classList.toggle('hidden', runningStep === 1);
    }

    // Update button text based on step
    if (localUseBtn) {
      switch (runningStep) {
        case 1:
          localUseBtn.textContent = policiesSupportEncode(
            'rulesBtnNextFmt',
            'Next: {0}',
            policiesSupportTr('rulesStepChooseProperty', 'Choose Property')
          );
          break;
        case 2:
          localUseBtn.textContent = policiesSupportEncode(
            'rulesBtnNextFmt',
            'Next: {0}',
            policiesSupportTr('rulesStepSelectCondition', 'Select Condition')
          );
          break;
        case 3:
          localUseBtn.textContent = policiesSupportTr('rulesUsePropertyBtn', 'Use Property');
          break;
      }
    }

    // Update preview
    this.refreshGlobalPolicyPreview();
  }
};

CatalogPresenter.prototype.refreshGlobalPolicyPreview = function() {
  const customField = document.querySelector('#windowCustomInput');
  const localConditionSelect = document.querySelector('#windowConditionSelect');
  const localPreviewContent = document.querySelector('#windowPreviewContent');

  if (customField && localPreviewContent) {
    const signal = customField.value.trim();
    const localCondition = localConditionSelect?.value || 'exists';

    if (signal) {
      localPreviewContent.textContent = `Window: "${signal}" (${localCondition})`;
      localPreviewContent.style.color = '';
    } else {
      localPreviewContent.textContent = '';
    }
  }
};

CatalogPresenter.prototype.goBackGlobalSupport = function() {
  const localStep2 = document.querySelector('#windowStep2');
  const localStep3 = document.querySelector('#windowStep3');

  if (localStep3?.classList.contains('active')) {
    this.refreshGlobalSupportSteps(2);
  } else if (localStep2?.classList.contains('active')) {
    this.refreshGlobalSupportSteps(1);
    const keywordField = document.querySelector('#windowKeywordInput');
    if (keywordField) {
      keywordField.focus();
    }
  }
};

CatalogPresenter.prototype.generateGlobalTemplates = function(localKeyword) {
  if (!localKeyword || localKeyword.trim() === '') return [];

  const localCssKeyword = localKeyword.replace(/\s+/g, '-').toLowerCase();

  const localTemplates = [
    { property: localCssKeyword, label: `Property "${localKeyword}"` },
    { property: `window.${localCssKeyword}`, label: `window.${localCssKeyword}` },
    { property: `navigator.${localCssKeyword}`, label: `navigator.${localCssKeyword}` },
    { property: `document.${localCssKeyword}`, label: `document.${localCssKeyword}` },
    { property: `globalThis.${localCssKeyword}`, label: `globalThis.${localCssKeyword}` }
  ];

  return localTemplates;
};

CatalogPresenter.prototype.presentGlobalSuggestions = function(localKeyword) {
  const suggestionsRegion = document.querySelector('#windowSuggestions');
  if (!suggestionsRegion) return;

  suggestionsRegion.innerHTML = '';

  if (!localKeyword || localKeyword.trim() === '') {
    suggestionsRegion.innerHTML = `
      <div class="suggestions-empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M13,9H11V7H13M13,17H11V11H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/>
        </svg>
        <div class="empty-title">Start typing to see suggestions</div>
        <div class="empty-hint">We'll show common window properties matching your search</div>
        <div class="empty-examples">
          Try: <code>chrome</code> <code>webkit</code> <code>eval</code> <code>cdc_</code>
        </div>
      </div>
    `;
    return;
  }

  const localTemplates = this.generateGlobalTemplates(localKeyword);

  localTemplates.forEach(localTemplate => {
    const localSuggestionControl = document.createElement('button');
    localSuggestionControl.type = 'button';
    localSuggestionControl.className = 'window-suggestion';
    localSuggestionControl.dataset.property = localTemplate.property;
    localSuggestionControl.innerHTML = `
      <span class="window-suggestion-property">${TextCodec.escapeMarkup(localTemplate.property)}</span>
      <span class="window-suggestion-label">${TextCodec.escapeMarkup(localTemplate.label)}</span>
    `;
    suggestionsRegion.appendChild(localSuggestionControl);
  });
};

CatalogPresenter.prototype.openGlobalSupportDialog = function(phaseEntry, fieldPosition) {
  const dialog = document.querySelector('#windowHelperModal');
  if (!dialog) return;

  this.currentWindowMethodItem = phaseEntry;

  const labelField = phaseEntry.querySelector('.method-input.method-name');
  const activeDatum = labelField?.value || '';

  // Clear keyword input FIRST (existing value goes only in custom input, not here)
  const keywordField = document.querySelector('#windowKeywordInput');
  if (keywordField) {
    keywordField.value = '';
  }

  // Set custom input to current value (existing property goes here)
  const customField = document.querySelector('#windowCustomInput');
  if (customField) {
    customField.value = activeDatum;
  }

  this.presentGlobalSuggestions('');
  this.refreshGlobalSupportSteps(1);
  this.restoreConditionDropdown();

  // Update preview if there's an existing value
  this.refreshGlobalPolicyPreview();

  // Hide parent modal backdrop to prevent blur stacking
  const localEditBackdrop = document.querySelector('#editRuleModal .rule-modal-backdrop');
  if (localEditBackdrop) localEditBackdrop.style.display = 'none';

  dialog.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Focus keyword input after modal is visible
  if (keywordField) {
    keywordField.focus();
  }
};

CatalogPresenter.prototype.restoreConditionDropdown = function() {
  const region = document.querySelector('#conditionDropdownContainer');
  const hiddenField = document.querySelector('#windowConditionSelect');
  const chosenCopy = document.querySelector('.condition-selected-text');
  const localMenu = document.querySelector('#conditionDropdownMenu');

  if (hiddenField) {
    hiddenField.value = 'exists';
  }

  if (chosenCopy) {
    chosenCopy.textContent = policiesSupportTr('rulesConditionExists', 'Exists');
  }

  if (localMenu) {
    localMenu.querySelectorAll('.condition-option').forEach(localOpt => {
      localOpt.classList.toggle('selected', localOpt.dataset.value === 'exists');
    });
  }

  if (region) {
    region.classList.remove('open');
  }
};

CatalogPresenter.prototype.useGlobalSignal = function() {
  const customField = document.querySelector('#windowCustomInput');
  const signal = customField?.value.trim();
  const localStep3 = document.querySelector('#windowStep3');
  const localIsOnStep3 = localStep3?.classList.contains('active');

  if (!signal) {
    Toasts.caution('Please select or enter a property');
    document.querySelector('#windowKeywordInput')?.focus();
    return;
  }

  // If we're not on step 3 yet, move to step 3 (condition selection)
  if (!localIsOnStep3) {
    this.refreshGlobalSupportSteps(3);
    return;
  }

  // We're on step 3, now apply both property and condition
  const localConditionSelect = document.querySelector('#windowConditionSelect');
  const localCondition = localConditionSelect?.value || 'exists';

  if (this.currentWindowMethodItem) {
    const labelField = this.currentWindowMethodItem.querySelector('.method-input.method-name');
    const datumField = this.currentWindowMethodItem.querySelector('.method-input.method-value');

    if (labelField) {
      labelField.value = signal;
    }
    if (datumField) {
      datumField.value = localCondition;
    }

    this.performSyncInlineConditionDropdown?.(this.currentWindowMethodItem);
    this.refreshPhaseIndicators(this.currentWindowMethodItem);
  }

  this.closeGlobalSupportDialog();
};

CatalogPresenter.prototype.closeGlobalSupportDialog = function() {
  const dialog = document.querySelector('#windowHelperModal');
  if (dialog) {
    dialog.style.display = 'none';
    document.body.style.overflow = '';
    this.currentWindowMethodItem = null;

    // Restore parent modal backdrop
    const localEditBackdrop = document.querySelector('#editRuleModal .rule-modal-backdrop');
    if (localEditBackdrop) localEditBackdrop.style.display = '';
  }
};

// ============================================
// Regex Helper Modal
// ============================================
