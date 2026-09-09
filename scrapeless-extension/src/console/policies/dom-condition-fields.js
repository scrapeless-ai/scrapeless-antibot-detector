/**
 * DOM-rule helper modal extension methods.
 * Dependencies: `src/console/policies/presenter.js` must be loaded first.
 */

CatalogPresenter.prototype.wireDomSupportDialog = function() {
  const dialog = document.querySelector('#domHelperModal');
  const localCloseBtn = document.querySelector('#closeDomHelper');
  const localCancelBtn = document.querySelector('#cancelDomHelper');
  const localUseBtn = document.querySelector('#useDomSelector');
  const localBackdrop = dialog?.querySelector('.rule-modal-backdrop');
  const keywordField = document.querySelector('#domKeywordInput');

  // Close modal events
  if (localCloseBtn) {
    localCloseBtn.addEventListener('click', () => this.closeDomSupportDialog());
  }
  if (localCancelBtn) {
    localCancelBtn.addEventListener('click', () => this.closeDomSupportDialog());
  }
  if (localBackdrop) {
    localBackdrop.addEventListener('click', () => this.closeDomSupportDialog());
  }

  // Use selector button
  if (localUseBtn) {
    localUseBtn.addEventListener('click', () => this.performUseDomSelector());
  }

  // Keyword input for filtering suggestions
  if (keywordField) {
    keywordField.addEventListener('input', (failure) => {
      const localKeyword = failure.target.value.trim();
      this.presentDomSuggestions(localKeyword);
    });
  }

  // Setup click handlers for DOM helper button and templates (using event delegation)
  document.addEventListener('click', (failure) => {
    // Handle DOM helper button clicks
    if (failure.target.closest('.dom-helper-btn')) {
      failure.stopPropagation();
      const control = failure.target.closest('.dom-helper-btn');
      const fieldPosition = control.dataset.inputIndex;
      const phaseEntry = control.closest('.method-item');
      if (phaseEntry) {
        this.openDomSupportDialog(phaseEntry, fieldPosition);
      }
    }

    // Handle Window helper button clicks
    if (failure.target.closest('.window-helper-btn')) {
      failure.stopPropagation();
      const control2 = failure.target.closest('.window-helper-btn');
      const fieldPosition2 = control2.dataset.inputIndex;
      const phaseEntry2 = control2.closest('.method-item');
      if (phaseEntry2) {
        this.openGlobalSupportDialog(phaseEntry2, fieldPosition2);
      }
    }

    // Handle condition helper button clicks (for WINDOW method)
    if (failure.target.closest('.condition-helper-btn')) {
      failure.stopPropagation();
      const control3 = failure.target.closest('.condition-helper-btn');
      const fieldPosition3 = control3.dataset.inputIndex;
      const phaseEntry3 = control3.closest('.method-item');
      if (phaseEntry3) {
        this.openConditionSupportDialog(phaseEntry3, fieldPosition3);
      }
    }

    // Handle template/suggestion clicks - directly apply selector
    if (failure.target.closest('.dom-template, .dom-suggestion')) {
      failure.stopPropagation();
      const localSuggestion = failure.target.closest('.dom-template, .dom-suggestion');
      const localSelector = localSuggestion.dataset.selector || localSuggestion.querySelector('.template-code')?.textContent;
      if (localSelector) {
        this.performUseDomSelector(localSelector);
      }
    }
  });
};

CatalogPresenter.prototype.openDomSupportDialog = function(phaseEntry, fieldPosition) {
  const dialog = document.querySelector('#domHelperModal');
  if (!dialog) return;

  // Store reference to current method item
  this.currentDomMethodItem = phaseEntry;

  // Get current DOM selector value
  const labelField = phaseEntry.querySelector('.method-input.method-name');
  const activeDatum = labelField?.value || '';

  // Put current value in keyword input for searching
  const keywordField = document.querySelector('#domKeywordInput');
  if (keywordField) {
    keywordField.value = activeDatum;
  }

  // Display initial suggestions (empty keyword shows all examples)
  this.presentDomSuggestions('');

  // Hide parent modal backdrop to prevent blur stacking
  const localEditBackdrop = document.querySelector('#editRuleModal .rule-modal-backdrop');
  if (localEditBackdrop) localEditBackdrop.style.display = 'none';

  // Show modal
  dialog.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Focus keyword input after modal is visible
  if (keywordField) {
    keywordField.focus();
  }
};

CatalogPresenter.prototype.performUseDomSelector = function(selectorDatum) {
  // Use provided selector or fall back to keyword input
  const keywordField = document.querySelector('#domKeywordInput');
  const localSelector = selectorDatum || keywordField?.value.trim();

  if (!localSelector) {
    Toasts.failure('Please enter a selector');
    return;
  }

  // Update the DOM input field
  if (this.currentDomMethodItem) {
    const labelField = this.currentDomMethodItem.querySelector('.method-input.method-name');
    if (labelField) {
      labelField.value = localSelector;
    }
  }

  // Close modal
  this.closeDomSupportDialog();
};

CatalogPresenter.prototype.closeDomSupportDialog = function() {
  const dialog = document.querySelector('#domHelperModal');
  if (dialog) {
    dialog.style.display = 'none';
    document.body.style.overflow = '';
    this.currentDomMethodItem = null;

    // Restore parent modal backdrop
    const localEditBackdrop = document.querySelector('#editRuleModal .rule-modal-backdrop');
    if (localEditBackdrop) localEditBackdrop.style.display = '';
  }
};

// ============================================
// Condition Helper Modal (for WINDOW method)
// ============================================
