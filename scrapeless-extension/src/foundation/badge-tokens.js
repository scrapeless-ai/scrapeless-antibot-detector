/**
 * Canonical badge constants and helpers.
 * Shared across popup and background contexts.
 */

const BadgeTokens = {
    TEXT: {
        LOADING: '\u280b',
        DISABLED: 'OFF',
        BLACKLISTED: 'BLK',
        INTERRUPTED: '\u21BB',
        CLEARED: '\u21BB',
        CLEAN: '',
        EMPTY: ''
    },

    COLORS: {
        LOW: '#43c59e',
        MEDIUM: '#e6a647',
        HIGH: '#f06a54',
        LOADING: '#12a594',
        DISABLED: '#ff8c5a',
        BLACKLISTED: '#ff8c5a',
        CLEARED: '#81918b',
        CLEAN: '#43c59e'
    },

    THRESHOLDS: {
        MEDIUM: 3,
        HIGH: 5
    },

    // Braille frames for the animated "analyzing" badge spinner (driven from the
    // background while a detection runs). LOADING above is frame 0.
    SPINNER_FRAMES: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
};

function resolveBadgePaletteForTotal(total) {
    const palette = BadgeTokens.COLORS;
    if (total >= BadgeTokens.THRESHOLDS.HIGH) return palette.HIGH;
    if (total >= BadgeTokens.THRESHOLDS.MEDIUM) return palette.MEDIUM;
    return palette.LOW;
}

// True if a badge text represents the "loading/analyzing" state — either the
// static LOADING glyph or any animated spinner frame. Use this instead of
// `text === BADGE.TEXT.LOADING` so checks work while the spinner is cycling.
function isLoadingBadgeCopy(copy) {
    const localT = (copy || '').trim();
    return localT === BadgeTokens.TEXT.LOADING || BadgeTokens.SPINNER_FRAMES.indexOf(localT) !== -1;
}

const localBadgeGlobal = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));

if (localBadgeGlobal) {
    localBadgeGlobal.BadgeTokens = BadgeTokens;
    localBadgeGlobal.getBadgeColorForCount = resolveBadgePaletteForTotal;
    localBadgeGlobal.isLoadingBadgeText = isLoadingBadgeCopy;
}

