/**
 * Worker Keepalive Manager
 * Prevents service worker suspension during active detections
 *
 * Key Features:
 * - Periodic chrome.runtime.getPlatformInfo() every 20s to keep worker alive
 * - Auto-cleanup when no active detections
 * - Reference counting for multiple active detections
 * - Minimal CPU/memory overhead
 */

/**
 * WorkerKeepaliveManager - Keeps service worker alive during detections
 */
class WorkerLeaseRegistry {
  constructor() {
    // Keepalive state
    this.keepaliveInterval = null;
    this.keepalivePeriodMs = RuntimePolicy.KEEPALIVE_PERIOD_MS;
    this.staleOperationMs = RuntimePolicy.STALE_OPERATION_MS;

    // Reference counting for active operations
    this.activeOperations = new Map(); // operationId -> { tabId, startTime, reason }

    // State
    this.isRunning = false;
  }

  /**
   * Start a keepalive for an operation
   * @param {string} operationId - Unique operation identifier
   * @param {Object} context - Operation context { tabId, reason }
   */
  beginOperation(operationToken, localContext = {}) {
    this.activeOperations.set(operationToken, {
      tabId: localContext.tabId || null,
      reason: localContext.reason || 'unknown',
      startTime: Date.now()
    });

    // Start keepalive if not already running
    if (!this.isRunning) {
      this._beginLease();
    }

    Telemetry.performBackground(`[WorkerKeepalive] Started operation: ${operationToken} (${this.activeOperations.size} active)`);
  }

  /**
   * End a keepalive operation
   * @param {string} operationId - Operation identifier
   */
  performEndOperation(operationToken) {
    if (this.activeOperations.has(operationToken)) {
      this.activeOperations.delete(operationToken);

      Telemetry.performBackground(`[WorkerKeepalive] Ended operation: ${operationToken} (${this.activeOperations.size} remaining)`);

      // Stop keepalive if no more operations
      if (this.activeOperations.size === 0) {
        this._haltLease();
      }
    }
  }

  /**
   * End all operations for a specific tab
   * @param {number} tabId - Tab ID
   */
  endOperationsForPage(pageToken) {
    const localToRemove = [];

    for (const [opToken, localContext] of this.activeOperations.entries()) {
      if (localContext.tabId === pageToken) {
        localToRemove.push(opToken);
      }
    }

    for (const opToken2 of localToRemove) {
      this.performEndOperation(opToken2);
    }

    if (localToRemove.length > 0) {
      Telemetry.performBackground(`[WorkerKeepalive] Ended ${localToRemove.length} operations for tab ${pageToken}`);
    }
  }

  /**
   * Start the keepalive interval
   */
  _beginLease() {
    if (this.isRunning) return;

    this.isRunning = true;

    // Initial keepalive
    this._sendLease();

    // Start periodic keepalives
    this.keepaliveInterval = setInterval(() => {
      this._sendLease();
    }, this.keepalivePeriodMs);

    Telemetry.performBackground('[WorkerKeepalive] Started keepalive');
  }

  /**
   * Stop the keepalive interval
   */
  _haltLease() {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    Telemetry.performBackground('[WorkerKeepalive] Stopped keepalive');
  }

  /**
   * Send a keepalive ping
   * Uses chrome.runtime.getPlatformInfo() as a lightweight keepalive
   */
  /**
   * Drop operations older than staleOperationMs. These leak when a detection
   * state is evicted by TTL/LRU before finalize/tab-close/url-change ends its
   * keepalive op; without this sweep the leaked op pins the worker awake forever.
   */
  performSweepStaleOperations() {
    const localNow = Date.now();
    for (const [opToken, executionScope] of this.activeOperations.entries()) {
      if (localNow - executionScope.startTime > this.staleOperationMs) {
        Telemetry.performBackground(`[WorkerKeepalive] Sweeping stale operation: ${opToken} (age ${localNow - executionScope.startTime}ms)`);
        this.activeOperations.delete(opToken);
      }
    }
    if (this.activeOperations.size === 0) {
      this._haltLease();
    }
  }

  async _sendLease() {
    // Reap leaked operations first; this may stop the keepalive if none remain.
    this.performSweepStaleOperations();
    if (!this.isRunning) return;

    try {
      // This API call keeps the service worker alive
      await chrome.runtime.getPlatformInfo();
    } catch (failure) {
      // Silently fail - worker might be terminating
      Telemetry.performWarn('BACKGROUND', '[WorkerKeepalive] Keepalive failed:', failure.message);
    }
  }

}

// Export for use in src/entry/worker.js
if (typeof globalThis !== 'undefined') {
  globalThis.WorkerLeaseRegistry = WorkerLeaseRegistry;
}

// Node test export (no-op in the browser/SW, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) { module.exports = WorkerLeaseRegistry; }
