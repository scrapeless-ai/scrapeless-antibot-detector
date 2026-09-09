// Custom language picker for settings (replaces native <select>).

// Requires settings-ui.js to load first.



PreferenceForm.LANGUAGE_CHOICES = [

  { value: 'auto', labelKey: 'settingsLanguageAuto', label: 'Use browser language' },

  { value: 'en', label: 'English' },

  { value: 'es', label: 'Español' },

  { value: 'pt_BR', label: 'Português (Brasil)' },

  { value: 'fr', label: 'Français' },

  { value: 'de', label: 'Deutsch' },

  { value: 'it', label: 'Italiano' },

  { value: 'ru', label: 'Русский' },

  { value: 'ja', label: '日本語' },

  { value: 'ko', label: '한국어' },

  { value: 'zh_CN', label: '简体中文' },

  { value: 'ar', label: 'العربية' },

  { value: 'hi', label: 'हिन्दी' }

];



PreferenceForm.performStripLeadingEmoji = function(copy) {

  if (!copy || typeof copy !== 'string') return copy;

  return copy.replace(/^(\s*\p{Extended_Pictographic}\uFE0F?\s*)+/u, '').trim() || copy;

};



PreferenceForm._languageChoiceLabel = function(choice) {

  if (choice.labelKey && typeof LocaleRuntime !== 'undefined') {

    const localTranslated = LocaleRuntime.resolve(choice.labelKey);

    if (localTranslated) {

      return PreferenceForm.performStripLeadingEmoji(localTranslated);

    }

  }

  return choice.label;

};



PreferenceForm._resolveLocaleFlagAddress = function(localLocale) {

  if (typeof WebAddress === 'undefined' || typeof WebAddress.resolveLocaleFlagAddress !== 'function') {

    return null;

  }

  return WebAddress.resolveLocaleFlagAddress(localLocale, 40);

};



PreferenceForm.performLanguageFlagMarkup = function(choice) {

  const address = PreferenceForm._resolveLocaleFlagAddress(choice.value);

  if (!address) {

    return '<span class="language-picker-flag-slot language-picker-flag-slot--empty" aria-hidden="true"></span>';

  }

  const safeAddress = TextCodec.escapeMarkup(address);

  return `<span class="language-picker-flag-slot" aria-hidden="true"><img class="language-picker-flag" src="${safeAddress}" width="22" height="16" alt="" loading="lazy" decoding="async"></span>`;

};



PreferenceForm.performApplyLanguagePickerFlag = function(localSlotEl, localLocale) {

  if (!localSlotEl) return;



  const address = PreferenceForm._resolveLocaleFlagAddress(localLocale);

  if (!address) {

    localSlotEl.innerHTML = '';

    localSlotEl.classList.add('language-picker-flag-slot--empty');

    return;

  }



  localSlotEl.classList.remove('language-picker-flag-slot--empty');

  let localImg = localSlotEl.querySelector('img.language-picker-flag');

  if (!localImg) {

    localImg = document.createElement('img');

    localImg.className = 'language-picker-flag';

    localImg.width = 22;

    localImg.height = 16;

    localImg.alt = '';

    localImg.loading = 'lazy';

    localImg.decoding = 'async';

    localSlotEl.appendChild(localImg);

  }

  localImg.src = address;

};



PreferenceForm._findLanguageChoice = function(datum) {

  return PreferenceForm.LANGUAGE_CHOICES.find((localOpt) => localOpt.value === datum)

    || PreferenceForm.LANGUAGE_CHOICES[0];

};



PreferenceForm.performRefreshLanguagePickerLabels = function() {

  const localMenu = document.querySelector('#languagePickerMenu');

  if (!localMenu) return;



  localMenu.querySelectorAll('.language-picker-option').forEach((node) => {

    const choice = PreferenceForm._findLanguageChoice(node.dataset.value);

    const localLabelEl = node.querySelector('.language-picker-option-label');

    const localFlagSlot = node.querySelector('.language-picker-flag-slot');

    if (localLabelEl) {

      localLabelEl.textContent = PreferenceForm._languageChoiceLabel(choice);

    }

    if (localFlagSlot) {

      PreferenceForm.performApplyLanguagePickerFlag(localFlagSlot, choice.value);

    }

  });



  const localHidden = document.querySelector('#languageOverride');

  if (localHidden) {

    PreferenceForm.assignLanguagePickerDatum(localHidden.value || 'auto');

  }

};



PreferenceForm.assignLanguagePickerDatum = function(datum) {

  const localPicker = document.querySelector('#languagePicker');

  const localHidden = document.querySelector('#languageOverride');

  const localLabelEl = document.querySelector('#languagePickerLabel');

  const localFlagSlot = document.querySelector('#languagePickerFlagSlot');

  const localMenu = document.querySelector('#languagePickerMenu');

  if (!localPicker || !localHidden) return;



  const localChoice = datum || 'auto';

  localHidden.value = localChoice;

  const choice = PreferenceForm._findLanguageChoice(localChoice);



  PreferenceForm.performApplyLanguagePickerFlag(localFlagSlot, choice.value);

  if (localLabelEl) {

    localLabelEl.textContent = PreferenceForm._languageChoiceLabel(choice);

  }



  if (localMenu) {

    localMenu.querySelectorAll('.language-picker-option').forEach((node) => {

      const chosen = node.dataset.value === localChoice;

      node.classList.toggle('is-selected', chosen);

      node.setAttribute('aria-selected', chosen ? 'true' : 'false');

    });

  }

};



PreferenceForm._syncLanguagePickerOpenSession = function() {

  const localPicker = document.querySelector('#languagePicker');

  const localCard = document.querySelector('.settings-card--language');

  const localIsOpen = localPicker && localPicker.classList.contains('open');

  if (localCard) {

    localCard.classList.toggle('is-picker-open', !!localIsOpen);

  }

};



PreferenceForm.performCloseLanguagePicker = function() {

  const localPicker = document.querySelector('#languagePicker');

  const localTrigger = document.querySelector('#languagePickerTrigger');

  const localMenu = document.querySelector('#languagePickerMenu');

  if (!localPicker || !localMenu) return;

  localPicker.classList.remove('open');

  localMenu.hidden = true;

  if (localTrigger) localTrigger.setAttribute('aria-expanded', 'false');

  PreferenceForm._syncLanguagePickerOpenSession();

};



PreferenceForm.performOpenLanguagePicker = function() {

  const localPicker = document.querySelector('#languagePicker');

  const localTrigger = document.querySelector('#languagePickerTrigger');

  const localMenu = document.querySelector('#languagePickerMenu');

  if (!localPicker || !localMenu) return;



  localPicker.classList.add('open');

  localMenu.hidden = false;

  if (localTrigger) localTrigger.setAttribute('aria-expanded', 'true');

  PreferenceForm._syncLanguagePickerOpenSession();



  localMenu.classList.remove('language-picker-menu--up');

  requestAnimationFrame(() => {

    const dialogBody = localPicker.closest('.modal-body');

    if (!dialogBody) return;

    const localMenuRect = localMenu.getBoundingClientRect();

    const localBodyRect = dialogBody.getBoundingClientRect();

    if (localMenuRect.bottom > localBodyRect.bottom - 4) {

      dialogBody.scrollTop += (localMenuRect.bottom - localBodyRect.bottom) + 12;

    }

  });

};



PreferenceForm.performApplyLanguageChoice = async function(localChoice) {

  PreferenceForm.assignLanguagePickerDatum(localChoice);

  PreferenceForm.performCloseLanguagePicker();



  try {

    await chrome.storage.local.set({ scrapeless_language_override: localChoice });

  } catch (failure) {

    Telemetry.failure('UI', 'Failed to save language override', failure);

  }



  if (typeof LocaleRuntime !== 'undefined') {

    try {

      await LocaleRuntime.readOverride(localChoice === 'auto' ? null : localChoice);

      LocaleRuntime.performApply(document);

      if (typeof PreferenceForm.applyTaxonomyPaletteLabels === 'function') {

        PreferenceForm.applyTaxonomyPaletteLabels();

      }

      if (typeof PreferenceForm.syncPaletteRowBadges === 'function') {

        PreferenceForm.syncPaletteRowBadges();

      }

      PreferenceForm.performRefreshLanguagePickerLabels();

      const findingsPane = window.popupInstance?.findingsPane;
      if (findingsPane && typeof findingsPane.refreshScanSessionI18N === 'function') {
        findingsPane.refreshScanSessionI18N();
      } else if (findingsPane && typeof findingsPane.refreshEmptySessionI18N === 'function') {
        findingsPane.refreshEmptySessionI18N();
      }

    } catch (local) { /* best-effort */ }

  }

};



PreferenceForm.performInitLanguagePicker = function() {

  const localPicker = document.querySelector('#languagePicker');

  const localMenu = document.querySelector('#languagePickerMenu');

  const localTrigger = document.querySelector('#languagePickerTrigger');

  if (!localPicker || !localMenu || !localTrigger || localPicker.dataset.initialized === '1') {

    return;

  }

  localPicker.dataset.initialized = '1';



  localMenu.innerHTML = PreferenceForm.LANGUAGE_CHOICES.map((choice) => {

    const localLabel = PreferenceForm._languageChoiceLabel(choice);

    return `<li class="language-picker-option" role="option" data-value="${choice.value}" aria-selected="false">

      ${PreferenceForm.performLanguageFlagMarkup(choice)}

      <span class="language-picker-option-label">${TextCodec.escapeMarkup(localLabel)}</span>

    </li>`;

  }).join('');



  const localInitial = document.querySelector('#languageOverride')?.value || 'auto';

  PreferenceForm.assignLanguagePickerDatum(localInitial);



  localTrigger.addEventListener('click', (failure) => {

    failure.stopPropagation();

    if (localPicker.classList.contains('open')) {

      PreferenceForm.performCloseLanguagePicker();

    } else {

      PreferenceForm.performOpenLanguagePicker();

    }

  });



  localMenu.addEventListener('click', (failure) => {

    const choice = failure.target.closest('.language-picker-option');

    if (!choice) return;

    PreferenceForm.performApplyLanguageChoice(choice.dataset.value || 'auto');

  });



  document.addEventListener('click', (failure) => {

    if (!localPicker.contains(failure.target)) {

      PreferenceForm.performCloseLanguagePicker();

    }

  });



  document.addEventListener('keydown', (failure) => {

    if (failure.key === 'Escape') {

      PreferenceForm.performCloseLanguagePicker();

    }

  });

};

if (typeof self !== 'undefined') {
  self.PreferenceForm = PreferenceForm;
}
