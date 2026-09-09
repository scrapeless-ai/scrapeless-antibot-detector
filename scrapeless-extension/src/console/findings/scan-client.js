/**
 * Detection static request/process methods.
 * Dependencies: `Detection` class must be loaded first.
 */
const FindingsQuery = (typeof self !== 'undefined' && self.FindingsQuery) ? self.FindingsQuery : {};

FindingsQuery.resolveBadgeCondition = async function(pageToken) {
    const badgeCopy = await FindingsPresenter.resolveBadgeCopy(pageToken);
    const badgePalette = await FindingsPresenter.resolveBadgeBackgroundPalette(pageToken);
    const localTrimmed = badgeCopy ? badgeCopy.trim() : '';
    const localIsGrayBadge = badgePalette === '#6B7280' || badgePalette === '#6b7280';
    const localIsLegacyInterrupted = localTrimmed === '?' || localTrimmed === '\u2715' || localTrimmed === '\u00D7';

    // Determine if this is a cleared cache badge (gray) or interrupted detection badge (other colors)
    const localIsCleared = localTrimmed === BadgeTokens.TEXT.CLEARED && localIsGrayBadge;
    const localIsInterrupted = (localTrimmed === BadgeTokens.TEXT.INTERRUPTED || localIsLegacyInterrupted) && !localIsCleared;

    return {
      text: badgeCopy,
      trimmed: localTrimmed,
      color: badgePalette,
      isLoading: isLoadingBadgeCopy(localTrimmed),
      isCleared: localIsCleared,
      isInterrupted: localIsInterrupted,
      isError: localIsLegacyInterrupted,
      isQuestion: localTrimmed === '?',
      isEmpty: localTrimmed === ''
    };
};

FindingsQuery.requestFocusedTabScan = async function(localContext) {
    const { detection: findingsPane, Utils: ExtensionGateway, processDetectionDataCallback: ingestScanPayloadContinuation } = localContext;

    // Prevent duplicate concurrent requests
    if (findingsPane.isRequestingScan) {
      if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Already requesting detection, skipping duplicate request');
      return;
    }

    try {
      findingsPane.isRequestingScan = true;

      // Wait for background response before choosing UI state (avoids Analyzing -> Interrupted flicker)

      const [page] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!page) {
        Telemetry.failure('UI', 'Detection: No active tab found');
        findingsPane.presentEmptyState();
        findingsPane.isRequestingScan = false;
        return;
      }

      // Check if extension is enabled
      const outcome = await chrome.storage.local.get(['scrapeless_enabled']);
      const isActive = outcome.scrapeless_enabled !== false;
      findingsPane.assignExtensionActive(isActive);
      if (!isActive) {
        if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Extension is disabled');
        // Check if domain is also blacklisted to show the indicator
        const localIsBlacklisted = await ExtensionGateway.isAddressBlacklisted(page.url);
        findingsPane.presentDisabledState(localIsBlacklisted);
        findingsPane.isRequestingScan = false;
        return;
      }

      // Check if URL is blacklisted
      if (await ExtensionGateway.isAddressBlacklisted(page.url)) {
        if (findingsPane.debugStrategy) Telemetry.performUi('Detection: URL is blacklisted');
        const address = new URL(page.url);
        findingsPane.presentBlacklistSession(address.hostname);
        findingsPane.isRequestingScan = false;
        return;
      }

      // Request detection data from background
      chrome.runtime.sendMessage(
        { type: 'READ_SCAN_PAYLOAD', tabId: page.id },
        async (reply) => {
          // Clear the request flag
          findingsPane.isRequestingScan = false;

          if (chrome.runtime.lastError) {
            Telemetry.failure('UI', 'Detection: Error getting detection data:', chrome.runtime.lastError);
            findingsPane.presentEmptyState();
            return;
          }

          // Let badge check determine state when response is null
          if (!reply) {
            if (findingsPane.debugStrategy) Telemetry.performUi('Detection: No response yet, continuing to badge check...');
            // Don't return - let badge check handle state
          }

          if (reply && reply.status === 'pending') {
            if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Detection still running - checking if cached data exists first');

            // Race condition: detection may have completed while status still says pending
            if (reply.data && reply.data.detectionResults?.length > 0) {
              if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Found cached results despite pending status - displaying');
              await ingestScanPayloadContinuation(reply.data);
              return;
            }

            // Badge numeric = detection done but cache write pending; retry after delay
            const badgeCondition = await FindingsPresenter.resolveBadgeCondition(page.id);
            const localIsNumericBadge = /^\d+\+?$/.test(badgeCondition.trimmed);

            if (localIsNumericBadge && !reply.data) {
              Telemetry.performUi('Detection: Badge shows count but no data yet - retrying in 500ms', { badge: badgeCondition.trimmed });
              // Wait for cache to be ready, then retry (increased from 300ms for slower cache writes)
              await new Promise(localResolve => setTimeout(localResolve, 500));
              const retryReply = await new Promise((localResolve) => {
                chrome.runtime.sendMessage(
                  { type: 'READ_SCAN_PAYLOAD', tabId: page.id },
                  localResolve
                );
              });

              if (retryReply && retryReply.data && retryReply.data.detectionResults?.length > 0) {
                Telemetry.performUi('Detection: Retry successful - displaying results');
                await ingestScanPayloadContinuation(retryReply.data);
                return;
              }

              // Still no data after retry - try one more time with longer delay (increased from 500ms)
              await new Promise(localResolve => setTimeout(localResolve, 1000));
              const retryReply2 = await new Promise((localResolve) => {
                chrome.runtime.sendMessage(
                  { type: 'READ_SCAN_PAYLOAD', tabId: page.id },
                  localResolve
                );
              });

              if (retryReply2 && retryReply2.data && retryReply2.data.detectionResults?.length > 0) {
                Telemetry.performUi('Detection: Second retry successful - displaying results');
                await ingestScanPayloadContinuation(retryReply2.data);
                return;
              }

              // Give up and show what we have based on badge
              Telemetry.performWarn('UI', 'Detection: Badge shows count but no data after retries', { badge: badgeCondition.trimmed });
            }

            // No cached data, truly still running - show analyzing state
            if (findingsPane.debugStrategy) Telemetry.performUi('Detection: No cached data, showing analyzing state');

            // Skip re-render if already analyzing (prevents UI flicker on popup reopen)
            if (!findingsPane.isShowingAnalyzing) {
              findingsPane.presentScanningState();
            } else {
              if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Already showing analyzing, updating progress only');
              if (!findingsPane.scanPhases || findingsPane.scanPhases.length === 0) {
                findingsPane.scanPhases = findingsPane.composeScanPhases();
                findingsPane.paintAnalysisSteps();
              }
            }

            // Color completed steps immediately (one-by-one progress)
            if (reply.progress && reply.progress.completedMethods) {
              const lastPhase = reply.progress.method || reply.progress.completedMethods[reply.progress.completedMethods.length - 1];
              findingsPane.refreshPhaseCondition(lastPhase, reply.progress.completedMethods);
            }

            return;
          }

          if (reply && reply.status === 'interrupted') {
            if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Detection status interrupted with no data - showing empty state');
            findingsPane.presentEmptyState();
            return;
          }

          if (reply && reply.status === 'error') {
            Telemetry.failure('UI', 'Detection: Background reported error fetching detection data:', reply.error);
            findingsPane.presentEmptyState();
            return;
          }

          // Use badge status helper
          const badgeCondition2 = await FindingsPresenter.resolveBadgeCondition(page.id);

          if (badgeCondition2.isLoading) {
            if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Badge shows hourglass - checking if cache exists before showing loading');

            // Badge shows loading - but check cache first in case detection completed
            // and we're in a race condition where badge wasn't updated yet
            chrome.runtime.sendMessage(
              { type: 'READ_SCAN_PAYLOAD', tabId: page.id },
              async (reply) => {
                if (chrome.runtime.lastError) {
                  Telemetry.failure('UI', 'Detection: Error checking cache:', chrome.runtime.lastError);
                  if (!findingsPane.wasInterrupted) {
                    findingsPane.presentScanningState();
                  }
                  return;
                }

                if (reply?.data?.detectionResults?.length > 0) {
                  // Cache has data! Detection completed but badge not updated yet
                  // Note: Don't update progress here - cache hit means detection is done
                  // Just show the results directly
                  await ingestScanPayloadContinuation(reply.data);
                } else {
                  // No cache yet, truly still loading
                  if (findingsPane.debugStrategy) Telemetry.performUi('Detection: No cache found, showing analyzing state');
                  if (!findingsPane.wasInterrupted) {
                    findingsPane.presentScanningState();
                  }
                }
              }
            );
            return;
          }

          // Gray "CLR" badge = cache was cleared; show empty state
          if (badgeCondition2.isCleared) {
            if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Badge indicates cache cleared, showing empty state');
            findingsPane.presentEmptyState();
            return;
          }

          // Show interrupted only when no valid data (badge may be stale)
          if (badgeCondition2.isInterrupted && (!reply || !reply.data)) {
            if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Badge indicates interruption with no data, showing empty state');
            findingsPane.presentEmptyState();
            return;
          }

          if (reply && reply.data) {
            // Update step colors from completed methods
            if (reply.progress && reply.progress.completedMethods) {
              const lastPhase2 = reply.progress.method || reply.progress.completedMethods[reply.progress.completedMethods.length - 1];
              findingsPane.refreshPhaseCondition(lastPhase2, reply.progress.completedMethods);
            }

            await ingestScanPayloadContinuation(reply.data);
          } else {
            // Keep analyzing state while detection is in progress
            const activeBadgeCondition = await FindingsPresenter.resolveBadgeCondition(page.id);
            if (activeBadgeCondition.isLoading) {
              if (findingsPane.debugStrategy) Telemetry.performUi('Detection: No data yet but detection in progress, keeping analyzing state');
              if (!findingsPane.isShowingAnalyzing) {
                findingsPane.presentScanningState();
              }
            } else {
              if (findingsPane.debugStrategy) Telemetry.performUi('Detection: No detection data available');
              findingsPane.presentEmptyState();
            }
          }
        }
      );
    } catch (failure) {
      Telemetry.failure('UI', 'Detection: Failed to request detection:', failure);
      findingsPane.presentEmptyState();
    }
};

FindingsQuery.acceptPageSnapshot = async function(localContext, scanSnapshot) {
    const { detection: findingsPane, detectionEngine: scanEvaluator, detectorManager: ruleCatalog, history: archivePane } = localContext;

    if (findingsPane.debugStrategy) {
      Telemetry.performUi('[DEBUG processDetectionData] Called with:', {
        hasDetectionData: !!scanSnapshot,
        dataKeys: scanSnapshot ? Object.keys(scanSnapshot) : null,
        hasDetectionResults: !!scanSnapshot?.detectionResults,
        detectionCount: scanSnapshot?.detectionResults?.length
      });
    }

    try {
      if (!findingsPane.isExtensionEnabled) {
        findingsPane.presentDisabledState();
        return;
      }

      if (!scanSnapshot) {
        if (findingsPane.debugStrategy) {
          Telemetry.performUi('[DEBUG processDetectionData] No detection data provided - showing empty state');
        }
        findingsPane.presentEmptyState();
        return;
      }

      // Set detectors and run detection
      scanEvaluator.assignCatalog(ruleCatalog.resolveAllCatalog());

      let findings = [];

      // Check if we have pre-processed detection results
      if (scanSnapshot.detectionResults) {
        if (findingsPane.debugStrategy) {
          Telemetry.performUi('[DEBUG processDetectionData] Using pre-processed results:', scanSnapshot.detectionResults.length);
        }
        findings = scanSnapshot.detectionResults;

        // MIGRATION: Handle old cached data format
        // Old format stored full URL in 'value', new format stores matched substring
        findings = findings.map(findingsPane => {
          if (findingsPane.signals) {
            findingsPane.signals = findingsPane.signals.map(hit => {
              if (hit.type === 'url' || hit.type === 'urls') {
                // Case 1: No value field at all
                if (!hit.value) {
                  return { ...hit, value: hit.fullUrl || hit.pattern };
                }
                // Case 2: Value contains full URL (old format: https://...)
                // Need to extract matched part from full URL using pattern
                else if (hit.value.includes('://') && hit.pattern) {
                  try {
                    // Try to extract the matched substring from the full URL
                    const localRegex = new RegExp(hit.pattern, 'gi');
                    const localExtracted = localRegex.exec(hit.value);
                    if (localExtracted && localExtracted[0]) {
                      return { ...hit, value: localExtracted[0], fullUrl: hit.value };
                    }
                  } catch (failure) {
                    // If regex fails, keep the full URL
                    Telemetry.performDebug('UI', '[Migration] Failed to extract match from URL:', failure);
                  }
                }
              }
              // For non-URL matches without value field
              else if (!hit.value && hit.pattern) {
                return { ...hit, value: hit.pattern };
              }
              return hit;
            });
          }
          return findingsPane;
        });
      } else if (scanSnapshot.pageData) {
        if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Running detection on raw page data');
        findings = scanEvaluator.detectOnSheet(scanSnapshot.pageData);
      } else {
        if (findingsPane.debugStrategy) Telemetry.performDebug('UI', 'Detection: No valid data format in detectionData');
        findingsPane.presentEmptyState();
        return;
      }

      if (findingsPane.debugStrategy) {
        Telemetry.performUi(`[DEBUG processDetectionData] Found ${findings.length} security systems, calling displayResults()`);
      }

      // Display results with metadata
      // Construct cacheMetadata from available fields
      const memoMetadata = scanSnapshot.expiry ? {
        expiry: scanSnapshot.expiry,
        url: scanSnapshot.url,
        timestamp: scanSnapshot.timestamp,
        favicon: scanSnapshot.favicon,
        memoScope: scanSnapshot.memoScope
      } : null;

      if (findingsPane.debugStrategy) {
        Telemetry.performUi('[DEBUG processDetectionData] Cache metadata:', memoMetadata);
        Telemetry.performUi('[DEBUG processDetectionData] From storage:', scanSnapshot.fromStorage);
      }

      await findingsPane.paintFindings(findings, {
        fromStorage: scanSnapshot.fromStorage || false,
        cacheMetadata: memoMetadata
      });

      if (findingsPane.debugStrategy) {
        Telemetry.performUi('[DEBUG processDetectionData] displayResults() completed');
      }

      // Update history if we have detections
      if (findings.length > 0 && archivePane && typeof archivePane.presentArchive === 'function') {
        if (findingsPane.debugStrategy) Telemetry.performUi('Detection: Updating history');
        await archivePane.presentArchive();
      }
    } catch (failure) {
      Telemetry.failure('UI', 'Detection: Failed to process detection data:', failure);
      Telemetry.failure('UI', 'Detection: Stack trace:', failure.stack);
      findingsPane.presentEmptyState();
    }
};

FindingsQuery.resolveBadgeCopy = async function(pageToken) {
    try {
      return await new Promise((localResolve) => {
        chrome.action.getBadgeText({ tabId: pageToken }, (copy) => {
          if (chrome.runtime.lastError) {
            Telemetry.performDebug('UI', 'Detection: Failed to read badge text:', chrome.runtime.lastError.message);
            localResolve('');
            return;
          }
          localResolve(copy || '');
        });
      });
    } catch (failure) {
      Telemetry.failure('UI', 'Detection: Unexpected error reading badge text:', failure);
      return '';
    }
};

FindingsQuery.resolveBadgeBackgroundPalette = async function(pageToken) {
    try {
      return await new Promise((localResolve) => {
        chrome.action.getBadgeBackgroundColor({ tabId: pageToken }, (paletteDetail) => {
          if (chrome.runtime.lastError) {
            Telemetry.performDebug('UI', 'Detection: Failed to read badge color:', chrome.runtime.lastError.message);
            localResolve('');
            return;
          }
          // colorInfo is ColorArray [r, g, b, a], not {r, g, b, a}
          if (paletteDetail && typeof paletteDetail === 'object') {
            const localR = (paletteDetail[0] || 0).toString(16).padStart(2, '0');
            const localG = (paletteDetail[1] || 0).toString(16).padStart(2, '0');
            const rightValue = (paletteDetail[2] || 0).toString(16).padStart(2, '0');
            localResolve(`#${localR}${localG}${rightValue}`.toUpperCase());
          } else {
            localResolve('');
          }
        });
      });
    } catch (failure) {
      Telemetry.failure('UI', 'Detection: Unexpected error reading badge color:', failure);
      return '';
    }
};

if (typeof self !== 'undefined') {
    self.FindingsQuery = FindingsQuery;
}
