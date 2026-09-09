/**
 * Analytics data frame - turns the raw detection archive into the aggregates
 * the charts consume.
 *
 * The archive is the only source of truth here. Every number on the analytics
 * page is derived from `scrapeless_history` entries, so nothing is stored twice
 * and the page can never drift from what the History pane shows.
 */
class AnalyticsFrame {

    /** Canonical taxonomy keys. Order is the categorical palette slot order. */
    static get TAXONOMY_ORDER() {
        return ['antibot', 'captcha', 'fingerprint', 'other'];
    }

    static get TAXONOMY_LABELS() {
        return {
            antibot: 'Anti-Bot',
            captcha: 'Captcha',
            fingerprint: 'Fingerprint',
            other: 'Other'
        };
    }

    static get GRADE_ORDER() {
        return ['low', 'medium', 'high'];
    }

    /** Fixed column order for the signal matrix, roughly network-to-runtime. */
    static get SIGNAL_ORDER() {
        return ['cookie', 'header', 'url', 'content', 'dom', 'window', 'js_hooks', 'payload', 'other'];
    }

    /**
     * The last label of a hostname. Not a public-suffix parse - `.co.uk` reads
     * as `uk` - so it is labelled "domain ending" rather than "TLD".
     */
    static domainEnding(host) {
        const labels = String(host || '').split('.').filter(Boolean);
        return labels.length > 1 ? labels[labels.length - 1].toLowerCase() : '';
    }

    static get SIGNAL_LABELS() {
        return {
            cookie: 'Cookie',
            header: 'Header',
            url: 'URL',
            content: 'Content',
            dom: 'DOM',
            window: 'Window',
            payload: 'Payload',
            js_hooks: 'JS hooks'
        };
    }

    /**
     * Detections arrive keyed either by the catalog folder ("antibot") or by the
     * detector file's display category ("Anti-Bot"). Both fold to one key.
     */
    static canonicalizeTaxonomy(label) {
        const token = String(label || '').toLowerCase().replace(/[\s_-]/g, '');
        if (token === 'antibot') return 'antibot';
        if (token === 'captcha') return 'captcha';
        if (token === 'fingerprint' || token === 'fingerprinting') return 'fingerprint';
        return 'other';
    }

    static canonicalizeGrade(label) {
        const token = String(label || '').toLowerCase();
        if (token === 'low' || token === 'easy') return 'low';
        if (token === 'high' || token === 'hard') return 'high';
        return 'medium';
    }

    static canonicalizeSignalType(label) {
        const token = String(label || '').toLowerCase().replace(/[\s-]/g, '_');
        return AnalyticsFrame.SIGNAL_LABELS[token] ? token : 'other';
    }

    /**
     * Read the archive out of extension storage. Returns null when the page is
     * open over file:// (no extension context) so the caller can offer the
     * import path instead of showing a false "no data" state.
     */
    static async readArchive() {
        const bridge = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
            ? chrome.storage.local
            : null;
        if (!bridge) return null;

        const everything = await bridge.get(['scrapeless_history']);
        return AnalyticsFrame.adoptArchivePayload(everything.scrapeless_history);
    }

    /**
     * Accept either the sealed record, the retired envelope, or a bare array -
     * the same three shapes the History pane reads, so an export taken from any
     * release of the extension loads here.
     */
    static adoptArchivePayload(payload) {
        if (!payload) return [];
        let decoded = payload;
        if (typeof decoded === 'string') {
            try {
                decoded = JSON.parse(decoded);
            } catch (failure) {
                return [];
            }
        }
        if (Array.isArray(decoded)) return decoded;
        if (Array.isArray(decoded.entries)) return decoded.entries;
        if (Array.isArray(decoded.items)) return decoded.items;
        return [];
    }

    /** Flatten one archive entry into the rows the aggregates iterate. */
    static explodeEntry(entry) {
        const stamp = Number(entry?.timestamp) || Date.parse(entry?.timestamp || '') || 0;
        const host = entry?.hostname
            || (() => {
                try { return new URL(entry?.url || '').hostname; } catch (failure) { return ''; }
            })();

        const findings = Array.isArray(entry?.detections) ? entry.detections : [];
        return {
            id: entry?.id || '',
            stamp,
            host,
            url: entry?.url || '',
            title: entry?.title || '',
            findings: findings.map((finding) => ({
                taxonomy: AnalyticsFrame.canonicalizeTaxonomy(finding?.category || finding?.detector?.category),
                vendor: finding?.detector?.name || finding?.name || 'Unknown',
                vendorId: finding?.detector?.id || finding?.id || '',
                grade: AnalyticsFrame.canonicalizeGrade(finding?.difficulty || finding?.detector?.difficulty),
                confidence: Number.isFinite(Number(finding?.confidence)) ? Number(finding.confidence) : null,
                signals: Array.isArray(finding?.signals) ? finding.signals : []
            }))
        };
    }

    /** Rows inside the active filter slice, newest first. */
    static sliceRows(entries, filters = {}) {
        const since = Number(filters.since) || 0;
        // Inclusive upper bound. A custom range hands us the last day's final
        // millisecond, not its midnight, so the closing day stays in the slice.
        const until = Number(filters.until) || 0;
        const taxonomy = filters.taxonomy && filters.taxonomy !== 'all' ? filters.taxonomy : null;
        const needle = String(filters.host || '').trim().toLowerCase();

        return entries
            .map(AnalyticsFrame.explodeEntry)
            .filter((row) => row.stamp > 0)
            .filter((row) => (since ? row.stamp >= since : true))
            .filter((row) => (until ? row.stamp <= until : true))
            .filter((row) => (needle
                ? (row.host.toLowerCase().includes(needle) || row.title.toLowerCase().includes(needle))
                : true))
            .map((row) => (taxonomy
                ? { ...row, findings: row.findings.filter((finding) => finding.taxonomy === taxonomy) }
                : row))
            .filter((row) => (taxonomy ? row.findings.length > 0 : true))
            .sort((left, right) => right.stamp - left.stamp);
    }

    static dayToken(stamp) {
        const moment = new Date(stamp);
        const month = String(moment.getMonth() + 1).padStart(2, '0');
        const day = String(moment.getDate()).padStart(2, '0');
        return `${moment.getFullYear()}-${month}-${day}`;
    }

    /**
     * Build every aggregate in one pass over the slice.
     * @param {Array} entries - raw archive entries
     * @param {object} filters - { since, until, taxonomy, host }
     */
    static compile(entries, filters = {}) {
        const rows = AnalyticsFrame.sliceRows(entries, filters);

        const taxonomyTally = new Map(AnalyticsFrame.TAXONOMY_ORDER.map((key) => [key, 0]));
        const gradeTally = { low: 0, medium: 0, high: 0 };
        const vendorTally = new Map();
        const siteTally = new Map();
        const signalTally = new Map();
        const dayTally = new Map();
        const confidenceBins = new Array(10).fill(0);
        const perPageTally = new Map();
        const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
        const pairTally = new Map();
        const suffixTally = new Map();
        const layerTally = new Map();
        const evidenceTally = new Map();
        const gradeByTaxonomy = new Map(AnalyticsFrame.TAXONOMY_ORDER.map((key) => [key, { sum: 0, count: 0, low: 100, high: 0 }]));
        const signalByTaxonomy = new Map(AnalyticsFrame.TAXONOMY_ORDER.map(
            (key) => [key, new Map(AnalyticsFrame.SIGNAL_ORDER.map((type) => [type, 0]))]
        ));

        let detectionTotal = 0;
        let protectedPages = 0;
        let confidenceSum = 0;
        let confidenceCount = 0;

        for (const row of rows) {
            const moment = new Date(row.stamp);
            heat[moment.getDay()][moment.getHours()] += 1;

            const dayKey = AnalyticsFrame.dayToken(row.stamp);
            if (!dayTally.has(dayKey)) {
                dayTally.set(dayKey, {
                    day: dayKey,
                    stamp: new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).getTime(),
                    antibot: 0,
                    captcha: 0,
                    fingerprint: 0,
                    other: 0,
                    total: 0,
                    pages: 0,
                    hits: 0
                });
            }
            const dayRow = dayTally.get(dayKey);
            dayRow.pages += 1;
            if (row.findings.length > 0) dayRow.hits += 1;

            const ending = AnalyticsFrame.domainEnding(row.host);
            if (ending) {
                if (!suffixTally.has(ending)) suffixTally.set(ending, { ending, scans: 0, sites: new Set(), count: 0 });
                const suffixRow = suffixTally.get(ending);
                suffixRow.scans += 1;
                suffixRow.sites.add(row.host);
                suffixRow.count += row.findings.length;
            }

            const layers = new Set(row.findings.map((finding) => finding.taxonomy)).size;
            layerTally.set(layers, (layerTally.get(layers) || 0) + 1);

            if (row.host) {
                if (!siteTally.has(row.host)) {
                    siteTally.set(row.host, { host: row.host, count: 0, pages: 0, vendors: new Set(), lastSeen: 0 });
                }
                const siteRow = siteTally.get(row.host);
                siteRow.pages += 1;
                siteRow.lastSeen = Math.max(siteRow.lastSeen, row.stamp);
            }

            if (row.findings.length > 0) protectedPages += 1;
            perPageTally.set(row.findings.length, (perPageTally.get(row.findings.length) || 0) + 1);

            const vendorsOnPage = [];
            for (const finding of row.findings) {
                detectionTotal += 1;
                taxonomyTally.set(finding.taxonomy, (taxonomyTally.get(finding.taxonomy) || 0) + 1);
                gradeTally[finding.grade] += 1;
                dayRow[finding.taxonomy] += 1;
                dayRow.total += 1;

                if (!vendorTally.has(finding.vendor)) {
                    vendorTally.set(finding.vendor, {
                        name: finding.vendor,
                        taxonomy: finding.taxonomy,
                        count: 0,
                        sites: new Set(),
                        confidenceSum: 0,
                        confidenceCount: 0
                    });
                }
                const vendorRow = vendorTally.get(finding.vendor);
                vendorRow.count += 1;
                if (row.host) vendorRow.sites.add(row.host);

                if (row.host && siteTally.has(row.host)) {
                    const siteRow = siteTally.get(row.host);
                    siteRow.count += 1;
                    siteRow.vendors.add(finding.vendor);
                }

                if (finding.confidence !== null) {
                    const clamped = Math.max(0, Math.min(100, finding.confidence));
                    confidenceBins[Math.min(9, Math.floor(clamped / 10))] += 1;
                    confidenceSum += clamped;
                    confidenceCount += 1;
                    vendorRow.confidenceSum += clamped;
                    vendorRow.confidenceCount += 1;

                    const spread = gradeByTaxonomy.get(finding.taxonomy);
                    spread.sum += clamped;
                    spread.count += 1;
                    spread.low = Math.min(spread.low, clamped);
                    spread.high = Math.max(spread.high, clamped);
                }

                const matrixRow = signalByTaxonomy.get(finding.taxonomy);
                for (const signal of finding.signals) {
                    const type = AnalyticsFrame.canonicalizeSignalType(signal?.type);
                    signalTally.set(type, (signalTally.get(type) || 0) + 1);
                    matrixRow.set(type, (matrixRow.get(type) || 0) + 1);

                    // The literal thing that gave the vendor away - a cookie
                    // name, a header, a global. Keyed with its type so a cookie
                    // and a header sharing a name stay separate rows.
                    const token = String(signal?.value ?? signal?.pattern ?? '').trim();
                    if (token && token.length <= 80) {
                        const evidenceKey = `${type} ${token}`;
                        if (!evidenceTally.has(evidenceKey)) {
                            evidenceTally.set(evidenceKey, { token, type, count: 0, vendors: new Set() });
                        }
                        const evidenceRow = evidenceTally.get(evidenceKey);
                        evidenceRow.count += 1;
                        evidenceRow.vendors.add(finding.vendor);
                    }
                }

                if (!vendorsOnPage.includes(finding.vendor)) vendorsOnPage.push(finding.vendor);
            }

            for (let left = 0; left < vendorsOnPage.length; left += 1) {
                for (let right = left + 1; right < vendorsOnPage.length; right += 1) {
                    const pair = [vendorsOnPage[left], vendorsOnPage[right]].sort();
                    const pairKey = `${pair[0]} ${pair[1]}`;
                    pairTally.set(pairKey, (pairTally.get(pairKey) || 0) + 1);
                }
            }
        }

        const vendors = [...vendorTally.values()]
            .map((vendor) => ({
                name: vendor.name,
                taxonomy: vendor.taxonomy,
                count: vendor.count,
                sites: vendor.sites.size,
                avgConfidence: vendor.confidenceCount ? Math.round(vendor.confidenceSum / vendor.confidenceCount) : null
            }))
            .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

        const sites = [...siteTally.values()]
            .map((site) => ({
                host: site.host,
                count: site.count,
                pages: site.pages,
                vendors: site.vendors.size,
                lastSeen: site.lastSeen
            }))
            .sort((left, right) => right.count - left.count || right.pages - left.pages || left.host.localeCompare(right.host));

        const byDay = [...dayTally.values()].sort((left, right) => left.stamp - right.stamp);

        // Cumulative distinct vendors, walked forward in time. `rows` is newest
        // first, so this walks a reversed copy rather than re-sorting in place.
        const seenVendors = new Set();
        const coverageByDay = new Map();
        for (const row of [...rows].reverse()) {
            for (const finding of row.findings) seenVendors.add(finding.vendor);
            coverageByDay.set(AnalyticsFrame.dayToken(row.stamp), seenVendors.size);
        }
        const coverage = byDay.map((row) => ({
            day: row.day,
            stamp: row.stamp,
            vendors: coverageByDay.get(row.day) || 0
        }));

        const rateByDay = byDay.map((row) => ({
            day: row.day,
            stamp: row.stamp,
            scans: row.pages,
            hits: row.hits,
            rate: row.pages ? Math.round((row.hits / row.pages) * 100) : 0
        }));

        const suffixes = [...suffixTally.values()]
            .map((row) => ({ ending: row.ending, scans: row.scans, sites: row.sites.size, count: row.count }))
            .sort((left, right) => right.count - left.count || right.scans - left.scans);

        const layering = [...layerTally.entries()]
            .map(([layers, pages]) => ({ layers, pages }))
            .sort((left, right) => left.layers - right.layers);

        const evidence = [...evidenceTally.values()]
            .map((row) => ({ token: row.token, type: row.type, count: row.count, vendors: row.vendors.size }))
            .sort((left, right) => right.count - left.count || left.token.localeCompare(right.token));

        const confidenceByTaxonomy = AnalyticsFrame.TAXONOMY_ORDER
            .map((key) => {
                const spread = gradeByTaxonomy.get(key);
                return {
                    key,
                    label: AnalyticsFrame.TAXONOMY_LABELS[key],
                    low: spread.count ? spread.low : 0,
                    high: spread.count ? spread.high : 0,
                    average: spread.count ? Math.round(spread.sum / spread.count) : 0,
                    count: spread.count
                };
            })
            .filter((slot) => slot.count > 0);

        const activeTaxonomies = AnalyticsFrame.TAXONOMY_ORDER
            .filter((key) => (taxonomyTally.get(key) || 0) > 0);
        const signalMatrix = {
            rows: activeTaxonomies.map((key) => AnalyticsFrame.TAXONOMY_LABELS[key]),
            columns: AnalyticsFrame.SIGNAL_ORDER
                .filter((type) => activeTaxonomies.some((key) => signalByTaxonomy.get(key).get(type) > 0))
                .map((type) => ({ type, label: AnalyticsFrame.SIGNAL_LABELS[type] || 'Other' })),
            matrix: []
        };
        signalMatrix.matrix = activeTaxonomies.map(
            (key) => signalMatrix.columns.map((column) => signalByTaxonomy.get(key).get(column.type) || 0)
        );
        signalMatrix.max = Math.max(0, ...signalMatrix.matrix.flat());
        // Each row is normalised to its own total. Colouring by the raw count
        // would just repaint "anti-bot is the biggest category", which the
        // category split already says; the question here is which signal types
        // characterise each category, and that only reads across shares.
        signalMatrix.shares = signalMatrix.matrix.map((row) => {
            const rowTotal = row.reduce((sum, value) => sum + value, 0);
            return row.map((value) => (rowTotal ? Math.round((value / rowTotal) * 100) : 0));
        });

        const signals = [...signalTally.entries()]
            .map(([type, count]) => ({ type, label: AnalyticsFrame.SIGNAL_LABELS[type] || 'Other', count }))
            .sort((left, right) => right.count - left.count);

        const perPage = [...perPageTally.entries()]
            .map(([findings, pages]) => ({ findings, pages }))
            .sort((left, right) => left.findings - right.findings);

        const pairs = [...pairTally.entries()]
            .map(([pairKey, count]) => {
                const [left, right] = pairKey.split(' ');
                return { left, right, count };
            })
            .sort((left, right) => right.count - left.count);

        const stamps = rows.map((row) => row.stamp);

        return {
            rows,
            span: {
                from: stamps.length ? Math.min(...stamps) : 0,
                to: stamps.length ? Math.max(...stamps) : 0,
                days: byDay.length
            },
            totals: {
                pages: rows.length,
                detections: detectionTotal,
                vendors: vendors.length,
                sites: sites.length,
                protectedPages,
                cleanPages: rows.length - protectedPages,
                protectedRate: rows.length ? Math.round((protectedPages / rows.length) * 100) : 0,
                perPage: rows.length ? detectionTotal / rows.length : 0,
                avgConfidence: confidenceCount ? Math.round(confidenceSum / confidenceCount) : null
            },
            byTaxonomy: AnalyticsFrame.TAXONOMY_ORDER
                .map((key) => ({ key, label: AnalyticsFrame.TAXONOMY_LABELS[key], count: taxonomyTally.get(key) || 0 }))
                .filter((slot) => slot.count > 0),
            byGrade: AnalyticsFrame.GRADE_ORDER.map((key) => ({ key, count: gradeTally[key] })),
            byDay,
            coverage,
            rateByDay,
            vendors,
            sites,
            suffixes,
            layering,
            evidence,
            signals,
            signalMatrix,
            confidenceByTaxonomy,
            perPage,
            pairs,
            confidence: confidenceBins.map((count, index) => ({ from: index * 10, to: index * 10 + 10, count })),
            heat: { matrix: heat, max: Math.max(0, ...heat.flat()) }
        };
    }
}

if (typeof window !== 'undefined') window.AnalyticsFrame = AnalyticsFrame;
if (typeof module !== 'undefined' && module.exports) module.exports = AnalyticsFrame;
