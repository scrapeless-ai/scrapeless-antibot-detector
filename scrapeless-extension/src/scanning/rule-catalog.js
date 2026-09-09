class RuleCatalog {
    static RULE_TOKEN_PREFIX = 'detect-';
    static DETECTION_PHASE_KEYS = ['cookie', 'header', 'content', 'dom', 'url', 'window', 'js_hooks', 'payload'];
    constructor(taxonomy) {
        this.taxonomy = taxonomy || new TaxonomyCatalog();
        this.ruleSet = {};
        this.started = false;
    }

    // Remove prefix, join with spaces, capitalize
    static humanizeRuleLabel(ruleToken) {
        if (!ruleToken || typeof ruleToken !== 'string') return 'Unknown';
        const localCleaned = ruleToken.replace(/^detect-/, '').replace(/[-_]+/g, ' ').trim();
        return localCleaned.split(' ').filter(Boolean).map(localWord => localWord.charAt(0).toUpperCase() + localWord.slice(1)).join(' ');
    }

    // Ensure canonical prefix format
    static canonicalizeRuleToken(ruleToken) {
        if (!ruleToken || typeof ruleToken !== 'string') return '';
        if (ruleToken.startsWith(RuleCatalog.RULE_TOKEN_PREFIX)) {
            return ruleToken;
        }
        return `${RuleCatalog.RULE_TOKEN_PREFIX}${ruleToken}`;
    }

    // Convert category name to display format
    static taxonomyPresentLabel(taxonomyLabel) {
        const localNormalized = (taxonomyLabel || '').toLowerCase();
        const index = {
            antibot: 'Anti-Bot',
            captcha: 'CAPTCHA',
            fingerprint: 'Fingerprint'
        };
        return index[localNormalized] || taxonomyLabel || 'Unknown';
    }

    /**
     * Apply small, targeted fixups to known detectors to prevent common false-positives.
     * This runs for detectors loaded from disk, storage, or remote updates.
     * @param {object} detectorData
     * @param {object} context
     * @param {string} context.source
     */
    static applyRuleFixups(rulePayload, { source: origin = 'unknown' } = {}) {
        try {
            if (!rulePayload || typeof rulePayload !== 'object') return rulePayload;
            const findingsPane = rulePayload.detection;
            if (!findingsPane || typeof findingsPane !== 'object') return rulePayload;

            // DataDome: cookie/header names must be exact to avoid matching GitHub's ref-selector:* cookies
            // (e.g., "ref-selector:...datadome..." would previously match "datadome" via substring).
            if (rulePayload.id === 'detect-datadome') {
                const localEscapeRegExp = (localStr) => String(localStr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const ensureExactLabelPolicy = (policy, expectedLabel) => {
                    if (!policy || typeof policy !== 'object') return false;
                    if (typeof policy.name !== 'string') return false;
                    const localNormalized = policy.name.trim();
                    if (!localNormalized) return false;

                    const localAnchored = `^${localEscapeRegExp(expectedLabel)}$`;
                    const localExpectedLower = expectedLabel.toLowerCase();
                    const localNormalizedLower = localNormalized.toLowerCase();

                    // Be conservative: DataDome is known to use an exact cookie/header name.
                    // Any pattern containing "datadome" but not anchored is treated as too broad
                    // and can match GitHub storage keys like "ref-selector:*datadome*".
                    const localLooksLikeDatadome = localNormalizedLower.includes(localExpectedLower);
                    const localIsAlreadyExact = localNormalized === localAnchored;

                    let localChanged = false;
                    if (localLooksLikeDatadome && !localIsAlreadyExact) {
                        policy.name = localAnchored;
                        localChanged = true;
                    } else if (localNormalized === expectedLabel && !localIsAlreadyExact) {
                        policy.name = localAnchored;
                        localChanged = true;
                    }

                    if (localLooksLikeDatadome && policy.nameRegex !== true) {
                        policy.nameRegex = true;
                        localChanged = true;
                    }

                    // Never let DataDome match storage keys (localStorage/sessionStorage entries).
                    // Only real cookies/headers should be used.
                    if (policy.nameScope === 'storage' || policy.nameScope === 'all_with_storage') {
                        policy.nameScope = 'all';
                        localChanged = true;
                    }
                    if (policy.valueScope === 'storage' || policy.valueScope === 'all_with_storage') {
                        policy.valueScope = 'all';
                        localChanged = true;
                    }

                    return localChanged;
                };

                let localChanged = false;
                if (Array.isArray(findingsPane.cookie)) {
                    for (const policy of findingsPane.cookie) {
                        localChanged = ensureExactLabelPolicy(policy, 'datadome') || localChanged;
                    }
                }
                if (Array.isArray(findingsPane.header)) {
                    for (const policy2 of findingsPane.header) {
                        localChanged = ensureExactLabelPolicy(policy2, 'x-datadome-cid') || localChanged;
                    }
                }

                if (localChanged) {
                    Telemetry.performDebug('DETECTOR', `[normalizeDetectorSchema] Applied DataDome fixups (${origin})`);
                }
            }
        } catch (failure) {
        }

        return rulePayload;
    }

    // Validate and normalize detector schema; ensures canonical IDs and safe defaults
    static canonicalizeRuleSchema(rulePayload, { categoryName: taxonomyLabel, detectorName: ruleLabel, source: origin = 'unknown' } = {}) {
        if (!rulePayload || typeof rulePayload !== 'object') {
            Telemetry.failure('DETECTOR', `[normalizeDetectorSchema] Invalid detector data (${origin})`, { categoryName: taxonomyLabel, detectorName: ruleLabel });
            return null;
        }

        const canonicalToken = RuleCatalog.canonicalizeRuleToken(ruleLabel || rulePayload.id || '');
        if (!canonicalToken) {
            Telemetry.failure('DETECTOR', `[normalizeDetectorSchema] Missing detector ID (${origin})`, { categoryName: taxonomyLabel, detectorName: ruleLabel });
            return null;
        }

        if (!rulePayload.id || rulePayload.id !== canonicalToken) {
            Telemetry.performDebug('DETECTOR', `[normalizeDetectorSchema] Canonicalizing ID (${origin})`, {
                from: rulePayload.id,
                to: canonicalToken
            });
            rulePayload.id = canonicalToken;
        }

        if (!rulePayload.name || typeof rulePayload.name !== 'string') {
            rulePayload.name = RuleCatalog.humanizeRuleLabel(canonicalToken);
            Telemetry.performDebug('DETECTOR', `[normalizeDetectorSchema] Missing name, using fallback (${origin})`, {
                id: canonicalToken,
                name: rulePayload.name
            });
        }

        if (!rulePayload.category || typeof rulePayload.category !== 'string') {
            rulePayload.category = RuleCatalog.taxonomyPresentLabel(taxonomyLabel);
        }

        if (rulePayload.enabled === undefined) {
            rulePayload.enabled = true;
        }

        if (!rulePayload.version || typeof rulePayload.version !== 'string') {
            rulePayload.version = '0.0';
        }

        // Detectors already written to storage still carry the upstream
        // author, and the bundled JSON is only read on first install — so
        // without this the rule editor keeps showing 'Scrapeless' for every
        // rule that was saved before the rename.
        if (typeof rulePayload.author === 'string' && rulePayload.author.toLowerCase() === 'scrapeless') {
            rulePayload.author = 'Scrapeless';
        } else if (!rulePayload.author || typeof rulePayload.author !== 'string') {
            rulePayload.author = 'Scrapeless';
        }

        const localNormalizedDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
            ? FindingMetrics.canonicalizeDifficulty(rulePayload.difficulty)
            : null;
        const baselineDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.baselineDifficultyForTaxonomy === 'function')
            ? FindingMetrics.baselineDifficultyForTaxonomy(taxonomyLabel || rulePayload.category)
            : 'Medium';
        rulePayload.difficulty = localNormalizedDifficulty || baselineDifficulty;

        if (!rulePayload.detection || typeof rulePayload.detection !== 'object') {
            // Storage is the one origin that repairs itself: readFromStorage runs
            // backfillEmptyDetectionsFromBundle immediately after this and adopts
            // the bundled patterns. Warning here fired once per rule on every
            // service worker start, for rules the very next step fixed — five
            // lines of WARN a load, describing nothing actionable. The rules that
            // genuinely cannot be repaired are reported once, after the backfill,
            // where the message can say so truthfully.
            const localReport = origin === 'storage'
                ? Telemetry.performDebug
                : Telemetry.performWarn;
            localReport('DETECTOR', `[normalizeDetectorSchema] Missing detection object (${origin})`, {
                id: canonicalToken
            });
            rulePayload.detection = {};
        }

        const findingsPane = rulePayload.detection;

        for (const lookupKey of RuleCatalog.DETECTION_PHASE_KEYS) {
            if (findingsPane[lookupKey] !== undefined && !Array.isArray(findingsPane[lookupKey])) {
                Telemetry.performWarn('DETECTOR', `[normalizeDetectorSchema] Invalid detection key type (${origin})`, {
                    id: canonicalToken,
                    key: lookupKey,
                    type: typeof findingsPane[lookupKey]
                });
                findingsPane[lookupKey] = [];
            }
        }

        // Disallow storage scopes for cookie/header matching
        const canonicalizeCookieHeaderBoundary = (boundary, localFallback) => {
            const localNormalized = typeof boundary === 'string' ? boundary.trim().toLowerCase() : '';
            if (localNormalized === 'all_with_storage') return 'all';
            if (localNormalized === 'storage') return localFallback;
            if (localNormalized === 'request' || localNormalized === 'response' || localNormalized === 'all') return localNormalized;
            return localFallback;
        };

        if (Array.isArray(findingsPane.cookie)) {
            for (const policy of findingsPane.cookie) {
                if (!policy || typeof policy !== 'object') continue;
                if (policy.nameScope != null) policy.nameScope = canonicalizeCookieHeaderBoundary(policy.nameScope, 'request');
                if (policy.valueScope != null) policy.valueScope = canonicalizeCookieHeaderBoundary(policy.valueScope, 'request');
            }
        }

        if (Array.isArray(findingsPane.header)) {
            for (const policy2 of findingsPane.header) {
                if (!policy2 || typeof policy2 !== 'object') continue;
                if (policy2.nameScope != null) policy2.nameScope = canonicalizeCookieHeaderBoundary(policy2.nameScope, 'response');
                if (policy2.valueScope != null) policy2.valueScope = canonicalizeCookieHeaderBoundary(policy2.valueScope, 'response');
            }
        }

        RuleCatalog.applyRuleFixups(rulePayload, { source: origin });

        return rulePayload;
    }

    /**
     * Initialize the DetectorManager by loading categories and detectors from files
     * and saving them to Chrome storage
     */
    async start() {
        if (this.started) {
            return;
        }

        try {
            if (!this.taxonomy.started) {
                await this.taxonomy.start();
            }

            const repositoryReady = await this.readFromRepository();

            if (!repositoryReady || this.resolveRuleTotal() === 0) {
                await this.readCatalogFromPosition();
                await this.persistCatalogToRepository();
            }

            this.started = true;
        } catch (failure) {
            Telemetry.failure('DETECTOR', 'DetectorManager failed to initialize', failure);
            throw failure;
        }
    }


    /**
     * Load all detector files based on categories
     * Reads each detector file from detectors/{category}/{detector}.json
     */
    async readCatalogFromPosition() {
        const readPromises = [];
        const taxonomies = this.taxonomy.resolveAllTaxonomies();

        let aggregateCatalogToRead = 0;

        for (const [taxonomyLabel, taxonomyPayload] of Object.entries(taxonomies)) {
            if (taxonomyPayload.detectors && Array.isArray(taxonomyPayload.detectors)) {
                aggregateCatalogToRead += taxonomyPayload.detectors.length;
            }
        }

        for (const [taxonomyLabel2, taxonomyPayload2] of Object.entries(taxonomies)) {
            if (!taxonomyPayload2.detectors || !Array.isArray(taxonomyPayload2.detectors)) {
                continue;
            }

            if (!this.ruleSet[taxonomyLabel2]) {
                this.ruleSet[taxonomyLabel2] = {};
            }

            for (const ruleLabel of taxonomyPayload2.detectors) {
                const localPromise = this.readRuleResource(taxonomyLabel2, ruleLabel);
                readPromises.push(localPromise);
            }
        }

        await Promise.allSettled(readPromises);

        // Validation: Ensure at least some detectors loaded
        const finalTotal = this.resolveRuleTotal();
        if (finalTotal === 0) {
            Telemetry.failure('DETECTOR', 'No detectors loaded - JSON files may be missing or corrupt', {
                detectors: this.ruleSet
            });
            throw new Error('No detectors were loaded - all JSON files may be missing or corrupt');
        }
    }

    /**
     * Load a single detector file with timeout
     * @param {string} categoryName - Category name (antibot, captcha, fingerprint)
     * @param {string} detectorName - Detector name (cloudflare, hcaptcha, etc.)
     */
    async readRuleResource(taxonomyLabel, ruleLabel) {
        const FETCH_DEADLINE = RuntimePolicy.FETCH_DEADLINE;

        try {
            const ruleRoute = `detectors/${taxonomyLabel}/${ruleLabel}.json`;

            // Create fetch with timeout
            const localController = new AbortController();
            const deadlineToken = setTimeout(() => localController.abort(), FETCH_DEADLINE);

            try {
                const reply = await fetch(chrome.runtime.getURL(ruleRoute), {
                    signal: localController.signal
                });

                clearTimeout(deadlineToken);

                if (!reply.ok) {
                    Telemetry.performWarn('DETECTOR', 'Detector file not found', { path: ruleRoute, status: reply.status });
                    return;
                }

                const rulePayload = await reply.json();

                // Validate detector data structure
                const localNormalized = RuleCatalog.canonicalizeRuleSchema(rulePayload, {
                    categoryName: taxonomyLabel,
                    detectorName: ruleLabel,
                    source: 'file'
                });
                if (!localNormalized) {
                    Telemetry.failure('DETECTOR', 'Invalid detector data after normalization', { path: ruleRoute });
                    return;
                }

                // Default enabled to true if not specified
                if (localNormalized.enabled === undefined) {
                    localNormalized.enabled = true;
                }

                // Update lastUpdated to include time if it doesn't already
                if (localNormalized.lastUpdated && !localNormalized.lastUpdated.includes(':')) {
                    // Old format (YYYY-MM-DD), add default time
                    localNormalized.lastUpdated = `${localNormalized.lastUpdated} 00:00:00`;
                }

                this.ruleSet[taxonomyLabel][ruleLabel] = localNormalized;

            } catch (fetchFailure) {
                clearTimeout(deadlineToken);

                if (fetchFailure.name === 'AbortError') {
                    Telemetry.failure('DETECTOR', 'Timeout loading detector', { path: ruleRoute, timeout: FETCH_DEADLINE });
                } else {
                    throw fetchFailure;
                }
            }

        } catch (failure) {
            Telemetry.failure('DETECTOR', 'Failed to load detector', { category: taxonomyLabel, detector: ruleLabel, error: failure.message });
            throw failure; // Re-throw to be caught by Promise.allSettled
        }
    }


    /**
     * Save all detector data to Chrome storage as 'scrapeless_detectors'
     * Uses StorageManager for consistent save patterns
     */
    composePortableCatalog() {
        const portableCatalog = JSON.parse(JSON.stringify(this.ruleSet));

        for (const taxonomyCatalog of Object.values(portableCatalog)) {
            for (const rule of Object.values(taxonomyCatalog)) {
                if (rule && rule._searchStrings) {
                    delete rule._searchStrings;
                }
            }
        }

        return portableCatalog;
    }

    async persistCatalogToRepository() {
        try {
            const portableCatalog = this.composePortableCatalog();

            // Use StorageManager for consistent save with metadata
            const completion = await ExtensionStore.persistToRepository('scrapeless_detectors', {
                rules: portableCatalog,
                total: this.resolveRuleTotal()
            }, {
                wrapMetadata: true,
                countProperty: null // totalCount already included in data
            });

            if (!completion) {
                throw new Error('StorageManager.saveToStorage returned false');
            }
        } catch (failure) {
            Telemetry.failure('DETECTOR', 'Failed to save detectors to storage', failure);
            throw failure;
        }
    }


    // Rules holding no patterns in any phase: they cannot match anything, so a
    // scan iterates them for nothing and the editor shows "0 patterns".
    resolveInertRuleTokens() {
        const localInert = [];
        for (const [taxonomy, taxonomyCatalog] of Object.entries(this.ruleSet || {})) {
            if (!taxonomyCatalog || typeof taxonomyCatalog !== 'object') continue;
            for (const [ruleToken, rule] of Object.entries(taxonomyCatalog)) {
                const findingsPane = rule?.detection;
                const hasPatterns = Boolean(findingsPane) && RuleCatalog.DETECTION_PHASE_KEYS.some(
                    (lookupKey) => Array.isArray(findingsPane[lookupKey]) && findingsPane[lookupKey].length > 0
                );
                if (!hasPatterns) {
                    localInert.push(`${taxonomy}/${ruleToken}`);
                }
            }
        }
        return localInert;
    }

    // Bundled detector files are only read on a first install: a rule seeded
    // while its bundled file was empty keeps that empty detection in storage
    // forever, and the rule editor shows "0 patterns" for data that exists on
    // disk. This backfills just the detection object from the bundled file for
    // stored rules that hold no patterns at all; every other stored field
    // (enabled, name, custom edits) is left untouched.
    // Returns true when at least one rule adopted bundled patterns.
    async backfillEmptyDetectionsFromBundle() {
        const resolveHasPatterns = (detection) => Boolean(detection) && RuleCatalog.DETECTION_PHASE_KEYS.some(
            (lookupKey) => Array.isArray(detection[lookupKey]) && detection[lookupKey].length > 0
        );
        let localRepaired = false;
        const repairedTokens = [];
        for (const [taxonomy, taxonomyCatalog] of Object.entries(this.ruleSet || {})) {
            if (!taxonomyCatalog || typeof taxonomyCatalog !== 'object') continue;
            const taxonomyDetail = this.taxonomy?.resolveTaxonomyDetail?.(taxonomy);
            const bundledTokens = Array.isArray(taxonomyDetail?.detectors) ? taxonomyDetail.detectors : [];
            for (const [ruleToken, rule] of Object.entries(taxonomyCatalog)) {
                if (resolveHasPatterns(rule?.detection)) continue;
                if (!bundledTokens.includes(ruleToken)) continue;
                const storedRule = rule;
                await this.readRuleResource(taxonomy, ruleToken);
                const bundledRule = this.ruleSet[taxonomy]?.[ruleToken];
                // readRuleResource stores the bundled copy under the same key;
                // restore the stored rule and adopt only its detection.
                this.ruleSet[taxonomy][ruleToken] = storedRule;
                if (bundledRule && bundledRule !== storedRule && resolveHasPatterns(bundledRule.detection)) {
                    storedRule.detection = bundledRule.detection;
                    localRepaired = true;
                    repairedTokens.push(`${taxonomy}/${ruleToken}`);
                }
            }
        }
        if (localRepaired) {
            Telemetry.performDebug('DETECTOR', '[backfillEmptyDetectionsFromBundle] Restored bundled patterns for pattern-less stored rules', {
                detectors: repairedTokens
            });
        }
        return localRepaired;
    }

    // Load from Chrome storage; returns true if data was loaded

    async readFromRepository() {
        try {
            const readyPayload = await ExtensionStore.batchReadRepository([
                {
                    primary: 'scrapeless_categories',
                    legacy: 'scrapeless_categories.json',
                    dataProperty: null
                },
                {
                    primary: 'scrapeless_detectors',
                    legacy: 'scrapeless_detectors.json',
                    dataProperty: null
                }
            ]);

            const taxonomiesPayload = readyPayload['scrapeless_categories'];
            if (taxonomiesPayload) {
                const storedTaxa = ExtensionStore.openRecord(taxonomiesPayload, 'taxa', 'categories') || {};
                const taxonomyTotal = Object.keys(storedTaxa).length;
                this.taxonomy.taxonomies = storedTaxa;
                this.taxonomy.started = taxonomyTotal > 0;
            }

            const catalogPayload = readyPayload['scrapeless_detectors'];

            if (catalogPayload) {
                const storedRules = ExtensionStore.openRecord(catalogPayload, 'rules', 'detectors');
                if (!storedRules || typeof storedRules !== 'object') {
                    Telemetry.failure('DETECTOR', 'Invalid storage format - rule set missing or wrong type', { detectorsData: catalogPayload });
                    return false;
                }

                const normalizedCatalog = {};
                const localSeenIds = new Set();
                let localNeedsResave = false;
                let localHasCorruption = false;

                for (const [taxonomy, taxonomyCatalog] of Object.entries(storedRules)) {
                    if (!normalizedCatalog[taxonomy]) {
                        normalizedCatalog[taxonomy] = {};
                    }

                    if (!taxonomyCatalog || typeof taxonomyCatalog !== 'object') {
                        Telemetry.performWarn('DETECTOR', '[loadFromStorage] Invalid category detector map, skipping', { category: taxonomy });
                        localNeedsResave = true;
                        continue;
                    }

                    for (const [ruleLookup, rule] of Object.entries(taxonomyCatalog)) {
                        const priorDifficulty = rule?.difficulty;
                        if (rule?.detection) {
                            for (const phasePayload of Object.values(rule.detection)) {
                                if (typeof phasePayload === 'string') {
                                    localHasCorruption = true;
                                    break;
                                }
                            }
                        }
                        if (localHasCorruption) break;

                        const preferredToken = (typeof ruleLookup === 'string' && ruleLookup.startsWith(RuleCatalog.RULE_TOKEN_PREFIX))
                            ? ruleLookup
                            : (rule?.id || ruleLookup);
                        const localNormalized = RuleCatalog.canonicalizeRuleSchema(rule, {
                            categoryName: taxonomy,
                            detectorName: preferredToken,
                            source: 'storage'
                        });

                        if (!localNormalized) {
                            localNeedsResave = true;
                            continue;
                        }

                        if (localNormalized.id !== ruleLookup) {
                            localNeedsResave = true;
                        }
                        if (localNormalized.difficulty !== priorDifficulty) {
                            localNeedsResave = true;
                        }

                        if (localSeenIds.has(localNormalized.id)) {
                            Telemetry.performDebug('DETECTOR', '[loadFromStorage] Duplicate detector ID, skipping', {
                                id: localNormalized.id,
                                category: taxonomy
                            });
                            localNeedsResave = true;
                            continue;
                        }

                        localSeenIds.add(localNormalized.id);
                        normalizedCatalog[taxonomy][localNormalized.id] = localNormalized;
                    }

                    if (localHasCorruption) break;
                }

                if (localHasCorruption) {
                    await this.readCatalogFromPosition();
                    await this.persistCatalogToRepository();
                    return true;
                }

                this.ruleSet = normalizedCatalog;

                if (await this.backfillEmptyDetectionsFromBundle()) {
                    localNeedsResave = true;
                }

                // Whatever is still pattern-less after the backfill cannot be
                // repaired from disk — the bundled file has no patterns either —
                // so the rule can never match. That is worth one warning naming
                // them, unlike the per-rule noise the normalizer used to emit
                // before this step had run.
                const localInertRules = this.resolveInertRuleTokens();
                if (localInertRules.length > 0) {
                    Telemetry.performWarn('DETECTOR', '[loadFromStorage] Rules carry no detection patterns and cannot match; the bundled copy is empty too', {
                        detectors: localInertRules
                    });
                }

                const ruleTotal = this.resolveRuleTotal();
                if (ruleTotal === 0) {
                    return false; // Force reload from JSON
                }

                if (localNeedsResave) {
                    await this.persistCatalogToRepository();
                }

                return true;
            }

            return false;

        } catch (failure) {
            Telemetry.failure('DETECTOR', 'Failed to load from storage', failure);
            return false;
        }
    }

    /**
     * Get category information including color and detector list
     * @param {string} categoryName - Category name
     * @returns {object} Category data with colour and detectors array
     */
    resolveTaxonomyDetail(taxonomyLabel) {
        return this.taxonomy.resolveTaxonomyDetail(taxonomyLabel);
    }

    /**
     * Get a specific detector's full configuration
     * @param {string} categoryName - Category name
     * @param {string} detectorName - Detector name (ID)
     * @returns {object} Detector configuration object
     */
    resolveRule(taxonomyLabel, ruleLabel) {
        return this.ruleSet[taxonomyLabel]?.[ruleLabel];
    }

    /**
     * Normalize category name to internal key format
     * @param {string} category - Category display name (e.g., "Anti-Bot", "CAPTCHA")
     * @returns {string} Normalized category key (e.g., "antibot", "captcha")
     */
    canonicalizeTaxonomyLabel(taxonomy) {
        if (!taxonomy) return '';

        const localNormalized = taxonomy.toLowerCase()
            .replace(/[^a-z]/g, ''); // Remove spaces, hyphens, etc.

        // Map known variations
        const taxonomyIndex = {
            'antibot': 'antibot',
            'captcha': 'captcha',
            'fingerprint': 'fingerprint'
        };

        return taxonomyIndex[localNormalized] || localNormalized;
    }

    /**
     * Get a detector by its display name within a category
     * @param {string} categoryName - Category name (display name or internal key)
     * @param {string} displayName - Detector display name
     * @returns {object|null} Detector configuration object or null if not found
     */
    resolveRuleByLabel(taxonomyLabel, presentLabel) {
        // Normalize category name to internal key
        const normalizedTaxonomy = this.canonicalizeTaxonomyLabel(taxonomyLabel);
        const taxonomyCatalog = this.ruleSet[normalizedTaxonomy];
        if (!taxonomyCatalog) return null;

        for (const [token, rule] of Object.entries(taxonomyCatalog)) {
            if (rule.name === presentLabel) {
                return rule;
            }
        }
        return null;
    }

    /**
     * Find a detector by ID across all categories
     * Fallback method when category is unknown or incorrect
     * @param {string} detectorId - Detector ID to find
     * @returns {object|null} Detector configuration object or null if not found
     */
    findRuleByToken(ruleToken) {
        // Search all categories for the detector
        for (const [taxonomyLabel, taxonomyCatalog] of Object.entries(this.ruleSet)) {
            // Check if detector exists with this exact ID as key
            if (taxonomyCatalog[ruleToken]) {
                return taxonomyCatalog[ruleToken];
            }

            // Also check if any detector has this as its 'id' property
            for (const [lookupKey, rule] of Object.entries(taxonomyCatalog)) {
                if (rule.id === ruleToken) {
                    return rule;
                }
            }
        }

        return null;
    }

    /**
     * Get all detectors organized by category
     * @returns {object} All detectors organized by category
     */
    resolveAllCatalog() {
        return this.ruleSet;
    }

    /**
     * Get total number of loaded detectors
     * @returns {number} Total count of detectors
     */
    resolveRuleTotal() {
        let total = 0;
        for (const taxonomy of Object.values(this.ruleSet)) {
            total += Object.keys(taxonomy).length;
        }
        return total;
    }

    /**
     * Replace or merge the in-memory catalog from an imported JSON payload.
     * Accepts the sealed envelope and the retired `{ timestamp, detectors }`
     * shape, since an import file may have been written by either build.
     */
    async ingestCatalogPayload(payload, mergeWithCurrent = false) {
        const importedCatalog = ExtensionStore.openRecord(payload, 'rules', 'detectors') ?? payload;
        if (!importedCatalog || typeof importedCatalog !== 'object' || Array.isArray(importedCatalog)) {
            return false;
        }

        const priorCatalog = this.ruleSet;

        try {
            const nextCatalog = mergeWithCurrent
                ? JSON.parse(JSON.stringify(this.ruleSet))
                : {};
            const tokenOwners = new Map();
            let acceptedTotal = 0;

            for (const [existingTaxonomy, existingRules] of Object.entries(nextCatalog)) {
                for (const existingToken of Object.keys(existingRules || {})) {
                    tokenOwners.set(existingToken, existingTaxonomy);
                }
            }

            for (const [rawTaxonomy, rawRules] of Object.entries(importedCatalog)) {
                const taxonomyLabel = this.canonicalizeTaxonomyLabel(rawTaxonomy);
                if (
                    !taxonomyLabel ||
                    ['__proto__', 'prototype', 'constructor'].includes(taxonomyLabel) ||
                    !rawRules ||
                    typeof rawRules !== 'object' ||
                    Array.isArray(rawRules)
                ) {
                    continue;
                }

                if (!nextCatalog[taxonomyLabel]) {
                    nextCatalog[taxonomyLabel] = {};
                }

                for (const [rawToken, rawRule] of Object.entries(rawRules)) {
                    if (
                        ['__proto__', 'prototype', 'constructor'].includes(rawToken) ||
                        !rawRule ||
                        typeof rawRule !== 'object' ||
                        Array.isArray(rawRule)
                    ) {
                        continue;
                    }

                    const ruleCopy = JSON.parse(JSON.stringify(rawRule));
                    const normalizedRule = RuleCatalog.canonicalizeRuleSchema(ruleCopy, {
                        categoryName: taxonomyLabel,
                        detectorName: rawToken,
                        source: 'import'
                    });
                    if (!normalizedRule) continue;

                    const existingOwner = tokenOwners.get(normalizedRule.id);
                    if (existingOwner && existingOwner !== taxonomyLabel) {
                        Telemetry.performWarn('DETECTOR', 'Skipping duplicate imported detector ID', {
                            id: normalizedRule.id,
                            category: taxonomyLabel,
                            existingCategory: existingOwner
                        });
                        continue;
                    }

                    tokenOwners.set(normalizedRule.id, taxonomyLabel);
                    nextCatalog[taxonomyLabel][normalizedRule.id] = normalizedRule;
                    acceptedTotal += 1;
                }

                if (Object.keys(nextCatalog[taxonomyLabel]).length === 0) {
                    delete nextCatalog[taxonomyLabel];
                }
            }

            if (acceptedTotal === 0) {
                return false;
            }

            this.ruleSet = nextCatalog;
            await this.persistCatalogToRepository();
            return true;
        } catch (failure) {
            this.ruleSet = priorCatalog;
            Telemetry.failure('DETECTOR', 'Failed to import detector catalog', failure);
            return false;
        }
    }

    composeCatalogExport() {
        return ExtensionStore.sealRecord('rules', this.composePortableCatalog());
    }

    async purgeCatalog() {
        const priorCatalog = this.ruleSet;
        try {
            this.ruleSet = {};
            await this.persistCatalogToRepository();
            return true;
        } catch (failure) {
            this.ruleSet = priorCatalog;
            Telemetry.failure('DETECTOR', 'Failed to clear detector catalog', failure);
            return false;
        }
    }

    async removeRule(taxonomy, label) {
        const taxonomyLabel = this.canonicalizeTaxonomyLabel(taxonomy);
        const existingRule = this.ruleSet[taxonomyLabel]?.[label];
        if (!existingRule) return false;

        delete this.ruleSet[taxonomyLabel][label];
        try {
            await this.persistCatalogToRepository();
            return true;
        } catch (failure) {
            this.ruleSet[taxonomyLabel][label] = existingRule;
            Telemetry.failure('DETECTOR', 'Failed to remove detector', failure);
            return false;
        }
    }

    async replaceRule(taxonomy, label, rule) {
        const taxonomyLabel = this.canonicalizeTaxonomyLabel(taxonomy);
        const existingRule = this.ruleSet[taxonomyLabel]?.[label];
        if (!existingRule) return false;

        const normalizedRule = RuleCatalog.canonicalizeRuleSchema(
            JSON.parse(JSON.stringify(rule)),
            { categoryName: taxonomyLabel, detectorName: label, source: 'editor' }
        );
        if (!normalizedRule) return false;

        this.ruleSet[taxonomyLabel][label] = normalizedRule;
        try {
            await this.persistCatalogToRepository();
            return true;
        } catch (failure) {
            this.ruleSet[taxonomyLabel][label] = existingRule;
            Telemetry.failure('DETECTOR', 'Failed to replace detector', failure);
            return false;
        }
    }

    /**
     * Add a new detector
     * @param {string} category - Detector category
     * @param {string} name - Detector name
     * @param {Object} detector - Detector configuration
     * @returns {Promise<boolean>} Success status
     */
    async addRule(taxonomy, label, rule) {
        try {
            if (!this.ruleSet[taxonomy]) {
                this.ruleSet[taxonomy] = {};
            }

            const localNormalizedDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
                ? FindingMetrics.canonicalizeDifficulty(rule?.difficulty)
                : null;
            const baselineDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.baselineDifficultyForTaxonomy === 'function')
                ? FindingMetrics.baselineDifficultyForTaxonomy(taxonomy || rule?.category)
                : 'Medium';
            rule.difficulty = localNormalizedDifficulty || baselineDifficulty;

            // Add timestamp in local time: YYYY-MM-DD HH:MM:SS
            const localNow = new Date();
            const localYear = localNow.getFullYear();
            const localMonth = String(localNow.getMonth() + 1).padStart(2, '0');
            const localDay = String(localNow.getDate()).padStart(2, '0');
            const localHours = String(localNow.getHours()).padStart(2, '0');
            const localMinutes = String(localNow.getMinutes()).padStart(2, '0');
            const localSeconds = String(localNow.getSeconds()).padStart(2, '0');
            rule.lastUpdated = `${localYear}-${localMonth}-${localDay} ${localHours}:${localMinutes}:${localSeconds}`;

            this.ruleSet[taxonomy][label] = rule;
            await this.persistCatalogToRepository();
            return true;
        } catch (failure) {
            Telemetry.failure('DETECTOR', 'Failed to add detector', failure);
            return false;
        }
    }

    /**
     * Get the CategoryManager instance
     * @returns {CategoryManager} The category manager instance
     */
    resolveTaxonomyCoordinator() {
        return this.taxonomy;
    }
}

if (typeof window !== 'undefined') {
  window.RuleCatalog = RuleCatalog;
}
