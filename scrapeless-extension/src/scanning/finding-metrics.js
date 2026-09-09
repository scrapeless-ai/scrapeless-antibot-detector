/**
 * DetectionUtils - Shared detection confidence and difficulty analysis
 */
class FindingMetrics {

  /**
   * Normalize difficulty label to canonical values.
   * @param {string} value
   * @returns {'Low'|'Medium'|'High'|null}
   */
  static canonicalizeDifficulty(datum) {
    if (typeof datum !== 'string') return null;
    const localNormalized = datum.trim().toLowerCase();
    if (localNormalized === 'low') return 'Low';
    if (localNormalized === 'medium') return 'Medium';
    if (localNormalized === 'high') return 'High';
    return null;
  }

  /**
   * Convert difficulty label to numeric rank.
   * @param {string} label
   * @returns {0|1|2|3}
   */
  static resolveDifficultyRank(localLabel) {
    const localNormalized = FindingMetrics.canonicalizeDifficulty(localLabel);
    if (localNormalized === 'Low') return 1;
    if (localNormalized === 'Medium') return 2;
    if (localNormalized === 'High') return 3;
    return 0;
  }

  /**
   * Convert numeric rank back to difficulty label.
   * @param {number} rank
   * @returns {'Low'|'Medium'|'High'}
   */
  static performRankToDifficulty(localRank) {
    if (localRank >= 3) return 'High';
    if (localRank >= 2) return 'Medium';
    return 'Low';
  }

  /**
   * Get default detector difficulty for a category.
   * @param {string} category
   * @returns {'Low'|'Medium'|'High'}
   */
  static baselineDifficultyForTaxonomy(taxonomy) {
    const localNormalized = String(taxonomy || '').toLowerCase().replace(/[^a-z]/g, '');
    if (localNormalized === 'captcha') return 'High';
    if (localNormalized === 'fingerprint') return 'Low';
    if (localNormalized === 'antibot') return 'Medium';
    return 'Medium';
  }

  /**
   * Compute the average confidence for a list of detections (0-100).
   * @param {Array} detections
   * @returns {number}
   */
  static measureAverageEvidence(findings = []) {
    if (!Array.isArray(findings) || findings.length === 0) return 0;
    const aggregate = findings.reduce((localSum, localD) => localSum + (localD?.confidence || 0), 0);
    return Math.round(aggregate / findings.length);
  }

  /**
   * Compute a difficulty level for a set of detections.
   * This is a UI-facing heuristic (Low/Medium/High), not a security guarantee.
   * @param {Array} detections
   * @param {number} [avgConfidence]
   * @returns {'Low'|'Medium'|'High'}
   */
  static resolveDifficultyLevel(findings = [], avgEvidence = undefined) {
    const aggregateFindings = Array.isArray(findings) ? findings.length : 0;
    const safeFindings = Array.isArray(findings) ? findings : [];

    const safeAvgEvidence = Number.isFinite(avgEvidence)
      ? avgEvidence
      : FindingMetrics.measureAverageEvidence(findings);

    const normalizedTaxonomies = safeFindings.map((localD) => {
      const taxonomy = localD?.category ?? localD?.detector?.category ?? '';
      return String(taxonomy).toLowerCase();
    });

    const antiCaptchaTotal = normalizedTaxonomies.filter((taxonomy) => {
      return taxonomy.includes('anti') || taxonomy.includes('captcha');
    }).length;

    // Fingerprint-only detections (even many of them) shouldn't imply a "hard" page.
    const localFingerprintOnly = aggregateFindings > 0 && normalizedTaxonomies.every((taxonomy) => {
      return taxonomy.includes('fingerprint');
    });

    const isHighTierLabel = (localD) => {
      const label = (localD?.detector?.name || localD?.detector || localD?.name || '').toLowerCase();
      return label.includes('shape security') ||
        label.includes('shapesecurity') ||
        label.includes('hcaptcha') ||
        label.includes('arkose') ||
        label.includes('funcaptcha');
    };

    const highTierHighEvidence = safeFindings.some((localD) => {
      return isHighTierLabel(localD) && (localD?.confidence || 0) >= 80;
    });

    let localHeuristicDifficulty = 'Low';
    if (highTierHighEvidence) localHeuristicDifficulty = 'High';
    else if (localFingerprintOnly) localHeuristicDifficulty = 'Low';
    else if (antiCaptchaTotal >= 2 || aggregateFindings > 2 || safeAvgEvidence > 60) localHeuristicDifficulty = 'Medium';

    // Manual detector difficulty acts as a minimum floor for aggregate difficulty.
    const localManualFloorRank = safeFindings.reduce((limitRank, findingsPane) => {
      const localManualDifficulty = FindingMetrics.canonicalizeDifficulty(
        findingsPane?.difficulty || findingsPane?.detector?.difficulty
      );
      return Math.max(limitRank, FindingMetrics.resolveDifficultyRank(localManualDifficulty));
    }, 0);

    const localHeuristicRank = FindingMetrics.resolveDifficultyRank(localHeuristicDifficulty);
    return FindingMetrics.performRankToDifficulty(Math.max(localHeuristicRank, localManualFloorRank));
  }

  /**
   * Compute difficulty + default color.
   * @param {Array} detections
   * @param {number} [avgConfidence]
   * @returns {{difficulty: 'Low'|'Medium'|'High', difficultyColor: string}}
   */
  static resolveDifficultyDetail(findings = [], avgEvidence = undefined) {
    const localDifficulty = FindingMetrics.resolveDifficultyLevel(findings, avgEvidence);
    const palette = {
      High: '#ef4444',
      Medium: '#f59e0b',
      Low: '#22c55e'
    };
    return { difficulty: localDifficulty, difficultyColor: palette[localDifficulty] || palette.Low };
  }
}

if (typeof window !== 'undefined') {
  window.FindingMetrics = FindingMetrics;
} else if (typeof self !== 'undefined') {
  self.FindingMetrics = FindingMetrics;
}
