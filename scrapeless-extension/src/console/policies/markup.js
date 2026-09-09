/**
 * Rules Formatters Module
 *
 * Contains formatting and display utility methods:
 * - Date formatting (getRelativeTime, formatLastUpdated, etc.)
 * - Detection methods display
 * - Category/badge helpers
 * - Icon rendering
 *
 * These methods are added to the Rules prototype.
 */

// ============================================
// Date Formatting Methods
// ============================================

/**
 * Get relative time string from a date
 * @param {Date} date - Date object
 * @returns {string} Relative time string
 */
CatalogPresenter.prototype.resolveRelativeMoment = function(localDate) {
  const localNow = new Date();
  const localDiffMs = localNow - localDate;
  const localDiffSeconds = Math.floor(localDiffMs / 1000);
  const localDiffMinutes = Math.floor(localDiffSeconds / 60);
  const localDiffHours = Math.floor(localDiffMinutes / 60);
  const localDiffDays = Math.floor(localDiffHours / 24);
  const localDiffWeeks = Math.floor(localDiffDays / 7);
  const localDiffMonths = Math.floor(localDiffDays / 30);
  const localDiffYears = Math.floor(localDiffDays / 365);

  if (localDiffSeconds < 60) {
    return 'just now';
  } else if (localDiffMinutes < 60) {
    return localDiffMinutes === 1
      ? (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('timeOneMinuteAgo')) || '1 minute ago')
      : (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.encode('timeMinutesAgoLongFmt', localDiffMinutes)) || `${localDiffMinutes} minutes ago`);
  } else if (localDiffHours < 24) {
    return localDiffHours === 1
      ? (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('timeOneHourAgo')) || '1h ago')
      : (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.encode('timeHoursAgoLongFmt', localDiffHours)) || `${localDiffHours}h ago`);
  } else if (localDiffDays < 7) {
    return localDiffDays === 1
      ? (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('timeOneDayAgo')) || '1 day ago')
      : (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.encode('timeDaysAgoLongFmt', localDiffDays)) || `${localDiffDays} days ago`);
  } else if (localDiffWeeks < 4) {
    return localDiffWeeks === 1
      ? (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('timeOneWeekAgo')) || '1 week ago')
      : (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.encode('timeWeeksAgoFmt', localDiffWeeks)) || `${localDiffWeeks} weeks ago`);
  } else if (localDiffMonths < 12) {
    return localDiffMonths === 1
      ? (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('timeOneMonthAgo')) || '1 month ago')
      : (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.encode('timeMonthsAgoFmt', localDiffMonths)) || `${localDiffMonths} months ago`);
  } else {
    return localDiffYears === 1
      ? (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.resolve('timeOneYearAgo')) || '1 year ago')
      : (((typeof LocaleRuntime !== 'undefined') && LocaleRuntime.encode('timeYearsAgoFmt', localDiffYears)) || `${localDiffYears} years ago`);
  }
};

/**
 * Format date in compact style
 * @param {Date} date - Date object
 * @returns {string} Formatted date string
 */
CatalogPresenter.prototype.encodeCompactDate = function(localDate) {
  const localMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const localDay = localDate.getDate();
  const localMonth = localMonths[localDate.getMonth()];
  const localYear = localDate.getFullYear();
  const localHours = localDate.getHours().toString().padStart(2, '0');
  const localMinutes = localDate.getMinutes().toString().padStart(2, '0');
  return `${localDay} ${localMonth} ${localYear}, ${localHours}:${localMinutes}`;
};

/**
 * Format last updated timestamp into friendly text
 * @param {string|number} rawTimestamp - Raw timestamp value
 * @returns {string} Formatted timestamp string
 */
CatalogPresenter.prototype.encodeLastUpdated = function(unprocessedTimestamp) {
  if (!unprocessedTimestamp) {
    return 'Unknown';
  }

  let decodedDate = null;

  // Handle numeric timestamps directly
  if (typeof unprocessedTimestamp === 'number') {
    const localNumericDate = new Date(unprocessedTimestamp);
    if (!Number.isNaN(localNumericDate.getTime())) {
      decodedDate = localNumericDate;
    }
  }

  if (typeof unprocessedTimestamp === 'string') {
    let localNormalized = unprocessedTimestamp.trim();

    // Support legacy format "YYYY-MM-DD" by adding midnight time
    if (/^\d{4}-\d{2}-\d{2}$/.test(localNormalized)) {
      localNormalized = `${localNormalized}T00:00:00`;
    }

    // Replace space separator with T for ISO compatibility
    if (localNormalized.includes(' ') && !localNormalized.includes('T')) {
      localNormalized = localNormalized.replace(' ', 'T');
    }

    const localDateObj = new Date(localNormalized);
    if (!Number.isNaN(localDateObj.getTime())) {
      decodedDate = localDateObj;
    }
  }

  if (!decodedDate) {
    return String(unprocessedTimestamp);
  }

  // Format: "relative time (absolute time)"
  const relativeMoment = this.resolveRelativeMoment(decodedDate);
  const localCompactDate = this.encodeCompactDate(decodedDate);

  return `${relativeMoment} (${localCompactDate})`;
};

/**
 * Get timestamp for sorting
 * @param {string|number} rawTimestamp - Raw timestamp value
 * @returns {number} Timestamp in milliseconds
 */
CatalogPresenter.prototype.resolveSortTimestamp = function(unprocessedTimestamp) {
  if (!unprocessedTimestamp) {
    return 0;
  }

  if (typeof unprocessedTimestamp === 'number') {
    return unprocessedTimestamp;
  }

  if (typeof unprocessedTimestamp === 'string') {
    let localNormalized = unprocessedTimestamp.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(localNormalized)) {
      localNormalized = `${localNormalized}T00:00:00`;
    }

    if (localNormalized.includes(' ') && !localNormalized.includes('T')) {
      localNormalized = localNormalized.replace(' ', 'T');
    }

    const decoded = new Date(localNormalized);
    if (!Number.isNaN(decoded.getTime())) {
      return decoded.getTime();
    }
  }

  return 0;
};

// ============================================
// Detection Methods Display
// ============================================

/**
 * Get detection methods HTML from detector data
 * @param {object} detector - Detector object
 * @returns {string} HTML for detection method tags
 */
CatalogPresenter.prototype.resolveScanPhases = function(rule) {
  let phasesMarkup = '';

  // Get detection methods from the detection object keys
  let scanPhases = null;
  if (rule.detection && typeof rule.detection === 'object') {
    scanPhases = Object.keys(rule.detection).filter(lookupKey =>
      rule.detection[lookupKey] &&
      (Array.isArray(rule.detection[lookupKey]) ? rule.detection[lookupKey].length > 0 : true)
    );
  }

  // Add detection methods from detector data
  if (scanPhases && Array.isArray(scanPhases)) {
    scanPhases.forEach((phase) => {
      const phaseStr = typeof phase === 'string' ? phase : phase.name || phase.type || 'Unknown';

      // Get dynamic color from CategoryManager tags using original methodStr (preserve underscores)
      const tagPalette = this.taxonomy.resolveTagTone(phaseStr);

      // Format the name for display only (replace underscores and uppercase)
      const phaseLabel = phaseStr.replace(/_/g, ' ').toUpperCase();

      if (tagPalette && tagPalette !== '#666666') {
        // Parse hex color to RGB for semi-transparent background
        const localHex = tagPalette.replace('#', '');
        const localR = parseInt(localHex.substring(0, 2), 16);
        const localG = parseInt(localHex.substring(2, 4), 16);
        const rightValue = parseInt(localHex.substring(4, 6), 16);
        // Use muted/subtle style: semi-transparent background with colored text
        phasesMarkup += `<span class="method-tag" style="background: rgba(${localR}, ${localG}, ${rightValue}, 0.25); color: ${tagPalette}; border: 1px solid rgba(${localR}, ${localG}, ${rightValue}, 0.4);">${phaseLabel}</span>`;
      } else {
        // Fallback to CSS class
        const localBadgeClass = this.resolvePhaseBadgeClass(phaseStr);
        phasesMarkup += `<span class="method-tag ${localBadgeClass}">${phaseLabel}</span>`;
      }
    });
  } else {
    // Fallback: create detection methods based on category and add detector name
    const taxonomyPhase = this.resolveTaxonomyPhase(rule.category);
    const taxonomyClass = this.resolveTaxonomyClass(rule.category);

    if (taxonomyPhase) {
      phasesMarkup += `<span class="method-tag ${taxonomyClass}">${taxonomyPhase}</span>`;
    }

    // Add detector name as secondary method if different from category
    if (rule.displayName && rule.displayName !== taxonomyPhase) {
      phasesMarkup += `<span class="method-tag secondary">${rule.displayName}</span>`;
    }
  }

  return phasesMarkup;
};

// ============================================
// Category & Badge Helpers
// ============================================

/**
 * Get category-based detection method
 * @param {string} category - Category name
 * @returns {string} Detection method name
 */
CatalogPresenter.prototype.resolveTaxonomyPhase = function(taxonomy) {
  return this.taxonomy.resolveTaxonomyPresentLabel(taxonomy) || 'Detection';
};

/**
 * Get category-based CSS class for method tags
 * @param {string} category - Category name
 * @returns {string} CSS class name
 */
CatalogPresenter.prototype.resolveTaxonomyClass = function(taxonomy) {
  return this.taxonomy.resolveTaxonomyBadgeClass(taxonomy);
};

/**
 * Get method-specific badge class for detection method types
 * @param {string} method - Method name (cookies, headers, urls, scripts, etc.)
 * @returns {string} CSS class name
 */
CatalogPresenter.prototype.resolvePhaseBadgeClass = function(phase) {
  switch (phase?.toLowerCase()) {
    case 'cookies':
      return 'primary'; // Orange
    case 'headers':
      return 'secondary'; // Purple
    case 'urls':
    case 'url':
      return 'fingerprint'; // Purple
    case 'content':
    case 'script':
      return 'waf'; // Red
    default:
      return 'primary';
  }
};

// ============================================
// Icon Rendering
// ============================================

/**
 * Get detector icon HTML from detector data
 * @param {object} detector - Detector object
 * @param {string} [category] - Detector category
 * @returns {string} HTML for detector icon
 */
CatalogPresenter.prototype.resolveRuleGlyph = function(rule, taxonomy = '') {
  // Default Scrapeless icon fallback
  const consoleGlyph = chrome.runtime.getURL('brand/toolbar-128.png');
  const normalizedTaxonomy = String(taxonomy || rule?.category || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const isFingerprintTaxonomy = normalizedTaxonomy === 'fingerprint' || normalizedTaxonomy.includes('fingerprint');


  const localWrapFingerprintImage = (localSrc, localAlt, originKind, localFallback) => {
    const localFallbackAttr = localFallback ? ` data-fallback="${localFallback}"` : '';
    return `
      <div class="detector-icon-svg fingerprint-icon fingerprint-icon-shell">
        <img src="${localSrc}" alt="${localAlt}" class="detector-icon-img fingerprint-icon-image fingerprint-icon-image--${originKind}"${localFallbackAttr}>
      </div>
    `;
  };

  // Check for custom uploaded icon first
  if (rule.customIcon) {
    if (isFingerprintTaxonomy) {
      return localWrapFingerprintImage(rule.customIcon, 'Icon', 'custom', consoleGlyph);
    }
    return `<img src="${rule.customIcon}" alt="Icon" class="detector-icon-img" data-fallback="${consoleGlyph}">`;
  }

  // Try to get real icon from detector data
  if (rule.icon) {
    const lowerGlyph = rule.icon.toLowerCase ? rule.icon.toLowerCase() : rule.icon;

    if (lowerGlyph === 'default') {
      if (isFingerprintTaxonomy) {
        return localWrapFingerprintImage(consoleGlyph, 'Scrapeless Icon', 'default', '');
      }
      return `<img src="${consoleGlyph}" alt="Scrapeless Icon" class="detector-icon-img">`;
    }
    // If icon is "custom.png" or "custom", use the Scrapeless icon directly
    if (rule.icon === 'custom.png' || rule.icon === 'custom') {
      if (isFingerprintTaxonomy) {
        return localWrapFingerprintImage(consoleGlyph, 'Scrapeless Icon', 'default', '');
      }
      return `<img src="${consoleGlyph}" alt="Scrapeless Icon" class="detector-icon-img">`;
    }

    // Check for fingerprint SVG icons
    const fingerprintGlyph = typeof FingerprintGlyphs !== 'undefined'
      ? FingerprintGlyphs.resolve(lowerGlyph)
      : '';
    if (fingerprintGlyph) {
      return `<div class="detector-icon-svg fingerprint-icon fingerprint-icon-shell">${fingerprintGlyph}</div>`;
    }

    // Vendor marks are drawn too — the bundled third-party logo files are no
    // longer used, though the filenames stay as the keys so saved rules and
    // exports keep resolving.
    if (typeof BrandGlyphs !== 'undefined' && BrandGlyphs.performHas(lowerGlyph)) {
      return `<div class="detector-icon-svg vendor-icon vendor-icon-shell">${BrandGlyphs.resolve(lowerGlyph)}</div>`;
    }

    // If it's a URL, return as image
    if (rule.icon.startsWith('http') || rule.icon.startsWith('/')) {
      if (isFingerprintTaxonomy) {
        return localWrapFingerprintImage(rule.icon, 'Icon', 'builtin', consoleGlyph);
      }
      return `<img src="${rule.icon}" alt="Icon" class="detector-icon-img" data-fallback="${consoleGlyph}">`;
    }
    // If it's a filename, construct the path to the detectors/icons folder
    if (rule.icon.includes('.png') || rule.icon.includes('.jpg') || rule.icon.includes('.svg') || rule.icon.includes('.webp')) {
      if (isFingerprintTaxonomy) {
        return localWrapFingerprintImage(`detectors/icons/${rule.icon}`, `${rule.displayName || rule.name} Icon`, 'builtin', consoleGlyph);
      }
      return `<img src="detectors/icons/${rule.icon}" alt="${rule.displayName || rule.name} Icon" class="detector-icon-img" data-fallback="${consoleGlyph}">`;
    }
    // Otherwise return as emoji or text
    return rule.icon;
  }

  // Fallback to the Scrapeless default icon
  if (isFingerprintTaxonomy) {
    return localWrapFingerprintImage(consoleGlyph, 'Scrapeless Icon', 'default', '');
  }
  return `<img src="${consoleGlyph}" alt="Scrapeless Icon" class="detector-icon-img">`;
};
