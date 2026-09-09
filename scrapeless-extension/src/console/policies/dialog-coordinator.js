/**
 * RulesModalLifecycle - Base class for rule modal open/close patterns.
 * Eliminates repeated open/close/backdrop logic across all rule modals.
 *
 * Dependencies: None (standalone class, load before rules.js)
 */
class PolicyDialogCoordinator {
  constructor(dialogSelector, choices = {}) {
    this.modalSelector = dialogSelector;
    this.parentBackdropSelector = choices.parentBackdrop || '#methodSettingsModal .rule-modal-backdrop';
    this.hideParentOnOpen = choices.hideParentOnOpen !== false;
  }

  resolveDialog() {
    return document.querySelector(this.modalSelector);
  }

  performOpen() {
    const dialog = this.resolveDialog();
    if (!dialog) return;

    if (this.hideParentOnOpen) {
      const localParent = document.querySelector(this.parentBackdropSelector);
      if (localParent) localParent.style.display = 'none';
    }

    dialog.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    this.onOpen?.();
  }

  performClose() {
    const dialog = this.resolveDialog();
    if (!dialog) return;

    dialog.style.display = 'none';
    document.body.style.overflow = '';

    if (this.hideParentOnOpen) {
      const localParent = document.querySelector(this.parentBackdropSelector);
      if (localParent) localParent.style.display = '';
    }

    this.onClose?.();
  }

  wireCloseSubscriptions(...localSelectors) {
    const localBackdrop = this.resolveDialog()?.querySelector('.rule-modal-backdrop');
    if (localBackdrop) localBackdrop.addEventListener('click', () => this.performClose());

    for (const localSelector of localSelectors) {
      const node = document.querySelector(localSelector);
      if (node) node.addEventListener('click', () => this.performClose());
    }
  }

  wireOpenSubscription(localBtnSelector) {
    const localBtn = document.querySelector(localBtnSelector);
    if (localBtn) localBtn.addEventListener('click', (failure) => { failure.stopPropagation(); this.performOpen(); });
  }
}
