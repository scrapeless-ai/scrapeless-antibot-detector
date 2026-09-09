/**
 * FormatUtils - Core formatting and display utility functions
 * Time formatting, HTML escaping, clipboard operations
 */
class TextCodec {

  /**
   * Convert time duration to milliseconds
   * @param {number} duration - Duration value
   * @param {string} unit - Time unit ('minutes', 'hours', 'days')
   * @returns {number} Duration in milliseconds
   */
  static performConvertToMilliseconds(localDuration, localUnit) {
    const localConversions = {
      minutes: localDuration * 60 * 1000,
      hours: localDuration * 60 * 60 * 1000,
      days: localDuration * 24 * 60 * 60 * 1000
    };
    return localConversions[localUnit] || localConversions.hours;
  }

  /**
   * Format timestamp as "X time ago" (e.g., "3h ago", "2d ago")
   * @param {number} timestamp - Unix timestamp in milliseconds
   * @returns {string} Human-readable time ago string
   */
  static resolveMomentAgo(localTimestamp) {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localFmt = (lookupKey, localFallback, localN) => (localT && localT.encode(lookupKey, localN)) || localFallback;
    const resolve = (lookupKey, localFallback) => (localT && localT.resolve(lookupKey)) || localFallback;

    if (!localTimestamp) return resolve('timeUnknown', 'Unknown');

    const localNow = Date.now();
    const localDiff = localNow - localTimestamp;

    if (localDiff < 0) return resolve('timeJustNow', 'Just now');

    const localSeconds = Math.floor(localDiff / 1000);
    const localMinutes = Math.floor(localSeconds / 60);
    const localHours = Math.floor(localMinutes / 60);
    const localDays = Math.floor(localHours / 24);

    if (localDays > 0) return localFmt('timeDaysAgoFmt', `${localDays}d ago`, localDays);
    if (localHours > 0) return localFmt('timeHoursAgoFmt', `${localHours}h ago`, localHours);
    if (localMinutes > 0) return localFmt('timeMinutesAgoFmt', `${localMinutes}m ago`, localMinutes);
    if (localSeconds > 0) return localFmt('timeSecondsAgoFmt', `${localSeconds}s ago`, localSeconds);
    return resolve('timeJustNow', 'Just now');
  }

  /**
   * Relative time without the "ago" word, for the history gutter.
   *
   * That column is 48px and every value in it is a relative time, so the word
   * is repeated on every row and carries nothing. It also made the column
   * ragged: "59m ago" needs 63.5px and wrapped to two lines while "1h ago"
   * stayed on one, and the same held in every locale — "hace 59m" wanted 71px,
   * Russian 102px, Hindi 105px, all against a 48px gutter.
   *
   * The compact strings are derived from each locale's own translation with the
   * ago-affix removed, so no unit token here was invented. Falls back to the
   * full form when a compact key is missing, which keeps this safe against a
   * locale file that has not been regenerated.
   *
   * @param {number} timestamp - Epoch milliseconds
   * @returns {string} e.g. "59m", "23h", "30d"
   */
  static resolveCompactMomentAgo(localTimestamp) {
    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const localFmt = (lookupKey, localN) => (localT && localT.encode(lookupKey, localN)) || null;

    if (!localTimestamp) return TextCodec.resolveMomentAgo(localTimestamp);

    const localDiff = Date.now() - localTimestamp;
    if (localDiff < 0) return TextCodec.resolveMomentAgo(localTimestamp);

    const localSeconds = Math.floor(localDiff / 1000);
    const localMinutes = Math.floor(localSeconds / 60);
    const localHours = Math.floor(localMinutes / 60);
    const localDays = Math.floor(localHours / 24);

    let localCompact = null;
    if (localDays > 0) localCompact = localFmt('timeCompactDaysFmt', localDays) || `${localDays}d`;
    else if (localHours > 0) localCompact = localFmt('timeCompactHoursFmt', localHours) || `${localHours}h`;
    else if (localMinutes > 0) localCompact = localFmt('timeCompactMinutesFmt', localMinutes) || `${localMinutes}m`;
    else if (localSeconds > 0) localCompact = localFmt('timeCompactSecondsFmt', localSeconds) || `${localSeconds}s`;

    return localCompact || TextCodec.resolveMomentAgo(localTimestamp);
  }

  /**
   * Escape HTML special characters to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} HTML-escaped text
   */
  static escapeMarkup(copy) {
    if (!copy) return '';

    const localDiv = document.createElement('div');
    localDiv.textContent = copy;
    return localDiv.innerHTML;
  }

  /**
   * Escape a value for use inside an HTML attribute ("..."). escapeHtml alone
   * does NOT escape quotes, so it is unsafe for attribute context — a value
   * containing a double-quote could break out. Use this for src/alt/title/etc.
   * @param {*} text
   * @returns {string}
   */
  static performEscapeAttr(copy) {
    return TextCodec.escapeMarkup(copy)
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Copy text to clipboard with optional visual feedback
   * @param {string} text - Text to copy
   * @param {object} options - Feedback options
   * @param {HTMLElement|null} options.element - Element to show inline feedback on
   * @param {boolean} [options.notify=true] - Display toast notification on success
   * @param {string} [options.notificationMessage='Copied'] - Success toast message
   * @param {string} [options.inlineMessage='Copied!'] - Temporary inline message
   * @param {number} [options.revertDelay=1600] - Delay before inline message reverts (ms)
   * @param {boolean} [options.useMicroToast=true] - Use compact micro toast vs full toast
   * @returns {Promise<boolean>} True if copy succeeded
   */
  static async performCopyToClipboard(copy, {
    element: node = null,
    notify: localNotify = true,
    notificationMessage: toastPacket = null,
    inlineMessage: inlinePacket = null,
    revertDelay: localRevertDelay = 1600,
    useMicroToast: localUseMicroToast = true
  } = {}) {
    const localI18n = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    if (toastPacket == null) {
      toastPacket = (localI18n && localI18n.performTr('copiedNotification', 'Copied')) || 'Copied';
    }
    if (inlinePacket == null) {
      inlinePacket = (localI18n && localI18n.performTr('copiedInlineMsg', '\u2713 Copied!')) || '\u2713 Copied!';
    }
    let completion = false;

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(copy);
        completion = true;
      } else if (typeof document !== 'undefined') {
        const localTextarea = document.createElement('textarea');
        localTextarea.value = copy;
        localTextarea.style.position = 'fixed';
        localTextarea.style.opacity = '0';
        document.body.appendChild(localTextarea);
        localTextarea.select();
        completion = document.execCommand('copy');
        document.body.removeChild(localTextarea);
      }
    } catch (failure) {
      Telemetry.failure('UTIL', 'Failed to copy to clipboard:', failure);
      completion = false;
    }

    if (!completion) {
      if (localNotify && typeof Toasts !== 'undefined' && typeof Toasts.failure === 'function') {
        Toasts.failure('Failed to copy to clipboard');
      }
      return false;
    }

    // Only show toast if no inline feedback element is provided (avoid redundancy)
    if (localNotify && !node && typeof Toasts !== 'undefined') {
      if (localUseMicroToast && typeof Toasts.performMicro === 'function') {
        Toasts.performMicro(toastPacket);
      } else if (typeof Toasts.completion === 'function') {
        Toasts.completion(toastPacket);
      }
    }

    if (node && typeof document !== 'undefined') {
      const isField = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
      const priorDatum = isField ? node.value : node.textContent;
      const priorMarkup = !isField ? node.innerHTML : null;

      node.dataset.copyOriginal = priorDatum ?? '';
      if (!isField && priorMarkup !== null && priorMarkup !== undefined) {
        node.dataset.copyOriginalHtml = priorMarkup;
      }

      if (isField) {
        node.value = inlinePacket;
      } else {
        node.textContent = inlinePacket;
      }

      node.classList.add('copy-feedback-active');

      window.setTimeout(() => {
        if (!node.dataset) {
          return;
        }

        const prior = node.dataset.copyOriginal;
        const priorInnerMarkup = node.dataset.copyOriginalHtml;
        if (isField) {
          if (prior !== undefined) {
            node.value = prior;
          }
        } else if (priorInnerMarkup !== undefined) {
          node.innerHTML = priorInnerMarkup;
        } else if (prior !== undefined) {
          node.textContent = prior;
        }

        node.classList.remove('copy-feedback-active');
        delete node.dataset.copyOriginal;
        if (node.dataset.copyOriginalHtml !== undefined) {
          delete node.dataset.copyOriginalHtml;
        }
      }, localRevertDelay);
    }

    return true;
  }
}

if (typeof window !== 'undefined') {
  window.TextCodec = TextCodec;
} else if (typeof self !== 'undefined') {
  self.TextCodec = TextCodec;
}

// Node test export (no-op in the browser, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) { module.exports = TextCodec; }
