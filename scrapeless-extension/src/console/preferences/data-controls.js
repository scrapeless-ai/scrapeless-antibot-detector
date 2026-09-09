// Data management UI methods for SettingsUI — extracted from settings-ui.js.
// Requires settings-ui.js to load first (defines const SettingsUI).

PreferenceForm.restoreToBaselines = async function() {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const localConfirmed = await Toasts.performConfirm({
      title: localTr('settingsResetTitle', 'Reset Settings'),
      message: localTr('settingsResetMessage', 'Are you sure you want to reset all settings to their default values? This action cannot be undone.'),
      type: 'warning',
      confirmText: localTr('btnReset', 'Reset'),
      cancelText: localTr('btnCancel', 'Cancel')
    });

    if (localConfirmed) {
      await this.readBaselines();
      this.refreshPreferencesUi();
      await this.persistPreferences();
      Toasts.completion(localTr('settingsResetToast', 'Settings reset'));
    }
};

PreferenceForm.purgeAllPayload = async function() {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localTr = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;
    const localFmt = (lookupKey, localFallback, ...operands) => (localT && localT.encode(lookupKey, ...operands)) || localFallback;
    const localConfirmed = await Toasts.performConfirm({
      title: localTr('clearAllDataTitle', 'Clear All Data'),
      message: localTr('clearAllDataMessage', 'Are you sure you want to clear ALL extension data? This will remove:<br><br>• All detection history<br>• All detector rules<br>• All settings<br><br>This action cannot be undone!'),
      type: 'danger',
      confirmText: localTr('clearEverythingBtn', 'Clear Everything'),
      cancelText: localTr('btnCancel', 'Cancel')
    });

    if (localConfirmed) {
      try {
        await chrome.storage.local.clear();
        Toasts.completion(localTr('dataClearedReloadNotice', 'All data cleared successfully! The extension will reload.'));

        setTimeout(() => {
          chrome.runtime.reload();
        }, 2000);

      } catch (failure) {
        Telemetry.failure('UI', 'Failed to clear data:', failure);
        Toasts.failure(localFmt('failedClearDataFmt', 'Failed to clear data: ' + failure.message, failure.message));
      }
    }
};

PreferenceForm._wirePayloadSubscriptions = function() {
    const restorePreferencesBtn = document.querySelector('#resetSettingsBtn');
    if (restorePreferencesBtn) {
      restorePreferencesBtn.addEventListener('click', () => this.restoreToBaselines());
    }

    const purgeAllPayloadBtn = document.querySelector('#clearAllDataBtn');
    if (purgeAllPayloadBtn) {
      purgeAllPayloadBtn.addEventListener('click', () => this.purgeAllPayload());
    }
};

if (typeof self !== 'undefined') {
    self.PreferenceForm = PreferenceForm;
}
