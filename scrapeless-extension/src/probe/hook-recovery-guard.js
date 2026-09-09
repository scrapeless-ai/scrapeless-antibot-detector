// Hook reliability: installation verification, integrity checks, failure reporting

(function() {
  'use strict';

  if (window.__ScrapelessHookRecoveryGuard) {
    return;
  }

  class HookRecoveryGuard {
    constructor() {
      this.expectedTargets = new Set();
      this.failureReporter = null;
    }

    assignFailureReporter(localReporter) {
      this.failureReporter = typeof localReporter === 'function' ? localReporter : null;
    }

    assignExpectedTargets(probeDefinitions) {
      this.expectedTargets.clear();

      for (const rule of probeDefinitions) {
        if (rule.hooks && Array.isArray(rule.hooks)) {
          for (const probe of rule.hooks) {
            if (probe.target) {
              this.expectedTargets.add(probe.target);
            }
          }
        }
      }
    }

    verifyProbeDestination(destination) {
      try {
        const localParts = destination.split('.');
        if (localParts.length < 2) {
          return { canInstall: false, reason: 'INVALID_PATH', descriptor: null };
        }

        let targetObject = window;
        for (let cursor = 0; cursor < localParts.length - 1; cursor++) {
          targetObject = targetObject[localParts[cursor]];
          if (targetObject == null) {
            return { canInstall: false, reason: 'PATH_NOT_FOUND', descriptor: null };
          }
        }

        const signalLabel = localParts[localParts.length - 1];
        const localDescriptor = Object.getOwnPropertyDescriptor(targetObject, signalLabel);

        if (!localDescriptor) {
          return { canInstall: false, reason: 'PROPERTY_NOT_FOUND', descriptor: null };
        }

        const localIsAccessor = typeof localDescriptor.get === 'function' && !localDescriptor.value;
        const isPhase = typeof localDescriptor.value === 'function';

        // Accessor hooks require configurable=true because we need to replace the getter/setter.
        if (localIsAccessor) {
          if (!localDescriptor.configurable) {
            return { canInstall: false, reason: 'NOT_CONFIGURABLE', descriptor: localDescriptor };
          }
          return { canInstall: true, reason: 'OK_ACCESSOR', descriptor: localDescriptor };
        }

        // Method hooks work if writable=true even when not configurable
        if (isPhase) {
          if (!localDescriptor.configurable && !localDescriptor.writable) {
            return { canInstall: false, reason: 'NOT_WRITABLE', descriptor: localDescriptor };
          }
          return { canInstall: true, reason: 'OK_METHOD', descriptor: localDescriptor };
        }

        return { canInstall: false, reason: 'NOT_HOOKABLE', descriptor: localDescriptor };
      } catch (failure) {
        return { canInstall: false, reason: `ERROR: ${failure.message}`, descriptor: null };
      }
    }

    registerProbeInstall(destination, priorDescriptor, localWrapperDescriptor) {
      const localVerified = this._verifyProbeInstallation(destination, localWrapperDescriptor);
      if (!localVerified) {
        this.performReportFailure(destination, 'VERIFICATION_FAILED', 'Hook installed but verification failed');
      }
    }

    registerProbeFailure(destination, failure) {
      this.performReportFailure(destination, 'INSTALL_FAILED', failure);
    }

    _verifyProbeInstallation(destination, localExpectedDescriptor) {
      try {
        const localParts = destination.split('.');
        let targetObject = window;

        for (let cursor = 0; cursor < localParts.length - 1; cursor++) {
          targetObject = targetObject[localParts[cursor]];
          if (targetObject == null) return false;
        }

        const signalLabel = localParts[localParts.length - 1];
        const activeDescriptor = Object.getOwnPropertyDescriptor(targetObject, signalLabel);

        if (!activeDescriptor) return false;

        if (localExpectedDescriptor.value) {
          return activeDescriptor.value === localExpectedDescriptor.value;
        }

        if (localExpectedDescriptor.get) {
          return activeDescriptor.get === localExpectedDescriptor.get;
        }

        return false;
      } catch (failure) {
        return false;
      }
    }

    performReportFailure(destination, kind, packet) {
      try {
        if (!this.failureReporter) return;
        this.failureReporter({
          type: 'PROBE_FAILURE_REPORT',
          target: destination,
          failureType: kind,
          message: packet,
          timestamp: Date.now()
        });
      } catch (failure) {
        // Silently fail
      }
    }

  }

  window.__ScrapelessHookRecoveryGuard = new HookRecoveryGuard();
})();
