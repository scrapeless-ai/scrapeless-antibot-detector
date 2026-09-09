/**
 * LogCollector - Stores logs in memory and allows export
 * Uses circular buffer to prevent memory overflow
 *
 * Usage:
 *   window.LogCollector.enable()  // Start collecting logs
 *   window.LogCollector.exportAsJSON()  // Export as JSON file
 *   window.LogCollector.exportAsText()  // Export as text file
 *   window.LogCollector.disable()  // Stop collecting
 */
class DiagnosticBuffer {
    constructor(limitTraces = RuntimePolicy.LOG_COLLECTOR_MAX_LOGS) {
        this.MAX_SAFE_LOGS = RuntimePolicy.LOG_COLLECTOR_MAX_LOGS;
        this.MAX_PERSISTED_LOGS = RuntimePolicy.LOG_COLLECTOR_MAX_PERSISTED;
        // Conservative limit: logging can crash browser in debug mode
        this.LOG_RATE_LIMIT_PER_SEC = RuntimePolicy.LOG_COLLECTOR_RATE_LIMIT;
        this.maxLogs = Math.min(Math.max(Number(limitTraces) || 5000, 100), this.MAX_SAFE_LOGS);
        // Ring buffer storage (O(1) append, no Array.shift())
        this.buffer = new Array(this.maxLogs);
        this.nextIndex = 0;
        this.size = 0;
        this.enabled = false;
        this.startTime = Date.now();
        this.originalConsole = null;
        this.storageKey = 'scrapeless_collected_logs';
        this.settingsKey = 'scrapeless_settings';
        // Legacy storage keys (pre v2.5) - settings are now stored inside scrapeless_settings
        this.legacyEnabledStateKey = 'scrapeless_log_collector_enabled';
        this.legacyMaxLogsKey = 'scrapeless_log_collector_max';
        this.storageWriteTimer = null;
        this.started = false;
        this.initPromise = null;
        this.rateWindowStart = Date.now();
        this.rateCount = 0;
        // Initialize and load from storage
        this.initPromise = this.startFromRepository();
    }

    _parsePreferencesRepositoryDatum(unprocessedDatum) {
        const outcome = {
            container: null,
            settings: null,
            wrapped: false,
            wasString: typeof unprocessedDatum === 'string'
        };

        if (unprocessedDatum === undefined || unprocessedDatum === null) {
            return outcome;
        }

        let decoded = unprocessedDatum;
        if (typeof unprocessedDatum === 'string') {
            try {
                decoded = JSON.parse(unprocessedDatum);
            } catch (failure) {
                return outcome;
            }
        }

        if (!decoded || typeof decoded !== 'object') {
            return outcome;
        }

        // Stored as { timestamp, settings: {...} }
        if (decoded.settings && typeof decoded.settings === 'object' && !Array.isArray(decoded.settings)) {
            outcome.container = decoded;
            outcome.settings = decoded.settings;
            outcome.wrapped = true;
            return outcome;
        }

        // Stored as a flat settings object
        outcome.container = decoded;
        outcome.settings = decoded;
        return outcome;
    }

    _persistPreferencesRepositoryDatum(region, localWasString) {
        try {
            const datumToPersist = localWasString ? JSON.stringify(region, null, 2) : region;
            chrome.storage.local.set({ [this.settingsKey]: datumToPersist });
        } catch (failure) {
            Telemetry.failure('UTIL', '[LogCollector] Failed to persist settings:', failure);
        }
    }

    _refreshPreferences(localPatch, { removeLegacyKeys: removeLegacyLookups = [] } = {}) {
        if (typeof chrome === 'undefined' || !chrome.storage) {
            return;
        }

        try {
            chrome.storage.local.get([this.settingsKey], (outcome) => {
                if (chrome.runtime?.lastError) {
                    Telemetry.performWarn('UTIL', '[LogCollector] Settings update skipped:', chrome.runtime.lastError.message);
                    return;
                }

                outcome = outcome || {};
                const decoded = this._parsePreferencesRepositoryDatum(outcome[this.settingsKey]);
                let region = decoded.container;
                let preferencePane = decoded.settings;
                let localWrapped = decoded.wrapped;
                let localWasString = decoded.wasString;

                if (!preferencePane || typeof preferencePane !== 'object') {
                    // Create wrapper by default for consistency with settings UI
                    region = {
                        timestamp: new Date().toISOString(),
                        settings: {}
                    };
                    preferencePane = region.settings;
                    localWrapped = true;
                    localWasString = true;
                }

                for (const [lookupKey, datum] of Object.entries(localPatch || {})) {
                    preferencePane[lookupKey] = datum;
                }

                if (localWrapped && region && typeof region === 'object') {
                    region.settings = preferencePane;
                    region.timestamp = new Date().toISOString();
                    this._persistPreferencesRepositoryDatum(region, localWasString);
                } else {
                    this._persistPreferencesRepositoryDatum(preferencePane, localWasString);
                }

                if (removeLegacyLookups.length > 0) {
                    try {
                        chrome.storage.local.remove(removeLegacyLookups);
                    } catch (failure) {
                        // Ignore removal errors
                    }
                }

                // Keep Logger globals in sync if Utils is available
                if (typeof ExtensionGateway !== 'undefined' && typeof ExtensionGateway.applyDebugStrategy === 'function') {
                    ExtensionGateway.applyDebugStrategy(preferencePane);
                } else if (typeof globalThis !== 'undefined') {
                    globalThis.journalActive = !!preferencePane.journalActive;
                }
            });
        } catch (failure) {
            Telemetry.failure('UTIL', '[LogCollector] Failed to update settings:', failure);
        }
    }

    performWriteEntry(localEntry) {
        this.buffer[this.nextIndex] = localEntry;
        this.nextIndex = (this.nextIndex + 1) % this.maxLogs;
        if (this.size < this.maxLogs) {
            this.size += 1;
        }
    }

    _resolveOrderedTraces() {
        if (this.size === 0) return [];
        const localOut = new Array(this.size);
        const begin = (this.nextIndex - this.size + this.maxLogs) % this.maxLogs;
        for (let cursor = 0; cursor < this.size; cursor++) {
            localOut[cursor] = this.buffer[(begin + cursor) % this.maxLogs];
        }
        return localOut.filter(Boolean);
    }

    _resolveLastNTraces(localN) {
        const total = Math.min(this.size, Math.max(0, localN | 0));
        if (total === 0) return [];
        const localOut = new Array(total);
        const begin = (this.nextIndex - total + this.maxLogs) % this.maxLogs;
        for (let cursor = 0; cursor < total; cursor++) {
            localOut[cursor] = this.buffer[(begin + cursor) % this.maxLogs];
        }
        return localOut.filter(Boolean);
    }

    _restoreFromArray(traceArray) {
        const traces = Array.isArray(traceArray) ? traceArray.slice(-this.maxLogs) : [];
        this.buffer = new Array(this.maxLogs);
        this.nextIndex = 0;
        this.size = 0;
        for (const localEntry of traces) {
            this.performWriteEntry(localEntry);
        }
    }

    /**
     * Initialize by loading logs and enabled state from chrome storage
     * Returns a Promise that resolves when initialization is complete
     * This restores logs and enabled state across service worker restarts
     */
    startFromRepository() {
        if (typeof chrome === 'undefined' || !chrome.storage) {
            this.started = true;
            return Promise.resolve(); // Not in extension context
        }

        return new Promise((localResolve) => {
            try {
                chrome.storage.local.get([this.storageKey, this.settingsKey, this.legacyEnabledStateKey, this.legacyMaxLogsKey], (outcome) => {
                    try {
                        if (chrome.runtime?.lastError) {
                            Telemetry.performWarn('UTIL', '[LogCollector] Storage restore skipped:', chrome.runtime.lastError.message);
                            this.started = true;
                            localResolve();
                            return;
                        }

                        outcome = outcome || {};
                        const storedTraces = (outcome[this.storageKey] && Array.isArray(outcome[this.storageKey]))
                            ? outcome[this.storageKey]
                            : [];

                        const decodedPreferences = this._parsePreferencesRepositoryDatum(outcome[this.settingsKey]);
                        const preferencePane = decodedPreferences.settings || {};
                        const hasLegacyActive = Object.prototype.hasOwnProperty.call(outcome, this.legacyEnabledStateKey);
                        const hasLegacyLimit = Object.prototype.hasOwnProperty.call(outcome, this.legacyMaxLogsKey);

                        // Restore max logs setting (settings first, then legacy fallback)
                        let unprocessedLimit = preferencePane.journalCeiling;
                        if ((unprocessedLimit === undefined || unprocessedLimit === null) && hasLegacyLimit) {
                            unprocessedLimit = outcome[this.legacyMaxLogsKey];
                        }
                        if (unprocessedLimit !== undefined && unprocessedLimit !== null) {
                            this.maxLogs = Math.min(Math.max(Number(unprocessedLimit) || 5000, 100), this.MAX_SAFE_LOGS);
                        }

                        // Restore logs after maxLogs is known so ring buffer indices stay consistent.
                        this._restoreFromArray(storedTraces);

                        // Restore enabled state and auto-resume collection if needed
                        let wasActive = false;
                        if (typeof preferencePane.journalActive === 'boolean') {
                            wasActive = preferencePane.journalActive === true;
                        } else if (hasLegacyActive) {
                            wasActive = outcome[this.legacyEnabledStateKey] === true;
                        }
                        if (wasActive) {
                            this.enabled = true;
                            this.interceptConsolePhases();
                            if (typeof globalThis !== 'undefined') {
                                globalThis.journalActive = true;
                            }
                        }

                        // Migrate legacy keys into scrapeless_settings and remove old keys
                        const localPatch = {};
                        const removeLegacyLookups = [];

                        // Always keep defaults in settings when settings object exists
                        const shouldWriteBaselines = !!decodedPreferences.container;

                        if (typeof preferencePane.journalActive !== 'boolean') {
                            if (hasLegacyActive) {
                                localPatch.journalActive = outcome[this.legacyEnabledStateKey] === true;
                            } else if (shouldWriteBaselines) {
                                localPatch.journalActive = false;
                            }
                        }

                        const activeLimit = preferencePane.journalCeiling;
                        const resolvedLimit = Math.min(Math.max(Number(unprocessedLimit) || 5000, 100), this.MAX_SAFE_LOGS);
                        if (activeLimit === undefined || activeLimit === null) {
                            if (unprocessedLimit !== undefined && unprocessedLimit !== null) {
                                localPatch.journalCeiling = resolvedLimit;
                            } else if (shouldWriteBaselines) {
                                localPatch.journalCeiling = this.maxLogs;
                            }
                        } else if (Number(activeLimit) !== resolvedLimit) {
                            localPatch.journalCeiling = resolvedLimit;
                        }

                        if (hasLegacyActive) removeLegacyLookups.push(this.legacyEnabledStateKey);
                        if (hasLegacyLimit) removeLegacyLookups.push(this.legacyMaxLogsKey);

                        if (Object.keys(localPatch).length > 0 || removeLegacyLookups.length > 0) {
                            this._refreshPreferences(localPatch, { removeLegacyKeys: removeLegacyLookups });
                        }
                    } catch (failure) {
                        Telemetry.failure('UTIL', '[LogCollector] Failed to restore from storage:', failure);
                        this._restoreFromArray([]);
                        this.enabled = false;
                    }

                    this.started = true;
                    localResolve();
                });
            } catch (failure) {
                // Storage API not available
                Telemetry.failure('UTIL', '[LogCollector] Failed to initialize from storage:', failure);
                this.started = true;
                localResolve();
            }
        });
    }

    /**
     * Save logs to chrome storage (debounced to avoid excessive writes)
     */
    persistTracesToRepository() {
        if (typeof chrome === 'undefined' || !chrome.storage) {
            return; // Not in extension context
        }

        // Debounce storage writes to reduce pressure on chrome.storage
        if (this.storageWriteTimer) {
            clearTimeout(this.storageWriteTimer);
        }

        this.storageWriteTimer = setTimeout(() => {
            try {
                const persistedTraces = this._resolveLastNTraces(this.MAX_PERSISTED_LOGS);
                chrome.storage.local.set({ [this.storageKey]: persistedTraces });
            } catch (failure) {
                Telemetry.failure('UTIL', '[LogCollector] Failed to save logs to storage:', failure);
            }
        }, 5000);
    }

    /**
     * Enable log collection
     */
    performEnable() {
        if (this.enabled) {
            return;
        }

        this.enabled = true;
        // Don't reset startTime or clear logs - preserve existing logs from storage
        this.interceptConsolePhases();
        // Ring buffer already clamps to maxLogs

        if (typeof globalThis !== 'undefined') {
            globalThis.journalActive = true;
        }

        // Persist enabled state to settings
        this._refreshPreferences({ journalActive: true }, { removeLegacyKeys: [this.legacyEnabledStateKey] });
    }

    /**
     * Disable log collection
     */
    performDisable() {
        if (!this.enabled) {
            return;
        }

        this.enabled = false;
        this.restoreConsolePhases();

        if (typeof globalThis !== 'undefined') {
            globalThis.journalActive = false;
        }

        // Persist disabled state to settings
        this._refreshPreferences({ journalActive: false }, { removeLegacyKeys: [this.legacyEnabledStateKey] });

    }

    /**
     * Intercept console methods to capture logs
     */
    interceptConsolePhases() {
        // Store original console methods before overriding
        const scopeRoot = (typeof globalThis !== 'undefined') ? globalThis : (typeof window !== 'undefined' ? window : self);
        const prior = scopeRoot && scopeRoot.__scrapelessOriginalConsole
            ? scopeRoot.__scrapelessOriginalConsole
            : console;
        this.originalConsole = {
            log: prior.log ? prior.log.bind(prior) : console.log,
            warn: prior.warn ? prior.warn.bind(prior) : console.warn,
            error: prior.error ? prior.error.bind(prior) : console.error,
            info: prior.info ? prior.info.bind(prior) : console.info,
            debug: prior.debug ? prior.debug.bind(prior) : (prior.log ? prior.log.bind(prior) : console.log)
        };

        // Override console methods
        const localThat = this;

        console.log = function(...operands) {
            localThat.addTrace('log', operands);
            if (localThat.performShouldForwardToConsole('log') && localThat.originalConsole?.log) {
                localThat.originalConsole.log(...localThat.performSanitizeConsoleArgs(operands));
            }
        };

        console.warn = function(...operands) {
            localThat.addTrace('warn', operands);
            if (localThat.performShouldForwardToConsole('warn') && localThat.originalConsole?.warn) {
                localThat.originalConsole.warn(...localThat.performSanitizeConsoleArgs(operands));
            }
        };

        console.error = function(...operands) {
            localThat.addTrace('error', operands);
            if (localThat.performShouldForwardToConsole('error') && localThat.originalConsole?.error) {
                localThat.originalConsole.error(...localThat.performSanitizeConsoleArgs(operands, { keepErrors: true }));
            }
        };

        console.info = function(...operands) {
            localThat.addTrace('info', operands);
            if (localThat.performShouldForwardToConsole('info') && localThat.originalConsole?.info) {
                localThat.originalConsole.info(...localThat.performSanitizeConsoleArgs(operands));
            }
        };

        console.debug = function(...operands) {
            localThat.addTrace('debug', operands);
            if (localThat.performShouldForwardToConsole('debug') && localThat.originalConsole?.debug) {
                localThat.originalConsole.debug(...localThat.performSanitizeConsoleArgs(operands));
            }
        };
    }

    /**
     * Restore original console methods
     */
    restoreConsolePhases() {
        if (this.originalConsole) {
            console.log = this.originalConsole.log;
            console.warn = this.originalConsole.warn;
            console.error = this.originalConsole.error;
            console.info = this.originalConsole.info;
            console.debug = this.originalConsole.debug;
            this.originalConsole = null;
        }
    }

    performShouldForwardToConsole(localLevel) {
        // When collecting, avoid printing high-volume logs to console.
        // DevTools (and SW logs) can retain rich objects and crash Chrome under log storms.
        return localLevel === 'warn' || localLevel === 'error';
    }

    performSanitizeConsoleArgs(operands, choices = {}) {
        const keepFailures = choices.keepErrors === true;
        const limitArgs = 5;
        return operands.slice(0, limitArgs).map((operand) => this.performSanitizeConsoleArg(operand, { keepErrors: keepFailures }));
    }

    performSanitizeConsoleArg(operand, choices = {}) {
        const keepFailures = choices.keepErrors === true;
        if (keepFailures && operand instanceof Error) return operand;
        if (operand === null || operand === undefined) return operand;

        const localT = typeof operand;
        if (localT === 'string') return this.performTruncateString(operand, 2000);
        if (localT === 'number' || localT === 'boolean' || localT === 'bigint') return operand;
        if (localT === 'function') return `[Function${operand.name ? ` ${operand.name}` : ''}]`;
        if (Array.isArray(operand)) return `[Array(${operand.length})]`;
        if (localT === 'object') {
            try {
                if (operand instanceof Error) return `Error(${operand.message})`;
            } catch (failure) {
                // ignore
            }

            // Typed arrays / ArrayBuffers can be enormous; never enumerate keys.
            try {
                if (typeof ArrayBuffer !== 'undefined' && operand instanceof ArrayBuffer) {
                    return `[ArrayBuffer(${operand.byteLength} bytes)]`;
                }
            } catch (failure2) {
                // ignore
            }
            try {
                if (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(operand)) {
                    const label = operand?.constructor?.name || 'TypedArray';
                    const localLen = typeof operand.length === 'number' ? operand.length : undefined;
                    const localBytes = typeof operand.byteLength === 'number' ? operand.byteLength : undefined;
                    if (typeof localLen === 'number' && typeof localBytes === 'number') return `[${label}(${localLen}) ${localBytes} bytes]`;
                    if (typeof localBytes === 'number') return `[${label} ${localBytes} bytes]`;
                    if (typeof localLen === 'number') return `[${label}(${localLen})]`;
                    return `[${label}]`;
                }
            } catch (failure3) {
                // ignore
            }

            if (operand instanceof Map) return `[Map(${operand.size})]`;
            if (operand instanceof Set) return `[Set(${operand.size})]`;
            if (operand instanceof Date) return operand.toISOString();

            try {
                const lookups = Object.keys(operand).slice(0, 10);
                return `{${lookups.join(', ')}}`;
            } catch (failure4) {
                return '[Object]';
            }
        }
        return String(operand);
    }

    /**
     * Add log entry to buffer (circular buffer)
     */
    addTrace(localLevel, operands) {
        if (!this.enabled) return;

        const localNow = Date.now();
        if (localNow - this.rateWindowStart >= 1000) {
            this.rateWindowStart = localNow;
            this.rateCount = 0;
        }
        this.rateCount += 1;
        if (this.rateCount > this.LOG_RATE_LIMIT_PER_SEC) {
            return;
        }

        const localEntry = {
            timestamp: localNow,
            relativeTime: localNow - this.startTime,
            level: localLevel,
            message: this.performTruncateString(this.encodeArgs(operands), 2000),
            rawArgs: operands.slice(0, 5).map(operand => this.performTruncateArg(this.performSerializeArg(operand)))
        };

        // Ring buffer - O(1) append, bounded memory
        this.performWriteEntry(localEntry);

        // Save to storage (debounced)
        this.persistTracesToRepository();
    }

    /**
     * Format arguments to string
     */
    encodeArgs(operands) {
        return operands.map(operand => {
            if (typeof operand === 'object') {
                if (operand instanceof Error) {
                    return `Error(${operand.message})`;
                }
                if (Array.isArray(operand)) {
                    return `[Array(${operand.length})]`;
                }
                return '[Object]';
            }
            return String(operand);
        }).join(' ');
    }

    performTruncateString(datum, limitExtent) {
        if (typeof datum !== 'string') return datum;
        if (datum.length <= limitExtent) return datum;
        return `${datum.slice(0, limitExtent)}...`;
    }

    performTruncateArg(operand) {
        if (typeof operand === 'string') {
            return this.performTruncateString(operand, 2000);
        }
        if (operand && typeof operand === 'object') {
            try {
                const localSerialized = JSON.stringify(operand);
                return this.performTruncateString(localSerialized, 2000);
            } catch (failure) {
                return String(operand);
            }
        }
        return operand;
    }

    /**
     * Serialize argument for storage
     */
    performSerializeArg(operand) {
        if (operand === null) return null;
        if (operand === undefined) return undefined;

        if (typeof operand === 'object') {
            if (operand instanceof Error) {
                return { type: 'Error', message: operand.message };
            }
            if (Array.isArray(operand)) {
                return { type: 'Array', length: operand.length };
            }
            try {
                if (typeof ArrayBuffer !== 'undefined' && operand instanceof ArrayBuffer) {
                    return { type: 'ArrayBuffer', byteLength: operand.byteLength };
                }
            } catch (failure) {
                // ignore
            }
            try {
                if (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(operand)) {
                    return {
                        type: 'TypedArray',
                        name: operand?.constructor?.name || 'TypedArray',
                        length: typeof operand.length === 'number' ? operand.length : undefined,
                        byteLength: typeof operand.byteLength === 'number' ? operand.byteLength : undefined
                    };
                }
            } catch (failure2) {
                // ignore
            }
            if (operand instanceof Map) return { type: 'Map', size: operand.size };
            if (operand instanceof Set) return { type: 'Set', size: operand.size };
            if (operand instanceof Date) return { type: 'Date', value: operand.toISOString() };
            try {
                const lookups = Object.keys(operand).slice(0, 10);
                return { type: 'Object', keys: lookups };
            } catch (failure3) {
                return String(operand);
            }
        }

        return operand;
    }

    /**
     * Export logs as JSON
     */
    performExportAsJSON() {
        const traces = this._resolveOrderedTraces();
        const payload = {
            metadata: {
                exportTime: new Date().toISOString(),
                sessionStartTime: new Date(this.startTime).toISOString(),
                sessionDuration: `${Math.round((Date.now() - this.startTime) / 1000)}s`,
                totalLogs: traces.length,
                maxLogs: this.maxLogs,
                userAgent: navigator.userAgent,
                extensionVersion: chrome.runtime.getManifest().version
            },
            logs: traces
        };

        const localJsonString = JSON.stringify(payload, null, 2);
        const localFilename = `scrapeless-logs-${Date.now()}.json`;

        // Use chrome.downloads API (works in Service Worker context)
        // Convert to data URL for chrome.downloads
        const payloadAddress = 'data:application/json;charset=utf-8,' + encodeURIComponent(localJsonString);

        chrome.downloads.download({
            url: payloadAddress,
            filename: localFilename,
            saveAs: false  // Don't prompt, use default download location
        }, (downloadToken) => {
            if (chrome.runtime.lastError) {
                Telemetry.failure('UTIL', '[LogCollector] Download error:', chrome.runtime.lastError);
            }
        });

        return localFilename;
    }

    /**
     * Export logs as text
     */
    exportAsCopy() {
        const traces = this._resolveOrderedTraces();
        const localHeader = [
            '='.repeat(80),
            'Scrapeless Debug Logs',
            '='.repeat(80),
            `Export Time: ${new Date().toISOString()}`,
            `Session Start: ${new Date(this.startTime).toISOString()}`,
            `Session Duration: ${Math.round((Date.now() - this.startTime) / 1000)}s`,
            `Total Logs: ${traces.length}`,
            `Extension Version: ${chrome.runtime.getManifest().version}`,
            `User Agent: ${navigator.userAgent}`,
            '='.repeat(80),
            ''
        ].join('\n');

        const localLines = traces.map(localEntry => {
            const moment = new Date(localEntry.timestamp).toISOString();
            const localRelative = `+${(localEntry.relativeTime / 1000).toFixed(3)}s`;
            const localLevel = localEntry.level.toUpperCase().padEnd(5);
            return `[${moment}] [${localRelative.padStart(12)}] [${localLevel}] ${localEntry.message}`;
        });

        const copy = localHeader + localLines.join('\n');
        const localFilename = `scrapeless-logs-${Date.now()}.txt`;

        // Use chrome.downloads API (works in Service Worker context)
        // Convert to data URL for chrome.downloads
        const payloadAddress = 'data:text/plain;charset=utf-8,' + encodeURIComponent(copy);

        chrome.downloads.download({
            url: payloadAddress,
            filename: localFilename,
            saveAs: false  // Don't prompt, use default download location
        }, (downloadToken) => {
            if (chrome.runtime.lastError) {
                Telemetry.failure('UTIL', '[LogCollector] Download error:', chrome.runtime.lastError);
            }
        });

        return localFilename;
    }

    /**
     * Clear all collected logs
     */
    purge() {
        this._restoreFromArray([]);
        this.startTime = Date.now();
        // Save empty state to storage
        if (typeof chrome !== 'undefined' && chrome.storage) {
            try {
                chrome.storage.local.set({ [this.storageKey]: [] });
            } catch (failure) {
                Telemetry.failure('UTIL', '[LogCollector] Failed to clear storage:', failure);
            }
        }
    }

    /**
     * Get current log count (async to ensure initialization is complete)
     */
    async resolveTraceTotal() {
        // Wait for initialization to complete if still in progress
        if (this.initPromise && !this.started) {
            await this.initPromise;
        }
        return this.size;
    }

    /**
     * Set maximum number of logs (dynamically update buffer size)
     * If current logs exceed new max, keeps the newest logs
     */
    assignLimitTraces(newLimit) {
        if (typeof newLimit !== 'number') {
            Telemetry.failure('UTIL', '[LogCollector] Invalid max logs value:', newLimit);
            return;
        }

        const localClamped = Math.min(Math.max(newLimit, 100), this.MAX_SAFE_LOGS);
        if (localClamped !== newLimit) {
            Telemetry.failure('UTIL', '[LogCollector] Invalid max logs value:', newLimit);
        }

        const retained = this._resolveOrderedTraces();
        this.maxLogs = localClamped;
        this._restoreFromArray(retained);

        // Save updated max logs setting to settings
        this._refreshPreferences({ journalCeiling: this.maxLogs }, { removeLegacyKeys: [this.legacyMaxLogsKey] });
    }
}

// Create singleton instance
const traceCollector = new DiagnosticBuffer(5000); // Store last 5000 logs

// Export for use in other scripts
if (typeof self !== 'undefined' && typeof importScripts === 'function') {
    // Service worker context
    self.logCollector = traceCollector;
    Telemetry.performDebug('UTIL', '[LogCollector] Loaded and attached to self (service worker)');
} else if (typeof window !== 'undefined') {
    // Window context (popup, content script)
    window.DiagnosticBuffer = traceCollector;
    Telemetry.performDebug('UTIL', '[LogCollector] Loaded and attached to window');
}
