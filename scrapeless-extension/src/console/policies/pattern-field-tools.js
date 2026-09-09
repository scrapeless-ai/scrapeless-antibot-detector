/**
 * Pattern Helper Modals - Regex, Whole Word, Case Sensitive
 * Merges 3 identical helper files into one data-driven module.
 *
 * Dependencies: rules-modal-lifecycle.js, rules.js
 */

// ============================================
// Shared factory for pattern helper modals
// ============================================

CatalogPresenter.prototype._wireMatcherSupport = function(profile) {
  const dialog = new PolicyDialogCoordinator(profile.modalSelector);
  dialog.wireCloseSubscriptions(...profile.closeSelectors);

  if (profile.openSelectors) {
    for (const localSel of profile.openSelectors) {
      dialog.wireOpenSubscription(localSel);
    }
  }

  const field = document.querySelector(profile.inputSelector);
  if (field) {
    field.addEventListener('input', (failure) => {
      const localKeyword = failure.target.value.toLowerCase().trim();
      profile.filterFn.call(this, localKeyword);
    });
  }

  dialog.onOpen = () => {
    if (field) {
      field.value = '';
      field.focus();
    }
    if (profile.stepSelectors) {
      const localStep1 = document.querySelector(profile.stepSelectors[0]);
      const localStep2 = document.querySelector(profile.stepSelectors[1]);
      if (localStep1) localStep1.classList.add('active');
      if (localStep2) localStep2.classList.remove('active');
    }
    profile.filterFn.call(this, '');
    profile.onOpen?.call(this);
  };

  return dialog;
};

// ============================================
// Regex Helper
// ============================================

CatalogPresenter.prototype.generateDynamicRegexMatchers = function(field) {
  const localEscaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    { pattern: `^${localEscaped}`, description: `Starts with "${field}"` },
    { pattern: `${localEscaped}$`, description: `Ends with "${field}"` },
    { pattern: `.*${localEscaped}.*`, description: `Contains "${field}" anywhere` },
    { pattern: `\\b${localEscaped}\\b`, description: `Whole word match "${field}"` },
    { pattern: `(${localEscaped}|alternative)`, description: `"${field}" OR another option` },
    { pattern: `^${localEscaped}.+$`, description: `Starts with "${field}" + more characters` }
  ];
};

CatalogPresenter.prototype.filterRegexMatchers = function(localKeyword) {
  const suggestionsRegion = document.querySelector('#regexSuggestions');
  if (!suggestionsRegion) return;

  if (!localKeyword) {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localMsg = (localT && localT.resolve('helperPatternStartTypingSuggestions')) || 'Start typing above to see suggestions...';
    const localDiv = document.createElement('div');
    localDiv.style.cssText = 'text-align: center; padding: 20px; color: var(--text-muted); font-size: 12px;';
    localDiv.textContent = localMsg;
    suggestionsRegion.replaceChildren(localDiv);
    return;
  }

  const matchers = this.generateDynamicRegexMatchers(localKeyword);
  const safeMarkup = matchers.map(localP => {
    const safeMatcher = TextCodec.escapeMarkup(localP.pattern);
    const localSafeDescription = TextCodec.escapeMarkup(localP.description);
    return `
    <div class="regex-pattern" data-pattern="${safeMatcher}">
      <div class="template-code">${safeMatcher}</div>
      <div class="template-description">${localSafeDescription}</div>
    </div>
  `;
  }).join('');
  suggestionsRegion.innerHTML = safeMarkup;
};

CatalogPresenter.prototype.assignRegexSupportDestinationActive = function(destination) {
  if (destination === 'payloadUrl') {
    const payloadAddressRegex = document.querySelector('#payloadUrlRegex');
    if (payloadAddressRegex) payloadAddressRegex.checked = true;
    return;
  }

  if (!this.currentMethodItem) return;

  if (destination === 'value') {
    this.currentMethodItem.dataset.valueRegex = 'true';
    const datumRegex = document.querySelector('#valueRegex');
    if (datumRegex) datumRegex.checked = true;
  } else {
    this.currentMethodItem.dataset.nameRegex = 'true';
    const labelRegex = document.querySelector('#nameRegex');
    if (labelRegex) labelRegex.checked = true;
  }

  this.refreshPhaseIndicators(this.currentMethodItem);
};

CatalogPresenter.prototype.applyRegexSupportMatcher = function(matcherCopy) {
  const destination = this.currentPatternHelperTarget || 'name';

  if (destination === 'payloadUrl') {
    const payloadAddressField = document.querySelector('#payloadUrlPattern');
    if (!payloadAddressField) return false;
    payloadAddressField.value = matcherCopy;
    this.assignRegexSupportDestinationActive(destination);
    return true;
  }

  if (!this.currentMethodItem) return false;

  const fieldSelector = destination === 'value'
    ? '.method-input.method-value'
    : '.method-input.method-name';
  const field = this.currentMethodItem.querySelector(fieldSelector);
  if (!field) return false;

  field.value = matcherCopy;
  this.assignRegexSupportDestinationActive(destination);
  return true;
};

CatalogPresenter.prototype.wireRegexSupportDialog = function() {
  this._regexHelperModal = this._wireMatcherSupport({
    modalSelector: '#regexHelperModal',
    closeSelectors: ['#closeRegexHelper', '#closeRegexHelperBtn'],
    inputSelector: '#regexKeywordInput',
    stepSelectors: ['#regexStep1', '#regexStep2'],
    filterFn: this.filterRegexMatchers,
    onOpen: function() {
      this.assignRegexSupportDestinationActive(this.currentPatternHelperTarget || this.currentFieldType || 'name');
    }
  });

  // Regex-specific: Enter key selects first pattern
  const keywordField = document.querySelector('#regexKeywordInput');
  if (keywordField) {
    keywordField.addEventListener('keydown', (failure) => {
      if (failure.key === 'Enter') {
        failure.preventDefault();
        const firstMatcher = document.querySelector('.regex-pattern');
        if (firstMatcher) firstMatcher.click();
      }
    });
  }

  // Regex-specific: Event delegation for open buttons and pattern clicks
  document.addEventListener('click', (failure) => {
    const supportBtn = failure.target.closest('#regexHelperBtn, #regexHelperBtnValue, #payloadUrlRegexHelperBtn');
    if (supportBtn) {
      failure.stopPropagation();
      this.currentPatternHelperTarget = supportBtn.id === 'regexHelperBtnValue'
        ? 'value'
        : supportBtn.id === 'payloadUrlRegexHelperBtn'
          ? 'payloadUrl'
          : 'name';
      this._regexHelperModal.performOpen();
    }

    if (failure.target.closest('.regex-pattern')) {
      failure.stopPropagation();
      const matcher = failure.target.closest('.regex-pattern');
      const matcherCopy = matcher.dataset.pattern;

      if (matcherCopy && this.applyRegexSupportMatcher(matcherCopy)) {
        Toasts.completion('Pattern applied');
        this._regexHelperModal.performClose();
      }
    }
  });
};

// ============================================
// Whole Word Helper
// ============================================

CatalogPresenter.prototype.performGenerateWholeWordExamples = function(field) {
  return [
    { text: field, match: true, reason: 'Exact word, surrounded by boundaries' },
    { text: `test${field}`, match: false, reason: 'Connected to "test", not isolated' },
    { text: `${field}More`, match: false, reason: 'Connected to "More", not isolated' },
    { text: `test ${field} more`, match: true, reason: 'Separated by spaces (word boundaries)' }
  ];
};

CatalogPresenter.prototype.filterWholeWordMatchers = function(localKeyword) {
  const examplesRegion = document.querySelector('#wholeWordExamples');
  if (!examplesRegion) return;

  if (!localKeyword) {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localMsg = (localT && localT.resolve('helperPatternStartTypingExamples')) || 'Start typing above to see examples...';
    const localDiv = document.createElement('div');
    localDiv.style.cssText = 'text-align: center; padding: 20px; color: var(--text-muted); font-size: 12px;';
    localDiv.textContent = localMsg;
    examplesRegion.replaceChildren(localDiv);
    return;
  }

  const localExamples = this.performGenerateWholeWordExamples(localKeyword);
  const localSafeKeyword = TextCodec.escapeMarkup(localKeyword);
  examplesRegion.innerHTML = `
    <div style="margin-bottom: 16px; padding: 12px; background: var(--bg-secondary); border-radius: 6px;">
      <div style="font-weight: 600; color: var(--success); margin-bottom: 8px;">Pattern: ${localSafeKeyword}</div>
      <table style="font-size: 10px; width: 100%; border-collapse: collapse;">
        <tr style="background: var(--bg-tertiary);">
          <td style="padding: 6px; border: 1px solid var(--border);">Text</td>
          <td style="padding: 6px; border: 1px solid var(--border);">Match?</td>
          <td style="padding: 6px; border: 1px solid var(--border);">Reason</td>
        </tr>
        ${localExamples.map(failure => `
          <tr>
            <td style="padding: 6px; border: 1px solid var(--border); color: var(--accent); font-family: monospace;">${TextCodec.escapeMarkup(failure.text)}</td>
            <td style="padding: 6px; border: 1px solid var(--border); color: ${failure.match ? 'var(--success)' : 'var(--danger)'};">${failure.match ? '\u2713 Match' : '\u2717 No match'}</td>
            <td style="padding: 6px; border: 1px solid var(--border);">${TextCodec.escapeMarkup(failure.reason)}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;
};

CatalogPresenter.prototype.wireWholeWordSupportDialog = function() {
  this._wholeWordHelperModal = this._wireMatcherSupport({
    modalSelector: '#wholeWordHelperModal',
    closeSelectors: ['#closeWholeWordHelper', '#closeWholeWordHelperBtn'],
    openSelectors: ['#wholeWordHelperBtn', '#wholeWordHelperBtnValue'],
    inputSelector: '#wholeWordKeywordInput',
    stepSelectors: ['#wholeWordStep1', '#wholeWordStep2'],
    filterFn: this.filterWholeWordMatchers
  });
};

// ============================================
// Case Sensitive Helper
// ============================================

CatalogPresenter.prototype.performGenerateCaseSensitiveExamples = function(field) {
  const localVariations = [
    { text: field, sensitive: true, insensitive: true }
  ];

  const localLower = field.toLowerCase();
  if (localLower !== field) {
    localVariations.push({ text: localLower, sensitive: false, insensitive: true });
  }

  const localUpper = field.toUpperCase();
  if (localUpper !== field && localUpper !== localLower) {
    localVariations.push({ text: localUpper, sensitive: false, insensitive: true });
  }

  const localCapitalized = field.charAt(0).toUpperCase() + field.slice(1).toLowerCase();
  if (localCapitalized !== field && localCapitalized !== localLower && localCapitalized !== localUpper) {
    localVariations.push({ text: localCapitalized, sensitive: false, insensitive: true });
  }

  return localVariations;
};

CatalogPresenter.prototype.filterCaseSensitiveMatchers = function(localKeyword) {
  const examplesRegion = document.querySelector('#caseSensitiveExamples');
  if (!examplesRegion) return;

  if (!localKeyword) {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localMsg = (localT && localT.resolve('helperPatternStartTypingExamples')) || 'Start typing above to see examples...';
    const localDiv = document.createElement('div');
    localDiv.style.cssText = 'text-align: center; padding: 20px; color: var(--text-muted); font-size: 12px;';
    localDiv.textContent = localMsg;
    examplesRegion.replaceChildren(localDiv);
    return;
  }

  const localExamples = this.performGenerateCaseSensitiveExamples(localKeyword);
  const localSafeKeyword = TextCodec.escapeMarkup(localKeyword);
  examplesRegion.innerHTML = `
    <div style="margin-bottom: 16px; padding: 12px; background: var(--bg-secondary); border-radius: 6px;">
      <div style="font-weight: 600; color: var(--danger); margin-bottom: 8px;">Pattern: ${localSafeKeyword}</div>
      <table style="font-size: 10px; width: 100%; border-collapse: collapse;">
        <tr style="background: var(--bg-tertiary);">
          <td style="padding: 6px; border: 1px solid var(--border); font-weight: 600;">Text Found</td>
          <td style="padding: 6px; border: 1px solid var(--border); font-weight: 600;">Case Sensitive</td>
          <td style="padding: 6px; border: 1px solid var(--border); font-weight: 600;">Case Insensitive</td>
        </tr>
        ${localExamples.map(failure => `
          <tr>
            <td style="padding: 6px; border: 1px solid var(--border); color: var(--accent); font-family: monospace;">${TextCodec.escapeMarkup(failure.text)}</td>
            <td style="padding: 6px; border: 1px solid var(--border); color: ${failure.sensitive ? 'var(--success)' : 'var(--danger)'};">${failure.sensitive ? '\u2713 Match' : '\u2717 No match'}</td>
            <td style="padding: 6px; border: 1px solid var(--border); color: ${failure.insensitive ? 'var(--success)' : 'var(--danger)'};">${failure.insensitive ? '\u2713 Match' : '\u2717 No match'}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `;
};

CatalogPresenter.prototype.wireCaseSensitiveSupportDialog = function() {
  this._caseSensitiveHelperModal = this._wireMatcherSupport({
    modalSelector: '#caseSensitiveHelperModal',
    closeSelectors: ['#closeCaseSensitiveHelper', '#closeCaseSensitiveHelperBtn'],
    openSelectors: ['#caseSensitiveHelperBtn', '#caseSensitiveHelperBtnValue', '#payloadUrlCaseHelperBtn'],
    inputSelector: '#caseSensitiveKeywordInput',
    stepSelectors: ['#caseSensitiveStep1', '#caseSensitiveStep2'],
    filterFn: this.filterCaseSensitiveMatchers
  });
};
