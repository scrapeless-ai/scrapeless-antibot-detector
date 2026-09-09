// Color personalization methods for SettingsUI — extracted from settings-ui.js.
// Requires settings-ui.js to load first (defines const SettingsUI).

PreferenceForm.TAXONOMY_PALETTE_LABELS = [
  { key: 'categoryAntibot', fallback: 'Anti-bot' },
  { key: 'categoryCaptcha', fallback: 'Captcha' },
  { key: 'categoryFingerprint', fallback: 'Fingerprint' }
];

PreferenceForm.applyTaxonomyPaletteLabels = function(scopeRoot) {
  const boundary = scopeRoot && typeof scopeRoot.querySelectorAll === 'function' ? scopeRoot : document;
  const localTr = (typeof LocaleRuntime !== 'undefined' && LocaleRuntime.performTr) ? LocaleRuntime.performTr.bind(LocaleRuntime) : null;

  PreferenceForm.TAXONOMY_PALETTE_LABELS.forEach(({ key: lookupKey, fallback: localFallback }) => {
    boundary.querySelectorAll(`.color-row-badge--category[data-i18n="${lookupKey}"]`).forEach((node) => {
      let localLabel = localTr ? localTr(lookupKey, localFallback) : localFallback;
      if (lookupKey === 'categoryCaptcha' && localLabel === 'CAPTCHA') {
        localLabel = 'Captcha';
      }
      node.textContent = localLabel;
    });
  });
};

PreferenceForm.performHexToRgb = function(localHex) {
  if (!localHex || typeof localHex !== 'string') return null;
  const localNormalized = localHex.trim().replace('#', '');
  if (localNormalized.length !== 6) return null;
  const localNum = parseInt(localNormalized, 16);
  if (Number.isNaN(localNum)) return null;
  return {
    r: (localNum >> 16) & 255,
    g: (localNum >> 8) & 255,
    b: localNum & 255
  };
};

PreferenceForm._applyPaletteRowBadgeStyle = function(localBadge, hexPalette) {
  if (!localBadge) return;
  const palette = hexPalette || '#666666';
  const localRgb = PreferenceForm.performHexToRgb(palette);
  if (!localRgb) return;
  localBadge.style.background = `rgba(${localRgb.r}, ${localRgb.g}, ${localRgb.b}, 0.2)`;
  localBadge.style.color = palette;
  localBadge.style.borderColor = `rgba(${localRgb.r}, ${localRgb.g}, ${localRgb.b}, 0.35)`;
};

PreferenceForm.syncPaletteRowBadges = function() {
  document.querySelectorAll('.color-row-badge[data-color-for]').forEach((localBadge) => {
    const fieldToken = localBadge.dataset.colorFor;
    const field = fieldToken ? document.querySelector(`#${fieldToken}`) : null;
    if (field) {
      PreferenceForm._applyPaletteRowBadgeStyle(localBadge, field.value);
    }
  });
};

PreferenceForm.wirePalettePaging = function() {
    const localPrevBtn = document.querySelector('#colorPrevBtn');
    const followingBtn = document.querySelector('#colorNextBtn');
    const sheetNum = document.querySelector('#colorPageNum');
    const aggregateSheets = document.querySelector('#colorTotalPages');
    const sheets = document.querySelectorAll('.color-page');

    if (!localPrevBtn || !followingBtn || !sheetNum || !aggregateSheets || sheets.length === 0) {
      return;
    }

    let activeSheet = 1;
    const aggregate = sheets.length;

    // JS owns the page count — the static HTML value is only a placeholder.
    aggregateSheets.textContent = aggregate;

    const refreshPaging = () => {
      sheetNum.textContent = activeSheet;

      sheets.forEach((sheet, position) => {
        sheet.style.display = (position + 1) === activeSheet ? 'block' : 'none';
      });

      localPrevBtn.disabled = activeSheet === 1;
      followingBtn.disabled = activeSheet === aggregate;
    };

    localPrevBtn.addEventListener('click', () => {
      if (activeSheet > 1) {
        activeSheet--;
        refreshPaging();
      }
    });

    followingBtn.addEventListener('click', () => {
      if (activeSheet < aggregate) {
        activeSheet++;
        refreshPaging();
      }
    });

    refreshPaging();
};

PreferenceForm._wirePaletteSubscriptions = function() {
  if (PreferenceForm._paletteSubscriptionsReady) return;
  PreferenceForm._paletteSubscriptionsReady = true;

  document.querySelectorAll('.color-row-badge[data-color-for]').forEach((localBadge) => {
    const fieldToken = localBadge.dataset.colorFor;
    const field = fieldToken ? document.querySelector(`#${fieldToken}`) : null;
    if (!field) return;

    const localSyncHex = () => {
      const hexToken = field.id.replace(/^color/, 'hex');
      const localHexEl = document.querySelector(`#${hexToken}`);
      if (localHexEl) {
        localHexEl.textContent = field.value;
      }
      PreferenceForm._applyPaletteRowBadgeStyle(localBadge, field.value);
    };

    field.addEventListener('input', localSyncHex);
    field.addEventListener('change', localSyncHex);
    localSyncHex();
  });

  PreferenceForm.syncPaletteRowBadges();
};

if (typeof self !== 'undefined') {
    self.PreferenceForm = PreferenceForm;
}
