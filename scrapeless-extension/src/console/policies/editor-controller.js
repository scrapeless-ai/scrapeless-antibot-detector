/**
 * Rules Editor - Form rendering and data collection/saving.
 * Merges rules-editor-render.js + rules-editor-data.js.
 *
 * Dependencies: rules.js, rules-condition-ui.js (for renderInlineConditionDropdown)
 */

// ============================================
// Form Rendering
// ============================================

const PHASE_MATCHERS_PER_SHEET = 10;

CatalogPresenter.prototype.normalizePhaseEvidence = function(evidence = 100) {
    const numericEvidence = Number(evidence);
    return Number.isFinite(numericEvidence)
      ? Math.max(0, Math.min(100, numericEvidence))
      : 100;
};

CatalogPresenter.prototype.resolvePhaseSettingsLabel = function(evidence = 100, hasCustomSettings = false, fieldType = 'name') {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const settingsCopy = (localT && localT.resolve('openSettings')) || 'Open settings';
    const confidenceCopy = (localT && localT.resolve('ruleConfidenceLevel')) || 'Confidence level';
    const targetCopy = fieldType === 'value'
      ? ((localT && localT.resolve('rulesValueFieldOptions')) || 'Value field options')
      : ((localT && localT.resolve('rulesPatternMatchingOptions')) || 'Pattern matching options');
    const customCopy = hasCustomSettings
      ? ` · ${(localT && localT.resolve('settingsCustomMethod')) || 'Custom'}`
      : '';
    return `${settingsCopy}: ${targetCopy} · ${confidenceCopy}: ${this.normalizePhaseEvidence(evidence)}%${customCopy}`;
};

CatalogPresenter.prototype.paintPhaseSettingsAction = function(evidence = 100, hasCustomSettings = false, fieldType = 'name') {
    const normalizedEvidence = this.normalizePhaseEvidence(evidence);
    const settingsLabel = TextCodec.performEscapeAttr(
      this.resolvePhaseSettingsLabel(normalizedEvidence, hasCustomSettings, fieldType)
    );
    return `
      <button
        type="button"
        class="method-action-btn settings ${hasCustomSettings ? 'has-custom-settings' : ''}"
        title="${settingsLabel}"
        aria-label="${settingsLabel}"
        data-confidence="${normalizedEvidence}"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35c-0.59,0.24-1.13,0.57-1.62,0.94L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87c-0.12,0.21-0.08,0.47,0.12,0.61l2.03,1.58c-0.05,0.3-0.09,0.63-0.09,0.94s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61l-2.03-1.58zM12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6s-1.62,3.6-3.6,3.6z" fill="currentColor"/>
        </svg>
      </button>
    `;
};

CatalogPresenter.prototype.refreshPhaseSettingsAction = function(control, evidence = 100, hasCustomSettings = false, fieldType = 'name') {
    if (!control) return;
    const normalizedEvidence = this.normalizePhaseEvidence(evidence);
    const settingsLabel = this.resolvePhaseSettingsLabel(normalizedEvidence, hasCustomSettings, fieldType);
    control.classList.toggle('has-custom-settings', hasCustomSettings);
    control.dataset.confidence = String(normalizedEvidence);
    control.title = settingsLabel;
    control.setAttribute('aria-label', settingsLabel);
};

CatalogPresenter.prototype.populateScanPhases = function(rule) {
    const region = document.querySelector('#detectionMethodsContainer');
    if (!region) return;

    if (!rule.detection) {
      rule.detection = {
        urls: [],
        headers: [],
        cookies: [],
        content: [],
        dom: []
      };
    }

    let phasesMarkup = '';

    const allPhaseTypes = ['url', 'header', 'cookie', 'content', 'dom', 'js_hooks', 'window', 'payload'];

    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const phaseLabelLookup = {
      url: 'methodLabelUrl', header: 'methodLabelHeader', cookie: 'methodLabelCookie',
      content: 'methodLabelContent', dom: 'methodLabelDom', js_hooks: 'methodLabelJsHooks',
      window: 'methodLabelWindow', payload: 'methodLabelPayload'
    };
    const phaseLabelFallback = {
      url: 'URL', header: 'HEADER', cookie: 'COOKIE', content: 'CONTENT', dom: 'DOM',
      js_hooks: 'JS HOOKS', window: 'WINDOW', payload: 'PAYLOAD'
    };

    allPhaseTypes.forEach(phaseKind => {
      const phasesPayload = rule.detection?.[phaseKind];
      const presentLabel = localT
        ? localT.resolve(phaseLabelLookup[phaseKind] || '') || (phaseLabelFallback[phaseKind] || phaseKind.toUpperCase())
        : (phaseLabelFallback[phaseKind] || phaseKind.toUpperCase());

      const tagPalette = this.taxonomy.resolveTagTone(phaseKind);
      const backgroundPalette = (tagPalette && tagPalette !== '#666666') ? tagPalette : '#666666';

      const phaseHex = backgroundPalette.replace('#', '');
      const phaseR = parseInt(phaseHex.substring(0, 2), 16) || 102;
      const phaseG = parseInt(phaseHex.substring(2, 4), 16) || 102;
      const phaseB = parseInt(phaseHex.substring(4, 6), 16) || 102;

      const helpControlTitle = phaseKind === 'js_hooks' ? 'What are JS hooks?' :
                             phaseKind === 'window' ? 'What are Window properties?' :
                             phaseKind === 'url' ? 'What is URL detection?' :
                             phaseKind === 'header' ? 'What is Header detection?' :
                             phaseKind === 'cookie' ? 'What is Cookie detection?' :
                             phaseKind === 'content' ? 'What is Content detection?' :
                             phaseKind === 'dom' ? 'What is DOM detection?' :
                             phaseKind === 'payload' ? 'What is Payload detection?' :
                             'What is this detection method?';

      const phaseSupport = `
            <button class="method-help-btn" type="button" data-method-help="${phaseKind}" title="${helpControlTitle}" aria-label="${helpControlTitle}">?</button>
          `;

      const matcherTotal = Array.isArray(phasesPayload) ? phasesPayload.length : 0;
      const matcherTotalCopy = matcherTotal === 1
        ? ((localT && localT.resolve('methodOnePattern')) || '1 pattern')
        : ((localT && localT.encode('methodPatternsFmt', matcherTotal)) || `${matcherTotal} patterns`);

      phasesMarkup += `
        <div class="method-section collapsed" data-method-type="${phaseKind}" data-empty="${matcherTotal === 0}" style="--con-cat: ${backgroundPalette};">
          <div class="method-header">
            <button
              type="button"
              class="method-header-toggle"
              aria-expanded="false"
              aria-controls="method-items-${phaseKind}"
            >
              <span class="method-header-left">
                <span class="method-title" style="background: rgba(${phaseR}, ${phaseG}, ${phaseB}, 0.2); color: ${backgroundPalette}; border: 1px solid rgba(${phaseR}, ${phaseG}, ${phaseB}, 0.35); padding: 6px 12px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; display: inline-block;">${presentLabel}</span>
              </span>
              <span class="method-pattern-count">${matcherTotalCopy}</span>
              <svg class="method-collapse-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z" fill="currentColor"/>
              </svg>
            </button>
            ${phaseSupport}
          </div>
          <div class="method-search-row">
            <input
              type="text"
              class="method-search-input"
              data-method-search="${phaseKind}"
              placeholder="${(localT && localT.resolve('methodSearchPatterns')) || 'Search patterns...'}"
            >
          </div>
          <div class="method-items" id="method-items-${phaseKind}">
      `;

      if (Array.isArray(phasesPayload) && phasesPayload.length > 0) {
        phasesPayload.forEach((phase, position) => {
            let label = '';
            let datum = '';

            // Extract name/value based on method type's data structure
            if (phaseKind === 'header' || phaseKind === 'cookie') {
              label = phase.name || '';
              datum = phase.value || '';
            } else if (phaseKind === 'url' || phaseKind === 'content' || phaseKind === 'payload') {
              label = phase.text || '';
              datum = phase.description || '';
            } else if (phaseKind === 'dom') {
              label = phase.selector || '';
              datum = phase.description || '';
            } else if (phaseKind === 'js_hooks') {
              label = phase.target || '';
              datum = phase.description || '';
            } else if (phaseKind === 'window') {
              label = phase.path || '';
              datum = phase.condition || 'exists';
            }

            // These go straight into markup. They were being interpolated raw
            // into value="..." and a detector rule can carry any text at all,
            // so a quote in a pattern was enough to break out of the field.
            const labelMarkup = TextCodec.escapeMarkup(String(label));
            const datumMarkup = TextCodec.escapeMarkup(String(datum));

            const evidence = this.normalizePhaseEvidence(phase.confidence);

            let labelRegex = false, labelWholeWord = false, labelCaseSensitive = false;
            let datumRegex = false, datumWholeWord = false, datumCaseSensitive = false;

            if (phaseKind === 'header' || phaseKind === 'cookie') {
              labelRegex = phase.nameRegex || false;
              labelWholeWord = phase.nameWholeWord || false;
              labelCaseSensitive = phase.nameCaseSensitive || false;
              datumRegex = phase.valueRegex || false;
              datumWholeWord = phase.valueWholeWord || false;
              datumCaseSensitive = phase.valueCaseSensitive || false;
            } else if (phaseKind === 'url' || phaseKind === 'content' || phaseKind === 'payload') {
              labelRegex = phase.textRegex || false;
              labelWholeWord = phase.textWholeWord || false;
              labelCaseSensitive = phase.textCaseSensitive || false;
            } else if (phaseKind === 'dom') {
              labelRegex = phase.selectorRegex || false;
              labelWholeWord = phase.selectorWholeWord || false;
              labelCaseSensitive = phase.selectorCaseSensitive || false;
            }
            const localCheckScripts = phase.checkScripts === true || phase.scope === 'scripts';

            let labelBoundary = '';
            let datumBoundary = '';
            let copyBoundary = 'all';

            if (phaseKind === 'header') {
              labelBoundary = canonicalizeCookieHeaderBoundary(phase.nameScope || 'response', 'response');
              datumBoundary = canonicalizeCookieHeaderBoundary(phase.valueScope || 'response', 'response');
            } else if (phaseKind === 'cookie') {
              labelBoundary = canonicalizeCookieHeaderBoundary(phase.nameScope || 'request', 'request');
              datumBoundary = canonicalizeCookieHeaderBoundary(phase.valueScope || 'request', 'request');
            } else if (phaseKind === 'url') {
              copyBoundary = phase.textScope || 'all';
            }

            let payloadAddressMatcher = '';
            let payloadAddressRegex = false;
            let payloadAddressCaseSensitive = false;
            let payloadPhases = '';

            if (phaseKind === 'payload') {
              payloadAddressMatcher = phase.urlPattern || '';
              payloadAddressRegex = phase.urlRegex || false;
              payloadAddressCaseSensitive = phase.urlCaseSensitive || false;
              if (Array.isArray(phase.methods) && phase.methods.length > 0) {
                payloadPhases = phase.methods.join(',');
              }
            }

            if (!label && !datum) {
              return;
            }

            // js_hooks: single input (target only); window: dual inputs (path + condition)
            const singleFieldTypes = ['url', 'content', 'dom', 'js_hooks', 'payload'];
            const isSingleField = singleFieldTypes.includes(phaseKind);

            let fieldPlaceholder = 'Name';
            let datumPlaceholder = 'Value (optional)';
            if (phaseKind === 'dom') fieldPlaceholder = 'CSS Selector (e.g., .class, #id, [attr])';
            else if (phaseKind === 'content') fieldPlaceholder = 'Text/Word to search';
            else if (phaseKind === 'url') fieldPlaceholder = 'URL Pattern';
            else if (phaseKind === 'js_hooks') fieldPlaceholder = 'JS Hook Target (e.g., navigator.webdriver)';
            else if (phaseKind === 'window') {
              fieldPlaceholder = 'Window Path (e.g., grecaptcha, _cf_chl_opt)';
              datumPlaceholder = 'Condition (e.g., typeof object, typeof function)';
            }
            else if (phaseKind === 'cookie') {
              fieldPlaceholder = 'Cookie Name (e.g., __cf_bm, session_id)';
              datumPlaceholder = 'Cookie Value Pattern (optional)';
            }
            else if (phaseKind === 'payload') fieldPlaceholder = 'Text (e.g., sensor_data, challenge_token)';

            const hasLabelCustomPreferences = labelRegex || labelWholeWord || labelCaseSensitive ||
                                          (phaseKind === 'content' && localCheckScripts === true);
            const hasDatumCustomPreferences = datumRegex || datumWholeWord || datumCaseSensitive;

            const globalConditionDropdown = phaseKind === 'window'
              ? this.paintInlineConditionDropdown(datum, phaseKind, position)
              : '';
            const presentDatumRow = !isSingleField && (phaseKind === 'window' || datum);
            const presentLabelPreferences = true;
            const presentDatumActions = phaseKind !== 'window';

            phasesMarkup += `
              <div class="method-item"
                data-method-order="${position}"
                data-confidence="${evidence}"
                data-name-regex="${labelRegex}"
                data-name-wholeword="${labelWholeWord}"
                data-name-case="${labelCaseSensitive}"
                data-value-regex="${datumRegex}"
                data-value-wholeword="${datumWholeWord}"
                data-value-case="${datumCaseSensitive}"
                data-check-scripts="${localCheckScripts}"
                data-name-scope="${labelBoundary}"
                data-value-scope="${datumBoundary}"
                data-text-scope="${copyBoundary}"
                data-payload-url-pattern="${payloadAddressMatcher}"
                data-payload-url-regex="${payloadAddressRegex}"
                data-payload-url-case-sensitive="${payloadAddressCaseSensitive}"
                data-payload-methods="${payloadPhases}">
                <div class="method-item-content">
                  <div class="method-item-inputs">
                    <div class="input-with-indicators">
                      <div class="input-row">
                        <span class="doc-ord" aria-hidden="true">${String(position + 1).padStart(2, '0')}</span>
                        <textarea rows="1" class="method-input method-name" placeholder="${fieldPlaceholder}" data-method-key="${phaseKind}" data-item-index="${position}">${labelMarkup}</textarea><div class="doc-echo" aria-hidden="true"></div>
                        ${phaseKind === 'dom' ? `<button class="dom-helper-btn" title="DOM Selector Examples" aria-label="DOM Selector Examples" data-input-index="${position}">?</button>` : ''}
                        ${phaseKind === 'window' ? `<button class="window-helper-btn" title="Window Property Examples" aria-label="Window Property Examples" data-input-index="${position}">?</button>` : ''}
                        <div class="field-actions" data-field-type="name">
                          ${presentLabelPreferences ? this.paintPhaseSettingsAction(evidence, hasLabelCustomPreferences, 'name') : ''}
                          <button type="button" class="method-action-btn delete" title="Delete Method" aria-label="Delete method">
                            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                              <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor"/>
                            </svg>
                          </button>
                        </div>
                      </div>
                      <div class="input-badges-row">
                        <div class="input-indicators" data-for="name-${phaseKind}-${position}"></div>
                      </div>
                    </div>
                    ${!isSingleField ? `
                    <div class="input-with-indicators value-field-container" style="display: ${presentDatumRow ? 'flex' : 'none'}">
                      <div class="input-row">
                        <span class="doc-ord doc-ord--cont" aria-hidden="true">${phaseKind === 'window' ? '\u27E9' : '='}</span>
                        ${phaseKind === 'window'
                          ? globalConditionDropdown
                          : `<textarea rows="1" class="method-input method-value" placeholder="${datumPlaceholder}" data-method-key="${phaseKind}" data-item-index="${position}">${datumMarkup}</textarea><div class="doc-echo" aria-hidden="true"></div>`
                        }
                        ${presentDatumActions ? `
                        <div class="field-actions" data-field-type="value">
                          ${this.paintPhaseSettingsAction(evidence, hasDatumCustomPreferences, 'value')}
                          <button type="button" class="method-action-btn delete" title="Clear Value" aria-label="Clear value">
                            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                              <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor"/>
                            </svg>
                          </button>
                        </div>
                        ` : ''}
                      </div>
                      <div class="input-badges-row">
                        <div class="input-indicators" data-for="value-${phaseKind}-${position}"></div>
                      </div>
                    </div>
                    <button class="add-value-btn" style="display: ${presentDatumRow ? 'none' : 'flex'}" data-method-key="${phaseKind}" data-item-index="${position}">
                      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
                      </svg>
                      ${(localT && localT.resolve('methodAddValue')) || 'Add Value'}
                    </button>
                    ` : ''}
                  </div>
                </div>
              </div>
            `;
        });
      }

      phasesMarkup += `
          </div>
          <div class="method-pagination" data-method-pagination="${phaseKind}">
            <span class="method-pagination-info">Showing 0-0 of 0 patterns</span>
            <div class="method-pagination-controls">
              <button type="button" class="method-pagination-btn prev" title="Previous page" disabled>
                <svg width="12" height="12" viewBox="0 0 24 24">
                  <path d="M15.41,7.41L14,6L8,12L14,18L15.41,16.59L10.83,12L15.41,7.41Z" fill="currentColor"/>
                </svg>
              </button>
              <span class="method-pagination-page">Page 1 / 1</span>
              <button type="button" class="method-pagination-btn next" title="Next page" disabled>
                <svg width="12" height="12" viewBox="0 0 24 24">
                  <path d="M8.59,16.59L10,18L16,12L10,6L8.59,7.41L13.17,12L8.59,16.59Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>
          <button class="add-method-btn" data-method-type="${phaseKind}">
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
            </svg>
            ${(localT && localT.resolve('methodAddPattern')) || 'Add Pattern'}
          </button>
        </div>
      `;
    });

    region.innerHTML = phasesMarkup;
    this.methodPaginationState = {};

    const phaseSections = region.querySelectorAll('.method-section');
    phaseSections.forEach(localSection => {
      this.refreshPhaseSectionPaging(localSection);
    });
    this.refreshAllAddMatcherControlSessions();

    const filterFields = region.querySelectorAll('.method-search-input');
    filterFields.forEach(field => {
      field.addEventListener('input', (signal) => {
        const localSection = signal.target.closest('.method-section');
        this.refreshPhaseSectionPaging(localSection, { searchQuery: signal.target.value });
      });
    });

    const phaseEntries = region.querySelectorAll('.method-item');
    phaseEntries.forEach(entry => {
      const hasPreferences =
        entry.dataset.nameRegex === 'true' ||
        entry.dataset.nameWholeword === 'true' ||
        entry.dataset.nameCase === 'true' ||
        entry.dataset.valueRegex === 'true' ||
        entry.dataset.valueWholeword === 'true' ||
        entry.dataset.valueCase === 'true';

      if (hasPreferences) {
        this.refreshPhaseIndicators(entry);
      }

      const labelField = entry.querySelector('.method-input.method-name');
      const datumField = entry.querySelector('.method-input.method-value');

      if (labelField) {
        labelField.addEventListener('input', () => {
          this.refreshPhaseIndicators(entry);
        });
      }

      if (datumField) {
        const refreshRoute = () => {
          this.refreshPhaseIndicators(entry);
        };
        datumField.addEventListener('input', refreshRoute);
        datumField.addEventListener('change', refreshRoute);
      }
    });
  };

CatalogPresenter.prototype.resolvePhaseSectionKind = function(localSection) {
    if (!localSection) return '';

    const datasetKind = localSection.dataset.methodType;
    if (datasetKind) {
      return datasetKind === 'js hooks' ? 'js_hooks' : datasetKind;
    }

    const controlKind = localSection.querySelector('.add-method-btn')?.dataset.methodType;
    if (controlKind) return controlKind;

    const phaseTitle = localSection.querySelector('.method-title')?.textContent?.trim().toLowerCase();
    if (!phaseTitle) return '';

    if (phaseTitle === 'js hooks') return 'js_hooks';
    return phaseTitle;
  };

CatalogPresenter.prototype.refreshPhaseMatcherTotal = function(localSection) {
    if (!localSection) return 0;

    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const aggregateMatchers = localSection.querySelectorAll('.method-item').length;
    const matcherTotalEl = localSection.querySelector('.method-pattern-count');
    if (matcherTotalEl) {
      matcherTotalEl.textContent = aggregateMatchers === 1
        ? ((localT && localT.resolve('methodOnePattern')) || '1 pattern')
        : ((localT && localT.encode('methodPatternsFmt', aggregateMatchers)) || `${aggregateMatchers} patterns`);
    }
    // The skin reads this to decide whether the section is a heading or a
    // block, so it has to follow the count rather than the first render.
    localSection.dataset.empty = String(aggregateMatchers === 0);
    return aggregateMatchers;
  };

CatalogPresenter.prototype.resolvePhasePagingEntry = function(phaseKind) {
    if (!this.methodPaginationState || typeof this.methodPaginationState !== 'object') {
      this.methodPaginationState = {};
    }

    const retainedSession = this.methodPaginationState[phaseKind];
    if (retainedSession && typeof retainedSession === 'object') {
      if (typeof retainedSession.page !== 'number') retainedSession.page = 1;
      if (typeof retainedSession.searchQuery !== 'string') retainedSession.searchQuery = '';
      return retainedSession;
    }

    const localEntry = {
      page: typeof retainedSession === 'number' ? retainedSession : 1,
      searchQuery: ''
    };
    this.methodPaginationState[phaseKind] = localEntry;
    return localEntry;
  };

CatalogPresenter.prototype.phaseEntryHitsFilter = function(entry, normalizedFilter) {
    if (!normalizedFilter) return true;
    if (!entry) return false;

    const localTokens = [];

    entry.querySelectorAll('.method-input').forEach(field => {
      if (typeof field.value === 'string' && field.value.trim()) {
        localTokens.push(field.value.trim());
      }
    });

    const chosenCondition = entry.querySelector('.condition-selected-text')?.textContent?.trim();
    if (chosenCondition) {
      localTokens.push(chosenCondition);
    }

    const phaseLookup = entry.querySelector('.method-input')?.dataset.methodKey;
    if (phaseLookup) {
      localTokens.push(phaseLookup.replace(/_/g, ' '));
    }

    return localTokens.join(' ').toLowerCase().includes(normalizedFilter);
  };

CatalogPresenter.prototype.refreshPhaseSectionPaging = function(localSection, choices = {}) {
    if (!localSection) return;

    const phaseKind = this.resolvePhaseSectionKind(localSection);
    if (!phaseKind) return;
    const localIsCollapsed = localSection.classList.contains('collapsed');

    if (!this.methodPaginationState || typeof this.methodPaginationState !== 'object') {
      this.methodPaginationState = {};
    }

    const pagingEntry = this.resolvePhasePagingEntry(phaseKind);
    if (typeof choices.searchQuery === 'string') {
      pagingEntry.searchQuery = choices.searchQuery.trim().toLowerCase();
      pagingEntry.page = 1;
    }

    const entries = Array.from(localSection.querySelectorAll('.method-item'));
    const aggregateEntries = this.refreshPhaseMatcherTotal(localSection);
    const filterRow = localSection.querySelector('.method-search-row');
    const filterField = localSection.querySelector('.method-search-input');

    if (aggregateEntries === 0) {
      pagingEntry.searchQuery = '';
      pagingEntry.page = 1;
      if (filterField) {
        filterField.value = '';
      }
    }

    if (filterRow) {
      filterRow.style.display = (localIsCollapsed || aggregateEntries === 0) ? 'none' : '';
    }

    const filteredEntries = pagingEntry.searchQuery
      ? entries.filter(entry => this.phaseEntryHitsFilter(entry, pagingEntry.searchQuery))
      : entries;
    const filteredTotal = filteredEntries.length;
    const perSheet = PHASE_MATCHERS_PER_SHEET;
    const aggregateSheets = Math.max(1, Math.ceil(filteredTotal / perSheet));

    let activeSheet = pagingEntry.page || 1;

    if (choices.goToLastPage) {
      activeSheet = aggregateSheets;
    }
    if (typeof choices.pageDelta === 'number' && choices.pageDelta !== 0) {
      activeSheet += choices.pageDelta;
    }

    activeSheet = Math.min(Math.max(activeSheet, 1), aggregateSheets);
    pagingEntry.page = activeSheet;

    const beginPosition = (activeSheet - 1) * perSheet;
    const endPosition = beginPosition + perSheet;

    entries.forEach(entry => {
      entry.style.display = 'none';
    });

    filteredEntries.forEach((entry, position) => {
      if (position >= beginPosition && position < endPosition) {
        entry.style.display = '';
      }
    });

    const paging = localSection.querySelector('.method-pagination');
    const detailEl = localSection.querySelector('.method-pagination-info');
    const sheetEl = localSection.querySelector('.method-pagination-page');
    const localPrevBtn = localSection.querySelector('.method-pagination-btn.prev');
    const followingBtn = localSection.querySelector('.method-pagination-btn.next');

    if (detailEl) {
      const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
      if (filteredTotal === 0) {
        detailEl.textContent = pagingEntry.searchQuery
          ? ((localT && localT.resolve('methodNoMatchingPatterns')) || 'No matching patterns')
          : ((localT && localT.resolve('methodNoPatterns')) || 'No patterns');
      } else {
        const beginEntry = beginPosition + 1;
        const endEntry = Math.min(endPosition, filteredTotal);
        const localSuffix = pagingEntry.searchQuery
          ? ((localT && localT.resolve('methodSuffixMatches')) || 'matches')
          : ((localT && localT.resolve('methodSuffixPatterns')) || 'patterns');
        detailEl.textContent = (localT && localT.encode('paginationShowingItems', beginEntry, endEntry, filteredTotal, localSuffix))
          || `Showing ${beginEntry}-${endEntry} of ${filteredTotal} ${localSuffix}`;
      }
    }

    if (sheetEl) {
      sheetEl.textContent = `Page ${activeSheet} / ${aggregateSheets}`;
    }

    if (localPrevBtn) {
      localPrevBtn.disabled = activeSheet <= 1;
    }

    if (followingBtn) {
      followingBtn.disabled = activeSheet >= aggregateSheets;
    }

    if (paging) {
      if (localIsCollapsed) {
        paging.style.display = 'none';
      } else {
        paging.style.display = (filteredTotal > perSheet || !!pagingEntry.searchQuery) ? 'flex' : 'none';
      }
    }

    // Fields that were display:none while off-page measure as zero height, so
    // whatever just became visible has to be re-fitted.
    if (typeof this.fitPatternField === 'function') {
      localSection.querySelectorAll('textarea.method-input').forEach(this.fitPatternField);
    }
  };

CatalogPresenter.prototype.sectionHasEmptyRequiredMatcher = function(localSection) {
    if (!localSection) return false;

    return Array.from(localSection.querySelectorAll('.method-item')).some(entry => {
      const requiredField = entry.querySelector('.method-name');
      if (!requiredField) return false;
      return !requiredField.value.trim();
    });
  };

CatalogPresenter.prototype.refreshAddMatcherControlSession = function(localSection) {
    if (!localSection) return;

    const addMatcherBtn = localSection.querySelector('.add-method-btn');
    if (!addMatcherBtn) return;

    const hasEmptyRequiredMatcher = this.sectionHasEmptyRequiredMatcher(localSection);
    addMatcherBtn.disabled = hasEmptyRequiredMatcher;
    addMatcherBtn.setAttribute('aria-disabled', hasEmptyRequiredMatcher ? 'true' : 'false');

    if (hasEmptyRequiredMatcher) {
      addMatcherBtn.title = 'Complete the current empty pattern before adding another.';
    } else {
      addMatcherBtn.removeAttribute('title');
    }
  };

CatalogPresenter.prototype.refreshAllAddMatcherControlSessions = function() {
    const region = document.querySelector('#detectionMethodsContainer');
    if (!region) return;

    region.querySelectorAll('.method-section').forEach(localSection => {
      this.refreshAddMatcherControlSession(localSection);
    });
  };

CatalogPresenter.prototype.validateMatcherRows = function() {
    const phasesRegion = document.querySelector('#detectionMethodsContainer');
    if (!phasesRegion) {
      return {
        isValid: true,
        invalidRows: []
      };
    }

    const rejectedRows = [];
    const phaseSections = phasesRegion.querySelectorAll('.method-section');

    phaseSections.forEach(localSection => {
      const phaseKind = this.resolvePhaseSectionKind(localSection);
      const phaseEntries = Array.from(localSection.querySelectorAll('.method-item'));

      phaseEntries.forEach((entry, entryPositionInSection) => {
        const requiredField = entry.querySelector('.method-name');
        const requiredDatum = requiredField?.value?.trim() || '';

        if (!requiredDatum) {
          rejectedRows.push({
            section: localSection,
            item: entry,
            input: requiredField,
            methodType: phaseKind,
            itemIndexInSection: entryPositionInSection
          });
        }
      });
    });

    return {
      isValid: rejectedRows.length === 0,
      invalidRows: rejectedRows
    };
  };

CatalogPresenter.prototype.purgeMatcherValidationSession = function() {
    const dialog = document.querySelector('#editRuleModal');
    const boundary = dialog || document;

    boundary.querySelectorAll('.method-item-invalid').forEach(entry => {
      entry.classList.remove('method-item-invalid');
    });

    boundary.querySelectorAll('.method-input-invalid').forEach(field => {
      field.classList.remove('method-input-invalid');
      field.removeAttribute('aria-invalid');
    });
  };

CatalogPresenter.prototype.markMatcherValidationSession = function(rejectedRows = []) {
    if (!Array.isArray(rejectedRows) || rejectedRows.length === 0) return;

    rejectedRows.forEach(({ item: entry, input: field }) => {
      if (entry) {
        entry.classList.add('method-item-invalid');
      }
      if (field) {
        field.classList.add('method-input-invalid');
        field.setAttribute('aria-invalid', 'true');
      }
    });
  };

CatalogPresenter.prototype.revealAndFocusRejectedRow = function(rejectedRow) {
    if (!rejectedRow) return;

    const { section: localSection, item: entry, input: field, itemIndexInSection: entryPositionInSection } = rejectedRow;
    if (!localSection || !entry) return;

    localSection.classList.remove('collapsed');
    localSection.querySelector('.method-header-toggle')?.setAttribute('aria-expanded', 'true');

    const phaseKind = rejectedRow.methodType || this.resolvePhaseSectionKind(localSection);
    const filterField = localSection.querySelector('.method-search-input');
    if (filterField) {
      filterField.value = '';
    }

    if (phaseKind) {
      const pagingEntry = this.resolvePhasePagingEntry(phaseKind);
      pagingEntry.searchQuery = '';

      const allEntries = Array.from(localSection.querySelectorAll('.method-item'));
      const absolutePosition = typeof entryPositionInSection === 'number'
        ? entryPositionInSection
        : allEntries.indexOf(entry);
      const normalizedPosition = absolutePosition >= 0 ? absolutePosition : 0;
      pagingEntry.page = Math.max(1, Math.floor(normalizedPosition / PHASE_MATCHERS_PER_SHEET) + 1);
    }

    this.refreshPhaseSectionPaging(localSection);

    const destinationField = field || entry.querySelector('.method-name');
    requestAnimationFrame(() => {
      if (destinationField) {
        destinationField.focus();
        destinationField.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      } else {
        entry.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }
    });
  };

CatalogPresenter.prototype.addNewPhaseEntry = function(control) {
    const phaseSection = control.closest('.method-section');
    const phaseEntries = phaseSection.querySelector('.method-items');
    let phaseLookup = phaseSection.querySelector('.method-title').textContent.toLowerCase();

    if (phaseLookup === 'js hooks') phaseLookup = 'js_hooks';

    const entryPosition = `new-${Date.now()}`;
    const singleFieldTypes = ['url', 'content', 'dom', 'js_hooks', 'payload'];
    const isSingleField = singleFieldTypes.includes(phaseLookup);
    const localIsDom = phaseLookup === 'dom';
    const isGlobal = phaseLookup === 'window';

    let fieldPlaceholder = 'Name';
    let datumPlaceholder = 'Value (optional)';
    if (phaseLookup === 'dom') fieldPlaceholder = 'CSS Selector (e.g., .class, #id, [attr])';
    else if (phaseLookup === 'content') fieldPlaceholder = 'Text/Word to search';
    else if (phaseLookup === 'urls' || phaseLookup === 'url') fieldPlaceholder = 'URL Pattern';
    else if (phaseLookup === 'js_hooks') fieldPlaceholder = 'JS Hook Target (e.g., navigator.webdriver)';
    else if (phaseLookup === 'window') {
      fieldPlaceholder = 'Window Path (e.g., grecaptcha, _cf_chl_opt)';
      datumPlaceholder = 'Condition (e.g., typeof object, typeof function)';
    }
    else if (phaseLookup === 'payload') fieldPlaceholder = 'Text (e.g., sensor_data, challenge_token)';

    const globalConditionDropdown = isGlobal ? this.paintInlineConditionDropdown('exists', phaseLookup, entryPosition) : '';
    const presentDatumRow = isGlobal;
    const presentLabelPreferences = true;
    const presentDatumActions = !isGlobal;
    const phaseOrder = phaseEntries.querySelectorAll('.method-item').length;

    const newPhaseMarkup = `
      <div class="method-item"
        data-method-order="${phaseOrder}"
        data-confidence="100"
        data-name-regex="false"
        data-name-wholeword="false"
        data-name-case="false"
        data-value-regex="false"
        data-value-wholeword="false"
        data-value-case="false"
        data-payload-url-pattern=""
        data-payload-url-regex="false"
        data-payload-url-case-sensitive="false"
        data-payload-methods="">
        <div class="method-item-content">
          <div class="method-item-inputs">
            <div class="input-with-indicators">
              <div class="input-row">
                <span class="doc-ord" aria-hidden="true">${String(phaseOrder + 1).padStart(2, '0')}</span>
                <textarea rows="1" class="method-input method-name" placeholder="${fieldPlaceholder}" data-method-key="${phaseLookup}" data-item-index="${entryPosition}"></textarea><div class="doc-echo" aria-hidden="true"></div>
                ${localIsDom ? `<button type="button" class="dom-helper-btn" title="DOM Selector Examples" aria-label="DOM Selector Examples" data-input-index="${entryPosition}">?</button>` : ''}
                ${isGlobal ? `<button type="button" class="window-helper-btn" title="Window Property Examples" aria-label="Window Property Examples" data-input-index="${entryPosition}">?</button>` : ''}
                <div class="field-actions" data-field-type="name">
                  ${presentLabelPreferences ? this.paintPhaseSettingsAction(100, false, 'name') : ''}
                  <button type="button" class="method-action-btn delete" title="Delete Method" aria-label="Delete method">
                    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="input-badges-row">
                <div class="input-indicators" data-for="name-${phaseLookup}-${entryPosition}"></div>
              </div>
            </div>
            ${!isSingleField ? `
            <div class="input-with-indicators value-field-container" style="display: ${presentDatumRow ? 'flex' : 'none'}">
              <div class="input-row">
                    <span class="doc-ord doc-ord--cont" aria-hidden="true">${isGlobal ? '\u27E9' : '='}</span>
                    ${isGlobal
                      ? globalConditionDropdown
                      : `<textarea rows="1" class="method-input method-value" placeholder="${datumPlaceholder}" data-method-key="${phaseLookup}" data-item-index="${entryPosition}"></textarea><div class="doc-echo" aria-hidden="true"></div>`
                    }
                    ${presentDatumActions ? `
                    <div class="field-actions" data-field-type="value">
                  ${this.paintPhaseSettingsAction(100, false, 'value')}
                  <button type="button" class="method-action-btn delete" title="Clear Value" aria-label="Clear value">
                    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor"/>
                    </svg>
                  </button>
                </div>
                ` : ''}
              </div>
              <div class="input-badges-row">
                <div class="input-indicators" data-for="value-${phaseLookup}-${entryPosition}"></div>
              </div>
            </div>
            <button type="button" class="add-value-btn" style="display: ${presentDatumRow ? 'none' : 'flex'}" data-method-key="${phaseLookup}" data-item-index="${entryPosition}">
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
              </svg>
              ${((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('methodAddValue')) || 'Add Value'}
            </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;

    phaseEntries.insertAdjacentHTML('beforeend', newPhaseMarkup);
    const filterField = phaseSection.querySelector('.method-search-input');
    if (filterField && filterField.value.trim()) {
      filterField.value = '';
      this.refreshPhaseSectionPaging(phaseSection, { searchQuery: '' });
    }
    this.refreshPhaseSectionPaging(phaseSection, { goToLastPage: true });
    this.refreshAddMatcherControlSession(phaseSection);
    requestAnimationFrame(() => this.fitAllPatternFields?.());
  };

// ============================================
// Data Collection & Saving
// ============================================

CatalogPresenter.prototype._collectScanFromForm = function() {
    const phasesRegion = document.querySelector('#detectionMethodsContainer');
    if (!phasesRegion) return {};

    const scanPhases = {};
    const phaseSections = phasesRegion.querySelectorAll('.method-section');

    phaseSections.forEach(localSection => {
      const phaseTitle = localSection.querySelector('.method-title')?.textContent.toLowerCase();
      if (!phaseTitle) return;

      let phaseKind = phaseTitle;
      if (phaseTitle === 'js hooks') {
        phaseKind = 'js_hooks';
      }

      const phases = [];
      const phaseEntries = localSection.querySelectorAll('.method-item');

      phaseEntries.forEach(entry => {
        const labelField = entry.querySelector('.method-name');
        const datumField = entry.querySelector('.method-value');

        const hasLabel = labelField && labelField.value.trim();

        if (hasLabel) {
          let phasePayload = {
            confidence: parseInt(entry.dataset.confidence || '100'),
          };

          if (phaseKind === 'header' || phaseKind === 'cookie') {
            phasePayload.name = labelField.value;
            if (datumField?.value) {
              phasePayload.value = datumField.value;
            }
          } else if (phaseKind === 'url' || phaseKind === 'content' || phaseKind === 'payload') {
            phasePayload.text = labelField.value;
            if (datumField?.value) {
              phasePayload.description = datumField.value;
            }
          } else if (phaseKind === 'dom') {
            phasePayload.selector = labelField.value;
            if (datumField?.value) {
              phasePayload.description = datumField.value;
            }
          } else if (phaseKind === 'js_hooks') {
            phasePayload.target = labelField.value;
            if (datumField?.value) {
              phasePayload.description = datumField.value;
            }
          } else if (phaseKind === 'window') {
            phasePayload.path = labelField.value;
            phasePayload.condition = datumField?.value || 'exists';
          }

          if (phaseKind === 'header' || phaseKind === 'cookie') {
            if (entry.dataset.nameRegex === 'true') phasePayload.nameRegex = true;
            if (entry.dataset.nameWholeword === 'true') phasePayload.nameWholeWord = true;
            if (entry.dataset.nameCase === 'true') phasePayload.nameCaseSensitive = true;
            if (entry.dataset.valueRegex === 'true') phasePayload.valueRegex = true;
            if (entry.dataset.valueWholeword === 'true') phasePayload.valueWholeWord = true;
            if (entry.dataset.valueCase === 'true') phasePayload.valueCaseSensitive = true;
          } else if (phaseKind === 'url' || phaseKind === 'content' || phaseKind === 'payload') {
            if (entry.dataset.nameRegex === 'true') phasePayload.textRegex = true;
            if (entry.dataset.nameWholeword === 'true') phasePayload.textWholeWord = true;
            if (entry.dataset.nameCase === 'true') phasePayload.textCaseSensitive = true;
          } else if (phaseKind === 'dom') {
            if (entry.dataset.nameRegex === 'true') phasePayload.selectorRegex = true;
            if (entry.dataset.nameWholeword === 'true') phasePayload.selectorWholeWord = true;
            if (entry.dataset.nameCase === 'true') phasePayload.selectorCaseSensitive = true;
          }

          if (entry.dataset.checkScripts === 'true') {
            phasePayload.checkScripts = true;
          }

          if (phaseKind === 'header') {
            phasePayload.nameScope = canonicalizeCookieHeaderBoundary(entry.dataset.nameScope || 'response', 'response');
            phasePayload.valueScope = canonicalizeCookieHeaderBoundary(entry.dataset.valueScope || 'response', 'response');
          } else if (phaseKind === 'cookie') {
            phasePayload.nameScope = canonicalizeCookieHeaderBoundary(entry.dataset.nameScope || 'request', 'request');
            phasePayload.valueScope = canonicalizeCookieHeaderBoundary(entry.dataset.valueScope || 'request', 'request');
          } else if (phaseKind === 'url') {
            phasePayload.textScope = entry.dataset.textScope || 'all';
          }

          if (phaseKind === 'payload') {
            const addressMatcher = entry.dataset.payloadUrlPattern || '';
            if (addressMatcher) {
              phasePayload.urlPattern = addressMatcher;
              if (entry.dataset.payloadUrlRegex === 'true') {
                phasePayload.urlRegex = true;
              }
              if (entry.dataset.payloadUrlCaseSensitive === 'true') {
                phasePayload.urlCaseSensitive = true;
              }
            }
            const phasesCollection = entry.dataset.payloadMethods || '';
            if (phasesCollection) {
              phasePayload.methods = phasesCollection.split(',').filter(localM => localM.trim());
            }
          }

          phases.push(phasePayload);
        }
      });

      if (phases.length > 0) {
        scanPhases[phaseKind] = phases;
      }
    });

    return scanPhases;
  };

CatalogPresenter.prototype.refreshRuleBadgePalette = function(ruleLabel, palette) {
    if (!this.taxonomy || !ruleLabel || !palette) return;

    const taxonomies = this.taxonomy.resolveTaxonomies();

    Object.values(taxonomies).forEach(taxonomy => {
      if (taxonomy.detectors && taxonomy.detectors[ruleLabel]) {
        taxonomy.detectors[ruleLabel].color = palette;
      }
    });

    this.taxonomy.persistToRepository();
  };

CatalogPresenter.prototype.persistPolicy = function() {
    if (!this.currentEditDetector) return;

    this.purgeMatcherValidationSession();
    const matcherValidation = this.validateMatcherRows();
    if (!matcherValidation.isValid) {
      this.markMatcherValidationSession(matcherValidation.invalidRows);
      this.revealAndFocusRejectedRow(matcherValidation.invalidRows[0]);

      Toasts.caution('Please fill all required pattern fields before saving.');
      return;
    }

    const labelField = document.querySelector('#detectorNameInput');
    const taxonomySelect = document.querySelector('#detectorCategorySelect');
    const localDifficultySelect = document.querySelector('#detectorDifficultySelect');

    if (labelField) {
      this.currentEditDetector.detector.name = labelField.value;
      this.currentEditDetector.detector.displayName = labelField.value;
    }

    if (taxonomySelect) {
      this.currentEditDetector.detector.category = taxonomySelect.value;
      this.currentEditDetector.category = taxonomySelect.value;
    }

    if (localDifficultySelect) {
      const localNormalizedDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
        ? FindingMetrics.canonicalizeDifficulty(localDifficultySelect.value)
        : null;
      const baselineDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.baselineDifficultyForTaxonomy === 'function')
        ? FindingMetrics.baselineDifficultyForTaxonomy(this.currentEditDetector.category || this.currentEditDetector.detector.category)
        : 'Medium';
      this.currentEditDetector.detector.difficulty = localNormalizedDifficulty || baselineDifficulty;
    }

    const authorField = document.querySelector('#detectorAuthorInput');
    if (authorField) {
      const localAuthor = authorField.value.trim() || 'scrapeless';
      this.currentEditDetector.detector.author = localAuthor;
    }

    if (this.currentEditDetector.customIcon) {
      this.currentEditDetector.detector.customIcon = this.currentEditDetector.customIcon;
    }

    const scanPhases = this._collectScanFromForm();
    if (Object.keys(scanPhases).length > 0) {
      this.currentEditDetector.detector.detection = scanPhases;
      Telemetry.performUi('Updated detection methods:', scanPhases);
    }

    Telemetry.performUi('Saving rule for:', this.currentEditDetector.detector.displayName);

    const priorScan = this.currentEditDetector.originalDetection || {};
    const activeScan = this.currentEditDetector.detector.detection || {};
    const localHasChanges = this.currentEditDetector.isNew ||
      JSON.stringify(priorScan) !== JSON.stringify(activeScan);

    if (localHasChanges) {
      const localNow = new Date();
      const localYear = localNow.getFullYear();
      const localMonth = String(localNow.getMonth() + 1).padStart(2, '0');
      const localDay = String(localNow.getDate()).padStart(2, '0');
      const localHours = String(localNow.getHours()).padStart(2, '0');
      const localMinutes = String(localNow.getMinutes()).padStart(2, '0');
      const localSeconds = String(localNow.getSeconds()).padStart(2, '0');
      const localTimestamp = `${localYear}-${localMonth}-${localDay} ${localHours}:${localMinutes}:${localSeconds}`;

      this.currentEditDetector.detector.lastUpdated = localTimestamp;

      // Auto-increment version
      if (this.currentEditDetector.isNew) {
        this.currentEditDetector.detector.version = '1.0';
      } else {
        const activeVersion = this.currentEditDetector.detector.version || '1.0';
        const localVersionNum = parseFloat(activeVersion) || 1.0;
        const localNewVersion = (localVersionNum + 0.1).toFixed(1);
        this.currentEditDetector.detector.version = localNewVersion;
        Telemetry.performUi(`Version incremented: ${activeVersion} → ${localNewVersion}`);
      }
    } else {
      Telemetry.performUi('No changes detected, version and timestamp unchanged');
    }

    if (this.currentEditDetector.isNew) {
      const ruleLabel = this.currentEditDetector.detector.name || 'custom';
      const slugLabel = ruleLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const ruleToken = slugLabel || `custom-${Date.now()}`;

      this.currentEditDetector.detector.id = ruleToken;

      this.ruleCatalog.addRule(
        this.currentEditDetector.category,
        ruleToken,
        this.currentEditDetector.detector
      ).then(completion => {
        if (completion) {
          Telemetry.performUi('New detector added successfully');
          chrome.runtime.sendMessage({ type: 'RELOAD_RULE_CATALOG' }, (reply) => {
            Telemetry.performUi('Detectors reloaded in background:', reply);
          });
          this.presentPolicies();
        }
      });

      this.closeEditDialog();
      return;
    }

    if (this.ruleCatalog) {
      const updatedRule = {
        ...this.currentEditDetector.detector,
        customIcon: this.currentEditDetector.detector.customIcon
      };

      this.ruleCatalog.replaceRule(
        this.currentEditDetector.category,
        this.currentEditDetector.detectorName,
        updatedRule
      ).then(completion => {
        if (completion) {
          Telemetry.performUi('Detector updated, lastUpdated:', updatedRule.lastUpdated);
          Telemetry.performUi('Detector saved to storage successfully');
          chrome.runtime.sendMessage({ type: 'RELOAD_RULE_CATALOG' }, (reply) => {
            Telemetry.performUi('Detectors reloaded in background:', reply);
          });
        } else {
          Telemetry.failure('UI', 'Failed to save detector');
        }
      }).catch(failure => {
          Telemetry.failure('UI', 'Failed to save detector:', failure);
      });
    }

    if (this.taxonomy && this.colorManager) {
      const palette = this.colorManager.resolvePalette();
      this.refreshRuleBadgePalette(this.currentEditDetector.detectorName, palette);
    }

    this.closeEditDialog();
    this.presentPolicies();
  };
