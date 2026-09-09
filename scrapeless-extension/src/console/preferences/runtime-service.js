/**
 * Settings runtime-safe static APIs for background/content/popup.
 * Dependencies: `Settings` class compatibility wrappers call this registry.
 */
const PreferenceRuntime = (typeof self !== 'undefined' && self.PreferenceRuntime) ? self.PreferenceRuntime : {};

PreferenceRuntime.restoreEnabledToggle = async function(localToggle) {
    if (!localToggle) return;

    try {
      const outcome = await chrome.storage.local.get(['scrapeless_enabled']);
      const isActive = outcome.scrapeless_enabled !== false; // Default to true
      localToggle.checked = isActive;
      Telemetry.performUi('Toggle state loaded:', isActive);
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to load toggle state:', failure);
      localToggle.checked = true; // Default to enabled on error
    }
};

PreferenceRuntime.restoreInitialPane = async function(switchPageContinuation) {
    try {
      const preferencePane = await ExtensionGateway.resolvePreferences();
      // Preserve the user's selected default tab, including Advanced.
      // All tab surfaces remain available in the redesigned popup.
      switchPageContinuation(preferencePane.defaultTab || 'detection');
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to load default tab:', failure);
      switchPageContinuation('detection'); // Fallback to detection tab
    }
};

PreferenceRuntime.applyEnabledChange = async function(active, localContext = null) {
    try {
      const localHasBackgroundContext = localContext && localContext.ScanEngine && localContext.TaxonomyCatalog && localContext.categoryManager;

      await chrome.storage.local.set({ scrapeless_enabled: active });
      Telemetry.performUi('Extension enabled state updated:', active);

      if (!localHasBackgroundContext) {
        chrome.runtime.sendMessage({
          type: 'RUNTIME_POWER_CHANGED',
          enabled: active
        }).catch(() => {});
      }

      // Restore badges for ALL tabs when re-enabling extension
      if (active) {
        // Only restore badges when the worker supplied its scan and taxonomy services.
        // In popup context (!hasBackgroundContext), skip — background handles it via RUNTIME_POWER_CHANGED.
        // Without this guard, popup sets all badges to EMPTY which races with background's restore.
        if (localHasBackgroundContext) {
          const localTaxonomy = localContext.TaxonomyCatalog;
          const pages = await chrome.tabs.query({});

          for (const page of pages) {
            if (!page.url || page.url.startsWith('chrome://') || page.url.startsWith('chrome-extension://') ||
                page.url.startsWith('about:') || page.url.startsWith('edge://')) {
              continue;
            }
            try {
              const storedPayload = await localContext.ScanEngine.resolveStoredScan(page.url);
              if (storedPayload && storedPayload.detectionCount > 0) {
                const palette = await localTaxonomy.resolveBadgeTint(
                  storedPayload.detectionResults,
                  storedPayload.detectionCount,
                  localContext.categoryManager
                );
                chrome.action.setBadgeText({ text: storedPayload.detectionCount.toString(), tabId: page.id }).catch(() => {});
                chrome.action.setBadgeBackgroundColor({ color: palette, tabId: page.id }).catch(() => {});
              } else {
                chrome.action.setBadgeText({ text: BadgeTokens.TEXT.EMPTY, tabId: page.id }).catch(() => {});
              }
            } catch (failure) {
              // Tab might be closing
            }
          }
        }
      } else {
        const pages2 = await chrome.tabs.query({});
        for (const page2 of pages2) {
          chrome.action.setBadgeText({ text: BadgeTokens.TEXT.DISABLED, tabId: page2.id }).catch((failure) => {
            Telemetry.performUi(`[Settings] Failed to set disabled badge for tab ${page2.id}:`, failure.message);
          });
          chrome.action.setBadgeBackgroundColor({ color: BadgeTokens.COLORS.DISABLED, tabId: page2.id }).catch((failure) => {
            Telemetry.performUi(`[Settings] Failed to set badge color for tab ${page2.id}:`, failure.message);
          });
        }
      }
    } catch (failure2) {
      Telemetry.failure('UI', 'Failed to handle toggle:', failure2);
      throw failure2;
    }
};

PreferenceRuntime.routePreferencesUpdated = async function(localContext, sendReply) {
    try {
      const { taxonomy } = localContext;

      if (taxonomy) {
        await taxonomy.readFromRepository();
      }

      sendReply({ status: 'success' });
    } catch (failure) {
      Telemetry.failure('UI', 'Failed to handle settings update:', failure);
      sendReply({ status: 'error', error: failure.message });
    }
};

// SSRF guard for the user-supplied webhook URL. Blocks anything that's not
// HTTPS to a publicly-routable host so a hostile/misconfigured webhook URL
// can't probe the user's LAN, AWS metadata service, etc.
//
// Note: this is a static check at validation time — Chrome's fetch() doesn't
// expose a resolve-then-connect API, so a DNS-rebinding host that resolves
// publicly here and privately at fetch time can still slip through. The
// `redirect: 'error'` flag in the fetch options prevents the redirect-based
// variant of the same attack.
PreferenceRuntime._isWebhookAddressSafe = function(unprocessedAddress) {
    let decoded;
    try { decoded = new URL(unprocessedAddress); } catch { return false; }
    if (decoded.protocol !== 'https:') return false;

    const localHost = decoded.hostname.toLowerCase();
    if (localHost === 'localhost' || localHost.endsWith('.localhost')) return false;

    if (/^\d+\.\d+\.\d+\.\d+$/.test(localHost)) {
        const localO = localHost.split('.').map(Number);
        if (localO[0] === 0) return false;                              // 0.0.0.0/8     — "this network"
        if (localO[0] === 10) return false;                             // 10.0.0.0/8    — RFC 1918 private
        if (localO[0] === 127) return false;                            // 127.0.0.0/8   — loopback
        if (localO[0] === 169 && localO[1] === 254) return false;            // 169.254.0.0/16 — link-local (AWS/GCP metadata)
        if (localO[0] === 172 && localO[1] >= 16 && localO[1] <= 31) return false; // 172.16.0.0/12 — RFC 1918 private
        if (localO[0] === 192 && localO[1] === 168) return false;            // 192.168.0.0/16 — RFC 1918 private
    }

    if (localHost.startsWith('[') && localHost.endsWith(']')) {
        const localV6 = localHost.slice(1, -1);
        // ::1 = IPv6 loopback; :: = unspecified; fe80::/10 = link-local;
        // fc00::/7 = unique-local (matched via fc/fd prefix).
        if (localV6 === '::1' || localV6 === '::' || localV6.startsWith('fe80:') || localV6.startsWith('fc') || localV6.startsWith('fd')) return false;
    }

    return true;
};

PreferenceRuntime._redactAddressForTrace = function(unprocessedAddress) {
    try {
      const localU = new URL(unprocessedAddress);
      return `${localU.protocol}//${localU.host}${localU.pathname}`;
    } catch { return '[unparseable webhook url]'; }
};

// Builds the template-substitution context for webhook URL/headers/body.
PreferenceRuntime._assembleWebhookContext = function(sheetPayload, scanOutcomes) {
    const address = sheetPayload.url || '';
    let localHostname = sheetPayload.hostname || '';
    if (!localHostname && address) {
        try { localHostname = new URL(address).hostname; } catch { /* leave empty */ }
    }
    return {
        url: address,
        hostname: localHostname,
        title: sheetPayload.title || 'Untitled',
        favicon: WebAddress.canonicalizeSitemarkForRepository(
            sheetPayload.favicon,
            address || localHostname,
            64
        ),
        timestamp: new Date().toISOString(),
        detectionCount: scanOutcomes.length,
        categories: [...new Set(scanOutcomes.map(localD => localD.category))].join(',')
    };
};

// Substitutes <SITEURL>, <HOSTNAME>, etc. tokens into a template string.
// Pass encode=true for URL-component contexts.
PreferenceRuntime.performSubstituteWebhookTokens = function(localTemplate, executionScope, { encode: localEncode = false } = {}) {
    const failure = localEncode ? encodeURIComponent : (entryValue) => entryValue;
    return localTemplate
        .replace(/<SITEURL>/g, failure(executionScope.url))
        .replace(/<HOSTNAME>/g, failure(executionScope.hostname))
        .replace(/<TITLE>/g, failure(executionScope.title))
        .replace(/<FAVICON>/g, failure(executionScope.favicon))
        .replace(/<TIMESTAMP>/g, failure(executionScope.timestamp))
        .replace(/<DETECTION_COUNT>/g, String(executionScope.detectionCount))
        .replace(/<CATEGORIES>/g, failure(executionScope.categories));
};

PreferenceRuntime._assembleWebhookHeaders = function(localWebhook, phase, executionScope) {
    const localHeaders = {};
    if (phase !== 'GET') {
        localHeaders['Content-Type'] = localWebhook.relayContentType || 'application/json';
    }
    for (const localHeader of (localWebhook.relayHeaders || [])) {
        // Strip everything outside the RFC 7230 token charset (incl. CR/LF and
        // spaces) so a malformed header name throws no opaque fetch TypeError
        // and can't smuggle control characters.
        const label = (localHeader.name || '').trim().replace(/[^!#$%&'*+.^_`|~0-9A-Za-z-]/g, '');
        if (!label) continue;
        localHeaders[label] = PreferenceRuntime.performSubstituteWebhookTokens(localHeader.value || '', executionScope);
    }
    return localHeaders;
};

PreferenceRuntime._assembleWebhookBody = function(localWebhook, scanOutcomes, executionScope) {
    const localTemplate = (localWebhook.relayTemplate || '').trim();
    if (!localTemplate) {
        return JSON.stringify({
            url: executionScope.url,
            hostname: executionScope.hostname,
            title: executionScope.title,
            favicon: executionScope.favicon,
            detections: scanOutcomes,
            timestamp: executionScope.timestamp,
            count: executionScope.detectionCount
        });
    }
    return PreferenceRuntime.performSubstituteWebhookTokens(localTemplate, executionScope)
        .replace(/<DETECTIONS>/g, JSON.stringify(scanOutcomes));
};

PreferenceRuntime.sendWebhookIfActive = async function(sheetPayload, scanOutcomes) {
    // Outer-scope so the catch block can log even if URL processing threw.
    let redactedAddress = '';
    let phase = '';
    try {
        const preferencePane = await ExtensionGateway.resolvePreferences();
        const localWebhook = preferencePane.relay || {};
        if (!localWebhook.relayActive || !localWebhook.relayEndpoint) return;

        if (!PreferenceRuntime._isWebhookAddressSafe(localWebhook.relayEndpoint)) {
            Telemetry.performWarn('NETWORK', 'Webhook URL rejected (must be https:// to a public host)', {
                url: PreferenceRuntime._redactAddressForTrace(localWebhook.relayEndpoint)
            });
            return;
        }

        const executionScope = PreferenceRuntime._assembleWebhookContext(sheetPayload, scanOutcomes);
        phase = (localWebhook.relayMethod || 'POST').toUpperCase();
        const processedAddress = PreferenceRuntime.performSubstituteWebhookTokens(localWebhook.relayEndpoint, executionScope, { encode: true });
        redactedAddress = PreferenceRuntime._redactAddressForTrace(processedAddress);

        const fetchChoices = {
            method: phase,
            headers: PreferenceRuntime._assembleWebhookHeaders(localWebhook, phase, executionScope),
            redirect: 'error',
            credentials: 'omit',
            referrerPolicy: 'no-referrer'
        };
        if (phase !== 'GET') {
            fetchChoices.body = PreferenceRuntime._assembleWebhookBody(localWebhook, scanOutcomes, executionScope);
        }

        Telemetry.performNetwork('Sending webhook request:', {
            url: redactedAddress,
            method: fetchChoices.method,
            bodyLength: fetchChoices.body?.length || 0
        });

        const reply = await fetch(processedAddress, fetchChoices);
        if (reply.ok) {
            Telemetry.performNetwork('Webhook sent successfully', { url: redactedAddress, status: reply.status });
        } else {
            Telemetry.performWarn('NETWORK', 'Webhook returned non-OK status', {
                url: redactedAddress,
                status: reply.status,
                statusText: reply.statusText
            });
        }
    } catch (failure) {
        Telemetry.failure('NETWORK', 'Failed to send webhook:', {
            error: failure.message,
            name: failure.name,
            url: redactedAddress || '[no url]',
            method: phase || '[no method]'
        });
        // "Failed to fetch" usually means server down, CORS issue, firewall, or bad URL.
        if (failure.message.includes('Failed to fetch')) {
            Telemetry.failure('NETWORK', 'Hint: Check that your webhook server is running and accepts requests from extensions');
        }
    }
};

PreferenceRuntime.emitPublicApiEvent = async function(signalLabel, payload = {}) {
    try {
      Telemetry.performUi(`[Preferences] emitPublicApiEvent called: ${signalLabel}`);

      const preferencePane = await ExtensionGateway.resolvePreferences();
      const pageSignalsActive = preferencePane.pageSignals?.pageSignalsActive ?? false;

      if (!pageSignalsActive) {
        Telemetry.performUi(`JS API: Disabled in settings, skipping ${signalLabel} event`);
        return false;
      }

      // ISOLATED world events aren't visible to page scripts; use the authenticated
      // content bridge to reach MAIN world when available.
      const signalPayload = {
        ...payload,
        timestamp: payload.timestamp || new Date().toISOString()
      };

      Telemetry.performUi(`[Settings] Sending JS API event to MAIN world: scrapeless:${signalLabel}`);
      const localBridge = typeof window !== 'undefined' ? window.ScrapelessBridge : null;
      const packet = {
        type: 'SCRAPELESS_JS_API_EVENT',
        eventName: signalLabel,
        detail: signalPayload
      };

      if (localBridge && typeof localBridge.sendToMainWorld === 'function') {
        localBridge.sendToMainWorld(packet);
      } else {
        Telemetry.performWarn('UI', 'JS API: MAIN world bridge unavailable, event skipped');
        return false;
      }

      Telemetry.performUi(`JS API: Sent ${signalLabel} event to MAIN world`, payload);
      return true;

    } catch (failure) {
      Telemetry.failure('UI', `JS API: Failed to dispatch ${signalLabel} event:`, failure);
      return false;
    }
};

PreferenceRuntime.emitPublicReady = async function() {
    try {
      return PreferenceRuntime.emitPublicApiEvent('ready', {
        enabled: true,
        version: chrome.runtime.getManifest().version
      });

    } catch (failure) {
      Telemetry.failure('UI', 'JS API: Failed to dispatch ready event:', failure);
      return false;
    }
};

if (typeof self !== 'undefined') {
    self.PreferenceRuntime = PreferenceRuntime;
    if (typeof self.PreferencesPresenter === 'undefined') {
      self.PreferencesPresenter = {
        restoreEnabledToggle: (...operands) => PreferenceRuntime.restoreEnabledToggle(...operands),
        restoreInitialPane: (...operands) => PreferenceRuntime.restoreInitialPane(...operands),
        applyEnabledChange: (...operands) => PreferenceRuntime.applyEnabledChange(...operands),
        routePreferencesUpdated: (...operands) => PreferenceRuntime.routePreferencesUpdated(...operands),
        sendWebhookIfActive: (...operands) => PreferenceRuntime.sendWebhookIfActive(...operands),
        emitPublicApiEvent: (...operands) => PreferenceRuntime.emitPublicApiEvent(...operands),
        emitPublicReady: (...operands) => PreferenceRuntime.emitPublicReady(...operands)
      };
    }
}
