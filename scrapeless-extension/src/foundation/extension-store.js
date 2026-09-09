/**
 * StorageManager - Shared storage utilities for Chrome extension
 * Provides consistent patterns for loading, saving, and migrating storage data
 *
 * Used by: DetectorManager, CategoryManager, and other managers
 */
class ExtensionStore {
    /**
     * The shape every record is written in.
     *
     * Upstream wrote four different envelopes — { timestamp, settings },
     * { items }, { detectors, totalCount }, { categories, totalCategories } —
     * and none carried a version, so a reader could not tell an old record
     * from a new one without inspecting which keys happened to be present.
     * One sealed shape replaces all four:
     *
     *     { v, savedAt, <body>, total? }
     *
     * `v` is the point of it: the next shape change reads that instead of
     * guessing.
     */
    static get RECORD_VERSION() {
        return 1;
    }

    /**
     * @param {string} bodyLookup - Name the body is filed under (prefs, entries, rules, taxa).
     * @param {any} body - The record itself.
     * @param {Object} extra - Any further envelope fields, e.g. a total.
     */
    static sealRecord(bodyLookup, body, extra = {}) {
        return {
            v: ExtensionStore.RECORD_VERSION,
            savedAt: new Date().toISOString(),
            [bodyLookup]: body,
            ...extra
        };
    }

    /**
     * Read a sealed record's body, accepting the retired envelope so a read
     * that races the migration still returns something usable.
     */
    static openRecord(record, bodyLookup, retiredLookup) {
        if (!record || typeof record !== 'object') return null;
        if (record[bodyLookup] !== undefined) return record[bodyLookup];
        if (retiredLookup && record[retiredLookup] !== undefined) return record[retiredLookup];
        return null;
    }

    /**
     * Parse a stored value that may be a JSON string or an object.
     * Centralizes parsing logic to avoid duplicated try/catch blocks.
     * @param {any} rawData - Raw value from chrome.storage
     * @param {string|null} key - Optional storage key for logging context
     * @param {boolean} quiet - Suppress the parse-failure log. Set by the
     *   migration sweeps, which walk every `scrapeless_*` key and legitimately
     *   meet scalar preferences — `scrapeless_language_override` holds `'en'`.
     *   A non-record is an expected miss there, not corrupt storage.
     * @returns {Object|null} Parsed object or null on failure
     */
    static parseStoredDatum(unprocessedPayload, lookupKey = null, quiet = false) {
        if (unprocessedPayload === null || unprocessedPayload === undefined) {
            return null;
        }

        if (typeof unprocessedPayload === 'string') {
            try {
                return JSON.parse(unprocessedPayload);
            } catch (failure) {
                if (!quiet) {
                    const lookupLabel = lookupKey ? ` (${lookupKey})` : '';
                    Telemetry.failure('STORAGE', `Failed to parse stored JSON${lookupLabel}`, failure);
                }
                return null;
            }
        }

        if (typeof unprocessedPayload === 'object') {
            return unprocessedPayload;
        }

        return null;
    }

    /**
     * Normalize a storage value to object format if it was stored as JSON string.
     * @param {string} key - Storage key
     * @param {any} rawData - Raw value from chrome.storage
     * @returns {Promise<Object|null>} Parsed object or null
     */
    static async canonicalizeStoredDatum(lookupKey, unprocessedPayload) {
        const decoded = ExtensionStore.parseStoredDatum(unprocessedPayload, lookupKey);
        if (decoded && typeof unprocessedPayload === 'string') {
            try {
                await chrome.storage.local.set({ [lookupKey]: decoded });
            } catch (failure) {
                Telemetry.failure('STORAGE', `Failed to normalize storage value (${lookupKey})`, failure);
            }
        }
        return decoded;
    }

    /**
     * Normalize the Scrapeless settings container to the actual settings object.
     * Supports current raw settings, legacy JSON strings, and old { settings } wrappers.
     * @param {any} rawData - Raw scrapeless_settings value
     * @returns {Object} Settings object
     */
    static canonicalizePreferences(unprocessedPayload) {
        const decoded = ExtensionStore.parseStoredDatum(unprocessedPayload, 'scrapeless_settings');
        if (!decoded || typeof decoded !== 'object') {
            return {};
        }

        const sealed = ExtensionStore.openRecord(decoded, 'prefs', 'settings');
        if (sealed && typeof sealed === 'object') {
            return sealed;
        }

        return decoded;
    }

    /**
     * Load normalized extension settings.
     * @returns {Promise<Object>} Settings object
     */
    static async resolvePreferences() {
        try {
            const outcome = await chrome.storage.local.get(['scrapeless_settings']) || {};
            return ExtensionStore.canonicalizePreferences(outcome.scrapeless_settings);
        } catch (failure) {
            Telemetry.failure('STORAGE', 'Failed to load settings', failure);
            return {};
        }
    }

    /**
     * Save normalized extension settings in the canonical JSON-string wrapper format.
     * @param {Object} settings - Settings object
     * @returns {Promise<boolean>} Success status
     */
    static async persistPreferences(preferencePane) {
        try {
            await chrome.storage.local.set({
                scrapeless_settings: JSON.stringify(
                    ExtensionStore.sealRecord('prefs', preferencePane || {}), null, 2)
            });
            return true;
        } catch (failure) {
            Telemetry.failure('STORAGE', 'Failed to save settings', failure);
            return false;
        }
    }

    /**
     * Load data from Chrome storage with backward compatibility support
     * Automatically handles:
     * - Legacy key migration (old key → new key)
     * - JSON parsing
     * - Error handling
     *
     * @param {string} primaryKey - Primary storage key to try first
     * @param {string} legacyKey - Optional legacy key for backward compatibility
     * @param {string} dataProperty - Optional property to extract from parsed data (e.g., 'categories', 'detectors')
     * @returns {Promise<Object|null>} Parsed data object or null if not found
     *
     * @example
     * // Load categories with backward compatibility
     * const data = await StorageManager.loadFromStorage('scrapeless_categories', 'scrapeless_categories.json', 'categories');
     */
    static async readFromRepository(primaryLookup, legacyLookup = null, payloadSignal = null) {
        try {
            const lookupsToRead = [primaryLookup];
            if (legacyLookup) {
                lookupsToRead.push(legacyLookup);
            }

            const outcome = await chrome.storage.local.get(lookupsToRead) || {};

            let unprocessedPayload = null;
            let localNeedsMigration = false;

            // Try primary key first
            if (outcome[primaryLookup]) {
                unprocessedPayload = outcome[primaryLookup];
            }
            // Fallback to legacy key
            else if (legacyLookup && outcome[legacyLookup]) {
                unprocessedPayload = outcome[legacyLookup];
                localNeedsMigration = true;
            }

            // No data found
            if (!unprocessedPayload) {
                return null;
            }

            // Parse JSON if it's a string
            const decodedPayload = ExtensionStore.parseStoredDatum(unprocessedPayload, primaryLookup);
            if (!decodedPayload) {
                return null;
            }

            // Normalize storage to object format + perform legacy key migration if needed
            const shouldCanonicalize = typeof unprocessedPayload === 'string';
            if (localNeedsMigration || shouldCanonicalize) {
                Telemetry.repository('Migrating storage key', { from: legacyLookup, to: primaryLookup, normalize: shouldCanonicalize });
                await chrome.storage.local.set({ [primaryLookup]: decodedPayload });
                if (localNeedsMigration && legacyLookup) {
                    await chrome.storage.local.remove([legacyLookup]);
                }
            }

            // Extract specific property if requested
            if (payloadSignal && decodedPayload[payloadSignal] !== undefined) {
                return decodedPayload[payloadSignal];
            }

            return decodedPayload;

        } catch (failure) {
            Telemetry.failure('STORAGE', `Failed to load from storage (${primaryLookup})`, failure);
            return null;
        }
    }

    /**
     * Batch load multiple storage keys in a single Chrome storage call
     * Faster than sequential loads by using a single Chrome storage call
     *
     * @param {Array<Object>} keyConfigs - Array of key configurations
     * @param {string} keyConfigs[].primary - Primary storage key
     * @param {string} keyConfigs[].legacy - Optional legacy key for backward compatibility
     * @param {string} keyConfigs[].dataProperty - Optional property to extract from parsed data
     * @returns {Promise<Object>} Object with loaded data keyed by primary key name
     *
     * @example
     * // Load categories and detectors in one call
     * const data = await StorageManager.batchLoadStorage([
     *   { primary: 'scrapeless_categories', legacy: 'scrapeless_categories.json', dataProperty: 'categories' },
     *   { primary: 'scrapeless_detectors', legacy: 'scrapeless_detectors.json', dataProperty: 'detectors' }
     * ]);
     * // Returns: { scrapeless_categories: {...}, scrapeless_detectors: {...} }
     */
    static async batchReadRepository(lookupConfigs) {
        try {
            // Collect all keys to load (primary + legacy)
            const allLookups = [];
            const lookupIndex = {}; // Maps legacy keys back to their primary keys

            for (const profile of lookupConfigs) {
                allLookups.push(profile.primary);
                lookupIndex[profile.primary] = profile;

                if (profile.legacy) {
                    allLookups.push(profile.legacy);
                    lookupIndex[profile.legacy] = profile;
                }
            }

            // Single Chrome storage call for all keys
            const outcome = await chrome.storage.local.get(allLookups) || {};

            // Process each key config
            const readyPayload = {};
            const localMigrationsNeeded = [];

            for (const profile2 of lookupConfigs) {
                let unprocessedPayload = null;
                let localNeedsMigration = false;

                // Try primary key first
                if (outcome[profile2.primary]) {
                    unprocessedPayload = outcome[profile2.primary];
                }
                // Fallback to legacy key
                else if (profile2.legacy && outcome[profile2.legacy]) {
                    unprocessedPayload = outcome[profile2.legacy];
                    localNeedsMigration = true;
                }

                if (unprocessedPayload) {
                    // Parse JSON if it's a string (centralized)
                    const decodedPayload = ExtensionStore.parseStoredDatum(unprocessedPayload, profile2.primary);
                    if (!decodedPayload) {
                        readyPayload[profile2.primary] = null;
                        continue;
                    }

                    // Extract specific property if requested
                    if (profile2.dataProperty && decodedPayload[profile2.dataProperty] !== undefined) {
                        readyPayload[profile2.primary] = decodedPayload[profile2.dataProperty];
                    } else {
                        readyPayload[profile2.primary] = decodedPayload;
                    }

                    // Track migrations needed
                    if (localNeedsMigration || typeof unprocessedPayload === 'string') {
                        localMigrationsNeeded.push({
                            from: profile2.legacy,
                            to: profile2.primary,
                            data: decodedPayload,
                            normalize: typeof unprocessedPayload === 'string'
                        });
                    }
                } else {
                    readyPayload[profile2.primary] = null;
                }
            }

            // Perform all migrations in one batch operation
            if (localMigrationsNeeded.length > 0) {
                const localUpdates = {};
                const localRemovals = [];

                for (const localMigration of localMigrationsNeeded) {
                    Telemetry.repository('Migrating storage key', { from: localMigration.from, to: localMigration.to, normalize: localMigration.normalize });
                    localUpdates[localMigration.to] = localMigration.data;
                    if (localMigration.from) {
                        localRemovals.push(localMigration.from);
                    }
                }

                await chrome.storage.local.set(localUpdates);
                await chrome.storage.local.remove(localRemovals);
            }

            Telemetry.repository('Batch loaded storage keys', { count: lookupConfigs.length });
            return readyPayload;

        } catch (failure) {
            Telemetry.failure('STORAGE', 'Failed to batch load from storage', failure);
            return {};
        }
    }

    /**
     * Save data to Chrome storage with automatic timestamping and formatting
     * Wraps data with metadata (timestamp, count) for better tracking
     *
     * @param {string} key - Storage key to save under
     * @param {Object} data - Data to save
     * @param {Object} options - Save options
     * @param {boolean} options.wrapMetadata - Whether to wrap data with timestamp/count (default: true)
     * @param {string} options.countProperty - Property name for count metadata (default: null)
     * @param {number} options.jsonIndent - JSON.stringify indentation (default: 2)
     * @param {boolean} options.stringify - Whether to store as JSON string (default: false)
     * @returns {Promise<boolean>} Success status
     *
     * @example
     * // Save with metadata wrapper
     * await StorageManager.saveToStorage('scrapeless_categories', categoriesData, {
     *   countProperty: 'totalCategories'
     * });
     * // Saves: { timestamp: "2025-01-08...", categories: {...}, totalCategories: 5 }
     *
     * @example
     * // Save raw data without wrapper
     * await StorageManager.saveToStorage('scrapeless_settings', settingsData, { wrapMetadata: false });
     */
    static async persistToRepository(lookupKey, payload, choices = {}) {
        try {
            const {
                wrapMetadata: localWrapMetadata = true,
                countProperty: totalSignal = null,
                jsonIndent: localJsonIndent = 2,
                stringify: localStringify = false
            } = choices;

            let payloadToPersist = payload;

            // Wrap with metadata if requested
            if (localWrapMetadata) {
                const localWrapper = {
                    v: ExtensionStore.RECORD_VERSION,
                    savedAt: new Date().toISOString(),
                    ...payload
                };

                // Add count metadata if property name provided
                if (totalSignal && typeof payload === 'object') {
                    const total = Object.keys(payload).length;
                    localWrapper[totalSignal] = total;
                }

                payloadToPersist = localWrapper;
            }

            // Store as object by default; optionally stringify for legacy compatibility
            const datumToPersist = localStringify ? JSON.stringify(payloadToPersist, null, localJsonIndent) : payloadToPersist;

            await chrome.storage.local.set({ [lookupKey]: datumToPersist });

            Telemetry.repository('Saved to storage', { key: lookupKey });
            return true;

        } catch (failure) {
            Telemetry.failure('STORAGE', `Failed to save to storage (${lookupKey})`, failure);
            return false;
        }
    }

    /**
     * Clear one or more keys from Chrome storage
     *
     * @param {string|Array<string>} keys - Storage key(s) to clear
     * @returns {Promise<boolean>} Success status
     *
     * @example
     * await StorageManager.clearStorage('scrapeless_detectors');
     * await StorageManager.clearStorage(['scrapeless_detectors', 'scrapeless_detectors.json']);
     */
    static async purgeRepository(lookups) {
        try {
            const lookupArray = Array.isArray(lookups) ? lookups : [lookups];
            await chrome.storage.local.remove(lookupArray);
            Telemetry.repository('Cleared storage keys', { keys: lookupArray });
            return true;
        } catch (failure) {
            Telemetry.failure('STORAGE', 'Failed to clear storage', failure);
            return false;
        }
    }

    /**
     * Field names inherited verbatim from the upstream project, mapped onto
     * this project's own vocabulary. Every root is a distinct identifier, so a
     * key can be matched by name alone at any depth — which is what lets one
     * recursive pass cover the settings object, the archived scans that carry
     * a memo scope, and anything nested inside either.
     */
    static get RETIRED_FIELD_NAMES() {
        return {
            notificationsEnabled: 'alertsActive',
            debugMode: 'diagnosticMode',
            logCollectorEnabled: 'journalActive',
            logCollectorMaxLogs: 'journalCeiling',
            badgeColors: 'badgePalette',
            categoryColors: 'taxonomyPalette',
            tagColors: 'methodPalette',
            duplicatePrevention: 'repeatGuard',
            jsApi: 'pageSignals',
            cacheDuration: 'memoDuration',
            cacheUnit: 'memoUnit',
            cacheScope: 'memoScope',
            blacklistedDomains: 'skippedDomains',
            hooksConfig: 'probeConfig',
            enableJsApi: 'pageSignalsActive',
            enableWebhook: 'relayActive',
            webhookOnCache: 'relayOnMemoHit',
            webhookMethod: 'relayMethod',
            webhookUrl: 'relayEndpoint',
            webhookContentType: 'relayContentType',
            webhookPayload: 'relayTemplate',
            webhookHeaders: 'relayHeaders',
            historyLimit: 'archiveCeiling',
            autoClearDays: 'archivePruneDays',
            exportFormat: 'exportEncoding',
            includeTimestamps: 'includeMoments',
            historyBypassCache: 'archiveOnMemoHit',
            preventDuplicates: 'repeatGuardActive',
            duplicateScope: 'repeatScope',
            duplicateDuration: 'repeatDuration',
            duplicateUnit: 'repeatUnit',
            autoUpdate: 'autoSync',
            checkIntervalHours: 'syncIntervalHours',
            lastCheckTimestamp: 'lastSyncMoment',
            // The four settings groups. Safe to match by name here because
            // this walker only ever sees records read out of storage, never
            // a detector rule (which carries its own 'detection' block).
            detection: 'scanning',
            history: 'archive',
            webhook: 'relay',
            updates: 'catalogSync',
            // The hit list on an archived scan.
            matches: 'signals'
        };
    }

    /**
     * Rewrite a decoded record's field names onto the current vocabulary.
     *
     * Returns a new value rather than mutating, and reports whether anything
     * actually moved so a caller can skip the write when there is nothing to
     * do. A field already present under its current name wins: the retired
     * copy is dropped instead of overwriting it.
     *
     * @param {any} datum - Decoded record (object, array, or scalar).
     * @returns {{ datum: any, changed: boolean }}
     */
    static renameRetiredFields(datum) {
        const names = ExtensionStore.RETIRED_FIELD_NAMES;
        let changed = false;

        const walk = (value) => {
            if (Array.isArray(value)) {
                return value.map(walk);
            }
            if (!value || typeof value !== 'object') {
                return value;
            }
            const rebuilt = {};
            for (const [fieldName, fieldValue] of Object.entries(value)) {
                const currentName = names[fieldName];
                if (currentName) {
                    changed = true;
                    if (!Object.prototype.hasOwnProperty.call(value, currentName)) {
                        rebuilt[currentName] = walk(fieldValue);
                    }
                    continue;
                }
                rebuilt[fieldName] = walk(fieldValue);
            }
            return rebuilt;
        };

        return { datum: walk(datum), changed };
    }

    /**
     * The envelope each record is filed under, and the name upstream used.
     * A record already carrying a version is left alone.
     */
    static get RECORD_ENVELOPES() {
        return {
            scrapeless_settings:   { body: 'prefs',   retired: 'settings' },
            scrapeless_history:    { body: 'entries', retired: 'items' },
            scrapeless_detectors:  { body: 'rules',   retired: 'detectors',  total: ['total', 'totalCount'] },
            scrapeless_categories: { body: 'taxa',    retired: 'categories', total: ['total', 'totalCategories'] }
        };
    }

    /**
     * Bring stored records onto the current field names and envelope.
     *
     * Split out from the namespace sweep because it has to run on its own
     * too: an install that already moved namespace in an earlier release
     * still holds records under the old field names and the old envelope,
     * and nothing else would ever rewrite them.
     *
     * @param {Object} everything - The whole local area, already read.
     * @returns {Promise<number>} How many records were rewritten.
     */
    static async migrateStoredShapes(everything) {
        const envelopes = ExtensionStore.RECORD_ENVELOPES;
        const rewritten = {};

        for (const [lookup, record] of Object.entries(everything)) {
            if (!lookup.startsWith('scrapeless_')) continue;

            const decoded = ExtensionStore.parseStoredDatum(record, lookup, true);
            if (!decoded || typeof decoded !== 'object') continue;

            const fields = ExtensionStore.renameRetiredFields(decoded);
            let datum = fields.datum;
            let moved = fields.changed;

            const envelope = envelopes[lookup];
            if (envelope && datum && typeof datum === 'object' && !Array.isArray(datum)) {
                if (datum.v === undefined) {
                    const body = ExtensionStore.openRecord(datum, envelope.body, envelope.retired);
                    if (body !== null) {
                        const extra = {};
                        for (const totalLookup of (envelope.total || [])) {
                            if (datum[totalLookup] !== undefined) {
                                extra.total = datum[totalLookup];
                                break;
                            }
                        }
                        datum = ExtensionStore.sealRecord(envelope.body, body, extra);
                        // The record's own age is what matters, not this sweep's.
                        if (typeof decoded.timestamp === 'string') datum.savedAt = decoded.timestamp;
                        if (typeof decoded.savedAt === 'string') datum.savedAt = decoded.savedAt;
                        moved = true;
                    }
                }
            }

            if (moved) {
                rewritten[lookup] = (typeof record === 'string')
                    ? JSON.stringify(datum, null, 2)
                    : datum;
            }
        }

        const total = Object.keys(rewritten).length;
        if (total > 0) {
            await chrome.storage.local.set(rewritten);
            Telemetry.repository('Migrated stored record shapes', { records: total });
        }
        return total;
    }

    /**
     * Bring stored records onto the current shape.
     *
     * Field and envelope names were renamed after the first releases, so a
     * record written by an older build parses as empty until it is rewritten.
     * Reads the whole local area once rather than naming keys, because cached
     * scans are keyed dynamically and cannot be enumerated ahead of time.
     *
     * @returns {Promise<number>} How many records were rewritten.
     */
    static async migrateStoredRecords() {
        try {
            const everything = await chrome.storage.local.get(null) || {};
            return await ExtensionStore.migrateStoredShapes(everything);
        } catch (failure) {
            Telemetry.failure('STORAGE', 'Failed to migrate stored records', failure);
            return 0;
        }
    }
}

// Expose globally for extension runtime compatibility across popup/content/background contexts.
if (typeof globalThis !== 'undefined') {
    globalThis.ExtensionStore = ExtensionStore;
}
if (typeof window !== 'undefined') {
    window.ExtensionStore = ExtensionStore;
}
if (typeof self !== 'undefined') {
    self.ExtensionStore = ExtensionStore;
}
