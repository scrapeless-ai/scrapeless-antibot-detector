/**
 * UpdateManager - Handles auto-updating detector definitions from remote server
 *
 * Fetches detector JSONs from GitHub and merges with local storage.
 * Compliant with Chrome Web Store policies (JSON = data, not code).
 */
class CatalogUpdater {
    // Remote repository URL for detector files
    // Detectors live under scrapeless-extension/ since the repository was split
    // into the extension and the SDKs. raw.githubusercontent.com serves public
    // repositories only, so this resolves once the repository is public.
    static UPSTREAM_BASE_ADDRESS = 'https://raw.githubusercontent.com/scrapeless-ai/scrapeless-antibot-detector/main/scrapeless-extension/detectors';

    // Fetch timeout in milliseconds
    static FETCH_DEADLINE = RuntimePolicy.UPDATE_FETCH_TIMEOUT;

    // Storage keys
    static REPOSITORY_LOOKUPS = {
        PENDING_UPDATES: 'scrapeless_pending_updates',
        LAST_CHECK: 'scrapeless_last_update_check',
        UPDATE_ERRORS: 'scrapeless_update_errors',
        INCOMPATIBLE_UPDATES: 'scrapeless_incompatible_updates'
    };

    /**
     * Get extension version from manifest
     * @returns {string} Extension version string (e.g., "2.5.1")
     */
    static resolveExtensionVersion() {
        return chrome.runtime.getManifest().version;
    }

    /**
     * Check if a detector is compatible with the current extension version
     * @param {Object} detector - Detector object with optional minExtensionVersion
     * @returns {boolean} True if compatible (minExtensionVersion <= currentVersion)
     */
    static performIsCompatibleWithExtension(rule) {
        const floorRequired = rule.minExtensionVersion || '1.0';
        const active = this.resolveExtensionVersion();
        // Compatible if minRequired is NOT newer than current
        // (i.e., current >= minRequired)
        return !this.performIsNewerVersion(floorRequired, active);
    }

    /**
     * Get incompatible updates from storage
     * @returns {Promise<Array>} List of incompatible detector updates
     */
    static async resolveIncompatibleUpdates() {
        try {
            const outcome = await chrome.storage.local.get(this.REPOSITORY_LOOKUPS.INCOMPATIBLE_UPDATES);
            return outcome[this.REPOSITORY_LOOKUPS.INCOMPATIBLE_UPDATES] || [];
        } catch (failure) {
            Telemetry.performWarn('STORAGE', '[UpdateManager] Failed to read incompatible updates:', failure);
            return [];
        }
    }

    /**
     * Get incompatible updates count
     * @returns {Promise<number>}
     */
    static async resolveIncompatibleUpdatesTotal() {
        try {
            const localUpdates = await this.resolveIncompatibleUpdates();
            return localUpdates.length;
        } catch (failure) {
            Telemetry.performWarn('STORAGE', '[UpdateManager] Failed to count incompatible updates:', failure);
            return 0;
        }
    }

    /**
     * Check for detector updates from remote server
     * @param {boolean} force - Force check regardless of interval
     * @returns {Promise<{available: boolean, updates: Array, incompatibleCount: number, error: string|null}>}
     */
    static async performCheckForUpdates(localForce = false) {
        try {
            Telemetry.repository('UpdateManager: Checking for updates...');

            // Check if auto-update is enabled (unless forced)
            if (!localForce) {
                const preferencePane = await ExtensionGateway.resolvePreferences();
                if (!preferencePane.catalogSync?.autoSync) {
                    Telemetry.repository('UpdateManager: Auto-update disabled, skipping');
                    return { available: false, updates: [], incompatibleCount: 0, error: null };
                }

                // Check interval
                const localLastCheck = preferencePane.catalogSync?.lastSyncMoment || 0;
                const cadenceMs = (preferencePane.catalogSync?.syncIntervalHours || RuntimePolicy.DEFAULT_CACHE_EXPIRY_HOURS) * 3600000;
                const localNow = Date.now();

                if (localNow - localLastCheck < cadenceMs) {
                    Telemetry.repository('UpdateManager: Too soon to check again');
                    return { available: false, updates: [], incompatibleCount: 0, error: null };
                }
            }

            // Fetch remote index
            const upstreamPosition = await this.fetchUpstreamPosition();
            if (!upstreamPosition) {
                // Clear any stale pending updates since we can't reach the server
                await chrome.storage.local.remove(this.REPOSITORY_LOOKUPS.PENDING_UPDATES);
                Telemetry.repository('UpdateManager: Cleared pending updates due to fetch failure');
                return { available: false, updates: [], incompatibleCount: 0, error: 'Failed to fetch remote index' };
            }

            // Compare with local detectors (returns { updates, incompatibleUpdates })
            // Add 30-second timeout to prevent hanging on slow networks
            const localComparePromise = this.performCompareVersions(upstreamPosition);
            const deadlinePromise = new Promise((local, localReject) =>
                setTimeout(() => localReject(new Error('Update check timed out')), RuntimePolicy.UPDATE_CHECK_TIMEOUT)
            );
            const { updates: localUpdates, incompatibleUpdates: localIncompatibleUpdates } = await Promise.race([localComparePromise, deadlinePromise]);

            // Update last check timestamp
            await this.refreshLastCheckTimestamp();

            // Store pending updates for later application (only compatible ones)
            if (localUpdates.length > 0) {
                await chrome.storage.local.set({
                    [this.REPOSITORY_LOOKUPS.PENDING_UPDATES]: localUpdates
                });
            }

            Telemetry.repository(`UpdateManager: Found ${localUpdates.length} compatible updates, ${localIncompatibleUpdates.length} incompatible`);
            return {
                available: localUpdates.length > 0,
                updates: localUpdates,
                incompatibleCount: localIncompatibleUpdates.length,
                error: null
            };

        } catch (failure) {
            Telemetry.failure('STORAGE', 'UpdateManager: Error checking for updates', failure);
            return { available: false, updates: [], incompatibleCount: 0, error: failure.message };
        }
    }

    /**
     * Fetch remote index.json from GitHub
     * @returns {Promise<Object|null>}
     */
    static async fetchUpstreamPosition() {
        try {
            const localController = new AbortController();
            const deadlineToken = setTimeout(() => localController.abort(), this.FETCH_DEADLINE);

            const reply = await fetch(`${this.UPSTREAM_BASE_ADDRESS}/index.json`, {
                signal: localController.signal,
                cache: 'no-store'
            });

            clearTimeout(deadlineToken);

            if (!reply.ok) {
                throw new Error(`HTTP ${reply.status}: ${reply.statusText}`);
            }

            const payload = await reply.json();
            Telemetry.repository('UpdateManager: Fetched remote index successfully');
            return payload;

        } catch (failure) {
            if (failure.name === 'AbortError') {
                Telemetry.failure('STORAGE', 'UpdateManager: Fetch timeout');
            } else {
                Telemetry.failure('STORAGE', 'UpdateManager: Failed to fetch remote index', failure);
            }
            return null;
        }
    }

    /**
     * Compare local detector versions with remote
     * @param {Object} remoteIndex - Remote index.json content
     * @returns {Promise<{updates: Array, incompatibleUpdates: Array}>} Compatible and incompatible updates
     */
    static async performCompareVersions(upstreamPosition) {
        const localUpdates = [];
        const localIncompatibleUpdates = [];

        try {
            // Get local detectors from storage
            // Storage format (stringified JSON): { detectors: { antibot: {...}, captcha: {...} }, totalCount: N }
            const outcome = await chrome.storage.local.get('scrapeless_detectors');
            const repositoryPayload = await ExtensionStore.canonicalizeStoredDatum('scrapeless_detectors', outcome.scrapeless_detectors) || {};
            const deviceCatalog = repositoryPayload.detectors || {};

            // Collect all detector fetch promises for parallel execution
            const localFetchPromises = [];

            // Iterate through remote categories to build fetch list
            for (const [taxonomy, taxonomyPayload] of Object.entries(upstreamPosition)) {
                // Skip non-detector entries
                if (!taxonomyPayload.detectors || !Array.isArray(taxonomyPayload.detectors)) {
                    continue;
                }

                for (const ruleToken of taxonomyPayload.detectors) {
                    localFetchPromises.push(
                        this.fetchUpstreamRule(taxonomy, ruleToken)
                            .then(upstreamRule => ({ category: taxonomy, detectorId: ruleToken, remoteDetector: upstreamRule }))
                    );
                }
            }

            // Fetch all detectors in parallel (much faster than sequential)
            const fetchOutcomes = await Promise.all(localFetchPromises);

            // Process results
            for (const { category: taxonomy2, detectorId: ruleToken2, remoteDetector: upstreamRule } of fetchOutcomes) {
                if (!upstreamRule) continue;

                const upstreamVersion = upstreamRule.version || '0.0';

                // Get local version
                const deviceRule = deviceCatalog[taxonomy2]?.[ruleToken2];
                const deviceVersion = deviceRule?.version || '0.0';

                // Compare versions
                if (this.performIsNewerVersion(upstreamVersion, deviceVersion)) {
                    const refreshDetail = {
                        id: ruleToken2,
                        category: taxonomy2,
                        name: upstreamRule.name || ruleToken2,
                        localVersion: deviceVersion,
                        remoteVersion: upstreamVersion,
                        minExtensionVersion: upstreamRule.minExtensionVersion || '1.0',
                        isNew: !deviceRule
                    };

                    // Check extension compatibility
                    if (this.performIsCompatibleWithExtension(upstreamRule)) {
                        localUpdates.push(refreshDetail);
                        Telemetry.repository(`UpdateManager: Update available for ${ruleToken2}: ${deviceVersion} -> ${upstreamVersion}`);
                    } else {
                        localIncompatibleUpdates.push(refreshDetail);
                        Telemetry.performWarn('STORAGE', `UpdateManager: ${ruleToken2} v${upstreamVersion} requires extension v${upstreamRule.minExtensionVersion}, current: v${this.resolveExtensionVersion()}`);
                    }
                }
            }

            // Store incompatible updates for UI display
            if (localIncompatibleUpdates.length > 0) {
                await chrome.storage.local.set({
                    [this.REPOSITORY_LOOKUPS.INCOMPATIBLE_UPDATES]: localIncompatibleUpdates
                });
            } else {
                // Clear any stale incompatible updates
                await chrome.storage.local.remove(this.REPOSITORY_LOOKUPS.INCOMPATIBLE_UPDATES);
            }

        } catch (failure) {
            Telemetry.failure('STORAGE', 'UpdateManager: Error comparing versions', failure);
        }

        return { updates: localUpdates, incompatibleUpdates: localIncompatibleUpdates };
    }

    /**
     * Fetch a specific detector JSON from remote
     * @param {string} category - Detector category (antibot, captcha, fingerprint)
     * @param {string} detectorId - Detector ID (e.g., detect-akamai)
     * @returns {Promise<Object|null>}
     */
    static async fetchUpstreamRule(taxonomy, ruleToken) {
        try {
            const localController = new AbortController();
            const deadlineToken = setTimeout(() => localController.abort(), this.FETCH_DEADLINE);

            const address = `${this.UPSTREAM_BASE_ADDRESS}/${taxonomy}/${ruleToken}.json`;
            const reply = await fetch(address, {
                signal: localController.signal,
                cache: 'no-store'
            });

            clearTimeout(deadlineToken);

            if (!reply.ok) {
                throw new Error(`HTTP ${reply.status}`);
            }

            return await reply.json();

        } catch (failure) {
            Telemetry.performDebug('STORAGE', `UpdateManager: Could not fetch ${ruleToken}`, failure.message);
            return null;
        }
    }

    /**
     * Apply pending updates - download and merge detectors
     * @returns {Promise<{success: boolean, count: number, error: string|null}>}
     */
    static async performApplyUpdates() {
        try {
            Telemetry.repository('UpdateManager: Applying pending updates...');

            // Get pending updates
            const outcome = await chrome.storage.local.get(this.REPOSITORY_LOOKUPS.PENDING_UPDATES);
            const queuedUpdates = outcome[this.REPOSITORY_LOOKUPS.PENDING_UPDATES] || [];

            if (queuedUpdates.length === 0) {
                return { success: true, count: 0, error: null };
            }

            // Get current detectors
            // Storage format (stringified JSON): { detectors: { antibot: {...}, captcha: {...} }, totalCount: N }
            const ruleOutcome = await chrome.storage.local.get('scrapeless_detectors');
            const repositoryPayload = await ExtensionStore.canonicalizeStoredDatum('scrapeless_detectors', ruleOutcome.scrapeless_detectors) || {};
            const ruleSet = repositoryPayload.detectors || {};

            let updatedTotal = 0;
            let failedTotal = 0;

            for (const refresh of queuedUpdates) {
                try {
                    // Fetch the full detector data
                    const upstreamRule = await this.fetchUpstreamRule(refresh.category, refresh.id);
                    if (!upstreamRule) {
                        failedTotal++;
                        Telemetry.performWarn('STORAGE', `UpdateManager: Failed to fetch ${refresh.category}/${refresh.id}`);
                        continue;
                    }

                    // Preserve user settings (enabled/disabled state)
                    const deviceRule = ruleSet[refresh.category]?.[refresh.id];
                    if (deviceRule && typeof deviceRule.enabled === 'boolean') {
                        upstreamRule.enabled = deviceRule.enabled;
                    }
                    if (deviceRule && deviceRule.difficulty !== undefined) {
                        upstreamRule.difficulty = deviceRule.difficulty;
                    }

                    // Ensure category exists
                    if (!ruleSet[refresh.category]) {
                        ruleSet[refresh.category] = {};
                    }

                    // Update detector
                    ruleSet[refresh.category][refresh.id] = upstreamRule;
                    updatedTotal++;

                    Telemetry.repository(`UpdateManager: Updated ${refresh.id} to v${refresh.remoteVersion}`);

                } catch (failure) {
                    Telemetry.failure('STORAGE', `UpdateManager: Failed to update ${refresh.id}`, failure);
                }
            }

            // Save updated detectors (preserve storage structure, stringify for consistency)
            // Recalculate totalCount
            let aggregateTotal = 0;
            for (const taxonomy of Object.values(ruleSet)) {
                aggregateTotal += Object.keys(taxonomy).length;
            }

            await ExtensionStore.persistToRepository('scrapeless_detectors', {
                detectors: ruleSet,
                totalCount: aggregateTotal
            }, { wrapMetadata: true });

            // Clear pending updates
            await chrome.storage.local.remove(this.REPOSITORY_LOOKUPS.PENDING_UPDATES);

            Telemetry.repository(`UpdateManager: Applied ${updatedTotal} updates, ${failedTotal} failed`);
            return { success: true, count: updatedTotal, failed: failedTotal, error: null };

        } catch (failure2) {
            Telemetry.failure('STORAGE', 'UpdateManager: Error applying updates', failure2);
            return { success: false, count: 0, error: failure2.message };
        }
    }

    /**
     * Get pending updates count
     * @returns {Promise<number>}
     */
    static async resolveQueuedUpdatesTotal() {
        try {
            const outcome = await chrome.storage.local.get(this.REPOSITORY_LOOKUPS.PENDING_UPDATES);
            const queuedUpdates = outcome[this.REPOSITORY_LOOKUPS.PENDING_UPDATES] || [];
            return queuedUpdates.length;
        } catch (failure) {
            return 0;
        }
    }

    /**
     * Clear pending updates
     * @returns {Promise<void>}
     */
    static async purgeQueuedUpdates() {
        await chrome.storage.local.remove(this.REPOSITORY_LOOKUPS.PENDING_UPDATES);
    }

    /**
     * Update last check timestamp
     * @returns {Promise<void>}
     */
    static async refreshLastCheckTimestamp() {
        try {
            const preferencePane = await ExtensionGateway.resolvePreferences();
            if (!preferencePane.catalogSync) {
                preferencePane.catalogSync = {};
            }
            preferencePane.catalogSync.lastSyncMoment = Date.now();
            await ExtensionStore.persistPreferences(preferencePane);
        } catch (failure) {
            Telemetry.failure('STORAGE', 'UpdateManager: Failed to update timestamp', failure);
        }
    }

    /**
     * Compare version strings (semver-like)
     * @param {string} remote - Remote version (e.g., "1.2.0")
     * @param {string} local - Local version (e.g., "1.1.0")
     * @returns {boolean} True if remote is newer
     */
    static performIsNewerVersion(upstream, device) {
        const localParseVersion = (entryValue) => {
            return String(entryValue).split('.').map(localN => parseInt(localN, 10) || 0);
        };

        const upstreamParts = localParseVersion(upstream);
        const deviceParts = localParseVersion(device);

        // Pad arrays to same length
        const limitLen = Math.max(upstreamParts.length, deviceParts.length);
        while (upstreamParts.length < limitLen) upstreamParts.push(0);
        while (deviceParts.length < limitLen) deviceParts.push(0);

        // Compare each part
        for (let cursor = 0; cursor < limitLen; cursor++) {
            if (upstreamParts[cursor] > deviceParts[cursor]) return true;
            if (upstreamParts[cursor] < deviceParts[cursor]) return false;
        }

        return false; // Equal versions
    }

    // Alarm name for periodic update checks
    static ALARM_LABEL = 'scrapeless-update-check';

    /**
     * Schedule an initial update check + set up periodic alarm
     */
    static async performScheduleCheck() {
        try {
            const preferencePane = await ExtensionGateway.resolvePreferences();
            if (preferencePane.catalogSync?.autoSync) {
                Telemetry.performBackground('Auto-update enabled, checking for detector updates...');
                setTimeout(async () => {
                    try {
                        await this.performCheckForUpdates(false);
                        Telemetry.performBackground('Update check completed');
                    } catch (failure) {
                        Telemetry.performWarn('BACKGROUND', 'Failed to check for updates:', failure);
                    }
                }, RuntimePolicy.UPDATE_CHECK_DELAY);

                this.wireAlarm(preferencePane.catalogSync.syncIntervalHours || 12);
            } else {
                Telemetry.performBackground('Auto-update disabled, skipping update check');
                chrome.alarms.clear(this.ALARM_LABEL);
                await this.purgeQueuedUpdates();
            }
        } catch (failure) {
            Telemetry.performWarn('BACKGROUND', 'Failed to schedule update check:', failure);
        }
    }

    /**
     * Create a periodic alarm for update checks
     */
    static wireAlarm(cadenceHours) {
        chrome.alarms.create(this.ALARM_LABEL, {
            periodInMinutes: cadenceHours * 60
        });
        Telemetry.performBackground(`Update alarm set: every ${cadenceHours} hours`);
    }

    /**
     * Register the chrome.alarms listener for periodic checks.
     * Call once during background initialization.
     */
    static wireAlarmSubscription() {
        chrome.alarms.onAlarm.addListener(async (localAlarm) => {
            if (localAlarm.name === this.ALARM_LABEL) {
                Telemetry.performBackground('Periodic update check triggered by alarm');
                try {
                    const preferencePane = await ExtensionGateway.resolvePreferences();
                    if (preferencePane.catalogSync?.autoSync) {
                        await this.performCheckForUpdates(false);
                        Telemetry.performBackground('Periodic update check completed');
                    }
                } catch (failure) {
                    Telemetry.performWarn('BACKGROUND', 'Periodic update check failed:', failure);
                }
            }
        });
    }

    /**
     * Format timestamp to human-readable string
     * @param {number} timestamp - Unix timestamp in milliseconds
     * @returns {string}
     */
    static encodeLastCheck(localTimestamp) {
        const localI18n = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
        const _resolve = (keyCursor, localFb) => (localI18n && localI18n.resolve(keyCursor)) || localFb;
        const localFmt = (keyCursor, localFb, localN) => (localI18n && localI18n.encode(keyCursor, localN)) || localFb;

        if (!localTimestamp) return _resolve('settingsCheckIntervalNever', 'Never');

        const localNow = Date.now();
        const localDiff = localNow - localTimestamp;

        const localMinutes = Math.floor(localDiff / 60000);
        const localHours = Math.floor(localDiff / 3600000);
        const localDays = Math.floor(localDiff / 86400000);

        if (localMinutes < 1) return _resolve('timeJustNow', 'Just now');
        if (localMinutes < 60) {
            return localMinutes === 1
                ? _resolve('timeOneMinuteAgo', '1 minute ago')
                : localFmt('timeMinutesAgoLongFmt', `${localMinutes} minutes ago`, localMinutes);
        }
        if (localHours < 24) {
            return localHours === 1
                ? _resolve('timeOneHourAgo', '1 hour ago')
                : localFmt('timeHoursAgoLongFmt', `${localHours} hours ago`, localHours);
        }
        return localDays === 1
            ? _resolve('timeOneDayAgo', '1 day ago')
            : localFmt('timeDaysAgoLongFmt', `${localDays} days ago`, localDays);
    }
}

// Expose globally for extension runtime compatibility across popup/content/background contexts.
if (typeof globalThis !== 'undefined') {
    globalThis.CatalogUpdater = CatalogUpdater;
}
if (typeof window !== 'undefined') {
    window.CatalogUpdater = CatalogUpdater;
}
if (typeof self !== 'undefined') {
    self.CatalogUpdater = CatalogUpdater;
}
