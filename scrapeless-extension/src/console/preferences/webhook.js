// Webhook UI methods for SettingsUI — extracted from settings-ui.js
// to keep the main file under the 800-line cap.
// Requires settings-ui.js to load first (defines const SettingsUI).

PreferenceForm.wireWebhookPhaseRadios = function() {
    const localRadios = document.querySelectorAll('input[name="relayMethodRadio"]');
    const webhookPhaseField = document.querySelector('#relayMethod');
    const customRegion = document.querySelector('#webhookCustomMethodContainer');
    const customField = document.querySelector('#webhookCustomMethod');

    localRadios.forEach(localRadio => {
      localRadio.addEventListener('change', (failure) => {
        localRadios.forEach(localR => {
          const localBadge = localR.closest('.http-method-badge');
          if (localBadge) localBadge.classList.remove('checked');
        });

        const localBadge = failure.target.closest('.http-method-badge');
        if (localBadge) localBadge.classList.add('checked');

        if (failure.target.value === 'CUSTOM') {
          if (customRegion) customRegion.style.display = 'block';
          if (customField) customField.focus();
        } else {
          if (customRegion) customRegion.style.display = 'none';
          if (webhookPhaseField) webhookPhaseField.value = failure.target.value;
        }
      });
    });

    if (customField) {
      customField.addEventListener('input', () => {
        const customDatum = customField.value.trim().toUpperCase();
        if (customDatum && webhookPhaseField) {
          webhookPhaseField.value = customDatum;
        }
      });
    }
};

PreferenceForm.paintWebhookHeadersUi = function() {
    const region = document.querySelector('#relayHeadersContainer');
    if (!region) return;

    const localHeaders = this.preferences.relay?.relayHeaders || [];

    if (localHeaders.length === 0) {
      region.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 8px; text-align: center;">No custom headers configured</div>';
      return;
    }

    region.innerHTML = localHeaders.map((localHeader, position) => `
      <div class="webhook-header-item" data-index="${position}" style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
        <input type="text" class="webhook-header-name input-field" placeholder="Header name" value="${this.escapeMarkup(localHeader.name || '')}" style="flex: 1; font-size: 13px; padding: 8px;">
        <input type="text" class="webhook-header-value input-field" placeholder="Header value" value="${this.escapeMarkup(localHeader.value || '')}" style="flex: 2; font-size: 13px; padding: 8px;">
        <button type="button" class="remove-webhook-header-btn" data-index="${position}" style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 6px; display: flex; align-items: center;">
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    `).join('');

    region.querySelectorAll('.remove-webhook-header-btn').forEach(localBtn => {
      localBtn.addEventListener('click', () => {
        const position = parseInt(localBtn.getAttribute('data-index'));
        this.preferences.relay.relayHeaders.splice(position, 1);
        this.paintWebhookHeadersUi();
      });
    });

    region.querySelectorAll('.webhook-header-item').forEach(entry => {
      const position = parseInt(entry.getAttribute('data-index'));
      const labelField = entry.querySelector('.webhook-header-name');
      const datumField = entry.querySelector('.webhook-header-value');

      labelField.addEventListener('input', () => {
        this.preferences.relay.relayHeaders[position].name = labelField.value;
      });

      datumField.addEventListener('input', () => {
        this.preferences.relay.relayHeaders[position].value = datumField.value;
      });
    });
};

PreferenceForm.routeTestWebhook = async function() {
    const localBtn = document.querySelector('#testWebhookBtn');
    if (!localBtn) return;

    localBtn.disabled = true;
    const priorCopy = localBtn.innerHTML;
    localBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" class="spin">
        <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" fill="currentColor"/>
      </svg>
      Sending...
    `;

    try {
      const webhookAddress = document.querySelector('#relayEndpoint')?.value || '';
      const webhookPhase = document.querySelector('#relayMethod')?.value || 'POST';
      const webhookContentKind = document.querySelector('#relayContentType')?.value || 'application/json';
      const localWebhookPayload = document.querySelector('#relayTemplate')?.value || '';

      if (!webhookAddress) {
        const localTWH = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
        Toasts.failure((localTWH && localTWH.resolve('pleaseEnterWebhookUrl')) || 'Please enter a webhook URL');
        return;
      }

      const localCustomHeaders = this.preferences.relay?.relayHeaders || [];
      const testAddress = 'https://example.com/test-page';
      const localTestHostname = 'example.com';
      const localTestTitle = 'Test Page - Webhook Test';
      const testSitemark = 'https://example.com/favicon.ico';
      const localTestTimestamp = new Date().toISOString();
      const testFindings = [
        {
          id: 'test-detector',
          name: 'Test Detector',
          category: 'Anti-Bot',
          confidence: 95,
          color: '#F48120',
          methods: ['dom', 'cookie']
        }
      ];
      const testTotal = 1;
      const testTaxonomies = 'Anti-Bot';

      const localHeaders = {};
      if (webhookPhase.toUpperCase() !== 'GET') {
        localHeaders['Content-Type'] = webhookContentKind;
      }

      for (const localHeader of localCustomHeaders) {
        if (localHeader.name && localHeader.name.trim()) {
          let headerDatum = localHeader.value || '';
          headerDatum = headerDatum
            .replace(/<SITEURL>/g, testAddress)
            .replace(/<HOSTNAME>/g, localTestHostname)
            .replace(/<TITLE>/g, localTestTitle)
            .replace(/<FAVICON>/g, testSitemark)
            .replace(/<TIMESTAMP>/g, localTestTimestamp)
            .replace(/<DETECTION_COUNT>/g, String(testTotal))
            .replace(/<CATEGORIES>/g, testTaxonomies);
          localHeaders[localHeader.name.trim()] = headerDatum;
        }
      }

      let processedAddress = webhookAddress
        .replace(/<SITEURL>/g, encodeURIComponent(testAddress))
        .replace(/<HOSTNAME>/g, encodeURIComponent(localTestHostname))
        .replace(/<TITLE>/g, encodeURIComponent(localTestTitle))
        .replace(/<FAVICON>/g, encodeURIComponent(testSitemark))
        .replace(/<TIMESTAMP>/g, encodeURIComponent(localTestTimestamp))
        .replace(/<DETECTION_COUNT>/g, String(testTotal))
        .replace(/<CATEGORIES>/g, encodeURIComponent(testTaxonomies));

      const fetchChoices = {
        method: webhookPhase.toUpperCase(),
        headers: localHeaders
      };

      if (webhookPhase.toUpperCase() !== 'GET') {
        let localPayload = localWebhookPayload;

        if (!localPayload.trim()) {
          localPayload = JSON.stringify({
            url: testAddress,
            hostname: localTestHostname,
            title: localTestTitle,
            favicon: testSitemark,
            detections: testFindings,
            timestamp: localTestTimestamp,
            count: testTotal
          });
        } else {
          localPayload = localPayload
            .replace(/<SITEURL>/g, testAddress)
            .replace(/<HOSTNAME>/g, localTestHostname)
            .replace(/<TITLE>/g, localTestTitle)
            .replace(/<FAVICON>/g, testSitemark)
            .replace(/<TIMESTAMP>/g, localTestTimestamp)
            .replace(/<DETECTION_COUNT>/g, String(testTotal))
            .replace(/<CATEGORIES>/g, testTaxonomies)
            .replace(/<DETECTIONS>/g, JSON.stringify(testFindings));
        }

        fetchChoices.body = localPayload;
      }

      Telemetry.performNetwork('Test webhook:', { url: processedAddress, options: fetchChoices });

      const reply = await fetch(processedAddress, fetchChoices);

      const localTW = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
      if (reply.ok) {
        Toasts.completion((localTW && localTW.encode('webhookTestSuccessfulFmt', reply.status)) || `Webhook test successful! Status: ${reply.status}`);
        Telemetry.performNetwork('Test webhook success:', { status: reply.status });
      } else {
        Toasts.failure((localTW && localTW.encode('webhookFailedStatusFmt', reply.status)) || `Webhook returned status: ${reply.status}`);
        Telemetry.performWarn('NETWORK', 'Test webhook failed:', { status: reply.status });
      }
    } catch (failure) {
      Telemetry.failure('NETWORK', 'Test webhook error:', failure);
      const localTWE = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
      Toasts.failure((localTWE && localTWE.encode('webhookTestFailedFmt', failure.message)) || ('Webhook test failed: ' + failure.message));
    } finally {
      localBtn.disabled = false;
      localBtn.innerHTML = priorCopy;
    }
};

PreferenceForm._wireWebhookSubscriptions = function() {
    const localAddWebhookHeaderBtn = document.querySelector('#addWebhookHeaderBtn');
    if (localAddWebhookHeaderBtn) {
      localAddWebhookHeaderBtn.addEventListener('click', () => {
        if (!this.preferences.relay) {
          this.preferences.relay = { relayHeaders: [] };
        }
        if (!this.preferences.relay.relayHeaders) {
          this.preferences.relay.relayHeaders = [];
        }
        this.preferences.relay.relayHeaders.push({ name: '', value: '' });
        this.paintWebhookHeadersUi();
      });
    }

    const localEnableWebhookToggle = document.querySelector('#relayActive');
    const webhookPreferencesRegion = document.querySelector('#webhookSettings');
    const webhookOnMemoGroup = document.querySelector('#relayOnMemoHitGroup');
    if (localEnableWebhookToggle) {
      localEnableWebhookToggle.addEventListener('change', () => {
        PreferenceForm.assignToggleControlledVisibility(localEnableWebhookToggle, [
          { element: webhookPreferencesRegion, onDisplay: 'block' },
          { element: webhookOnMemoGroup, onDisplay: 'flex' }
        ]);
      });
      PreferenceForm.assignToggleControlledVisibility(localEnableWebhookToggle, [
        { element: webhookPreferencesRegion, onDisplay: 'block' },
        { element: webhookOnMemoGroup, onDisplay: 'flex' }
      ]);
    }

    const localTestWebhookBtn = document.querySelector('#testWebhookBtn');
    if (localTestWebhookBtn) {
      localTestWebhookBtn.addEventListener('click', () => this.routeTestWebhook());
    }
};

if (typeof self !== 'undefined') {
    self.PreferenceForm = PreferenceForm;
}
