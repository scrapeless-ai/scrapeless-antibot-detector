// Window property detection with adaptive polling and retry strategies

(function() {
  'use strict';

  if (window.__ScrapelessGlobalSignalWatcher) {
    return;
  }

  // Suppression depth key shared with src/entry/page-probe.js
  const PROBE_SUPPRESSION_DEPTH_LOOKUP = '__scrapelessHookSuppressionDepth';

  /**
   * Property States
   */
  const SignalSession = {
    PENDING: 'pending',           // Not yet checked
    PATH_NOT_FOUND: 'path_not_found',  // Parent path doesn't exist (retry)
    PROPERTY_ABSENT: 'property_absent', // Property doesn't exist on object (may appear later)
    DETECTED: 'detected',         // Property found and condition met
    NOT_MATCHED: 'not_matched',   // Property found but condition not met
    ERROR: 'error',               // Non-recoverable error
    ABANDONED: 'abandoned'        // Max retries exceeded
  };

  /**
   * Polling Phases - Adaptive timing based on script loading patterns
   */
  const BASELINE_POLLING_PHASES = {
    EARLY: {
      name: 'EARLY',
      duration: 2000,    // First 2 seconds
      interval: 100,     // Fast polling for immediate properties
      description: 'Fast polling for immediately available properties'
    },
    NORMAL: {
      name: 'NORMAL',
      duration: 8000,    // 2-10 seconds
      interval: 200,     // Typical script loading
      description: 'Normal polling for script-loaded properties'
    },
    LATE: {
      name: 'LATE',
      duration: 20000,   // 10-30 seconds
      interval: 500,     // Lazy-loaded scripts
      description: 'Slow polling for lazy-loaded properties'
    },
    FINAL: {
      name: 'FINAL',
      duration: 30000,   // 30-60 seconds
      interval: 1000,    // Very late properties
      description: 'Final polling for extremely late properties'
    }
  };

  /**
   * Retry Configuration
   */
  const BASELINE_RETRY_PROFILE = {
    // Linear backoff for missing paths (may appear as scripts load)
    pathNotFound: {
      maxRetries: 100,       // Many retries since paths can appear late
      baseDelay: 100,        // Start at 100ms
      maxDelay: 1000         // Cap at 1 second
    },
    // Exponential backoff for getter errors (usually temporary)
    getterError: {
      maxRetries: 10,        // Fewer retries for errors
      baseDelay: 50,
      multiplier: 1.5,
      maxDelay: 2000
    },
    // Property absent (not an error, just doesn't exist yet)
    propertyAbsent: {
      maxRetries: 50,        // Moderate retries
      baseDelay: 200
    }
  };

  const cloneProfile = (targetObject) => JSON.parse(JSON.stringify(targetObject));

  /**
   * WindowPropertyTracker - Manages reliable window property detection
   */
  class GlobalSignalWatcher {
    constructor() {
      // Property tracking state
      this.properties = new Map(); // path -> PropertyTrackingData

      // Polling state
      this.currentPhase = null;
      this.phaseStartTime = 0;
      this.pollingInterval = null;
      this.isPolling = false;
      this.completed = false;

      // Callbacks
      this.onDetection = null;
      this.onComplete = null;
      this.postMessageToIsolated = null;

      // Statistics
      this.stats = {
        totalProperties: 0,
        detected: 0,
        notMatched: 0,
        errors: 0,
        abandoned: 0,
        totalChecks: 0,
        phaseTransitions: 0
      };

      // Debug mode
      this.debugStrategy = false;

      // Configurable polling + retry settings
      this.pollingPhases = cloneProfile(BASELINE_POLLING_PHASES);
      this.retryConfig = cloneProfile(BASELINE_RETRY_PROFILE);
    }

    _composeStats() {
      return {
        totalProperties: 0,
        detected: 0,
        notMatched: 0,
        errors: 0,
        abandoned: 0,
        totalChecks: 0,
        phaseTransitions: 0
      };
    }

    restore() {
      if (this.pollingInterval) {
        clearTimeout(this.pollingInterval);
        this.pollingInterval = null;
      }

      this.properties.clear();
      this.currentPhase = null;
      this.phaseStartTime = 0;
      this.isPolling = false;
      this.completed = false;
      this.onDetection = null;
      this.onComplete = null;
      this.postMessageToIsolated = null;
      this.stats = this._composeStats();
      this.pollingPhases = cloneProfile(BASELINE_POLLING_PHASES);
      this.retryConfig = cloneProfile(BASELINE_RETRY_PROFILE);
    }

    /**
     * Initialize tracking for a set of property definitions
     * @param {Array} propertyDefinitions - Array of property definitions from detectors
     * @param {Object} options - Configuration options
     */
    start(signalDefinitions, choices = {}) {
      this.restore();
      this.onDetection = choices.onDetection || null;
      this.onComplete = choices.onComplete || null;
      this.postMessageToIsolated = typeof choices.postMessageToIsolated === 'function'
        ? choices.postMessageToIsolated
        : null;
      this.debugStrategy = choices.diagnosticMode || false;
      // Initialize tracking state for each property
      for (const localPropDef of signalDefinitions) {
        if (!localPropDef.path) continue;

        this.properties.set(localPropDef.path, {
          definition: localPropDef,
          state: SignalSession.PENDING,
          retryCount: 0,
          lastError: null,
          lastCheckTime: 0,
          nextRetryTime: 0,
          checkCount: 0
        });
      }

      this.stats.totalProperties = this.properties.size;
      this._trace(`Initialized tracking for ${this.properties.size} properties`);
    }

    performPostToIsolated(packet) {
      if (typeof this.postMessageToIsolated !== 'function') {
        return false;
      }
      return this.postMessageToIsolated(packet);
    }

    /**
     * Start adaptive polling
     */
    beginPolling() {
      if (this.isPolling) return;

      this.isPolling = true;
      this.phaseStartTime = Date.now();
      this.currentPhase = this.pollingPhases.EARLY;

      this._trace(`Starting adaptive polling in ${this.currentPhase.name} phase`);
      this._scheduleFollowingPoll();
    }

    /**
     * Schedule the next polling check
     */
    _scheduleFollowingPoll() {
      if (!this.isPolling) return;

      const localNow = Date.now();
      const localElapsed = localNow - this.phaseStartTime;

      // Check for phase transition
      const localNewPhase = this.performDeterminePhase(localElapsed);
      if (localNewPhase !== this.currentPhase) {
        this._trace(`Phase transition: ${this.currentPhase.name} → ${localNewPhase.name} at ${localElapsed}ms`);
        this.currentPhase = localNewPhase;
        this.stats.phaseTransitions++;
      }

      // Check if we've exceeded total duration
      const aggregateDuration = this.pollingPhases.EARLY.duration +
                           this.pollingPhases.NORMAL.duration +
                           this.pollingPhases.LATE.duration +
                           this.pollingPhases.FINAL.duration;

      if (localElapsed >= aggregateDuration) {
        this._trace(`Polling complete after ${localElapsed}ms (max duration reached)`);
        this._finishedPolling('max_duration');
        return;
      }

      // Check if all properties are in terminal state
      if (this._allSignalsTerminal()) {
        this._trace(`Polling complete after ${localElapsed}ms (all properties terminal)`);
        this._finishedPolling('all_terminal');
        return;
      }

      // Schedule next check
      this.pollingInterval = setTimeout(() => {
        this.performPerformPollingCheck();
        this._scheduleFollowingPoll();
      }, this.currentPhase.interval);
    }

    /**
     * Determine which polling phase based on elapsed time
     * @param {number} elapsed - Milliseconds since polling started
     * @returns {Object} Current phase
     */
    performDeterminePhase(localElapsed) {
      if (localElapsed < this.pollingPhases.EARLY.duration) {
        return this.pollingPhases.EARLY;
      } else if (localElapsed < this.pollingPhases.EARLY.duration + this.pollingPhases.NORMAL.duration) {
        return this.pollingPhases.NORMAL;
      } else if (localElapsed < this.pollingPhases.EARLY.duration + this.pollingPhases.NORMAL.duration + this.pollingPhases.LATE.duration) {
        return this.pollingPhases.LATE;
      } else {
        return this.pollingPhases.FINAL;
      }
    }

    /**
     * Perform a single polling check on all pending properties
     */
    performPerformPollingCheck() {
      const localNow = Date.now();

      for (const [resourcePath, trackingPayload] of this.properties.entries()) {
        // Skip terminal states
        if (this._isTerminalSession(trackingPayload.state)) continue;

        // Skip if not ready for retry
        if (localNow < trackingPayload.nextRetryTime) continue;

        // Check the property
        this._checkSignal(resourcePath, trackingPayload);
      }
    }

    /**
     * Check a single property and update its state
     * @param {string} path - Property path
     * @param {Object} trackingData - Tracking data for this property
     */
    _checkSignal(resourcePath, trackingPayload) {
      const localNow = Date.now();
      trackingPayload.lastCheckTime = localNow;
      trackingPayload.checkCount++;
      this.stats.totalChecks++;

      try {
        // Navigate to property
        const outcome = this._navigateToSignal(resourcePath);

        if (outcome.error) {
          this._routeSignalFailure(resourcePath, trackingPayload, outcome.error, outcome.errorType);
          return;
        }

        if (!outcome.found) {
          this._routeSignalNotFound(resourcePath, trackingPayload, outcome.reason);
          return;
        }

        // Property exists, check condition
        const localConditionMet = this.performCheckCondition(outcome.value, trackingPayload.definition);

        if (localConditionMet) {
          this._routeSignalDetected(resourcePath, trackingPayload, outcome.value);
        } else {
          trackingPayload.state = SignalSession.NOT_MATCHED;
          // Keep checking - condition might become true later
          this.performScheduleRetry(resourcePath, trackingPayload, 'propertyAbsent');
        }
      } catch (failure) {
        this._routeSignalFailure(resourcePath, trackingPayload, failure.message, 'exception');
      }
    }

    /**
     * Navigate to a property path and return its value
     * @param {string} path - Property path (e.g., "navigator.brave")
     * @returns {Object} { found: boolean, value: any, error: string, errorType: string, reason: string }
     */
    _navigateToSignal(resourcePath) {
      const localParts = resourcePath.split('.');
      let targetObject = window;
      let traversedRoute = 'window';

      const localPrevSuppressionDepth = typeof window[PROBE_SUPPRESSION_DEPTH_LOOKUP] === 'number'
        ? window[PROBE_SUPPRESSION_DEPTH_LOOKUP]
        : 0;
      window[PROBE_SUPPRESSION_DEPTH_LOOKUP] = localPrevSuppressionDepth + 1;

      try {
        for (let cursor = 0; cursor < localParts.length; cursor++) {
          const localPart = localParts[cursor];
          traversedRoute += `.${localPart}`;

          if (targetObject == null) {
            return {
              found: false,
              reason: `Parent path null at ${traversedRoute}`,
              errorType: 'path_null'
            };
          }

          try {
            // Check if property exists
            if (!(localPart in targetObject)) {
              if (cursor < localParts.length - 1) {
                // Intermediate path missing
                return {
                  found: false,
                  reason: `Path not found: ${traversedRoute}`,
                  errorType: 'path_not_found'
                };
              } else {
                // Final property missing
                return {
                  found: false,
                  reason: `Property absent: ${traversedRoute}`,
                  errorType: 'property_absent'
                };
              }
            }

            // Access the property (might throw for getters)
            targetObject = targetObject[localPart];
          } catch (failure) {
            return {
              found: false,
              error: failure.message,
              errorType: 'getter_error',
              reason: `Getter error at ${traversedRoute}: ${failure.message}`
            };
          }
        }

        return {
          found: true,
          value: targetObject
        };
      } finally {
        window[PROBE_SUPPRESSION_DEPTH_LOOKUP] = localPrevSuppressionDepth;
      }
    }

    /**
     * Check if a value meets the condition
     * @param {any} value - Property value
     * @param {Object} definition - Property definition with condition
     * @returns {boolean} True if condition is met
     */
    performCheckCondition(datum, localDefinition) {
      const localCondition = localDefinition.condition || 'truthy';

      // Shared, safe condition language (no eval).
      const localLang = globalThis.PropertyPredicateLanguage;
      if (localLang && typeof localLang.evaluate === 'function') {
        return localLang.evaluate(datum, localCondition);
      }

      // Fallback: default to truthy
      return !!datum;
    }

    /**
     * Handle property detection
     */
    _routeSignalDetected(resourcePath, trackingPayload, datum) {
      trackingPayload.state = SignalSession.DETECTED;
      this.stats.detected++;

      const findingsPane = {
        detectorId: trackingPayload.definition.detectorId,
        detectorName: trackingPayload.definition.detectorName,
        category: trackingPayload.definition.category,
        property: {
          path: resourcePath,
          actualType: datum === null ? 'null' : typeof datum,
          actualValue: typeof datum === 'object' ? '[object]' : String(datum).substring(0, 100),
          condition: trackingPayload.definition.condition || 'truthy',
          confidence: trackingPayload.definition.confidence || 80,
          description: trackingPayload.definition.description
        }
      };

      this._trace(`Detected: ${resourcePath} (${trackingPayload.definition.detectorName})`);

      if (this.onDetection) {
        this.onDetection([findingsPane]);
      }
    }

    /**
     * Handle property not found
     */
    _routeSignalNotFound(resourcePath, trackingPayload, localReason) {
      const failureKind = localReason.includes('Path not found') ? 'path_not_found' : 'property_absent';

      if (failureKind === 'path_not_found') {
        trackingPayload.state = SignalSession.PATH_NOT_FOUND;
        this.performScheduleRetry(resourcePath, trackingPayload, 'pathNotFound');
      } else {
        trackingPayload.state = SignalSession.PROPERTY_ABSENT;
        this.performScheduleRetry(resourcePath, trackingPayload, 'propertyAbsent');
      }
    }

    /**
     * Handle property access error
     */
    _routeSignalFailure(resourcePath, trackingPayload, failure, failureKind) {
      trackingPayload.lastError = failure;

      if (failureKind === 'getter_error') {
        // Getter errors might be temporary (e.g., cross-origin)
        this.performScheduleRetry(resourcePath, trackingPayload, 'getterError');
      } else {
        // Non-recoverable error
        trackingPayload.state = SignalSession.ERROR;
        this.stats.errors++;
        this._trace(`Error checking ${resourcePath}: ${failure}`);
      }
    }

    /**
     * Schedule a retry for a property
     */
    performScheduleRetry(resourcePath, trackingPayload, retryKind) {
      const profile = this.retryConfig[retryKind];
      if (!profile) return;

      trackingPayload.retryCount++;

      if (trackingPayload.retryCount > profile.maxRetries) {
        trackingPayload.state = SignalSession.ABANDONED;
        this.stats.abandoned++;
        this._trace(`Abandoned ${resourcePath} after ${trackingPayload.retryCount} retries`);
        return;
      }

      // Calculate delay based on retry type
      let localDelay;
      if (retryKind === 'getterError') {
        // Exponential backoff
        localDelay = Math.min(
          profile.baseDelay * Math.pow(profile.multiplier, trackingPayload.retryCount - 1),
          profile.maxDelay
        );
      } else {
        // Linear backoff for path/property not found
        localDelay = Math.min(
          profile.baseDelay + (trackingPayload.retryCount * 50),
          profile.maxDelay || profile.baseDelay * 10
        );
      }

      trackingPayload.nextRetryTime = Date.now() + localDelay;
    }

    /**
     * Check if all properties are in a terminal state
     */
    _allSignalsTerminal() {
      for (const trackingPayload of this.properties.values()) {
        if (!this._isTerminalSession(trackingPayload.state)) {
          return false;
        }
      }
      return true;
    }

    /**
     * Check if a state is terminal (won't change)
     */
    _isTerminalSession(session) {
      return [
        SignalSession.DETECTED,
        SignalSession.ERROR,
        SignalSession.ABANDONED
      ].includes(session);
    }

    /**
     * Complete polling and report results
     */
    _finishedPolling(localReason) {
      if (this.completed) return;
      this.completed = true;
      this.isPolling = false;

      if (this.pollingInterval) {
        clearTimeout(this.pollingInterval);
        this.pollingInterval = null;
      }

      const localElapsed = Date.now() - this.phaseStartTime;

      this._trace(`Polling complete: ${this.stats.detected}/${this.stats.totalProperties} detected`);
      this._trace(`Stats: ${JSON.stringify(this.stats)}`);

      if (this.onComplete) {
        this.onComplete({
          detectedCount: this.stats.detected,
          totalChecked: this.stats.totalProperties,
          elapsedMs: localElapsed,
          reason: localReason
        });
      }

      this.performPostToIsolated({
        type: 'GLOBAL_SIGNALS_COMPLETE',
        url: window.location.href,
        timestamp: Date.now(),
        detectedCount: this.stats.detected,
        totalChecked: this.stats.totalProperties,
        elapsedMs: localElapsed,
        reason: localReason
      });
    }

    /**
     * Stop polling (called on cache hit or disable)
     */
    halt() {
      this.isPolling = false;

      if (this.pollingInterval) {
        clearTimeout(this.pollingInterval);
        this.pollingInterval = null;
      }

      this._trace('Polling stopped');
    }

    /**
     * Log helper (only logs if diagnosticMode is enabled)
     */
    _trace(packet, payload = null) {
      if (!this.debugStrategy) return;

      const traceMsg = `[WindowPropertyTracker] ${packet}`;
      if (payload) {
        this.performPostToIsolated({
          type: 'SCRAPELESS_DEBUG_LOG',
          level: 'log',
          message: `${traceMsg} ${JSON.stringify(payload)}`,
          source: 'window-property-tracker',
          timestamp: Date.now()
        });
      } else {
        this.performPostToIsolated({
          type: 'SCRAPELESS_DEBUG_LOG',
          level: 'log',
          message: traceMsg,
          source: 'window-property-tracker',
          timestamp: Date.now()
        });
      }
    }
  }

  // Create singleton instance
  window.__ScrapelessGlobalSignalWatcher = new GlobalSignalWatcher();
})();
