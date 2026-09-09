// Pattern matching helpers for DetectionEngineManager.

function hitCookieLabelMatcher(label, matcher, choices = {}) {
    const {
        regex: localRegex = false,
        wholeWord: localWholeWord = false,
        caseSensitive: localCaseSensitive = false
    } = choices;

    if (!label || !matcher) {
        return false;
    }

    if (localRegex || localWholeWord) {
        return this.hitMatcher(label, matcher, choices);
    }

    const labelToCompare = localCaseSensitive ? label : label.toLowerCase();
    const matcherToCompare = localCaseSensitive ? matcher : matcher.toLowerCase();

    // Support simple wildcard patterns (e.g., "awswaf*")
    if (matcherToCompare.includes('*')) {
        const localEscaped = matcherToCompare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regexMatcher = `^${localEscaped.replace(/\\\*/g, '.*')}$`;
        try {
            return new RegExp(regexMatcher).test(labelToCompare);
        } catch (failure) {
            return false;
        }
    }

    // Default to prefix match (safer than substring for cookie names)
    return labelToCompare.startsWith(matcherToCompare);
}

function hitScanMatcher(copy, matcher, choices = {}, localPreparedLower) {
    const {
        regex: localRegex = false,
        wholeWord: localWholeWord = false,
        caseSensitive: localCaseSensitive = false
    } = choices;

    if (!copy || !matcher) {
        return false;
    }

    // Check result cache first (5-minute TTL). Hash the text once and reuse the
    // key for both the lookup and the store (previously hashed twice per call).
    const localPc = ScanEngine.matcherMemo;
    const copyLookup = localPc.copyLookupFor(copy);
    const memoized = localPc.resolveMemoizedHit(copy, matcher, choices, copyLookup);
    if (memoized.found) {
        return memoized.result;
    }

    // Apply case sensitivity once. Reuse a precomputed lowercased copy when the
    // caller passes one (runDetector lowercases pageHTML once for all patterns).
    const copyToFilter = localCaseSensitive ? copy : (localPreparedLower !== undefined ? localPreparedLower : copy.toLowerCase());
    const matcherToHit = localCaseSensitive ? matcher : matcher.toLowerCase();

    let outcome = false;

    // Regex matching
    if (localRegex) {
        const localCompiledRegex = ScanEngine.matcherMemo.resolveCompiledMatcher(matcherToHit, { regex: true, caseSensitive: localCaseSensitive });
        if (localCompiledRegex) {
            try {
                outcome = localCompiledRegex.test(copyToFilter);
            } catch (failure) {
                Telemetry.performWarn('DETECTION', 'Invalid regex pattern:', matcherToHit, failure);
                outcome = false;
            }
        }
    }
    // Whole word matching
    else if (localWholeWord) {
        const localCompiledRegex2 = ScanEngine.matcherMemo.resolveCompiledMatcher(matcherToHit, { wholeWord: true, caseSensitive: localCaseSensitive });
        if (localCompiledRegex2) {
            outcome = localCompiledRegex2.test(copyToFilter);
        } else {
            // Fallback to direct matching if compilation failed
            const escapedMatcher = this.escapeRegexMatcher(matcherToHit);
            const localWordBoundaryRegex = new RegExp(`\\b${escapedMatcher}\\b`, localCaseSensitive ? '' : 'i');
            outcome = localWordBoundaryRegex.test(copyToFilter);
        }
    }
    // Simple includes matching (fastest - no regex needed)
    else {
        outcome = copyToFilter.includes(matcherToHit);
    }

    // Cache result (5min TTL)
    localPc.memoHit(copy, matcher, choices, outcome, copyLookup);
    return outcome;
}

function findScanMatcherHit(copy, matcher, choices = {}) {
    const {
        regex: localRegex = false,
        wholeWord: localWholeWord = false,
        caseSensitive: localCaseSensitive = false
    } = choices;

    if (!copy || !matcher) return null;

    try {
        const copyToFilter = localCaseSensitive ? copy : copy.toLowerCase();
        const matcherToHit = localCaseSensitive ? matcher : matcher.toLowerCase();

        if (localRegex) {
            const localCompiledRegex = ScanEngine.matcherMemo.resolveCompiledMatcher(matcherToHit, { regex: true, caseSensitive: localCaseSensitive });
            if (!localCompiledRegex) return null;
            const outcome = copy.match(localCompiledRegex);
            return (outcome && outcome.length) ? outcome[0] : null;
        }
        else if (localWholeWord) {
            const localCompiledRegex2 = ScanEngine.matcherMemo.resolveCompiledMatcher(matcherToHit, { wholeWord: true, caseSensitive: localCaseSensitive });
            if (!localCompiledRegex2) return null;
            const outcome2 = copy.match(localCompiledRegex2);
            return (outcome2 && outcome2.length) ? outcome2[0] : null;
        }
        else {
            // Substring matching
            const position = copyToFilter.indexOf(matcherToHit);
            if (position !== -1) {
                return copy.substring(position, position + matcher.length);
            }
        }
    } catch (failure) {
        Telemetry.performWarn('DETECTION', '[findPatternMatch] Error matching pattern:', failure);
    }

    return null;
}

function escapeRegexMatcher(localString) {
    return localString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Node test export (no-op in the browser, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        hitScanMatcher,
        findScanMatcherHit,
        hitCookieLabelMatcher,
        escapeRegexMatcher
    };
}
