// Settings update/save UI methods for SettingsUI — extracted from settings-ui.js
// after the file split. Requires settings-ui.js to load first.

PreferenceForm.routePersistPreferences = async function() {
  Telemetry.performUi('handleSaveSettings() called');
  const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
  const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
  const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;

  try {
    Telemetry.performUi('Getting settings from UI...');
    const newPreferences = this.resolvePreferencesFromUi();
    Telemetry.performUi('Settings from UI:', newPreferences);

    Telemetry.performUi('Validating settings...');
    const localValidation = this.validatePreferences(newPreferences);
    Telemetry.performUi('Validation result:', localValidation);

    if (!localValidation.isValid) {
      Telemetry.performWarn('UI', 'Settings validation failed:', localValidation.errors);
      Toasts.failure(
        localFmt('invalidSettingsFmt', 'Invalid settings: ' + localValidation.errors.join(', '), localValidation.errors.join(', '))
      );
      return;
    }

    Telemetry.performUi('Merging settings...');
    this.preferences = this.performDeepMerge(this.preferences, newPreferences);
    Telemetry.performUi('Settings merged:', this.preferences);

    Telemetry.performUi('Saving settings to storage...');
    await this.persistPreferences();
    Telemetry.performUi('Settings saved successfully');

    Telemetry.performUi('Closing modal...');
    this.dismissPreferences();
    Telemetry.performUi('Modal closed');

  } catch (failure) {
    Telemetry.failure('UI', 'Failed to handle save settings:', failure);
    Toasts.failure(
      localFmt('failedSaveSettingsFmt', 'Failed to save settings: ' + failure.message, failure.message)
    );
  }
};

PreferenceForm.refreshIncompatibleUpdatesPresent = async function() {
  const caution = document.querySelector('#incompatibleUpdatesWarning');
  if (!caution || typeof CatalogUpdater === 'undefined') return;

  try {
    const localUpdates = await CatalogUpdater.resolveIncompatibleUpdates();

    if (localUpdates.length === 0) {
      caution.style.display = 'none';
      return;
    }

    caution.style.display = 'flex';

    const totalSpan = document.querySelector('#incompatibleCount');
    if (totalSpan) {
      totalSpan.textContent = String(localUpdates.length);
    }

    const collection = document.querySelector('#incompatibleDetailsList');
    if (collection) {
      collection.replaceChildren();

      for (const refresh of localUpdates) {
        const entry = document.createElement('div');
        entry.className = 'incompatible-item';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'incompatible-item-name';
        labelSpan.textContent = refresh.name || refresh.id;

        const localVersionSpan = document.createElement('span');
        localVersionSpan.className = 'incompatible-item-version';
        localVersionSpan.textContent = `v${refresh.remoteVersion} (needs ext v${refresh.minExtensionVersion})`;

        entry.appendChild(labelSpan);
        entry.appendChild(localVersionSpan);
        collection.appendChild(entry);
      }
    }
  } catch (failure) {
    Telemetry.failure('UI', 'Failed to update incompatible updates display:', failure);
    caution.style.display = 'none';
  }
};

PreferenceForm.routeCheckUpdatesNow = async function() {
  const localBtn = document.querySelector('#checkUpdatesNowBtn');
  const localLastCheckSpan = document.querySelector('#lastUpdateCheckTime');
  if (!localBtn) return;

  const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
  const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
  const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;

  localBtn.disabled = true;
  const priorCopy = localBtn.innerHTML;
  localBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" class="spin">
      <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" fill="currentColor"/>
    </svg>
    Checking...
  `;

  try {
    if (typeof CatalogUpdater === 'undefined') {
      throw new Error(localTr('updateServiceNotAvailable', 'Update service not available'));
    }

    const outcome = await CatalogUpdater.performCheckForUpdates(true);

    if (localLastCheckSpan) {
      const preferencePane = await ExtensionGateway.resolvePreferences();
      const localLastCheck = preferencePane.catalogSync?.lastSyncMoment || 0;
      localLastCheckSpan.textContent = localLastCheck > 0
        ? CatalogUpdater.encodeLastCheck(localLastCheck)
        : localTr('timeJustNow', 'Just now');
    }

    const queuedTotal = await CatalogUpdater.resolveQueuedUpdatesTotal();

    if (outcome.error) {
      Toasts.failure(localTr('failedCheckForUpdates', 'Failed to check for updates'));
    } else if (queuedTotal > 0) {
      Toasts.completion(
        localFmt('foundDetectorUpdatesAvailableFmt', `Found ${queuedTotal} detector updates available!`, queuedTotal)
      );
    } else {
      Toasts.detail(localTr('allDetectorsUpToDate', 'All detectors are up to date.'));
    }

    const incompatibleTotal = await CatalogUpdater.resolveIncompatibleUpdatesTotal();
    if (incompatibleTotal > 0) {
      const localMsg = incompatibleTotal === 1
        ? '1 detector update requires a newer extension version.'
        : `${incompatibleTotal} detector updates require a newer extension version.`;
      Toasts.caution(localMsg, { duration: 8000 });
    }

    await this.refreshIncompatibleUpdatesPresent();

    Telemetry.performUi('Update check completed:', { pendingCount: queuedTotal, incompatibleCount: incompatibleTotal, result: outcome });

  } catch (failure) {
    Telemetry.failure('UI', 'Failed to check for updates:', failure);
    Toasts.failure(
      localFmt('failedCheckForUpdatesFmt', 'Failed to check for updates: ' + failure.message, failure.message)
    );
  } finally {
    localBtn.disabled = false;
    localBtn.innerHTML = priorCopy;
  }
};

if (typeof self !== 'undefined') {
  self.PreferenceForm = PreferenceForm;
}
