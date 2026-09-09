class PreferencesPresenter {
  constructor() {
    // Defaults loaded from defaults.json during startup.
    this.preferences = {};
    this.isModalVisible = false;
  }

  /**
   * Show settings modal
   */
  presentPreferences(...operands) {
    return PreferenceForm.presentPreferences.apply(this, operands);
  }
  dismissPreferences(...operands) {
    return PreferenceForm.dismissPreferences.apply(this, operands);
  }
  showPane(...operands) {
    return PreferenceForm.showPane.apply(this, operands);
  }
  async readPreferences(...operands) {
    return await PreferenceForm.readPreferences.apply(this, operands);
  }
  performDeepMerge(...operands) {
    return PreferenceForm.performDeepMerge.apply(this, operands);
  }
  async persistPreferences(...operands) {
    return await PreferenceForm.persistPreferences.apply(this, operands);
  }
  refreshPreferencesUi(...operands) {
    return PreferenceForm.refreshPreferencesUi.apply(this, operands);
  }
  resolvePreferencesFromUi(...operands) {
    return PreferenceForm.resolvePreferencesFromUi.apply(this, operands);
  }
  validatePreferences(...operands) {
    return PreferenceForm.validatePreferences.apply(this, operands);
  }
  async restoreToBaselines(...operands) {
    return await PreferenceForm.restoreToBaselines.apply(this, operands);
  }
  async purgeAllPayload(...operands) {
    return await PreferenceForm.purgeAllPayload.apply(this, operands);
  }
  bindShellEvents(...operands) {
    return PreferenceForm.bindShellEvents.apply(this, operands);
  }
  beginTraceTotalRefresh(...operands) {
    return PreferenceForm.beginTraceTotalRefresh.apply(this, operands);
  }
  haltTraceTotalRefresh(...operands) {
    return PreferenceForm.haltTraceTotalRefresh.apply(this, operands);
  }
  refreshTraceTotal(...operands) {
    return PreferenceForm.refreshTraceTotal.apply(this, operands);
  }
  wirePalettePaging(...operands) {
    return PreferenceForm.wirePalettePaging.apply(this, operands);
  }
  paintBlacklistUi(...operands) {
    return PreferenceForm.paintBlacklistUi.apply(this, operands);
  }
  wireBlacklistSignalSubscriptions(...operands) {
    return PreferenceForm.wireBlacklistSignalSubscriptions.apply(this, operands);
  }
  paintWebhookHeadersUi(...operands) {
    return PreferenceForm.paintWebhookHeadersUi.apply(this, operands);
  }
  assignToggleControlledVisibility(...operands) {
    return PreferenceForm.assignToggleControlledVisibility.apply(this, operands);
  }
  escapeMarkup(...operands) {
    return TextCodec.escapeMarkup(...operands);
  }
  async routePersistPreferences(...operands) {
    return await PreferenceForm.routePersistPreferences.apply(this, operands);
  }

  /**
   * Load preferences from defaults.json (single source of truth).
   */
  async readBaselines() {
    try {
      const address = chrome.runtime.getURL('src/console/preferences/defaults.json');
      const reply = await fetch(address);
      const payload = await reply.json();
      this.preferences = payload.settings || payload;
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to load preferences defaults', failure);
      this.preferences = {};
    }
  }

  /**
   * Initialize settings section
   */
  async start() {
    Telemetry.performUi('Settings section initializing...');
    await this.readBaselines();
    await this.hydrateMarkup();
    this.bindShellEvents();
    await this.readPreferences();
    Telemetry.performUi('Settings section initialized');
  }

  /**
   * Load HTML template into settings modal
   */
  async hydrateMarkup() {
    try {
      Telemetry.performUi('Loading settings HTML from:', chrome.runtime.getURL('src/console/preferences/pane.html'));
      const reply = await fetch(chrome.runtime.getURL('src/console/preferences/pane.html'));
      const markup = await reply.text();
      Telemetry.performUi('Settings HTML fetched, length:', markup.length);

      const preferencesDialog = document.querySelector('#settingsModal');
      if (preferencesDialog) {
        preferencesDialog.innerHTML = markup;
        Telemetry.performUi('Settings HTML inserted into modal');

        if (typeof LocaleRuntime !== 'undefined') {
          LocaleRuntime.performApply(preferencesDialog);
        }
        if (typeof PreferenceForm.applyTaxonomyPaletteLabels === 'function') {
          PreferenceForm.applyTaxonomyPaletteLabels(preferencesDialog);
        }
        if (typeof PreferenceForm.syncPaletteRowBadges === 'function') {
          PreferenceForm.syncPaletteRowBadges();
        }

        // Verify critical elements exist
        const persistBtn = document.querySelector('#saveSettingsBtn');
        const localCancelBtn = document.querySelector('#cancelSettingsBtn');
        Telemetry.performUi('Save button found:', !!persistBtn, 'Cancel button found:', !!localCancelBtn);
      } else {
        Telemetry.failure('UI', 'Settings modal container #settingsModal not found in DOM');
      }
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to load settings HTML:', failure);
    }
  }

  // ============================================================================
  // Static Methods (Background & Popup Context)
  // ============================================================================

  /**
   * Load toggle state from storage and apply to toggle element
   * @param {HTMLElement} toggle - Toggle element
   */
  static async restoreEnabledToggle(...operands) {
    return await PreferenceRuntime.restoreEnabledToggle.apply(this, operands);
  }
  static async restoreInitialPane(...operands) {
    return await PreferenceRuntime.restoreInitialPane.apply(this, operands);
  }
  static async applyEnabledChange(...operands) {
    return await PreferenceRuntime.applyEnabledChange.apply(this, operands);
  }
  static async routePreferencesUpdated(...operands) {
    return await PreferenceRuntime.routePreferencesUpdated.apply(this, operands);
  }
  static async sendWebhookIfActive(...operands) {
    return await PreferenceRuntime.sendWebhookIfActive.apply(this, operands);
  }
  static async emitPublicApiEvent(...operands) {
    return await PreferenceRuntime.emitPublicApiEvent.apply(this, operands);
  }
  static async emitPublicReady(...operands) {
    return await PreferenceRuntime.emitPublicReady.apply(this, operands);
  }
  wireWebhookPhaseRadios(...operands) {
    return PreferenceForm.wireWebhookPhaseRadios.apply(this, operands);
  }
  async routeTestWebhook(...operands) {
    return await PreferenceForm.routeTestWebhook.apply(this, operands);
  }
  async refreshIncompatibleUpdatesPresent(...operands) {
    return await PreferenceForm.refreshIncompatibleUpdatesPresent.apply(this, operands);
  }
  async routeCheckUpdatesNow(...operands) {
    return await PreferenceForm.routeCheckUpdatesNow.apply(this, operands);
  }

}

if (typeof window !== 'undefined') {
  window.PreferencesPresenter = PreferencesPresenter;
}
