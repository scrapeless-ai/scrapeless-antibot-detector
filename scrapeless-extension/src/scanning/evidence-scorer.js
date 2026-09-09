/**
 * ConfidenceManager - Handles confidence calculation for detections
 * Simplified: Only max confidence calculation is used
 */
class EvidenceScorer {
  constructor() {
    // Only max confidence calculation is used.
  }

  /**
   * Calculate overall confidence from detection matches
   * Uses maximum confidence value from all matches
   * @param {Array} matches - Array of detection matches with confidence values
   * @returns {number} Overall confidence (0-100)
   */
  deriveEvidence(hits = []) {
    if (!hits || hits.length === 0) {
      return 0;
    }
    return this.deriveLimitEvidence(hits);
  }

  /**
   * Calculate maximum confidence from all matches
   * @param {Array} matches - Array of detection matches
   * @returns {number} Maximum confidence value
   */
  deriveLimitEvidence(hits) {
    let limitEvidence = 0;
    for (const hit of hits) {
      if (hit.confidence && hit.confidence > limitEvidence) {
        limitEvidence = hit.confidence;
      }
    }
    return limitEvidence;
  }
}

// Node test export (no-op in the browser, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) { module.exports = EvidenceScorer; }
