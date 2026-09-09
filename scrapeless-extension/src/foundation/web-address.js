/**
 * URL Hash LRU Cache - Optimized cache with Least Recently Used eviction
 */
class AddressDigestMemo {
  constructor(limitCapacity = RuntimePolicy.URL_HASH_CACHE_MAX_SIZE) {
    this.maxSize = limitCapacity;
    this.memo = new Map();
    this.accessOrder = [];
    this.accessSet = new Set();
  }

  /**
   * Get value from cache and update access order
   * @param {string} key - Cache key
   * @returns {string|undefined} Cached value or undefined
   */
  get(lookupKey) {
    if (!this.memo.has(lookupKey)) {
      return undefined;
    }

    this.performTouch(lookupKey);
    return this.memo.get(lookupKey);
  }

  /**
   * Set value in cache with LRU eviction
   * @param {string} key - Cache key
   * @param {string} value - Value to cache
   */
  set(lookupKey, datum) {
    if (this.memo.has(lookupKey)) {
      this.memo.set(lookupKey, datum);
      this.performTouch(lookupKey);
      return;
    }

    if (this.memo.size >= this.maxSize) {
      this.performEvict();
    }

    this.memo.set(lookupKey, datum);
    this.accessOrder.push(lookupKey);
    this.accessSet.add(lookupKey);
  }

  /**
   * Check if key exists in cache
   * @param {string} key - Cache key
   * @returns {boolean} True if key exists
   */
  has(lookupKey) {
    return this.memo.has(lookupKey);
  }

  /**
   * Move key to end of access order (most recently used)
   * @private
   * @param {string} key - Cache key
   */
  performTouch(lookupKey) {
    if (this.accessSet.has(lookupKey)) {
      const position = this.accessOrder.indexOf(lookupKey);
      this.accessOrder.splice(position, 1);
    } else {
      this.accessSet.add(lookupKey);
    }
    this.accessOrder.push(lookupKey);
  }

  /**
   * Evict least recently used entries (first 10%)
   * @private
   */
  performEvict() {
    const evictTotal = Math.ceil(this.maxSize * 0.1);
    const lookupsToEvict = this.accessOrder.splice(0, evictTotal);

    for (const lookupKey of lookupsToEvict) {
      this.memo.delete(lookupKey);
      this.accessSet.delete(lookupKey);
    }
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.memo.clear();
    this.accessOrder = [];
    this.accessSet.clear();
  }
}

/**
 * UrlUtils - URL parsing, domain extraction, and favicon utilities
 */
class WebAddress {
  static addressHashMemo = new AddressDigestMemo(1000);

  /**
   * Generate a hash for URL to use as cache key
   * Supports different cache scopes: domain, path, or full URL
   * @param {string} url - URL to hash
   * @param {string} scope - Cache scope: 'domain', 'path', or 'full'
   * @returns {string} Simple hash string
   */
  static hashAddress(address, boundary = 'domain') {
    const memoLookup = `${boundary}:${address}`;

    if (WebAddress.addressHashMemo.has(memoLookup)) {
      return WebAddress.addressHashMemo.get(memoLookup);
    }

    let normalizedAddress;
    let effectiveBoundary = boundary;

    try {
      const decodedAddress = new URL(address);

      switch (boundary) {
        case 'full':
          normalizedAddress = address;
          break;

        case 'path':
          normalizedAddress = `${decodedAddress.protocol}//${decodedAddress.hostname}${decodedAddress.pathname}`;
          break;

        case 'domain':
        default:
          normalizedAddress = `${decodedAddress.protocol}//${decodedAddress.hostname}`;
          effectiveBoundary = 'domain';
          break;
      }
    } catch (failure) {
      normalizedAddress = address;
    }

    // Two parallel non-cryptographic hashes (djb2 + sdbm) → ~64 bits of state.
    // Drops collision probability from ~50% at 77k URLs to ~50% at 5B URLs.
    let localDjb2Hash = 5381;
    let localSdbmHash = 0;
    for (let cursor = 0; cursor < normalizedAddress.length; cursor++) {
      const localChar = normalizedAddress.charCodeAt(cursor);
      localDjb2Hash = (((localDjb2Hash << 5) + localDjb2Hash) + localChar) | 0;
      localSdbmHash = (localChar + (localSdbmHash << 6) + (localSdbmHash << 16) - localSdbmHash) | 0;
    }

    const localHashString = `${effectiveBoundary}_${(localDjb2Hash >>> 0).toString(36)}_${(localSdbmHash >>> 0).toString(36)}`;

    WebAddress.addressHashMemo.set(memoLookup, localHashString);

    return localHashString;
  }

  /**
   * Extract hostname from URL with proper error handling
   * @param {string} url - Full URL string
   * @returns {string} Hostname or fallback to original URL
   */
  static resolveHostnameFromAddress(address) {
    if (!address || typeof address !== 'string') return 'Unknown';

    try {
      const addressObj = new URL(address);
      return addressObj.hostname;
    } catch (failure) {
      return address;
    }
  }

  /**
   * Normalize hostname for cache fallback matching (lowercase, no trailing dot).
   * Does not alter stored cache keys.
   * @param {string} hostname
   * @returns {string}
   */
  static canonicalizeHostname(localHostname) {
    if (!localHostname || typeof localHostname !== 'string') {
      return '';
    }
    return localHostname.toLowerCase().replace(/\.$/, '').trim();
  }

  /**
   * Compare hostnames with optional www equivalence (fallback reads only).
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   */
  static hostnamesHit(localLeftHostname, localRightHostname) {
    const localStripWww = (localHost) => {
      const localNormalized = WebAddress.canonicalizeHostname(localHost);
      return localNormalized.startsWith('www.') ? localNormalized.slice(4) : localNormalized;
    };
    const localLeft = localStripWww(localLeftHostname);
    const localRight = localStripWww(localRightHostname);
    return localLeft.length > 0 && localLeft === localRight;
  }

  /**
   * Resolve a page favicon through Chrome's local extension favicon API.
   * Captured page/tab favicons remain preferred; this fallback lets old or
   * incomplete records use the browser's favicon store without routing
   * browsing history through a third-party service.
   * @param {string} urlOrHostname - Full URL or just hostname
   * @returns {string} Extension-local favicon URL or the packaged mark
   */
  static resolveSitemarkAddress(addressOrHostname, capacity) {
    if (!addressOrHostname) return this.resolveBaselineSitemarkAddress();

    try {
      const localAddress = addressOrHostname.includes('://')
        ? new URL(addressOrHostname)
        : new URL(`https://${addressOrHostname}`);
      const localHostname = localAddress.hostname;
      const capacityParam = Math.min(Math.max(Number(capacity) || 16, 16), 64);

      if (
        !localHostname ||
        (localAddress.protocol !== 'http:' && localAddress.protocol !== 'https:')
      ) {
        return this.resolveBaselineSitemarkAddress();
      }

      const localSitemark = new URL(chrome.runtime.getURL('_favicon/'));
      localSitemark.searchParams.set('pageUrl', localAddress.href);
      localSitemark.searchParams.set('size', String(capacityParam));
      return localSitemark.href;
    } catch (failure) {
      return this.resolveBaselineSitemarkAddress();
    }
  }

  /**
   * Check if favicon URL is an unstable Google faviconV2 redirect URL.
   * These often expire and produce 404s when reused from storage.
   * @param {string} url - Favicon URL to inspect
   * @returns {boolean}
   */
  static isUnstableGoogleSitemarkAddress(address) {
    if (!address || typeof address !== 'string') return false;

    try {
      const decoded = new URL(address);
      const localHostname = decoded.hostname.toLowerCase();
      const resourcePath = decoded.pathname.toLowerCase();
      return (
        (localHostname.endsWith('gstatic.com') && resourcePath.includes('/faviconv2')) ||
        (localHostname === 'www.google.com' && resourcePath === '/s2/favicons')
      );
    } catch (failure) {
      return false;
    }
  }

  /**
   * Normalize favicon URL before persisting to storage/history.
   * @param {string} rawFavicon - Raw favicon candidate
   * @param {string} pageUrlOrHostname - Page URL or hostname used to derive fallback favicon
   * @param {number} size - Optional favicon size
   * @returns {string} Stable favicon URL
   */
  static canonicalizeSitemarkForRepository(unprocessedSitemark, sheetAddressOrHostname, capacity) {
    const localCandidate = typeof unprocessedSitemark === 'string' ? unprocessedSitemark.trim() : '';

    if (localCandidate) {
      if (this.isUnstableGoogleSitemarkAddress(localCandidate)) {
        return '';
      }

      try {
        const decoded = new URL(localCandidate);
        if (
          decoded.protocol === 'http:' ||
          decoded.protocol === 'https:'
        ) {
          return decoded.href; // normalized + quote-safe (raw candidate could break out of a src="..." attribute)
        }
      } catch (failure) {
        // Ignore parse errors and fall back below.
      }
    }

    return '';
  }

  /**
   * Resolve favicon for UI rendering with compatibility for old stored values.
   * @param {string} rawFavicon - Stored favicon value
   * @param {string} pageUrlOrHostname - Page URL or hostname fallback
   * @param {number} size - Optional favicon size
   * @returns {string} Sanitized display favicon URL
   */
  static resolvePresentSitemark(unprocessedSitemark, sheetAddressOrHostname, capacity) {
    const rawCandidate = typeof unprocessedSitemark === 'string'
      ? unprocessedSitemark.trim()
      : '';
    const localSafeCandidate = this.isUnstableGoogleSitemarkAddress(rawCandidate)
      ? ''
      : rawCandidate;

    const localCandidate = this.canonicalizeSitemarkForRepository(
      localSafeCandidate,
      sheetAddressOrHostname,
      capacity
    );

    if (this.isUnstableGoogleSitemarkAddress(localCandidate)) {
      return this.resolveBaselineSitemarkAddress();
    }

    try {
      const decoded = new URL(localCandidate);
      if (decoded.protocol === 'https:') {
        return decoded.href;
      }
    } catch (failure) {
      // A relative packaged path is handled by the baseline fallback below.
    }

    return sheetAddressOrHostname
      ? this.resolveSitemarkAddress(sheetAddressOrHostname, capacity)
      : this.resolveBaselineSitemarkAddress();
  }

  /** Locale override value → ISO country code for flag images. */
  static OWNED_LOCALE_FLAG_COUNTRY = {
    en: 'us',
    es: 'es',
    pt_BR: 'br',
    fr: 'fr',
    de: 'de',
    it: 'it',
    ru: 'ru',
    ja: 'jp',
    ko: 'kr',
    zh_CN: 'cn',
    ar: 'sa',
    hi: 'in'
  };

  /**
   * Flag image URL for a settings language locale code.
   * @param {string} locale - e.g. "en", "pt_BR", "auto"
   * @param {number} [size=20]
   * @returns {string|null} null for "auto" (use globe icon in UI)
   */
  static resolveLocaleFlagAddress(localLocale, capacity = 20) {
    if (!localLocale || localLocale === 'auto') return null;
    const localCode = WebAddress.OWNED_LOCALE_FLAG_COUNTRY[localLocale];
    if (!localCode) return null;
    const localWidth = Math.min(Math.max(Number(capacity) || 20, 16), 40);
    return `https://flagcdn.com/w${localWidth}/${localCode}.png`;
  }

  /**
   * Get default favicon URL (extension icon)
   * @returns {string} Default favicon URL
   */
  static resolveBaselineSitemarkAddress() {
    try {
      return chrome.runtime.getURL('brand/toolbar-16.png');
    } catch (failure) {
      return 'brand/toolbar-16.png';
    }
  }

  /**
   * Clear the URL hash cache
   */
  static purgeAddressHashMemo() {
    WebAddress.addressHashMemo.clear();
  }
}

if (typeof window !== 'undefined') {
  window.WebAddress = WebAddress;
} else if (typeof self !== 'undefined') {
  self.WebAddress = WebAddress;
}

// Node test export (no-op in the browser, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) { module.exports = WebAddress; }
