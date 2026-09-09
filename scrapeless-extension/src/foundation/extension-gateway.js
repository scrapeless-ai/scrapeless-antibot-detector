/**
 * Extension utilities for settings, caching, lifecycle, and page data collection.
 *
 * Focused utility class for Chrome extension operations.
 * Pure formatting → FormatUtils, URL operations → UrlUtils, Detection analysis → DetectionUtils
 */

class ExtensionGateway {
  /**
   * Apply debug mode flag globally for Logger.
   * @param {object} settings
   */
  static applyDebugStrategy(preferencePane) {
    const active = !!preferencePane?.diagnosticMode;
    const traceCollectorActive = !!preferencePane?.journalActive;
    if (typeof globalThis !== 'undefined') {
      globalThis.diagnosticMode = active;
      globalThis.journalActive = traceCollectorActive;
    }
    if (typeof window !== 'undefined') {
      window.diagnosticMode = active;
      window.journalActive = traceCollectorActive;
    }
    if (typeof self !== 'undefined') {
      self.diagnosticMode = active;
      self.journalActive = traceCollectorActive;
    }
  }

  // ============================================================================
  // Detection Request Throttling
  // ============================================================================

  /**
   * Check if we should skip detection due to recent request
   * @param {number} tabId - Tab ID
   * @param {number} threshold - Minimum milliseconds between requests (default 2000ms)
   * @param {Map} recentRequests - Map to track recent requests (passed from caller)
   * @returns {boolean} true if should skip, false otherwise
   */
  static shouldSkipScan(pageToken, localThreshold = RuntimePolicy.DETECTION_SKIP_THRESHOLD, recentInbounds) {
    const lastInbound = recentInbounds.get(pageToken);
    const localNow = Date.now();

    if (lastInbound && (localNow - lastInbound) < localThreshold) {
      return true;
    }

    recentInbounds.set(pageToken, localNow);
    setTimeout(() => {
      if (recentInbounds.get(pageToken) === localNow) {
        recentInbounds.delete(pageToken);
      }
    }, 10000);

    return false;
  }

  // ============================================================================
  // Content Script URL Validation
  // ============================================================================

  /**
   * Check if a URL is valid for content script injection
   * @param {string} url - URL to check
   * @returns {boolean} true if valid, false if restricted
   */
  static isAcceptedContentScriptAddress(address) {
    if (!address) {
      return false;
    }

    const localRestrictedPrefixes = [
      'chrome://',
      'chrome-extension://',
      'edge://',
      'about:',
      'chrome-devtools://',
      'devtools://',
      'view-source:',
      'data:',
      'blob:',
      'file://'
    ];

    return !localRestrictedPrefixes.some(localPrefix => address.startsWith(localPrefix));
  }

  /**
   * Check if a tab is valid for content script operations
   * @param {object} tab - Chrome tab object
   * @returns {boolean} true if valid, false if invalid
   */
  static isAcceptedContentScriptPage(page) {
    return page && page.url && this.isAcceptedContentScriptAddress(page.url);
  }

  // ============================================================================
  // Extension Context Lifecycle
  // ============================================================================

  /**
   * Check if extension context is still valid
   * @returns {boolean} true if context is valid, false otherwise
   */
  static hasLiveRuntime() {
    try {
      if (chrome && chrome.runtime && chrome.runtime.id) {
        const address = chrome.runtime.getURL('');
        if (address && address.startsWith('chrome-extension://')) {
          return true;
        }
      }
      return false;
    } catch (failure) {
      if (!(failure instanceof TypeError && /Cannot read|undefined|invalid/.test(failure.message))) {
        Telemetry.failure('UTIL', 'Extension context check error:', failure.message);
      }
      return false;
    }
  }

  /**
   * Clean up orphaned content script when extension context is invalidated
   * @param {object} cleanup - Cleanup configuration
   * @returns {boolean} true if cleanup was performed, false if already cleaned up
   */
  static disposePageAgent(localCleanup) {
    if (localCleanup.hasCleanedUp) return false;
    localCleanup.hasCleanedUp = true;

    if (localCleanup.contextCheckInterval) {
      clearInterval(localCleanup.contextCheckInterval);
      localCleanup.contextCheckInterval = null;
    }

    if (localCleanup.notifyPageLoad) {
      document.removeEventListener('DOMContentLoaded', localCleanup.notifyPageLoad);
      document.removeEventListener('visibilitychange', localCleanup.notifyPageLoad);
      window.removeEventListener('focus', localCleanup.notifyPageLoad);
      window.removeEventListener('beforeunload', localCleanup.notifyPageLoad);
      window.removeEventListener('hashchange', localCleanup.notifyPageLoad);
      window.removeEventListener('popstate', localCleanup.notifyPageLoad);
    }

    if (localCleanup.hookMessageHandler) {
      window.removeEventListener('message', localCleanup.hookMessageHandler);
    }

    if (localCleanup.detectionEngine) {
      localCleanup.detectionEngine.purgeScanPayload();
      localCleanup.detectionEngine = null;
    }

    if (typeof window !== 'undefined') {
      window.__scrapelessContentScriptInitialized = false;
      window.__scrapelessHooksInstalled = false;
    }

    return true;
  }

  // ============================================================================
  // Page Data Collection & Messaging
  // ============================================================================

  /**
   * Notify background about page load (cache check first)
   * @param {Object} context - Context object with detectionEngine, isExtensionContextValid, cleanupOrphanedScript, triggerSource
   */
  static async announceNavigation(localContext) {
    const { detectionEngine: scanEvaluator, isExtensionContextValid: isExtensionContextAccepted, cleanupOrphanedScript: localCleanupOrphanedScript, triggerSource: triggerOrigin = 'page_load' } = localContext;

    if (!isExtensionContextAccepted()) {
      localCleanupOrphanedScript();
      return;
    }

    const debounceMoment = triggerOrigin === 'visibility_change' ? 10000 :
                        triggerOrigin === 'url_change' ? 1000 :
                        2000;

    if (!scanEvaluator.shouldRunScan(debounceMoment)) {
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: 'PAGE_LOAD_SIGNAL',
        url: window.location.href,
        timestamp: Date.now(),
        triggerSource: triggerOrigin
      }, (reply) => {
        if (chrome.runtime.lastError) {
          if (chrome.runtime.lastError.message &&
            chrome.runtime.lastError.message.includes('Extension context invalidated')) {
            Telemetry.performDebug('UTIL', 'Extension context invalidated (extension reloaded)');
            localCleanupOrphanedScript();
          }
        }
      });
    } catch (failure) {
      if (failure.message && failure.message.includes('Extension context invalidated')) {
        localCleanupOrphanedScript();
      }
    }
  }

  /**
   * Collect page data and send to background (called when cache miss)
   * @param {Object} context - Context object with detectionEngine, isExtensionContextValid, cleanupOrphanedScript
   */
  static async submitPageSnapshot(localContext) {
    const { detectionEngine: scanEvaluator, isExtensionContextValid: isExtensionContextAccepted, cleanupOrphanedScript: localCleanupOrphanedScript } = localContext;

    if (!isExtensionContextAccepted()) {
      localCleanupOrphanedScript();
      return;
    }

    try {
      const sheetPayload = await scanEvaluator.collectSheetPayload();

      const plainSheetPayload = {
        url: sheetPayload.url,
        title: sheetPayload.title,
        favicon: sheetPayload.favicon,
        cookies: sheetPayload.cookies,
        content: sheetPayload.content,
        dom: sheetPayload.dom,
        headers: sheetPayload.headers,
        jsHooks: sheetPayload.jsHooks,
        payload: sheetPayload.payload,
        payloads: sheetPayload.payloads,
        networkUrls: sheetPayload.networkUrls,
        externalContent: sheetPayload.externalContent,
        responseCookies: sheetPayload.responseCookies,
        requestHeaders: sheetPayload.requestHeaders,
        pageHTML: sheetPayload.pageHTML
      };

      if (!isExtensionContextAccepted()) {
        localCleanupOrphanedScript();
        return;
      }

      try {
        chrome.runtime.sendMessage({
          type: 'SCAN_PAYLOAD',
          data: plainSheetPayload,
          tabId: null,
          timestamp: Date.now()
        }, (reply) => {
          if (chrome.runtime.lastError) {
            const failureMsg = chrome.runtime.lastError.message || '';

            if (failureMsg.includes('Extension context invalidated')) {
              localCleanupOrphanedScript();
            }
            else if (failureMsg.includes('Could not establish connection') ||
                     failureMsg.includes('Receiving end does not exist')) {
              // Silent - expected during reload
            }
            else {
              Telemetry.performWarn('UTIL', 'Scrapeless Content Script: Error sending detection data:', chrome.runtime.lastError);
            }
          }
        });
      } catch (sendFailure) {
        const failureMsg = sendFailure.message || '';

        if (failureMsg.includes('Extension context invalidated')) {
          localCleanupOrphanedScript();
        }
        else if (failureMsg.includes('Could not establish connection') ||
                 failureMsg.includes('Receiving end does not exist')) {
          // Silent - expected during reload
        }
        else {
          Telemetry.performWarn('UTIL', 'Scrapeless Content Script: Failed to send message:', sendFailure);
        }
      }
    } catch (failure) {
      if (failure.message && failure.message.includes('Extension context invalidated')) {
        localCleanupOrphanedScript();
      } else {
        Telemetry.failure('UTIL', 'Scrapeless Content Script: Error during detection:', failure);
      }
    }
  }

  // ============================================================================
  // Storage Helper Functions
  // ============================================================================

  /**
   * Get settings from storage with proper format handling
   * @returns {Promise<object>} Settings object (never null, returns {} on error)
   */
  static async resolvePreferences() {
    try {
      if (typeof ExtensionStore !== 'undefined' && typeof ExtensionStore.resolvePreferences === 'function') {
        const preferencePane = await ExtensionStore.resolvePreferences();
        ExtensionGateway.applyDebugStrategy(preferencePane);
        return preferencePane;
      }

      const outcome = await chrome.storage.local.get(['scrapeless_settings']);
      const decoded = typeof outcome.scrapeless_settings === 'string'
        ? JSON.parse(outcome.scrapeless_settings)
        : outcome.scrapeless_settings;
      const preferencePane2 = decoded?.settings && typeof decoded.settings === 'object'
        ? decoded.settings
        : (decoded || {});
      ExtensionGateway.applyDebugStrategy(preferencePane2);
      return preferencePane2;
    } catch (failure) {
      Telemetry.failure('UTIL', 'Failed to load settings:', failure);
    }

    ExtensionGateway.applyDebugStrategy({ diagnosticMode: false });
    return {};
  }

  /**
   * Get history-specific settings with defaults
   * @returns {Promise<object>} History settings with defaults applied
   */
  static async resolveArchivePreferences() {
    const preferencePane = await this.resolvePreferences();
    const archivePreferences = preferencePane.archive || {};
    const localDuplicatePrevention = preferencePane.repeatGuard || {};

    const unprocessedDuplicateBoundary = localDuplicatePrevention.repeatScope ?? preferencePane.repeatScope ?? 'full_url';
    const normalizedDuplicateBoundary = (() => {
      const normalizedBoundary = String(unprocessedDuplicateBoundary || '').toLowerCase();

      if (normalizedBoundary === 'url' || normalizedBoundary === 'full') {
        return 'full_url';
      }

      if (normalizedBoundary === 'domain' || normalizedBoundary === 'path' || normalizedBoundary === 'full_url') {
        return normalizedBoundary;
      }

      return 'full_url';
    })();

    const decodedDuplicateDuration = parseInt(
      localDuplicatePrevention.repeatDuration ?? preferencePane.repeatDuration ?? 1,
      10
    );

    return {
      archiveCeiling: archivePreferences.archiveCeiling ?? preferencePane.archiveCeiling ?? 0,
      archivePruneDays: archivePreferences.archivePruneDays ?? preferencePane.archivePruneDays ?? 30,
      exportEncoding: archivePreferences.exportEncoding || preferencePane.exportEncoding || 'json',
      includeMoments: archivePreferences.includeMoments ?? preferencePane.includeMoments ?? true,
      archiveOnMemoHit: archivePreferences.archiveOnMemoHit ?? preferencePane.archiveOnMemoHit ?? false,
      repeatGuardActive: localDuplicatePrevention.repeatGuardActive ?? preferencePane.repeatGuardActive ?? false,
      repeatScope: normalizedDuplicateBoundary,
      repeatDuration: Number.isFinite(decodedDuplicateDuration) && decodedDuplicateDuration > 0
        ? decodedDuplicateDuration
        : 1,
      repeatUnit: localDuplicatePrevention.repeatUnit || preferencePane.repeatUnit || 'hours'
    };
  }

  /**
   * Check if a URL is blacklisted
   * @param {string} url - URL to check
   * @returns {Promise<boolean>} True if URL's domain is blacklisted
   */
  static async isAddressBlacklisted(address) {
    if (!address) return false;

    try {
      const preferencePane = await this.resolvePreferences();
      const localBlacklist = preferencePane.scanning?.skippedDomains || preferencePane.skippedDomains || [];
      const localHostname = WebAddress.resolveHostnameFromAddress(address);
      return localBlacklist.includes(localHostname);
    } catch (failure) {
      Telemetry.failure('UTIL', 'Error checking blacklist:', failure);
      return false;
    }
  }

  /**
   * Get cache scope from settings
   * @returns {Promise<string>} Cache scope: 'domain', 'path', or 'full'
   */
  static async resolveMemoBoundary() {
    try {
      const preferencePane = await this.resolvePreferences();
      const boundary = preferencePane.scanning?.memoScope || preferencePane.memoScope || 'domain';
      if (!['domain', 'path', 'full'].includes(boundary)) {
        Telemetry.performWarn('UTIL', `[getCacheScope] Invalid cache scope: ${boundary}, defaulting to 'domain'`);
        return 'domain';
      }
      return boundary;
    } catch (failure) {
      Telemetry.failure('UTIL', '[getCacheScope] Error getting cache scope:', failure);
      return 'domain';
    }
  }

}

if (typeof window !== 'undefined') {
  window.ExtensionGateway = ExtensionGateway;
} else if (typeof self !== 'undefined') {
  self.ExtensionGateway = ExtensionGateway;
}
