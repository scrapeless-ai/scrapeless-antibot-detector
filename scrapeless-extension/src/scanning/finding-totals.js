/**
 * DetectionCategorySummary - canonical category buckets for detection totals.
 *
 * Every result belongs to exactly one bucket so the rendered breakdown always
 * adds up to the displayed detection count, including custom detector data.
 */
const FindingTotals = (() => {
    const taxonomyAliases = new Map([
        ['antibot', 'antibot'],
        ['waf', 'antibot'],
        ['captcha', 'captcha'],
        ['fingerprint', 'fingerprint'],
        ['fingerprinting', 'fingerprint']
    ]);

    function composeEmptyTaxonomyCounts() {
        return {
            antibot: 0,
            captcha: 0,
            fingerprint: 0,
            other: 0
        };
    }

    function canonicalizeTaxonomyLookup(findingsPane) {
        const taxonomyLabel = findingsPane?.category ?? findingsPane?.detector?.category ?? '';
        const normalizedTaxonomyLabel = String(taxonomyLabel)
            .trim()
            .toLowerCase()
            .replace(/[^a-z]/g, '');

        return taxonomyAliases.get(normalizedTaxonomyLabel) || 'other';
    }

    function totalFindingsByTaxonomy(findings) {
        const taxonomyCounts = composeEmptyTaxonomyCounts();
        const scanOutcomes = Array.isArray(findings) ? findings : [];

        for (const findingsPane of scanOutcomes) {
            const taxonomyLookup = canonicalizeTaxonomyLookup(findingsPane);
            taxonomyCounts[taxonomyLookup] += 1;
        }

        return taxonomyCounts;
    }

    return Object.freeze({
        normalizeCategoryKey: canonicalizeTaxonomyLookup,
        countDetectionsByCategory: totalFindingsByTaxonomy
    });
})();

if (typeof self !== 'undefined') {
    self.FindingTotals = FindingTotals;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FindingTotals;
}
