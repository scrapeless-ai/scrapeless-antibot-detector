// Manages detector categories, colors, and storage
class TaxonomyCatalog {
    constructor() {
        this.taxonomies = {};
        this.started = false;
    }

    static resolvePackagedFallbackPosition() {
        return {
            version: '1.0.0',
            antibot: {
                colour: '#FF6B4A',
                detectors: [
                    'detect-akamai',
                    'detect-cloudflare',
                    'detect-aws-waf',
                    'detect-f5',
                    'detect-datadome',
                    'detect-incapsula',
                    'detect-perimeterx',
                    'detect-shapesecurity',
                    'detect-sucuri',
                    'detect-reblaze',
                    'detect-threatmetrix',
                    'detect-meetrics',
                    'detect-ocule',
                    'detect-cheq',
                    'detect-kasada'
                ]
            },
            captcha: {
                colour: '#70C9D5',
                detectors: [
                    'detect-hcaptcha',
                    'detect-recaptcha',
                    'detect-geetest',
                    'detect-qcloud',
                    'detect-funcaptcha',
                    'detect-aliexpress',
                    'detect-friendlycaptcha',
                    'detect-captchaeu'
                ]
            },
            fingerprint: {
                colour: '#9B8AF7',
                detectors: [
                    'detect-audio-fingerprint',
                    'detect-battery-fingerprint',
                    'detect-canvas-fingerprint',
                    'detect-clipboard-fingerprint',
                    'detect-crypto-fingerprint',
                    'detect-css-fingerprint',
                    'detect-font-fingerprint',
                    'detect-gamepads-fingerprint',
                    'detect-geolocation-fingerprint',
                    'detect-hardware-fingerprint',
                    'detect-indexeddb-fingerprint',
                    'detect-media-fingerprint',
                    'detect-navigator-fingerprint',
                    'detect-orientation-fingerprint',
                    'detect-performance-fingerprint',
                    'detect-screen-fingerprint',
                    'detect-storage-fingerprint',
                    'detect-timezone-fingerprint',
                    'detect-usb-fingerprint',
                    'detect-webgl-fingerprint',
                    'detect-webrtc-fingerprint'
                ]
            },
            tags: {
                dom: { colour: '#5DD3C4' },
                header: { colour: '#E4A0D6' },
                cookie: { colour: '#E6A647' },
                content: { colour: '#43C59E' },
                url: { colour: '#70C9D5' },
                js_hooks: { colour: '#B6A9FF' },
                window: { colour: '#75C9A6' },
                payload: { colour: '#D08AD7' }
            },
            badge: {
                low: { colour: '#43C59E' },
                medium: { colour: '#E6A647' },
                high: { colour: '#F06A54' }
            }
        };
    }

    /**
     * Initialize the CategoryManager by loading categories from storage first,
     * then falling back to index.json if storage is empty.
     * This preserves custom colors (badge, category, tag) across sessions.
     */
    async start() {
        if (this.started) return;

        try {
            // Load from storage first (preserves custom colors)
            const repositoryReady = await this.readFromRepository();

            if (!repositoryReady) {
                await this.readTaxonomiesFromPosition();
                await this.persistToRepository();
            } else {
                // Merge new tags from index.json not yet in storage
                await this.mergeNewTagsFromPosition();
            }

            await this.syncPaletteFromPreferences();

            this.started = true;
        } catch (failure) {
            Telemetry.failure('DETECTOR', 'CategoryManager failed to initialize', failure);
            throw failure;
        }
    }

    /**
     * Load categories from detectors/index.json
     * Sets this.categories with the index data
     */
    async readTaxonomiesFromPosition() {
        try {
            const positionAddress = chrome.runtime.getURL('detectors/index.json');
            const reply = await fetch(positionAddress);

            if (!reply.ok) {
                throw new Error(`Failed to load index.json: ${reply.statusText}`);
            }

            const positionPayload = await reply.json();
            this.taxonomies = positionPayload;

            if (!this.taxonomies.badge) {
                Telemetry.performWarn('DETECTOR', 'No badge section found in index.json');
            }

        } catch (failure) {
            Telemetry.failure('DETECTOR', 'Failed to load detectors index, using packaged fallback', failure);
            this.taxonomies = TaxonomyCatalog.resolvePackagedFallbackPosition();
        }
    }

    /**
     * Merge new tags from index.json into storage data
     * This ensures new detection methods added to index.json are available even with old storage data
     */
    async mergeNewTagsFromPosition() {
        try {
            const positionAddress = chrome.runtime.getURL('detectors/index.json');
            const reply = await fetch(positionAddress);

            if (!reply.ok) return;

            const positionPayload = await reply.json();

            if (positionPayload.tags) {
                if (!this.taxonomies.tags) {
                    this.taxonomies.tags = {};
                }

                let mergedTotal = 0;
                for (const [tagLabel, tagPayload] of Object.entries(positionPayload.tags)) {
                    if (!this.taxonomies.tags[tagLabel]) {
                        this.taxonomies.tags[tagLabel] = tagPayload;
                        mergedTotal++;
                    }
                }

                if (mergedTotal > 0) {
                    await this.persistToRepository();
                }
            }
        } catch (failure) {
            // Silently fail - not critical
        }
    }

    async persistToRepository() {
        try {
            const completion = await ExtensionStore.persistToRepository('scrapeless_categories', {
                taxa: this.taxonomies,
                total: Object.keys(this.taxonomies).length
            }, {
                wrapMetadata: true,
                countProperty: null // totalCategories already included in data
            });

            if (!completion) {
                throw new Error('StorageManager.saveToStorage returned false');
            }
        } catch (failure) {
            Telemetry.failure('DETECTOR', 'Failed to save categories to storage', failure);
            throw failure;
        }
    }

    async readFromRepository() {
        try {
            const taxonomiesPayload = await ExtensionStore.readFromRepository(
                'scrapeless_categories',
                'scrapeless_categories.json',
                null // Load full wrapper (timestamp + categories)
            );

            if (taxonomiesPayload && taxonomiesPayload.categories && typeof taxonomiesPayload.categories === 'object') {
                this.taxonomies = taxonomiesPayload.categories;
                this.started = Object.keys(this.taxonomies).length > 0;
                return true;
            }

            return false;
        } catch (failure) {
            Telemetry.failure('DETECTOR', 'Failed to load categories from storage', failure);
            return false;
        }
    }

    /**
     * Get list of available category names
     * @returns {string[]} Array of category names
     */
    resolveTaxonomies() {
        return Object.keys(this.taxonomies);
    }

    /**
     * Get all categories data
     * @returns {object} All categories with their configurations
     */
    resolveAllTaxonomies() {
        return this.taxonomies;
    }

    /**
     * Get category information including color and detector list
     * @param {string} categoryName - Category name
     * @returns {object} Category data with colour and detectors array
     */
    resolveTaxonomyDetail(taxonomyLabel) {
        return this.taxonomies[taxonomyLabel];
    }

    /**
     * Get color for a specific category
     * Returns the color from CategoryManager's stored data
     * @param {string} categoryName - Category name
     * @returns {string} Category color hex value or default
     */
    resolveTaxonomyPalette(taxonomyLabel) {
        const taxonomyDetail = this.taxonomies[taxonomyLabel];
        return taxonomyDetail?.colour || '#9B8AF7';
    }

    /**
     * Sync category colors from Settings
     * This should be called after Settings saves category colors
     * @returns {Promise<boolean>} True if colors were synced successfully
     */
    async syncPaletteFromPreferences() {
        try {
            // Read colors from Settings
            const preferencesPayload = await ExtensionGateway.resolvePreferences();
            const taxonomyPalette = preferencesPayload?.taxonomyPalette;

            if (taxonomyPalette) {
                // Update colors in CategoryManager's categories
                for (const [taxonomyLabel, palette] of Object.entries(taxonomyPalette)) {
                    if (this.taxonomies[taxonomyLabel]) {
                        this.taxonomies[taxonomyLabel].colour = palette;
                    }
                }

                // Save updated categories to storage
                await this.persistToRepository();
                return true;
            }
            return false;
        } catch (failure) {
            Telemetry.failure('DETECTOR', 'Failed to sync colors from Settings', failure);
            return false;
        }
    }

    /**
     * Get category display name
     * @param {string} categoryName - Category name
     * @returns {string} Formatted display name
     */
    resolveTaxonomyPresentLabel(taxonomyLabel) {
        const i18NLookupByTaxonomy = {
            antibot: 'categoryAntibot',
            captcha: 'categoryCaptcha',
            fingerprint: 'categoryFingerprint'
        };
        const lookupKey = i18NLookupByTaxonomy[taxonomyLabel?.toLowerCase()];
        if (lookupKey && typeof LocaleRuntime !== 'undefined') {
            const localTranslated = LocaleRuntime.resolve(lookupKey);
            if (localTranslated) return localTranslated;
        }

        switch (taxonomyLabel?.toLowerCase()) {
            case 'antibot':
                return 'Anti-Bot';
            case 'captcha':
                return 'Captcha';
            case 'fingerprint':
                return 'Fingerprint';
            default:
                return taxonomyLabel.charAt(0).toUpperCase() + taxonomyLabel.slice(1);
        }
    }

    /**
     * Get category badge CSS class
     * @param {string} categoryName - Category name
     * @returns {string} CSS class name for badges
     */
    resolveTaxonomyBadgeClass(taxonomyLabel) {
        switch (taxonomyLabel?.toLowerCase()) {
            case 'antibot':
            case 'anti-bot':
                return 'antibot';
            case 'captcha':
                return 'captcha';
            case 'fingerprint':
                return 'fingerprint';
            default:
                return 'primary';
        }
    }

    /**
     * Get all tag colors from index.json
     * @returns {object} Object with tag names as keys and color hex values
     */
    resolveTagPalette() {
        return this.taxonomies.tags || {};
    }

    /**
     * Get color for a specific tag (dom, header, cookie, etc.)
     * @param {string} tagName - Tag name (lowercase)
     * @returns {string} Tag color hex value or default
     */
    resolveTagTone(tagLabel) {
        const localTags = this.resolveTagPalette();
        const normalizedTagLabel = tagLabel.toLowerCase();

        const tagPayload = localTags[normalizedTagLabel];

        if (typeof tagPayload === 'string') {
            return tagPayload;
        } else if (tagPayload && tagPayload.colour) {
            return tagPayload.colour;
        }

        return '#666666';
    }

    /**
     * Get badge colors configuration
     * @returns {object} Object with low, medium, high badge colors
     */
    resolveBadgePalette() {
        return this.taxonomies.badge || {
            low: { colour: BadgeTokens.COLORS.LOW },
            medium: { colour: BadgeTokens.COLORS.MEDIUM },
            high: { colour: BadgeTokens.COLORS.HIGH }
        };
    }

    /**
     * Get color for a specific badge level
     * @param {string} level - Badge level: 'low', 'medium', or 'high'
     * @returns {string} Badge color hex value or default
     */
    resolveBadgeTone(localLevel) {
        const badgePalette = this.resolveBadgePalette();
        const localNormalizedLevel = localLevel.toLowerCase();

        const levelPayload = badgePalette[localNormalizedLevel];

        let palette;
        if (typeof levelPayload === 'string') {
            palette = levelPayload;
        } else if (levelPayload && levelPayload.colour) {
            palette = levelPayload.colour;
        } else {
            const baselines = {
                low: BadgeTokens.COLORS.LOW,
                medium: BadgeTokens.COLORS.MEDIUM,
                high: BadgeTokens.COLORS.HIGH
            };
            palette = baselines[localNormalizedLevel] || BadgeTokens.COLORS.LOW;
        }

        return palette;
    }

    /**
     * Get badge colors from CategoryManager instance or storage
     * @param {CategoryManager} [categoryManagerInstance] - Optional CategoryManager instance
     * @returns {Promise<Object>} Badge colors {low, medium, high}
     */
    static async resolveConfiguredBadgePalette(taxonomyCoordinatorInstance = null) {
        try {
            if (taxonomyCoordinatorInstance && taxonomyCoordinatorInstance.started) {
                return {
                    low: taxonomyCoordinatorInstance.resolveBadgeTone('low'),
                    medium: taxonomyCoordinatorInstance.resolveBadgeTone('medium'),
                    high: taxonomyCoordinatorInstance.resolveBadgeTone('high')
                };
            }

            const canonicalizePalette = (datum, localFallback) => {
                if (typeof datum === 'string') return datum;
                if (datum && typeof datum === 'object') {
                    if (typeof datum.colour === 'string') return datum.colour;
                    if (typeof datum.color === 'string') return datum.color;
                }
                return localFallback;
            };

            const outcome = await chrome.storage.local.get(['scrapeless_categories', 'scrapeless_settings']);

            if (outcome.scrapeless_categories) {
                const taxonomiesPayload = typeof outcome.scrapeless_categories === 'string'
                    ? JSON.parse(outcome.scrapeless_categories)
                    : outcome.scrapeless_categories;

                const taxonomiesScope = taxonomiesPayload?.categories || taxonomiesPayload;
                const localBadge = taxonomiesScope?.badge;

                if (localBadge) {
                    return {
                        low: canonicalizePalette(localBadge.low, BadgeTokens.COLORS.LOW),
                        medium: canonicalizePalette(localBadge.medium, BadgeTokens.COLORS.MEDIUM),
                        high: canonicalizePalette(localBadge.high, BadgeTokens.COLORS.HIGH)
                    };
                }
            }

            const preferencesPayload = await ExtensionGateway.resolvePreferences();
            const badgePalette = preferencesPayload?.badgePalette;
            if (badgePalette) {
                return {
                    low: badgePalette.low || BadgeTokens.COLORS.LOW,
                    medium: badgePalette.medium || BadgeTokens.COLORS.MEDIUM,
                    high: badgePalette.high || BadgeTokens.COLORS.HIGH
                };
            }

            return {
                low: BadgeTokens.COLORS.LOW,
                medium: BadgeTokens.COLORS.MEDIUM,
                high: BadgeTokens.COLORS.HIGH
            };
        } catch (failure) {
            Telemetry.failure('BADGE', 'Error getting badge colors', failure);
            return {
                low: BadgeTokens.COLORS.LOW,
                medium: BadgeTokens.COLORS.MEDIUM,
                high: BadgeTokens.COLORS.HIGH
            };
        }
    }

    /**
     * The badge's tint, from one rule.
     *
     * Six call sites picked this colour three different ways — from the run's
     * difficulty, from the raw count, and from the hardcoded defaults ignoring
     * the user's own palette — so the same page was painted differently
     * depending on which one ran last. A page whose twenty-one low-confidence
     * fingerprints score Low came up red on the page-load repaint and turned
     * teal the moment the popup opened and repainted it by difficulty.
     *
     * Difficulty is the rule, because it is what the popup shows next to the
     * count and what the history rows are graded by. The count thresholds
     * survive only as the fallback for a cached scan written before results
     * were stored alongside the total — the one case that cannot know better.
     *
     * @param {Array|null} findings - The run's detections, when available.
     * @param {number|null} total - Detection count, for the fallback.
     * @param {Object|null} taxonomyCoordinatorInstance - Live catalog, if started.
     * @returns {Promise<string>} A colour from the configured badge palette.
     */
    static async resolveBadgeTint(findings, total = null, taxonomyCoordinatorInstance = null) {
        const badgePalette = await TaxonomyCatalog.resolveConfiguredBadgePalette(taxonomyCoordinatorInstance);
        const localFindings = Array.isArray(findings) ? findings : null;

        if (localFindings && localFindings.length > 0 && typeof FindingMetrics !== 'undefined') {
            const avgEvidence = FindingMetrics.measureAverageEvidence(localFindings);
            const localDifficulty = FindingMetrics.resolveDifficultyLevel(localFindings, avgEvidence);
            if (localDifficulty === 'High') return badgePalette.high;
            if (localDifficulty === 'Medium') return badgePalette.medium;
            return badgePalette.low;
        }

        const localTotal = Number.isFinite(total)
            ? total
            : (localFindings ? localFindings.length : 0);
        if (localTotal >= BadgeTokens.THRESHOLDS.HIGH) return badgePalette.high;
        if (localTotal >= BadgeTokens.THRESHOLDS.MEDIUM) return badgePalette.medium;
        return badgePalette.low;
    }
}

if (typeof window !== 'undefined') {
    window.TaxonomyCatalog = TaxonomyCatalog;
}
