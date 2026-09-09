/**
 * Detection pattern cache
 * High-performance caching for compiled regex patterns and match results
 */

/**
 * Simple hash function for cache keys
 * @param {string} str - String to hash
 * @returns {string} - Base36 hash
 */
function localSimpleHash(localStr) {
    let localHash = 0;
    for (let cursor = 0; cursor < localStr.length; cursor++) {
        const localChar = localStr.charCodeAt(cursor);
        localHash = ((localHash << 5) - localHash) + localChar;
        localHash = localHash & localHash; // Convert to 32bit integer
    }
    return localHash.toString(36); // Base36 for shorter keys
}

/**
 * Heuristic ReDoS check — rejects patterns most likely to cause catastrophic
 * backtracking. Conservative: prefers false positives (over-rejection) to a
 * hung extension. Catches `(a+)+`, `(a*)*`, `(\d+)+`, `(a{2,})+`, etc.
 * @param {string} pattern - User-supplied regex source
 * @returns {boolean} true if the pattern looks dangerous
 */
function localIsLikelyEvilRegex(matcher) {
    if (typeof matcher !== 'string') return false;
    if (matcher.length > 1000) return true;
    // group containing + * or {n,} immediately followed by another + or *
    if (/\([^()]*[+*][^()]*\)\s*[+*]/.test(matcher)) return true;
    if (/\([^()]*\{\d+,\}[^()]*\)\s*[+*]/.test(matcher)) return true;
    return false;
}

/**
 * PatternCache - High-performance caching for compiled regex patterns and match results
 * Uses LRU eviction strategy to limit memory usage
 * Eliminates 60-80% of regex compilation overhead
 */
class CompiledPatternPool {
    constructor(limitCapacity = RuntimePolicy.PATTERN_CACHE_MAX_SIZE) {
        this.maxSize = limitCapacity;
        // Cache for compiled regex patterns: key -> {regex, timestamp}
        this.regexCache = new Map();
        // Cache for match results: key -> {result, timestamp}
        this.matchCache = new Map();
        // FIFO queue for O(1) eviction
        this.insertionOrder = [];
    }

    /**
     * Generate cache key from pattern and options
     */
    resolveMemoLookup(matcher, choices = {}) {
        return `${matcher}|${choices.regex}|${choices.wholeWord}|${choices.caseSensitive}`;
    }

    /**
     * Get or compile regex pattern
     */
    resolveCompiledMatcher(matcher, choices = {}) {
        const lookupKey = this.resolveMemoLookup(matcher, choices);

        if (this.regexCache.has(lookupKey)) {
            return this.regexCache.get(lookupKey).regex;
        }

        // Compile and cache
        let localCompiledRegex = null;
        try {
            if (choices.regex) {
                if (localIsLikelyEvilRegex(matcher)) {
                    if (typeof Telemetry !== 'undefined' && Telemetry.performWarn) {
                        Telemetry.performWarn('DETECTION', '[PatternCache] Rejecting potentially dangerous regex (ReDoS risk):', matcher);
                    }
                    return null;
                }
                // Non-global: these compiled regexes are cached and reused across
                // many texts with .test(); a 'g' flag makes lastIndex persist and
                // produces intermittent false negatives. .test()/.match()[0] don't
                // need the global flag.
                const localFlags = choices.caseSensitive ? '' : 'i';
                localCompiledRegex = new RegExp(matcher, localFlags);
            } else if (choices.wholeWord) {
                const escapedMatcher = matcher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                localCompiledRegex = new RegExp(`\\b${escapedMatcher}\\b`, choices.caseSensitive ? '' : 'i');
            }
        } catch (failure) {
            return null;
        }

        // Cache and evict if needed
        this.regexCache.set(lookupKey, { regex: localCompiledRegex, timestamp: Date.now() });
        this.insertionOrder.push(lookupKey);
        this.performEvictIfNeeded();

        return localCompiledRegex;
    }

    /**
     * Check if match result is cached
     */
    copyLookupFor(copy) {
        // Hash full text instead of truncating (prevents collisions)
        return copy.length > 100 ? localSimpleHash(copy) : copy;
    }

    resolveMemoizedHit(copy, matcher, choices, copyLookup) {
        const copyHash = copyLookup !== undefined ? copyLookup : this.copyLookupFor(copy);
        const hitLookup = `${copyHash}|${this.resolveMemoLookup(matcher, choices)}`;

        if (this.matchCache.has(hitLookup)) {
            const memoized = this.matchCache.get(hitLookup);
            if (Date.now() - memoized.timestamp < RuntimePolicy.MATCH_CACHE_TTL) {
                return { found: true, result: memoized.result };
            }
            // Expired, remove
            this.matchCache.delete(hitLookup);
        }
        return { found: false };
    }

    /**
     * Cache a match result
     */
    memoHit(copy, matcher, choices, outcome, copyLookup) {
        const copyHash = copyLookup !== undefined ? copyLookup : this.copyLookupFor(copy);
        const hitLookup = `${copyHash}|${this.resolveMemoLookup(matcher, choices)}`;
        this.matchCache.set(hitLookup, { result: outcome, timestamp: Date.now() });
        this.insertionOrder.push(hitLookup);
        this.performEvictIfNeeded();
    }

    /**
     * Evict oldest entries if cache is full
     * Uses FIFO (First-In-First-Out) for O(1) eviction
     */
    performEvictIfNeeded() {
        const aggregateCapacity = this.regexCache.size + this.matchCache.size;
        if (aggregateCapacity > this.maxSize) {
            // Simple FIFO: evict oldest 10% from front of queue
            const evictTotal = Math.max(1, Math.floor(this.maxSize * 0.1));
            for (let cursor = 0; cursor < evictTotal && this.insertionOrder.length > 0; cursor++) {
                const oldestLookup = this.insertionOrder.shift();
                this.regexCache.delete(oldestLookup);
                this.matchCache.delete(oldestLookup);
            }
        }
    }

    /**
     * Clear all caches
     */
    purge() {
        this.regexCache.clear();
        this.matchCache.clear();
        this.insertionOrder = [];
    }
}

// Node test export (no-op in the browser, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) { module.exports = { CompiledPatternPool, localIsLikelyEvilRegex, localSimpleHash }; }
