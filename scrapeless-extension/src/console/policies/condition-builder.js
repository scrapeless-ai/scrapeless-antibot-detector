/**
 * Rules extension methods.
 * Dependencies: `src/console/policies/presenter.js` must be loaded first.
 */

CatalogPresenter.prototype.refreshGlobalConditionWizardDropdown = function() {
    const localMenu = document.querySelector('#conditionDropdownMenu');
    if (!localMenu) return;

    const localHidden = document.querySelector('#windowConditionSelect');
    const chosen = (localHidden?.value || 'exists').trim() || 'exists';

    // Rebuild menu using the same rendering as inline dropdowns.
    localMenu.innerHTML = this.paintGlobalConditionMenu(chosen);

    // Keep trigger text consistent with the hidden value.
    const triggerCopy = document.querySelector('#conditionDropdownTrigger .condition-selected-text');
    if (triggerCopy) {
      triggerCopy.textContent = chosen;
    }
  };

CatalogPresenter.prototype.resolveGlobalConditionChoices = function() {
    const localLang = globalThis.PropertyPredicateLanguage;
    const baselines = (localLang && typeof localLang.getPresetValues === 'function')
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

    const choices = [];
    const addChoice = (datum) => {
      const localTrimmed = (datum || '').trim();
      if (!localTrimmed) return;
      if (!choices.includes(localTrimmed)) {
        choices.push(localTrimmed);
      }
    };

    // Keep UI and engine aligned by defaulting to the shared condition language.
    baselines.forEach(addChoice);

    const existsPosition = choices.indexOf('exists');
    if (existsPosition > 0) {
      choices.splice(existsPosition, 1);
      choices.unshift('exists');
    } else if (existsPosition === -1) {
      choices.unshift('exists');
    }

    return choices;
  };

CatalogPresenter.prototype.resolveGlobalConditionGroups = function() {
    const localLang = globalThis.PropertyPredicateLanguage;
    if (localLang && typeof localLang.getPresetGroups === 'function') {
      return localLang.getPresetGroups();
    }

    // Fallback must mirror PRESET_GROUPS in window-condition-language.js
    return [
      { label: 'Type', values: ['typeof object', 'typeof function', 'typeof string', 'typeof number', 'typeof boolean', 'typeof symbol', 'typeof bigint'] },
      { label: 'Existence', values: ['exists', 'truthy', 'falsy', '!== undefined', '=== undefined', '!== null', '=== null'] },
      { label: 'Collections', values: ['array', 'non-empty array', 'empty array', 'has length', 'has keys', 'empty object'] },
      { label: 'Numeric', values: ['> 0', '>= 0', '=== 0', '!== 0', '> 1', '>= 1'] },
      { label: 'String', values: ['length > 0', 'length === 0'] },
      { label: 'Boolean', values: ['=== true', '=== false'] }
    ];
  };

CatalogPresenter.prototype.paintGlobalConditionMenu = function(chosenDatum) {
    const choices = this.resolveGlobalConditionChoices();
    const localNormalized = (chosenDatum || '').trim();
    const chosen = localNormalized || 'exists';
    const localAvailable = new Set(choices);

    const localGroups = this.resolveGlobalConditionGroups();

    const paintChoice = (datum) => {
      const safeDatum = TextCodec.escapeMarkup(datum);
      const isChosen = datum === chosen;
      return `<div class="condition-option${isChosen ? ' selected' : ''}" data-value="${safeDatum}">${safeDatum}</div>`;
    };

    const localRenderedGroups = localGroups.map((localGroup) => {
      const data = localGroup.values.filter((datum) => localAvailable.has(datum));
      if (data.length === 0) return '';
      return `
        <div class="condition-group">
          <div class="condition-group-label">${localGroup.label}</div>
          ${data.map(paintChoice).join('')}
        </div>
      `;
    }).join('');

    const localExtras = choices.filter((datum) => !localGroups.some((localGroup) => localGroup.values.includes(datum)));
    const localExtraGroup = localExtras.length
      ? `
        <div class="condition-group">
          <div class="condition-group-label">Other</div>
          ${localExtras.map(paintChoice).join('')}
        </div>
      `
      : '';

    const localCustomGroup = localNormalized && !choices.includes(localNormalized)
      ? `
        <div class="condition-group">
          <div class="condition-group-label">Custom</div>
          ${paintChoice(localNormalized)}
        </div>
      `
      : '';

    return localRenderedGroups + localExtraGroup + localCustomGroup;
  };

CatalogPresenter.prototype.paintInlineConditionDropdown = function(conditionDatum, phaseLookup, entryPosition) {
    const chosen = (conditionDatum || 'exists').trim() || 'exists';
    const safeChosen = TextCodec.escapeMarkup(chosen);
    const localMenu = this.paintGlobalConditionMenu(chosen);

    return `
      <div class="condition-dropdown inline-condition-dropdown" data-condition-dropdown="window" data-condition-value="${safeChosen}">
        <button type="button" class="condition-dropdown-trigger" aria-expanded="false">
          <span class="condition-selected-text">${safeChosen}</span>
          <svg class="dropdown-chevron" width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M6 8L1 3h10z"/>
          </svg>
        </button>
        <div class="condition-dropdown-menu">
          ${localMenu}
        </div>
        <input type="hidden" class="method-input method-value" value="${safeChosen}" data-method-key="${phaseLookup}" data-item-index="${entryPosition}">
      </div>
    `;
  };

CatalogPresenter.prototype.performSyncInlineConditionDropdown = function(phaseEntry) {
    const localDropdown = phaseEntry?.querySelector('.inline-condition-dropdown');
    if (!localDropdown) return;
    const hiddenField = localDropdown.querySelector('.method-input.method-value');
    const datum = hiddenField?.value || 'exists';
    const chosenCopy = localDropdown.querySelector('.condition-selected-text');
    if (chosenCopy) {
      chosenCopy.textContent = datum;
    }
    localDropdown.dataset.conditionValue = datum;
    localDropdown.querySelectorAll('.condition-option').forEach((choice) => {
      choice.classList.toggle('selected', choice.dataset.value === datum);
    });
  };

CatalogPresenter.prototype.performGenerateDomTemplates = function(localKeyword) {
    if (!localKeyword || localKeyword.trim() === '') return [];

    // Store original keyword for display and create CSS-safe version
    const priorKeyword = localKeyword;
    const localCssKeyword = localKeyword.replace(/\s+/g, '-').toLowerCase();

    const localTemplates = [
      // Basic selectors (use CSS-safe keyword for selector, original for display)
      { selector: `.${localCssKeyword}`, label: `Class selector for "${priorKeyword}"` },
      { selector: `#${localCssKeyword}`, label: `ID selector for "${priorKeyword}"` },
      { selector: `[data-${localCssKeyword}]`, label: `Data attribute for "${priorKeyword}"` },
      { selector: `[class*='${priorKeyword}']`, label: `Classes containing "${priorKeyword}"` },
      { selector: `[id*='${priorKeyword}']`, label: `IDs containing "${priorKeyword}"` },
      { selector: `iframe[src*='${priorKeyword}']`, label: `Iframes with "${priorKeyword}" in URL` },
      { selector: `[title*='${priorKeyword}']`, label: `Elements with "${priorKeyword}" in title` },
      { selector: `[alt*='${priorKeyword}']`, label: `Elements with "${priorKeyword}" in alt text` }
    ];

    // Only show element selector if it's a valid HTML tag name
    if (!localKeyword.includes(' ') && !localKeyword.includes('-')) {
      localTemplates.splice(5, 0,
        { selector: `${localCssKeyword}`, label: `${priorKeyword} HTML tag` },
        { selector: `[${localCssKeyword}]`, label: `Elements with ${priorKeyword} attribute` }
      );
    }

    // For compound words, also generate variations
    if (localCssKeyword.includes('-') || localCssKeyword.includes('_')) {
      const localCamelCase = localCssKeyword.replace(/[-_]([a-z])/g, (localG) => localG[1].toUpperCase());
      localTemplates.push(
        { selector: `.${localCamelCase}`, label: `Class selector for "${localCamelCase}" (camelCase)` }
      );
    }

    return localTemplates;
  };

CatalogPresenter.prototype.presentDomSuggestions = function(localKeyword) {
    const suggestionsRegion = document.querySelector('#domSuggestions');
    const customField = document.querySelector('#domCustomInput');

    if (!suggestionsRegion) return;

    // Clear existing suggestions
    suggestionsRegion.innerHTML = '';

    if (!localKeyword || localKeyword.trim() === '') {
      // Show empty state message
      suggestionsRegion.innerHTML = `
        <div class="suggestions-empty-state suggestions-empty-state-compact">
          <div class="empty-title">Start typing to see suggestions</div>
          <div class="empty-hint">Matching selectors will appear in this register.</div>
        </div>
      `;
      return;
    }

    // Generate dynamic templates based on keyword
    const localTemplates = this.performGenerateDomTemplates(localKeyword);

    // Build HTML for all suggestions
    let suggestionsMarkup = '';

    localTemplates.forEach(localTemplate => {
      const localEscapedSelector = TextCodec.escapeMarkup(localTemplate.selector);
      const localEscapedLabel = TextCodec.escapeMarkup(localTemplate.label);
      suggestionsMarkup += `
        <button type="button" class="dom-suggestion" data-selector="${localEscapedSelector}">
          <div class="dom-suggestion-selector">${localEscapedSelector}</div>
          <div class="dom-suggestion-label">${localEscapedLabel}</div>
        </button>
      `;
    });

    // Set all suggestions at once
    suggestionsRegion.innerHTML = suggestionsMarkup;

    // Update custom input placeholder
    if (customField) {
      customField.placeholder = `Or enter custom selector for "${localKeyword}"...`;
    }
  };
