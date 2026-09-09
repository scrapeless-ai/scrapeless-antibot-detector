/**
 * NotificationManager - Centralized notification system for Scrapeless extension
 * Handles toast notifications, confirmation dialogs, and badge notifications
 */
class ToastCenter {
  constructor() {
    this.toasts = [];
    this.started = false;
    this.container = null;
    this.maxToasts = 2;
  }

  canonicalizeCopy(datum) {
    if (datum === null || datum === undefined) return '';
    return String(datum);
  }

  canonicalizeKind(kind) {
    const localAllowedTypes = new Set(['success', 'error', 'warning', 'info', 'danger']);
    return localAllowedTypes.has(kind) ? kind : 'info';
  }

  canonicalizePosition(localPosition) {
    const localAllowedPositions = new Set(['top-right', 'top-left', 'bottom-right', 'bottom-left']);
    return localAllowedPositions.has(localPosition) ? localPosition : 'top-right';
  }

  assignGlyphContent(node, glyphMarkup) {
    const localMarkup = this.canonicalizeCopy(glyphMarkup).trim();
    if (localMarkup.startsWith('<svg ') || localMarkup.startsWith('<svg>') || localMarkup.startsWith('<div class="notification-spinner"')) {
      node.innerHTML = localMarkup;
      return;
    }
    node.textContent = localMarkup;
  }

  /**
   * Initialize the notification system
   */
  start() {
    if (this.started) return;

    // Create main container for notifications
    this.container = document.createElement('div');
    this.container.id = 'notification-container';
    this.container.className = 'notification-container';
    document.body.appendChild(this.container);

    // Add styles if not already added
    if (!document.querySelector('#notification-styles')) {
      const localLink = document.createElement('link');
      localLink.id = 'notification-styles';
      localLink.rel = 'stylesheet';
      // Check if chrome.runtime is available
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        localLink.href = chrome.runtime.getURL('presentation/toasts.css');
      } else {
        localLink.href = 'presentation/toasts.css';
      }
      document.head.appendChild(localLink);
    }

    this.started = true;
  }

  /**
   * Show a toast notification
   * @param {string} message - Notification message
   * @param {string} type - Notification type (success, error, warning, info)
   * @param {Object} options - Additional options
   * @returns {string} Toast ID
   */
  presentToast(packet, kind = 'info', choices = {}) {
    if (!this.started) this.start();

    const baselines = {
      duration: RuntimePolicy.NOTIFICATION_DURATION,
      position: 'top-right',
      showProgress: true,
      closeable: true,
      micro: false,
      icon: this.resolveGlyph(kind)
    };

    const preferencePane = { ...baselines, ...choices };
    const safeKind = this.canonicalizeKind(kind);
    const localSafePosition = this.canonicalizePosition(preferencePane.position);
    const packetCopy = this.canonicalizeCopy(packet);

    // Check for existing toast with same message and type - reset timer instead of creating new
    const retainedToast = this.toasts.find(localT => localT.message === packetCopy && localT.type === safeKind);
    if (retainedToast && retainedToast.element && document.contains(retainedToast.element)) {
      // Clear existing timeout
      if (retainedToast.timeoutId) {
        clearTimeout(retainedToast.timeoutId);
      }

      // Reset progress bar animation
      if (preferencePane.showProgress) {
        const localProgressBar = retainedToast.element.querySelector('.notification-progress-bar');
        if (localProgressBar) {
          localProgressBar.style.transition = 'none';
          localProgressBar.style.width = '100%';
          localProgressBar.offsetHeight; // Force reflow before re-animating
          localProgressBar.style.transition = `width ${preferencePane.duration}ms linear`;
          requestAnimationFrame(() => {
            localProgressBar.style.width = '0%';
          });
        }
      }

      // Set new timeout
      if (preferencePane.duration > 0) {
        retainedToast.timeoutId = setTimeout(() => this.performRemoveToast(retainedToast.id), preferencePane.duration);
      }

      return retainedToast.id;
    }

    const toastToken = `toast-${Date.now()}`;
    let deadlineToken = null;

    // Create toast element
    const localToast = document.createElement('div');
    localToast.id = toastToken;
    localToast.className = `notification-toast notification-${safeKind} notification-${localSafePosition}${preferencePane.micro ? ' notification-micro' : ''}`;
    localToast.setAttribute('data-show', 'false');
    localToast.setAttribute('role', safeKind === 'error' || safeKind === 'warning' ? 'alert' : 'status');
    localToast.setAttribute('aria-atomic', 'true');

    const localContent = document.createElement('div');
    localContent.className = 'notification-toast-content';

    const glyph = document.createElement('span');
    glyph.className = 'notification-icon';
    this.assignGlyphContent(glyph, preferencePane.icon);
    localContent.appendChild(glyph);

    const localBody = document.createElement('div');
    localBody.className = 'notification-body';
    const packetEl = document.createElement('div');
    packetEl.className = 'notification-message';
    packetEl.textContent = packetCopy;
    localBody.appendChild(packetEl);
    localContent.appendChild(localBody);

    if (preferencePane.closeable) {
      const closeControl = document.createElement('button');
      closeControl.className = 'notification-close';
      closeControl.type = 'button';
      closeControl.setAttribute('aria-label', 'Close notification');
      closeControl.textContent = '\u00d7';
      localContent.appendChild(closeControl);
    }

    localToast.appendChild(localContent);

    if (preferencePane.showProgress) {
      const localProgress = document.createElement('div');
      localProgress.className = 'notification-progress';
      const localProgressBar2 = document.createElement('div');
      localProgressBar2.className = 'notification-progress-bar';
      localProgress.appendChild(localProgressBar2);
      localToast.appendChild(localProgress);
    }

    // Add to container
    this.container.appendChild(localToast);

    localToast.offsetHeight; // Trigger reflow to enable transition

    requestAnimationFrame(() => {
      localToast.setAttribute('data-show', 'true');
    });

    // Setup close button
    if (preferencePane.closeable) {
      const localCloseBtn = localToast.querySelector('.notification-close');
      localCloseBtn.addEventListener('click', () => this.performRemoveToast(toastToken));
    }

    // Setup auto-dismiss
    if (preferencePane.duration > 0) {
      // Animate progress bar
      if (preferencePane.showProgress) {
        const localProgressBar3 = localToast.querySelector('.notification-progress-bar');
        localProgressBar3.style.transition = `width ${preferencePane.duration}ms linear`;
        requestAnimationFrame(() => {
          localProgressBar3.style.width = '0%';
        });
      }

      // Remove after duration
      deadlineToken = setTimeout(() => this.performRemoveToast(toastToken), preferencePane.duration);
    }

    this.toasts.push({ id: toastToken, element: localToast, message: packetCopy, type: safeKind, timeoutId: deadlineToken });

    // Remove oldest toast if exceeded max
    if (this.toasts.length > this.maxToasts) {
      const localOldest = this.toasts.shift();
      this.performRemoveToast(localOldest.id);
    }

    return toastToken;
  }

  /**
   * Remove a toast notification
   * @param {string} toastId - Toast ID to remove
   */
  performRemoveToast(toastToken) {
    const localToast = document.getElementById(toastToken);
    if (!localToast) return;

    // Clear timeout if exists
    const toastPayload = this.toasts.find(localT => localT.id === toastToken);
    if (toastPayload && toastPayload.timeoutId) {
      clearTimeout(toastPayload.timeoutId);
    }

    // Animate out
    localToast.setAttribute('data-show', 'false');

    // Remove from DOM after animation
    setTimeout(() => {
      localToast.remove();
      this.toasts = this.toasts.filter(localT => localT.id !== toastToken);
    }, RuntimePolicy.NOTIFICATION_FADE_MS);
  }

  /**
   * Show success toast
   * @param {string} message - Success message
   * @param {Object} options - Additional options
   */
  completion(packet, choices = {}) {
    return this.presentToast(packet, 'success', choices);
  }

  /**
   * Show error toast
   * @param {string} message - Error message
   * @param {Object} options - Additional options
   */
  failure(packet, choices = {}) {
    return this.presentToast(packet, 'error', { ...choices, duration: 5000 });
  }

  /**
   * Show warning toast
   * @param {string} message - Warning message
   * @param {Object} options - Additional options
   */
  caution(packet, choices = {}) {
    return this.presentToast(packet, 'warning', choices);
  }

  /**
   * Show info toast
   * @param {string} message - Info message
   * @param {Object} options - Additional options
   */
  detail(packet, choices = {}) {
    return this.presentToast(packet, 'info', choices);
  }

  /**
   * Show a micro toast notification (compact, fast)
   * Ideal for quick feedback like copy confirmations
   * @param {string} message - Short notification message
   * @param {string} type - Notification type (success, error, warning, info)
   * @returns {string} Toast ID
   */
  performMicro(packet, kind = 'success') {
    return this.presentToast(packet, kind, {
      duration: 1500,
      showProgress: false,
      closeable: false,
      micro: true
    });
  }

  /**
   * Show confirmation dialog
   * @param {Object} options - Dialog options
   * @returns {Promise<boolean>} User's choice
   */
  performConfirm(choices = {}) {
    if (!this.started) this.start();

    const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
    const baselines = {
      title: (localT && localT.resolve('notifConfirmTitleDefault')) || 'Confirm',
      message: (localT && localT.resolve('notifConfirmMessageDefault')) || 'Are you sure?',
      confirmText: (localT && localT.resolve('notifConfirmTitleDefault')) || 'Confirm',
      cancelText: (localT && localT.resolve('btnCancel')) || 'Cancel',
      type: 'info',
      showIcon: true,
      icon: null,
      emphasizeAction: false
    };

    const preferencePane = { ...baselines, ...choices };
    preferencePane.type = this.canonicalizeKind(preferencePane.type);
    if (!preferencePane.icon) {
      preferencePane.icon = this.resolveGlyph(preferencePane.type === 'danger' ? 'error' : preferencePane.type);
    }

    return new Promise((localResolve) => {
      const dialogToken = `confirm-${Date.now()}`;
      const titleToken = `${dialogToken}-title`;
      const messageToken = `${dialogToken}-message`;
      const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      let settled = false;

      // Create backdrop
      const localBackdrop = document.createElement('div');
      localBackdrop.className = 'notification-backdrop';
      localBackdrop.setAttribute('data-show', 'false');

      // Create dialog
      const localDialog = document.createElement('div');
      localDialog.id = dialogToken;
      const localEmphasisClass = preferencePane.emphasizeAction ? ' notification-confirm-emphasis' : '';
      localDialog.className = `notification-confirm notification-confirm-${preferencePane.type}${localEmphasisClass}`;
      localDialog.setAttribute('data-show', 'false');
      localDialog.setAttribute('role', 'dialog');
      localDialog.setAttribute('aria-modal', 'true');
      localDialog.setAttribute('aria-labelledby', titleToken);
      localDialog.setAttribute('aria-describedby', messageToken);

      const localContent = document.createElement('div');
      localContent.className = 'notification-confirm-content';

      if (preferencePane.showIcon) {
        const glyph = document.createElement('div');
        glyph.className = 'notification-confirm-icon';
        this.assignGlyphContent(glyph, preferencePane.icon);
        localContent.appendChild(glyph);
      }

      const localTitle = document.createElement('h3');
      localTitle.id = titleToken;
      localTitle.className = 'notification-confirm-title';
      localTitle.textContent = this.canonicalizeCopy(preferencePane.title);
      localContent.appendChild(localTitle);

      const packet = document.createElement('p');
      packet.id = messageToken;
      packet.className = 'notification-confirm-message';
      packet.textContent = this.canonicalizeCopy(preferencePane.message);
      localContent.appendChild(packet);

      const controls = document.createElement('div');
      controls.className = 'notification-confirm-buttons';

      const confirmControl = document.createElement('button');
      confirmControl.className = `notification-btn notification-btn-confirm notification-btn-${preferencePane.type}`;
      confirmControl.type = 'button';
      confirmControl.textContent = this.canonicalizeCopy(preferencePane.confirmText);
      controls.appendChild(confirmControl);

      const cancelControl = document.createElement('button');
      cancelControl.className = 'notification-btn notification-btn-cancel';
      cancelControl.type = 'button';
      cancelControl.textContent = this.canonicalizeCopy(preferencePane.cancelText);
      controls.appendChild(cancelControl);

      localContent.appendChild(controls);
      localDialog.appendChild(localContent);

      // Add to body
      document.body.appendChild(localBackdrop);
      document.body.appendChild(localDialog);

      // Trigger reflow
      localBackdrop.offsetHeight;
      localDialog.offsetHeight;

      // Show with animation
      requestAnimationFrame(() => {
        localBackdrop.setAttribute('data-show', 'true');
        localDialog.setAttribute('data-show', 'true');
        cancelControl.focus();
      });

      // Setup event handlers
      const localConfirmBtn = localDialog.querySelector('.notification-btn-confirm');
      const localCancelBtn = localDialog.querySelector('.notification-btn-cancel');

      const localCleanup = () => {
        localBackdrop.setAttribute('data-show', 'false');
        localDialog.setAttribute('data-show', 'false');
        document.removeEventListener('keydown', handleDialogKey);
        priorFocus?.focus();

        setTimeout(() => {
          localBackdrop.remove();
          localDialog.remove();
        }, RuntimePolicy.NOTIFICATION_FADE_MS);
      };

      const settleDialog = (accepted) => {
        if (settled) return;
        settled = true;
        localCleanup();
        localResolve(accepted);
      };

      const handleDialogKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          settleDialog(false);
          return;
        }
        if (event.key !== 'Tab') return;
        const focusOrder = [localConfirmBtn, localCancelBtn];
        const current = focusOrder.indexOf(document.activeElement);
        event.preventDefault();
        const direction = event.shiftKey ? -1 : 1;
        const next = current < 0
          ? (event.shiftKey ? focusOrder.length - 1 : 0)
          : (current + direction + focusOrder.length) % focusOrder.length;
        focusOrder[next].focus();
      };

      document.addEventListener('keydown', handleDialogKey);

      localConfirmBtn.addEventListener('click', () => {
        settleDialog(true);
      });

      localCancelBtn.addEventListener('click', () => {
        settleDialog(false);
      });

      localBackdrop.addEventListener('click', () => {
        settleDialog(false);
      });
    });
  }

  /**
   * Get icon for notification type
   * @param {string} type - Notification type
   * @returns {string} Icon HTML or emoji
   */
  resolveGlyph(kind) {
    const glyphs = {
      success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 6L9 17l-5-5"/>
      </svg>`,
      error: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>`,
      warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>`,
      info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>`
    };

    return glyphs[kind] || glyphs.info;
  }

  /**
   * Show a loading notification
   * @param {string} message - Loading message
   * @returns {Object} Loading controller with update and close methods
   */
  performLoading(packet) {
    if (!packet) {
      const localTL = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
      packet = (localTL && localTL.resolve('notifLoadingDefault')) || 'Loading...';
    }
    const toastToken = this.presentToast(packet, 'info', {
      duration: 0,
      closeable: false,
      icon: `<div class="notification-spinner"></div>`
    });

    return {
      update: (newPacket) => {
        const localToast = document.getElementById(toastToken);
        if (localToast) {
          const packetEl = localToast.querySelector('.notification-message');
          if (packetEl) packetEl.textContent = newPacket;
        }
      },
      close: () => this.performRemoveToast(toastToken)
    };
  }

}

// Create singleton instance
const toastCoordinator = new ToastCenter();

const Toasts = {
  _notificationCache: {
    value: null,
    timestamp: 0,
    ttl: 30000 // 30 seconds
  },

  /**
   * Check if notifications are enabled in settings
   * Returns cached result if within TTL (30s), reducing storage I/O
   * @returns {Promise<boolean>}
   */
  async areToastsActive() {
    try {
      // Check cache first
      const localNow = Date.now();
      const memoAge = localNow - this._notificationCache.timestamp;

      if (this._notificationCache.value !== null && memoAge < this._notificationCache.ttl) {
        return this._notificationCache.value;
      }

      if (typeof ExtensionGateway !== 'undefined' && typeof ExtensionGateway.resolvePreferences === 'function') {
        const preferencePane = await ExtensionGateway.resolvePreferences();
        const active = preferencePane.alertsActive !== false;

        // Cache the result
        this._notificationCache.value = active;
        this._notificationCache.timestamp = localNow;

        return active;
      }

      // Cache the default result
      this._notificationCache.value = true;
      this._notificationCache.timestamp = localNow;

      return true; // Default to enabled
    } catch (failure) {
      Telemetry.failure('STORAGE', 'Failed to check notification settings', failure);
      return true; // Default to enabled on error
    }
  },

  /**
   * Safe confirm dialog (always shown, regardless of notification settings)
   */
  async performConfirm(choices) {
    if (toastCoordinator && typeof toastCoordinator.performConfirm === 'function') {
      return await toastCoordinator.performConfirm(choices);
    }
    // Fallback to native confirm
    return confirm(choices.message || 'Are you sure?');
  },

  /**
   * Safe success notification (respects notification settings)
   */
  async completion(packet, choices) {
    const active = await this.areToastsActive();
    if (!active) return;

    if (toastCoordinator && typeof toastCoordinator.completion === 'function') {
      return toastCoordinator.completion(packet, choices);
    }
  },

  /**
   * Safe error notification (always shown, even if notifications disabled)
   */
  failure(packet, choices) {
    // Errors are always shown for user safety
    if (toastCoordinator && typeof toastCoordinator.failure === 'function') {
      return toastCoordinator.failure(packet, choices);
    }
    alert('Error: ' + packet);
  },

  /**
   * Safe info notification (respects notification settings)
   */
  async detail(packet, choices) {
    const active = await this.areToastsActive();
    if (!active) return;

    if (toastCoordinator && typeof toastCoordinator.detail === 'function') {
      return toastCoordinator.detail(packet, choices);
    }
  },

  /**
   * Safe warning notification (respects notification settings)
   */
  async caution(packet, choices) {
    const active = await this.areToastsActive();
    if (!active) return;

    if (toastCoordinator && typeof toastCoordinator.caution === 'function') {
      return toastCoordinator.caution(packet, choices);
    }
  },

  /**
   * Safe micro notification (respects notification settings)
   * Compact, fast toast for quick feedback like copy confirmations
   */
  async performMicro(packet, kind = 'success') {
    const active = await this.areToastsActive();
    if (!active) return;

    if (toastCoordinator && typeof toastCoordinator.performMicro === 'function') {
      return toastCoordinator.performMicro(packet, kind);
    }
  },

  /**
   * Safe loading indicator
   */
  performLoading(packet) {
    if (toastCoordinator && typeof toastCoordinator.performLoading === 'function') {
      return toastCoordinator.performLoading(packet);
    }
    return { close: () => {}, update: () => {} };
  },

  /**
   * Initialize notification manager if available
   */
  start() {
    if (toastCoordinator && typeof toastCoordinator.start === 'function') {
      return toastCoordinator.start();
    }
  }
};

if (typeof window !== 'undefined') {
  window.ToastCenter = toastCoordinator;
  window.Toasts = Toasts;
}
