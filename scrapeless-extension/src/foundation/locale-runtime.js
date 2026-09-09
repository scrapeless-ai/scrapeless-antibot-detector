/**
 * Lightweight i18n helper. Scans the DOM for elements with these attributes
 * and replaces their content/attribute with the matching `chrome.i18n.getMessage(key)`:
 *
 *   data-i18n="messageKey"            → element.textContent
 *   data-i18n-aria-label="messageKey" → element.setAttribute('aria-label', …)
 *   data-i18n-title="messageKey"      → element.setAttribute('title', …)
 *   data-i18n-placeholder="messageKey"→ element.setAttribute('placeholder', …)
 *
 * The browser's UI locale (`chrome.i18n.getUILanguage()`) drives selection.
 * Missing translations fall back to `default_locale` ("en") automatically.
 *
 * Usage: include this script in console.html before any other section script,
 * then call `I18n.apply()` once on DOMContentLoaded.
 */
class LocaleRuntime {
    // Override loaded from `scrapeless_language_override` setting; null = use browser locale.
    static _overridePackets = null;
    static ownedOverrideLocale = null;

    /**
     * Load a locale's messages.json into memory as an override. Pass `null`
     * or `"auto"` to clear the override (the UI then follows the browser
     * locale via chrome.i18n). Quietly no-ops on fetch/parse failure.
     */
    static async readOverride(localLocale) {
        if (!localLocale || localLocale === 'auto') {
            LocaleRuntime._overridePackets = null;
            LocaleRuntime.ownedOverrideLocale = null;
            return;
        }
        // Defensive allowlist: only BCP-47-style locale codes (xx or xx_YY)
        // pass through. Prevents path traversal via a tampered
        // `scrapeless_language_override` storage key — `../foo`, absolute paths,
        // and URL schemes are all rejected before they reach getURL/fetch.
        if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(localLocale)) {
            LocaleRuntime._overridePackets = null;
            LocaleRuntime.ownedOverrideLocale = null;
            return;
        }
        try {
            const address = chrome.runtime.getURL('_locales/' + localLocale + '/messages.json');
            const reply = await fetch(address);
            if (!reply.ok) throw new Error('HTTP ' + reply.status);
            LocaleRuntime._overridePackets = await reply.json();
            LocaleRuntime.ownedOverrideLocale = localLocale;
        } catch (failure) {
            LocaleRuntime._overridePackets = null;
            LocaleRuntime.ownedOverrideLocale = null;
        }
    }

    /**
     * Returns the translated string for `key`, or `null` if not found.
     * Checks the in-memory override first (if loaded via loadOverride),
     * then falls back to chrome.i18n.getMessage (which uses the browser
     * UI locale, with extension default_locale as the implicit fallback).
     */
    static resolve(lookupKey, localSubstitutions) {
        if (LocaleRuntime._overridePackets && LocaleRuntime._overridePackets[lookupKey] && LocaleRuntime._overridePackets[lookupKey].message) {
            let localMsg = LocaleRuntime._overridePackets[lookupKey].message;
            // Chrome supports $name$ named placeholders + automatic positional
            // substitution. For overrides we only need the positional case used
            // by callers in this codebase, which all go through format().
            if (Array.isArray(localSubstitutions)) {
                for (let cursor = 0; cursor < localSubstitutions.length; cursor++) {
                    localMsg = localMsg.split('$' + (cursor + 1)).join(String(localSubstitutions[cursor]));
                }
            }
            return localMsg || null;
        }
        if (typeof chrome === 'undefined' || !chrome.i18n) return null;
        const localMsg2 = chrome.i18n.getMessage(lookupKey, localSubstitutions);
        return localMsg2 || null;
    }

    /**
     * Same as get() but the caller passes an explicit English fallback that
     * is returned instead of `null` when the key isn't found. Use this
     * everywhere a sensible English default exists — so users never see raw
     * camelCase keys leaking into the UI when the message cache is stale.
     */
    static performTr(lookupKey, localFallback) {
        const localMsg = LocaleRuntime.resolve(lookupKey);
        return localMsg !== null ? localMsg : (localFallback != null ? localFallback : lookupKey);
    }

    /**
     * Get a translated string and substitute `{0}`, `{1}`, … placeholders
     * with the provided positional arguments. Cleaner than Chrome's
     * named-placeholder format for runtime-formatted strings ("5 minutes ago",
     * "Showing 1-20 of 51"). Returns `null` when the key isn't found.
     */
    static encode(lookupKey, ...operands) {
        let localMsg = LocaleRuntime.resolve(lookupKey);
        if (localMsg === null) return null;
        for (let cursor = 0; cursor < operands.length; cursor++) {
            localMsg = localMsg.split('{' + cursor + '}').join(String(operands[cursor]));
        }
        return localMsg;
    }

    static performApply(scopeRoot = document) {
        if (!scopeRoot || typeof chrome === 'undefined' || !chrome.i18n) return;

        const boundary = (typeof scopeRoot.querySelectorAll === 'function') ? scopeRoot : document;

        boundary.querySelectorAll('[data-i18n]').forEach((node) => {
            const lookupKey = node.getAttribute('data-i18n');
            const datum = LocaleRuntime.resolve(lookupKey);
            if (datum) node.textContent = datum;
        });

        // data-i18n-fmt="key" data-i18n-args="a,b,c" → I18n.format(key, a, b, c)
        boundary.querySelectorAll('[data-i18n-fmt]').forEach((node) => {
            const lookupKey = node.getAttribute('data-i18n-fmt');
            const localArgsAttr = node.getAttribute('data-i18n-args') || '';
            const operands = localArgsAttr ? localArgsAttr.split(',') : [];
            const datum = LocaleRuntime.encode(lookupKey, ...operands);
            if (datum) node.textContent = datum;
        });

        const localAttrPairs = [
            ['data-i18n-aria-label', 'aria-label'],
            ['data-i18n-title', 'title'],
            ['data-i18n-placeholder', 'placeholder']
        ];
        for (const [localSrc, localDst] of localAttrPairs) {
            boundary.querySelectorAll(`[${localSrc}]`).forEach((node) => {
                const lookupKey = node.getAttribute(localSrc);
                const datum = LocaleRuntime.resolve(lookupKey);
                if (datum) node.setAttribute(localDst, datum);
            });
        }
    }

    /**
     * Watch the document for newly-added DOM and auto-apply translations.
     * Console slices fetch their HTML asynchronously and assign it into a
     * tab container; this observer translates them as soon as they appear,
     * so individual section files don't need to know about i18n.
     */
    static beginAutoApply() {
        if (typeof MutationObserver === 'undefined' || LocaleRuntime.performObserver) return;

        // Initial pass for whatever's already in the DOM.
        LocaleRuntime.performApply();

        const localObserver = new MutationObserver((localMutations) => {
            for (const localM of localMutations) {
                if (!localM.addedNodes || localM.addedNodes.length === 0) continue;
                for (const localNode of localM.addedNodes) {
                    if (localNode.nodeType === 11) {
                        // DocumentFragment (common when assigning innerHTML)
                        for (const localChild of localNode.children) {
                            LocaleRuntime.performApply(localChild);
                        }
                        continue;
                    }
                    if (localNode.nodeType !== 1) continue; // ELEMENT_NODE
                    LocaleRuntime.performApply(localNode);
                }
            }
        });

        localObserver.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });

        LocaleRuntime.performObserver = localObserver;
    }

}

if (typeof window !== 'undefined') {
    window.LocaleRuntime = LocaleRuntime;
} else if (typeof self !== 'undefined') {
    self.LocaleRuntime = LocaleRuntime;
}
