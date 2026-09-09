/**
 * Settings UI/modal methods for popup context.
 * Dependencies: `Settings` class compatibility wrappers call this registry.
 */
const PreferenceForm = (typeof self !== 'undefined' && self.PreferenceForm) ? self.PreferenceForm : {};

PreferenceForm.presentPreferences = function() {
    const preferencesDialog = document.querySelector('#settingsModal');
    if (preferencesDialog) {
      preferencesDialog.classList.add('is-open');
      this.isModalVisible = true;
      this.readPreferences();
      requestAnimationFrame(() => {
        const runningBtn = document.querySelector('.settings-tab-btn.active');
        if (runningBtn) {
          runningBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      });
    }
};

PreferenceForm.dismissPreferences = function() {
    const preferencesDialog = document.querySelector('#settingsModal');
    if (preferencesDialog) {
      preferencesDialog.classList.remove('is-open');
      this.isModalVisible = false;
    }
};

PreferenceForm.showPane = function(pageLabel) {
    const allPageControls = document.querySelectorAll('.settings-tab-btn');
    let runningBtn = null;
    allPageControls.forEach(localBtn => {
      if (localBtn.getAttribute('data-settings-tab') === pageLabel) {
        localBtn.classList.add('active');
        runningBtn = localBtn;
      } else {
        localBtn.classList.remove('active');
      }
    });

    if (runningBtn) {
      runningBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    const allPageContents = document.querySelectorAll('.settings-tab-content');
    allPageContents.forEach(localContent => {
      if (localContent.getAttribute('data-tab-content') === pageLabel) {
        localContent.classList.add('active');
      } else {
        localContent.classList.remove('active');
      }
    });
};

PreferenceForm.readPreferences = async function() {
    try {
      const outcome = await chrome.storage.local.get(['scrapeless_settings']);

      if (outcome.scrapeless_settings) {
        // Handle both string and object storage formats
        const persistedPreferences = typeof ExtensionStore !== 'undefined' && typeof ExtensionStore.parseStoredDatum === 'function'
          ? ExtensionStore.parseStoredDatum(outcome.scrapeless_settings, 'scrapeless_settings')
          : (typeof outcome.scrapeless_settings === 'string'
              ? JSON.parse(outcome.scrapeless_settings)
              : outcome.scrapeless_settings);
        const readyPreferences = typeof ExtensionStore !== 'undefined' && typeof ExtensionStore.canonicalizePreferences === 'function'
          ? ExtensionStore.canonicalizePreferences(outcome.scrapeless_settings)
          : (persistedPreferences.settings || persistedPreferences);

        Telemetry.performUi('Loading settings - raw:', outcome.scrapeless_settings);
        Telemetry.performUi('Loading settings - parsed:', persistedPreferences);
        Telemetry.performUi('Loading settings - extracted:', readyPreferences);

        if (typeof readyPreferences === 'object' && readyPreferences !== null) {
          this.preferences = this.performDeepMerge(this.preferences, readyPreferences);
          const legacyProbesProfile = this.preferences.probeConfig;
          delete this.preferences.probeConfig;
          delete this.preferences.reliabilityConfig;
          // Legacy compatibility: migrate flat cache settings to nested structure
          if (this.preferences.scanning) {
            if (this.preferences.scanning.probeConfig === undefined &&
                legacyProbesProfile && typeof legacyProbesProfile === 'object') {
              this.preferences.scanning.probeConfig = legacyProbesProfile;
            }
            if (this.preferences.scanning.memoDuration === undefined && this.preferences.memoDuration !== undefined) {
              this.preferences.scanning.memoDuration = this.preferences.memoDuration;
            }
            if (this.preferences.scanning.memoUnit === undefined && this.preferences.memoUnit !== undefined) {
              this.preferences.scanning.memoUnit = this.preferences.memoUnit;
            }
            if (this.preferences.scanning.memoScope === undefined && this.preferences.memoScope !== undefined) {
              this.preferences.scanning.memoScope = this.preferences.memoScope;
            }
            if ((this.preferences.scanning.skippedDomains == null || this.preferences.scanning.skippedDomains.length === 0) &&
                Array.isArray(this.preferences.skippedDomains) && this.preferences.skippedDomains.length > 0) {
              this.preferences.scanning.skippedDomains = this.preferences.skippedDomains;
            }
            if (this.preferences.scanning.memoDuration === undefined && this.preferences.cacheHours !== undefined) {
              this.preferences.scanning.memoDuration = this.preferences.cacheHours;
              this.preferences.scanning.memoUnit = this.preferences.scanning.memoUnit || 'hours';
            }
          }
          delete this.preferences.memoDuration;
          delete this.preferences.memoUnit;
          delete this.preferences.memoScope;
          delete this.preferences.cacheHours;
          delete this.preferences.skippedDomains;
        }
      } else {
        Telemetry.performUi('No saved settings found, using defaults');
      }

      if (typeof ExtensionGateway !== 'undefined' && typeof ExtensionGateway.applyDebugStrategy === 'function') {
        ExtensionGateway.applyDebugStrategy(this.preferences);
      }

      // Apply current language override (stored separately from main settings
      // so it can be loaded at popup boot before settings UI initializes).
      try {
        const langOutcome = await chrome.storage.local.get(['scrapeless_language_override']);
        const langDatum = langOutcome.scrapeless_language_override || 'auto';
        if (typeof PreferenceForm.assignLanguagePickerDatum === 'function') {
          PreferenceForm.assignLanguagePickerDatum(langDatum);
        } else {
          const langField = document.querySelector('#languageOverride');
          if (langField) langField.value = langDatum;
        }
      } catch (local) {
        // chrome.storage unavailable (rare; e.g., extension reloading mid-popup).
        // Dropdown stays at its default 'auto' option — matches the runtime
        // behavior in src/entry/console.js, which also falls back to the browser locale
        // when storage is unreadable. No user-visible regression.
      }

      this.refreshPreferencesUi();
      Telemetry.performUi('Settings loaded and UI updated:', this.preferences);

    } catch (failure) {
      Telemetry.failure('UI', 'Failed to load settings:', failure);
      Toasts.failure(((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('failedLoadSettingsDefault')) || 'Failed to load settings. Using defaults.');
    }
};

PreferenceForm.performDeepMerge = function(destination, origin) {
    const outcome = { ...destination };

    const kindOf = (entryValue) => {
      if (Array.isArray(entryValue)) return 'array';
      if (entryValue === null) return 'null';
      return typeof entryValue;
    };

    for (const lookupKey in origin) {
      if (!origin.hasOwnProperty(lookupKey)) continue;
      const localSrcVal = origin[lookupKey];
      const localTgtVal = outcome[lookupKey];

      // New key (not in defaults) — allow as-is; can't validate without schema.
      if (localTgtVal === undefined) {
        outcome[lookupKey] = localSrcVal;
        continue;
      }

      // Drop stored values whose type doesn't match defaults — protects against
      // a corrupted/malicious storage entry poisoning the merged settings shape.
      if (kindOf(localSrcVal) !== kindOf(localTgtVal)) continue;

      if (kindOf(localSrcVal) === 'object') {
        outcome[lookupKey] = this.performDeepMerge(localTgtVal, localSrcVal);
      } else {
        outcome[lookupKey] = localSrcVal;
      }
    }

    return outcome;
};

PreferenceForm.assignToggleControlledVisibility = function(localToggleEl, localTargets = []) {
    if (!Array.isArray(localTargets) || localTargets.length === 0) {
      return;
    }

    const isActive = !!(localToggleEl && localToggleEl.checked);

    localTargets.forEach((destination) => {
      if (!destination || !destination.element) {
        return;
      }

      destination.element.style.display = isActive
        ? (destination.onDisplay || 'block')
        : 'none';
    });
};

PreferenceForm.persistPreferences = async function(choices = {}) {
    try {
      const localShouldNotify = choices.notify !== false;
      let oldMemoBoundary = null;
      try {
        const outcome = await chrome.storage.local.get(['scrapeless_settings']);
        if (outcome.scrapeless_settings) {
          const readyPreferences = typeof ExtensionStore !== 'undefined' && typeof ExtensionStore.canonicalizePreferences === 'function'
            ? ExtensionStore.canonicalizePreferences(outcome.scrapeless_settings)
            : {};
          oldMemoBoundary = readyPreferences.memoScope || readyPreferences.scanning?.memoScope || 'domain';
        }
      } catch (failure) {
        Telemetry.performDebug('UI', 'Could not read old cache scope:', failure);
      }

      delete this.preferences.probeConfig;
      delete this.preferences.reliabilityConfig;
      // Legacy compatibility: remove flat cache settings migrated to detection.*
      delete this.preferences.memoDuration;
      delete this.preferences.memoUnit;
      delete this.preferences.memoScope;
      delete this.preferences.cacheHours;
      delete this.preferences.skippedDomains;

      const preferencesPayload = ExtensionStore.sealRecord('prefs', this.preferences);

      await chrome.storage.local.set({
        'scrapeless_settings': JSON.stringify(preferencesPayload, null, 2)
      });

      if (typeof ExtensionGateway !== 'undefined' && typeof ExtensionGateway.applyDebugStrategy === 'function') {
        ExtensionGateway.applyDebugStrategy(this.preferences);
      }

      Telemetry.performUi('Settings saved:', this.preferences);

      const newMemoBoundary = this.preferences.memoScope || this.preferences.scanning?.memoScope || 'domain';
      const memoBoundaryChanged = oldMemoBoundary && oldMemoBoundary !== newMemoBoundary;

      if (memoBoundaryChanged) {
        Telemetry.performUi(`[Settings] Cache scope changed from "${oldMemoBoundary}" to "${newMemoBoundary}" - preserving cache data, invalidating current view`);

        WebAddress.purgeAddressHashMemo();

        chrome.runtime.sendMessage({ type: 'MEMO_SCOPE_CHANGED' }, (reply) => {
          if (chrome.runtime.lastError) {
            Telemetry.performDebug('UI', 'Failed to notify background of cache scope change:', chrome.runtime.lastError.message);
          }
        });

        chrome.runtime.sendMessage({ type: 'SCAN_PURGE_MEMO' }, (reply) => {
          if (chrome.runtime.lastError) {
            Telemetry.performDebug('UI', 'Failed to notify Detection tab:', chrome.runtime.lastError.message);
          }
        });
      }

      if (localShouldNotify) {
        Toasts.completion(((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('settingsSavedToast')) || 'Settings saved');
      }

      // Invalidate background settings cache so webhook/background features use updated values
      chrome.runtime.sendMessage({ type: 'PREFERENCES_UPDATED' }, (reply) => {
        if (chrome.runtime.lastError) {
          Telemetry.performDebug('UI', 'Failed to notify background of settings update:', chrome.runtime.lastError.message);
        } else {
          Telemetry.performUi('Background notified of settings update:', reply);
        }
      });

      chrome.runtime.sendMessage({ type: 'SYNC_TAXONOMY_PALETTE' }, (reply) => {
        if (chrome.runtime.lastError) {
          Telemetry.performDebug('UI', 'Failed to sync category colors:', chrome.runtime.lastError.message);
        } else {
          Telemetry.performUi('Category colors synced:', reply);
        }
      });

      return true;

    } catch (failure2) {
      Telemetry.failure('UI', 'Failed to save settings:', failure2);
      const localTFS = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
      Toasts.failure((localTFS && localTFS.encode('failedSaveSettingsFmt', failure2.message)) || ('Failed to save settings: ' + failure2.message));
      return false;
    }
};

PreferenceForm.refreshPreferencesUi = function() {
    // ========== GENERAL TAB ==========
    const toastsToggle = document.querySelector('#alertsActive');
    if (toastsToggle) {
      toastsToggle.checked = this.preferences.alertsActive ?? true;
    }

    const debugStrategyToggle = document.querySelector('#diagnosticModeGeneral');
    if (debugStrategyToggle) {
      debugStrategyToggle.checked = this.preferences.diagnosticMode ?? false;
    }

    const traceCollectorSection = document.querySelector('#logCollectorSection');
    if (traceCollectorSection) {
      traceCollectorSection.style.display = (this.preferences.diagnosticMode ?? false) ? 'block' : 'none';
    }

    const traceCollectorToggle = document.querySelector('#journalActive');
    if (traceCollectorToggle) {
      traceCollectorToggle.checked = this.preferences.journalActive ?? false;
    }

    const traceCollectorControls = document.querySelector('#logCollectorControls');
    if (traceCollectorControls) {
      traceCollectorControls.style.display = (this.preferences.journalActive ?? false) ? 'block' : 'none';
    }

    const traceCollectorLimitTracesField = document.querySelector('#journalCeiling');
    if (traceCollectorLimitTracesField) {
      const safeLimit = Math.min(Math.max(this.preferences.journalCeiling ?? 5000, 100), 5000);
      traceCollectorLimitTracesField.value = safeLimit;
    }

    const traceTotalLimit = document.querySelector('#logCountMax');
    if (traceTotalLimit) {
      const safeLimit2 = Math.min(Math.max(this.preferences.journalCeiling ?? 5000, 100), 5000);
      traceTotalLimit.textContent = safeLimit2;
    }

    if (this.preferences.journalActive ?? false) {
      this.beginTraceTotalRefresh();
    }

    // Badge Colors (using BADGE constants as defaults)
    if (this.preferences.badgePalette) {
      const paletteBadgeLow = document.querySelector('#colorBadgeLow');
      if (paletteBadgeLow) paletteBadgeLow.value = this.preferences.badgePalette.low || BadgeTokens.COLORS.LOW;

      const paletteBadgeMedium = document.querySelector('#colorBadgeMedium');
      if (paletteBadgeMedium) paletteBadgeMedium.value = this.preferences.badgePalette.medium || BadgeTokens.COLORS.MEDIUM;

      const paletteBadgeHigh = document.querySelector('#colorBadgeHigh');
      if (paletteBadgeHigh) paletteBadgeHigh.value = this.preferences.badgePalette.high || BadgeTokens.COLORS.HIGH;
    }

    // Category Colors
    if (this.preferences.taxonomyPalette) {
      const paletteAntibot = document.querySelector('#colorAntibot');
      if (paletteAntibot) paletteAntibot.value = this.preferences.taxonomyPalette.antibot || '#FF6B4A';

      const paletteCaptcha = document.querySelector('#colorCaptcha');
      if (paletteCaptcha) paletteCaptcha.value = this.preferences.taxonomyPalette.captcha || '#6CB6FF';

      const paletteFingerprint = document.querySelector('#colorFingerprint');
      if (paletteFingerprint) paletteFingerprint.value = this.preferences.taxonomyPalette.fingerprint || '#9B8AF7';
    }

    // Tag Colors
    if (this.preferences.methodPalette) {
      const paletteTagDom = document.querySelector('#colorTagDOM');
      if (paletteTagDom) paletteTagDom.value = this.preferences.methodPalette.dom || '#7ED67F';

      const paletteTagHeaders = document.querySelector('#colorTagHeaders');
      if (paletteTagHeaders) paletteTagHeaders.value = this.preferences.methodPalette.headers || '#E4A0D6';

      const paletteTagCookies = document.querySelector('#colorTagCookies');
      if (paletteTagCookies) paletteTagCookies.value = this.preferences.methodPalette.cookies || '#E6A647';

      const paletteTagContent = document.querySelector('#colorTagContent');
      if (paletteTagContent) paletteTagContent.value = this.preferences.methodPalette.content || '#4FD1B5';

      const paletteTagUrLs = document.querySelector('#colorTagURLs');
      if (paletteTagUrLs) paletteTagUrLs.value = this.preferences.methodPalette.urls || '#6CB6FF';

      const paletteTagJsProbes = document.querySelector('#colorTagJSHooks');
      if (paletteTagJsProbes) paletteTagJsProbes.value = this.preferences.methodPalette.js_hooks || '#B6A9FF';

      const paletteTagGlobal = document.querySelector('#colorTagWindow');
      if (paletteTagGlobal) paletteTagGlobal.value = this.preferences.methodPalette.window || '#F2857E';

      const paletteTagPayload = document.querySelector('#colorTagPayload');
      if (paletteTagPayload) paletteTagPayload.value = this.preferences.methodPalette.payload || '#C4D160';
    }

    if (typeof PreferenceForm.syncPaletteRowBadges === 'function') {
      PreferenceForm.syncPaletteRowBadges();
    }

    // ========== DETECTION TAB ==========
    if (this.preferences.scanning) {
      const memoBoundarySelect = document.querySelector('#memoScope');
      if (memoBoundarySelect) {
        memoBoundarySelect.value = this.preferences.scanning.memoScope || 'domain';
        Telemetry.performUi('Cache scope loaded:', this.preferences.scanning.memoScope);
      }

      const memoDurationField = document.querySelector('#memoDuration');
      if (memoDurationField) {
        memoDurationField.value = this.preferences.scanning.memoDuration || 12;
      }

      const memoUnitSelect = document.querySelector('#memoUnit');
      if (memoUnitSelect) {
        memoUnitSelect.value = this.preferences.scanning.memoUnit || 'hours';
      }

        this.paintBlacklistUi();
      this.wireBlacklistSignalSubscriptions();
    }

    // JS API Settings
    const localEnableJsApi = document.querySelector('#pageSignalsActive');
    const pageSignalsPreferencesRegion = document.querySelector('#pageSignalsSettings');
    const pageSignalsActive = this.preferences.pageSignals?.pageSignalsActive ?? false;
    if (localEnableJsApi) {
      localEnableJsApi.checked = pageSignalsActive;
    }
    PreferenceForm.assignToggleControlledVisibility(localEnableJsApi, [
      { element: pageSignalsPreferencesRegion, onDisplay: 'flex' }
    ]);

    // Webhook Settings
    const webhookPreferences = this.preferences.relay || {};
    const localEnableWebhook = document.querySelector('#relayActive');
    const isWebhookActive = webhookPreferences.relayActive ?? false;
    if (localEnableWebhook) localEnableWebhook.checked = isWebhookActive;

    const webhookPreferencesRegion = document.querySelector('#webhookSettings');
    const webhookOnMemoGroup = document.querySelector('#relayOnMemoHitGroup');
    PreferenceForm.assignToggleControlledVisibility(localEnableWebhook, [
      { element: webhookPreferencesRegion, onDisplay: 'block' },
      { element: webhookOnMemoGroup, onDisplay: 'flex' }
    ]);

    const webhookOnMemo = document.querySelector('#relayOnMemoHit');
    if (webhookOnMemo) webhookOnMemo.checked = webhookPreferences.relayOnMemoHit ?? false;

    const webhookPhaseField = document.querySelector('#relayMethod');
    const customRegion = document.querySelector('#webhookCustomMethodContainer');
    const customPhaseField = document.querySelector('#webhookCustomMethod');
    const datum = webhookPreferences.relayMethod || 'POST';
    const standardPhases = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const localIsCustom = !standardPhases.includes(datum.toUpperCase());

    if (webhookPhaseField) {
      webhookPhaseField.value = datum;
    }

    document.querySelectorAll('input[name="relayMethodRadio"]').forEach(localRadio => {
      localRadio.checked = false;
      const localBadge = localRadio.closest('.http-method-badge');
      if (localBadge) localBadge.classList.remove('checked');
    });

    if (localIsCustom && customRegion && customPhaseField) {
      const localCustomRadio = document.querySelector('input[name="relayMethodRadio"][value="CUSTOM"]');
      if (localCustomRadio) {
        localCustomRadio.checked = true;
        const localBadge = localCustomRadio.closest('.http-method-badge');
        if (localBadge) localBadge.classList.add('checked');
      }
      customRegion.style.display = 'block';
      customPhaseField.value = datum;
    } else {
      const localRadio = document.querySelector(`input[name="relayMethodRadio"][value="${datum.toUpperCase()}"]`);
      if (localRadio) {
        localRadio.checked = true;
        const localBadge2 = localRadio.closest('.http-method-badge');
        if (localBadge2) localBadge2.classList.add('checked');
      }
      if (customRegion) customRegion.style.display = 'none';
    }

    this.wireWebhookPhaseRadios();

    const webhookAddress = document.querySelector('#relayEndpoint');
    if (webhookAddress) webhookAddress.value = webhookPreferences.relayEndpoint || '';

    const webhookContentKind = document.querySelector('#relayContentType');
    if (webhookContentKind) webhookContentKind.value = webhookPreferences.relayContentType || 'application/json';

    const localWebhookPayload = document.querySelector('#relayTemplate');
    const baselinePayload = '{"url": "<SITEURL>", "hostname": "<HOSTNAME>", "title": "<TITLE>", "favicon": "<FAVICON>", "detections": <DETECTIONS>, "timestamp": "<TIMESTAMP>", "count": <DETECTION_COUNT>, "categories": "<CATEGORIES>"}';
    if (localWebhookPayload) localWebhookPayload.value = webhookPreferences.relayTemplate || baselinePayload;

    this.paintWebhookHeadersUi();

    // ========== HISTORY TAB ==========
    if (this.preferences.archive) {
      const archiveLimitField = document.querySelector('#archiveCeiling');
      if (archiveLimitField) archiveLimitField.value = this.preferences.archive.archiveCeiling ?? 0;

      const autoPurgeDays = document.querySelector('#archivePruneDays');
      if (autoPurgeDays) autoPurgeDays.value = this.preferences.archive.archivePruneDays ?? 30;

      const exportEncode = document.querySelector('#exportEncoding');
      if (exportEncode) exportEncode.value = this.preferences.archive.exportEncoding || 'json';

      const localIncludeTimestamps = document.querySelector('#includeMoments');
      if (localIncludeTimestamps) localIncludeTimestamps.checked = this.preferences.archive.includeMoments ?? true;

      const archiveBypassMemo = document.querySelector('#archiveOnMemoHit');
      if (archiveBypassMemo) archiveBypassMemo.checked = this.preferences.archive.archiveOnMemoHit ?? false;
    }

    // Duplicate Prevention Settings
    if (this.preferences.repeatGuard) {
      const localPreventDuplicates = document.querySelector('#repeatGuardActive');
      if (localPreventDuplicates) localPreventDuplicates.checked = this.preferences.repeatGuard.repeatGuardActive ?? false;

      const duplicateBoundary = document.querySelector('#repeatScope');
      if (duplicateBoundary) duplicateBoundary.value = this.preferences.repeatGuard.repeatScope || 'full_url';

      const localDuplicateDuration = document.querySelector('#repeatDuration');
      if (localDuplicateDuration) localDuplicateDuration.value = this.preferences.repeatGuard.repeatDuration ?? 1;

      const localDuplicateUnit = document.querySelector('#repeatUnit');
      if (localDuplicateUnit) localDuplicateUnit.value = this.preferences.repeatGuard.repeatUnit || 'hours';

        const duplicatePreferencesRegion = document.querySelector('#duplicateSettingsContainer');
      if (duplicatePreferencesRegion) {
        duplicatePreferencesRegion.style.display = (this.preferences.repeatGuard.repeatGuardActive ?? false) ? 'flex' : 'none';
      }
    }

    // ========== UPDATE SETTINGS ==========
    const autoRefreshToggle = document.querySelector('#autoSync');
    if (autoRefreshToggle) {
      autoRefreshToggle.checked = this.preferences.catalogSync?.autoSync ?? false;
    }

    const checkCadenceSelect = document.querySelector('#syncIntervalHours');
    if (checkCadenceSelect) {
      checkCadenceSelect.value = this.preferences.catalogSync?.syncIntervalHours ?? 12;
    }

    const refreshCadenceGroup = document.querySelector('#updateIntervalGroup');
    if (refreshCadenceGroup) {
      refreshCadenceGroup.style.display = (this.preferences.catalogSync?.autoSync ?? false) ? 'flex' : 'none';
    }

    const localLastCheckSpan = document.querySelector('#lastUpdateCheckTime');
    if (localLastCheckSpan) {
      const localLastCheck = this.preferences.catalogSync?.lastSyncMoment || 0;
      if (localLastCheck > 0 && typeof CatalogUpdater !== 'undefined') {
        localLastCheckSpan.textContent = CatalogUpdater.encodeLastCheck(localLastCheck);
      } else {
        localLastCheckSpan.textContent = ((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('settingsCheckIntervalNever')) || 'Never';
      }
    }

    if (typeof PreferenceForm.refreshIncompatibleUpdatesPresent === 'function') {
      void PreferenceForm.refreshIncompatibleUpdatesPresent.call(this);
    }

    if (typeof ConsoleChoiceRails !== 'undefined') {
      document.querySelectorAll('#settingsModal select').forEach((select) => ConsoleChoiceRails.refresh(select));
    }

};

PreferenceForm.resolvePreferencesFromUi = function() {
    const preferencePane = {};
    const localReadNumber = (localSelector, localFallback) => {
      const unprocessed = document.querySelector(localSelector)?.value;
      if (unprocessed === undefined || unprocessed === null || unprocessed === '') {
        return localFallback;
      }
      const datum = Number(unprocessed);
      return Number.isFinite(datum) ? datum : localFallback;
    };

    // ========== GENERAL TAB ==========
    const toastsToggle = document.querySelector('#alertsActive');
    const debugStrategyToggle = document.querySelector('#diagnosticModeGeneral');
    const traceCollectorToggle = document.querySelector('#journalActive');
    const traceCollectorLimitTracesField = document.querySelector('#journalCeiling');
    preferencePane.alertsActive = toastsToggle?.checked ?? this.preferences.alertsActive ?? true;
    preferencePane.diagnosticMode = debugStrategyToggle?.checked ?? this.preferences.diagnosticMode ?? false;
    preferencePane.journalActive = traceCollectorToggle?.checked ?? this.preferences.journalActive ?? false;
    const unprocessedLimitTraces = parseInt(traceCollectorLimitTracesField?.value ?? this.preferences.journalCeiling ?? 5000);
    preferencePane.journalCeiling = Math.min(Math.max(unprocessedLimitTraces, 100), 5000);

    // Badge Colors (using BADGE constants as defaults)
    preferencePane.badgePalette = {
      low: document.querySelector('#colorBadgeLow')?.value ?? this.preferences.badgePalette?.low ?? BadgeTokens.COLORS.LOW,
      medium: document.querySelector('#colorBadgeMedium')?.value ?? this.preferences.badgePalette?.medium ?? BadgeTokens.COLORS.MEDIUM,
      high: document.querySelector('#colorBadgeHigh')?.value ?? this.preferences.badgePalette?.high ?? BadgeTokens.COLORS.HIGH
    };

    // Category Colors
    preferencePane.taxonomyPalette = {
      antibot: document.querySelector('#colorAntibot')?.value ?? this.preferences.taxonomyPalette?.antibot ?? '#FF6B4A',
      captcha: document.querySelector('#colorCaptcha')?.value ?? this.preferences.taxonomyPalette?.captcha ?? '#6CB6FF',
      fingerprint: document.querySelector('#colorFingerprint')?.value ?? this.preferences.taxonomyPalette?.fingerprint ?? '#9B8AF7'
    };

    // Tag Colors
    preferencePane.methodPalette = {
      dom: document.querySelector('#colorTagDOM')?.value ?? this.preferences.methodPalette?.dom ?? '#7ED67F',
      headers: document.querySelector('#colorTagHeaders')?.value ?? this.preferences.methodPalette?.headers ?? '#E4A0D6',
      cookies: document.querySelector('#colorTagCookies')?.value ?? this.preferences.methodPalette?.cookies ?? '#E6A647',
      content: document.querySelector('#colorTagContent')?.value ?? this.preferences.methodPalette?.content ?? '#4FD1B5',
      urls: document.querySelector('#colorTagURLs')?.value ?? this.preferences.methodPalette?.urls ?? '#6CB6FF',
      js_hooks: document.querySelector('#colorTagJSHooks')?.value ?? this.preferences.methodPalette?.js_hooks ?? '#B6A9FF',
      window: document.querySelector('#colorTagWindow')?.value ?? this.preferences.methodPalette?.window ?? '#F2857E',
      payload: document.querySelector('#colorTagPayload')?.value ?? this.preferences.methodPalette?.payload ?? '#C4D160'
    };

    // ========== DETECTION TAB ==========
    preferencePane.scanning = {
      memoDuration: parseInt(document.querySelector('#memoDuration')?.value ?? this.preferences.scanning?.memoDuration ?? 12),
      memoUnit: document.querySelector('#memoUnit')?.value ?? this.preferences.scanning?.memoUnit ?? 'hours',
      memoScope: document.querySelector('#memoScope')?.value ?? this.preferences.scanning?.memoScope ?? 'domain',
      skippedDomains: this.preferences.scanning?.skippedDomains || [], // This is managed separately by the blacklist UI
      probeConfig: this.preferences.scanning?.probeConfig || {}
    };

    // JS API Settings
    const pageSignalsActive = document.querySelector('#pageSignalsActive')?.checked ?? this.preferences.pageSignals?.pageSignalsActive ?? false;
    preferencePane.pageSignals = {
      pageSignalsActive: pageSignalsActive
    };

    // Webhook Settings
    preferencePane.relay = {
      relayActive: document.querySelector('#relayActive')?.checked ?? this.preferences.relay?.relayActive ?? false,
      relayOnMemoHit: document.querySelector('#relayOnMemoHit')?.checked ?? this.preferences.relay?.relayOnMemoHit ?? false,
      relayMethod: document.querySelector('#relayMethod')?.value ?? this.preferences.relay?.relayMethod ?? 'POST',
      relayEndpoint: document.querySelector('#relayEndpoint')?.value ?? this.preferences.relay?.relayEndpoint ?? '',
      relayContentType: document.querySelector('#relayContentType')?.value ?? this.preferences.relay?.relayContentType ?? 'application/json',
      relayTemplate: document.querySelector('#relayTemplate')?.value ?? this.preferences.relay?.relayTemplate ?? '',
      relayHeaders: this.preferences.relay?.relayHeaders || []
    };

    // ========== HISTORY TAB ==========
    preferencePane.archive = {
      archiveCeiling: parseInt(document.querySelector('#archiveCeiling')?.value ?? this.preferences.archive?.archiveCeiling ?? 0),
      archivePruneDays: parseInt(document.querySelector('#archivePruneDays')?.value ?? this.preferences.archive?.archivePruneDays ?? 30),
      exportEncoding: document.querySelector('#exportEncoding')?.value ?? this.preferences.archive?.exportEncoding ?? 'json',
      includeMoments: document.querySelector('#includeMoments')?.checked ?? this.preferences.archive?.includeMoments ?? true,
      archiveOnMemoHit: document.querySelector('#archiveOnMemoHit')?.checked ?? this.preferences.archive?.archiveOnMemoHit ?? false
    };

    // Duplicate Prevention Settings
    preferencePane.repeatGuard = {
      repeatGuardActive: document.querySelector('#repeatGuardActive')?.checked ?? this.preferences.repeatGuard?.repeatGuardActive ?? false,
      repeatScope: document.querySelector('#repeatScope')?.value ?? this.preferences.repeatGuard?.repeatScope ?? 'full_url',
      repeatDuration: parseInt(document.querySelector('#repeatDuration')?.value ?? this.preferences.repeatGuard?.repeatDuration ?? 1),
      repeatUnit: document.querySelector('#repeatUnit')?.value ?? this.preferences.repeatGuard?.repeatUnit ?? 'hours'
    };

    // Update Settings
    preferencePane.catalogSync = {
      autoSync: document.querySelector('#autoSync')?.checked ?? this.preferences.catalogSync?.autoSync ?? false,
      syncIntervalHours: parseInt(document.querySelector('#syncIntervalHours')?.value ?? this.preferences.catalogSync?.syncIntervalHours ?? 12),
      lastSyncMoment: this.preferences.catalogSync?.lastSyncMoment ?? 0 // Preserve timestamp, don't reset on save
    };

    return preferencePane;
};

PreferenceForm.validatePreferences = function(preferencePane) {
    const failures = [];

    if (preferencePane.archive && preferencePane.archive.archiveCeiling !== undefined) {
      if (preferencePane.archive.archiveCeiling < 0 || preferencePane.archive.archiveCeiling > 10000) {
        failures.push('History limit must be between 0 (unlimited) and 10000');
      }
    }

    if (preferencePane.scanning && preferencePane.scanning.memoDuration !== undefined) {
      if (preferencePane.scanning.memoDuration < 1 || preferencePane.scanning.memoDuration > 9999) {
        failures.push('Cache duration must be between 1 and 9999');
      }
    }

    if (preferencePane.archive && preferencePane.archive.archivePruneDays !== undefined) {
      if (preferencePane.archive.archivePruneDays < 0 || preferencePane.archive.archivePruneDays > 365) {
        failures.push('Auto clear days must be between 0 and 365');
      }
    }

    if (preferencePane.repeatGuard && preferencePane.repeatGuard.repeatDuration !== undefined) {
      if (preferencePane.repeatGuard.repeatDuration < 1 || preferencePane.repeatGuard.repeatDuration > 999) {
        failures.push('Duplicate duration must be between 1 and 999');
      }
    }

    return {
      isValid: failures.length === 0,
      errors: failures
    };
};

PreferenceForm.bindShellEvents = function() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    const preferencesBtn = document.querySelector('#settingsBtn');
    if (preferencesBtn) {
      preferencesBtn.addEventListener('click', () => this.presentPreferences());
    }

    const closePreferencesBtn = document.querySelector('#closeSettingsModal');
    if (closePreferencesBtn) {
      closePreferencesBtn.addEventListener('click', () => this.dismissPreferences());
    }

    const persistPreferencesBtn = document.querySelector('#saveSettingsBtn');
    if (persistPreferencesBtn) {
      Telemetry.performUi('Save settings button found, attaching event listener');
      persistPreferencesBtn.addEventListener('click', async (failure) => {
        failure.preventDefault();
        Telemetry.performUi('Save settings button clicked');
        await this.routePersistPreferences();
      });
    } else {
      Telemetry.failure('UI', 'Save settings button NOT found - event listener not attached');
    }

    const cancelPreferencesBtn = document.querySelector('#cancelSettingsBtn');
    if (cancelPreferencesBtn) {
      cancelPreferencesBtn.addEventListener('click', () => this.dismissPreferences());
    }

    if (typeof PreferenceForm.performInitLanguagePicker === 'function') {
      PreferenceForm.performInitLanguagePicker();
    }

    const pageControls = document.querySelectorAll('.settings-tab-btn');
    pageControls.forEach(control => {
      control.addEventListener('click', () => {
        const pageLabel = control.getAttribute('data-settings-tab');
        this.showPane(pageLabel);
      });
    });

    const preferencesDialog = document.querySelector('#settingsModal');
    if (preferencesDialog) {
      preferencesDialog.addEventListener('click', (failure) => {
        if (failure.target === preferencesDialog || failure.target.classList.contains('base-modal-backdrop')) {
          this.dismissPreferences();
        }
      });
    }

    document.addEventListener('keydown', (failure) => {
      if (failure.key === 'Escape' && this.isModalVisible) {
        this.dismissPreferences();
      }
    });

    const addActiveDomainBtn = document.querySelector('#addCurrentDomainBtn');
    if (addActiveDomainBtn) {
      addActiveDomainBtn.addEventListener('click', async () => {
        const localT2 = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
        const localTr2 = (lookupKey, localFallback) => (localT2 && localT2.resolve(lookupKey)) || localFallback;
        const localFmt2 = (lookupKey, localFallback, ...operands) => (localT2 && localT2.encode(lookupKey, ...operands)) || localFallback;
        try {
          const [page] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!page || !page.url) {
            Toasts.failure(localTr2('couldNotGetPageUrl', 'Could not get current page URL'));
            return;
          }

          const address = new URL(page.url);
          const localDomain = address.hostname;

          if (!this.preferences.scanning) {
            this.preferences.scanning = { skippedDomains: [] };
          }
          if (!this.preferences.scanning.skippedDomains) {
            this.preferences.scanning.skippedDomains = [];
          }

          if (this.preferences.scanning.skippedDomains.includes(localDomain)) {
            Toasts.detail(localFmt2('domainAlreadyBlacklistedFmt', `${localDomain} is already blacklisted`, localDomain));
            return;
          }

          this.preferences.scanning.skippedDomains.push(localDomain);
          this.paintBlacklistUi();
          const persisted = await this.persistPreferences({ notify: false });
          if (!persisted) {
            return;
          }

          Toasts.completion(localFmt2('addedDomainToBlacklistFmt', `Added ${localDomain} to blacklist`, localDomain));
        } catch (failure) {
          Telemetry.failure('UI', 'Failed to add domain to blacklist', failure);
          Toasts.failure(localFmt2('failedAddDomainFmt', 'Failed to add domain: ' + failure.message, failure.message));
        }
      });
    }

    const localJsApiCodeBlock = document.querySelector('#pageSignalsUsageCode');
    if (localJsApiCodeBlock) {
      localJsApiCodeBlock.addEventListener('click', () => {
        TextCodec.performCopyToClipboard(localJsApiCodeBlock.textContent, { notificationMessage: 'Code copied' });
      });
    }

    document.querySelectorAll('.api-event-item code').forEach(localCodeEl => {
      localCodeEl.style.cursor = 'pointer';
      localCodeEl.title = 'Click to copy';
      localCodeEl.addEventListener('click', () => {
        TextCodec.performCopyToClipboard(localCodeEl.textContent, { notificationMessage: 'Copied' });
      });
    });

    const localEnableJsApiToggle = document.querySelector('#pageSignalsActive');
    const pageSignalsPreferencesRegion = document.querySelector('#pageSignalsSettings');
    if (localEnableJsApiToggle) {
      localEnableJsApiToggle.addEventListener('change', () => {
        PreferenceForm.assignToggleControlledVisibility(localEnableJsApiToggle, [
          { element: pageSignalsPreferencesRegion, onDisplay: 'flex' }
        ]);
      });
      PreferenceForm.assignToggleControlledVisibility(localEnableJsApiToggle, [
        { element: pageSignalsPreferencesRegion, onDisplay: 'flex' }
      ]);
    }

    const localPreventDuplicatesToggle = document.querySelector('#repeatGuardActive');
    const duplicatePreferencesRegion = document.querySelector('#duplicateSettingsContainer');
    if (localPreventDuplicatesToggle) {
      localPreventDuplicatesToggle.addEventListener('change', (failure) => {
        const isActive = failure.target.checked;
        if (duplicatePreferencesRegion) {
          duplicatePreferencesRegion.style.display = isActive ? 'flex' : 'none';
        }
      });
      const isActive = localPreventDuplicatesToggle.checked;
      if (duplicatePreferencesRegion) {
        duplicatePreferencesRegion.style.display = isActive ? 'flex' : 'none';
      }
    }

    // ========== UPDATE SETTINGS ==========
    const autoRefreshToggle = document.querySelector('#autoSync');
    const refreshCadenceGroup = document.querySelector('#updateIntervalGroup');
    if (autoRefreshToggle) {
      autoRefreshToggle.addEventListener('change', (failure) => {
        const isActive = failure.target.checked;
        if (!this.preferences.catalogSync) this.preferences.catalogSync = {};
        this.preferences.catalogSync.autoSync = isActive;
        if (refreshCadenceGroup) {
          refreshCadenceGroup.style.display = isActive ? 'flex' : 'none';
        }
        this.persistPreferences();
      });
    }

    const checkCadenceSelect = document.querySelector('#syncIntervalHours');
    if (checkCadenceSelect) {
      checkCadenceSelect.addEventListener('change', (failure) => {
        if (!this.preferences.catalogSync) this.preferences.catalogSync = {};
        this.preferences.catalogSync.syncIntervalHours = parseInt(failure.target.value, 10);
        this.persistPreferences();
      });
    }

    const localCheckUpdatesNowBtn = document.querySelector('#checkUpdatesNowBtn');
    if (localCheckUpdatesNowBtn) {
      localCheckUpdatesNowBtn.addEventListener('click', () => this.routeCheckUpdatesNow());
    }

    if (typeof PreferenceForm._wirePayloadSubscriptions === 'function') {
      PreferenceForm._wirePayloadSubscriptions.call(this);
    }
    if (typeof PreferenceForm._wireTraceSubscriptions === 'function') {
      PreferenceForm._wireTraceSubscriptions.call(this);
    }
    if (typeof PreferenceForm._wireWebhookSubscriptions === 'function') {
      PreferenceForm._wireWebhookSubscriptions.call(this);
    }

    this.wirePalettePaging();
    if (typeof PreferenceForm._wirePaletteSubscriptions === 'function') {
      PreferenceForm._wirePaletteSubscriptions();
    }
};

if (typeof self !== 'undefined') {
    self.PreferenceForm = PreferenceForm;
}
