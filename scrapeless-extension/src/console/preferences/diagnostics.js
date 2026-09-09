// Log collector UI methods for SettingsUI — extracted from settings-ui.js.
// Requires settings-ui.js to load first (defines const SettingsUI).

PreferenceForm.beginTraceTotalRefresh = function() {
    if (this.logCountUpdateInterval) {
      clearInterval(this.logCountUpdateInterval);
    }

    // Update immediately
    this.refreshTraceTotal();

    // Then update every 2 seconds
    this.logCountUpdateInterval = setInterval(() => {
      this.refreshTraceTotal();
    }, 2000);
};

PreferenceForm.haltTraceTotalRefresh = function() {
    if (this.logCountUpdateInterval) {
      clearInterval(this.logCountUpdateInterval);
      this.logCountUpdateInterval = null;
    }
};

PreferenceForm.refreshTraceTotal = function() {
    chrome.runtime.sendMessage({ type: 'JOURNAL_READ_COUNT' }).then((reply) => {
      if (reply && typeof reply.count === 'number') {
        const traceTotalDatum = document.querySelector('#logCountValue');
        if (traceTotalDatum) {
          traceTotalDatum.textContent = reply.count;
        }
      }
    }).catch(() => {
      // Silently ignore errors
    });
};

PreferenceForm._wireTraceSubscriptions = function() {
    const debugStrategyToggle = document.querySelector('#diagnosticModeGeneral');
    if (debugStrategyToggle) {
      debugStrategyToggle.addEventListener('change', (failure) => {
        const traceCollectorSection = document.querySelector('#logCollectorSection');
        if (traceCollectorSection) {
          traceCollectorSection.style.display = failure.target.checked ? 'block' : 'none';
        }
      });
    }

    const traceCollectorToggle = document.querySelector('#journalActive');
    if (traceCollectorToggle) {
      traceCollectorToggle.addEventListener('change', (failure) => {
        const traceCollectorControls = document.querySelector('#logCollectorControls');
        if (traceCollectorControls) {
          traceCollectorControls.style.display = failure.target.checked ? 'block' : 'none';
        }

        if (failure.target.checked) {
          chrome.runtime.sendMessage({ type: 'JOURNAL_ENABLE' }).catch(() => {
            Telemetry.performUi('Failed to enable log collection');
          });
          this.beginTraceTotalRefresh();
        } else {
          chrome.runtime.sendMessage({ type: 'JOURNAL_DISABLE' }).catch(() => {
            Telemetry.performUi('Failed to disable log collection');
          });
          this.haltTraceTotalRefresh();
        }
      });
    }

    const _tTrace = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const _trTrace = (lookupKey, localFallback) => (_tTrace && _tTrace.resolve(lookupKey)) || localFallback;

    const exportTracesJsonBtn = document.querySelector('#exportLogsJsonBtn');
    if (exportTracesJsonBtn) {
      exportTracesJsonBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'JOURNAL_EXPORT_JSON' }).catch(() => {
          Toasts.failure(_trTrace('failedExportLogs', 'Failed to export logs'));
        });
      });
    }

    const exportTracesCopyBtn = document.querySelector('#exportLogsTextBtn');
    if (exportTracesCopyBtn) {
      exportTracesCopyBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'JOURNAL_EXPORT_TEXT' }).catch(() => {
          Toasts.failure(_trTrace('failedExportLogs', 'Failed to export logs'));
        });
      });
    }

    const purgeTracesBtn = document.querySelector('#clearLogsBtn');
    if (purgeTracesBtn) {
      purgeTracesBtn.addEventListener('click', async () => {
        const localConfirmed = await Toasts.performConfirm({
          title: _trTrace('clearLogsTitle', 'Clear Logs'),
          message: _trTrace('clearLogsMessage', 'Are you sure you want to clear all collected logs? This action cannot be undone.'),
          type: 'warning',
          confirmText: _trTrace('btnClear', 'Clear'),
          cancelText: _trTrace('btnCancel', 'Cancel')
        });

        if (localConfirmed) {
          chrome.runtime.sendMessage({ type: 'JOURNAL_PURGE' }).then(() => {
            const traceTotalDatum = document.querySelector('#logCountValue');
            if (traceTotalDatum) {
              traceTotalDatum.textContent = '0';
            }
            Toasts.completion(_trTrace('logsCleared', 'Logs cleared'));
          }).catch(() => {
            Toasts.failure(_trTrace('failedClearLogs', 'Failed to clear logs'));
          });
        }
      });
    }

    const traceCollectorLimitTracesField = document.querySelector('#journalCeiling');
    if (traceCollectorLimitTracesField) {
      traceCollectorLimitTracesField.addEventListener('change', (failure) => {
        let limitTraces = parseInt(failure.target.value || 5000);
        if (limitTraces < 100) limitTraces = 100;
        if (limitTraces > 5000) limitTraces = 5000;
        failure.target.value = limitTraces;
        const traceTotalLimit = document.querySelector('#logCountMax');
        if (traceTotalLimit) {
          traceTotalLimit.textContent = limitTraces;
        }
        chrome.runtime.sendMessage({ type: 'JOURNAL_SET_CEILING', maxLogs: limitTraces }).catch(() => {
          Telemetry.performUi('Failed to set max logs');
        });
      });
    }
};

if (typeof self !== 'undefined') {
    self.PreferenceForm = PreferenceForm;
}
