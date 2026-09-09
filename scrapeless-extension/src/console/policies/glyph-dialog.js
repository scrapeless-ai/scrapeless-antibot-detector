/**
 * Icon Picker Modal Module
 *
 * Contains methods for the icon picker modal:
 * - openIconPicker - Opens the icon selection dialog
 * - selectIcon - Handles icon selection
 * - uploadCustomIcon - Handles custom icon upload
 *
 * These methods are added to the Rules prototype.
 */

// ============================================
// Icon Picker Modal
// ============================================

/**
 * Open icon picker dialog
 */
CatalogPresenter.prototype.openGlyphPicker = function() {
  // Remove any existing icon picker modal first (prevents stacking)
  const retainedDialog = document.querySelector('.icon-picker-modal');
  if (retainedDialog?.parentElement) {
    retainedDialog.parentElement.remove();
  }

  // List of available icons

  const availableGlyphs = [
    // Official brand icons
    'akamai_official.png',
    'aws_official.png',
    'cloudflare_official.png',
    'datadome_official.png',
    'f5_official.png',
    'funcaptcha_official.png',
    'geetest_official.png',
    'hcaptcha_official.png',
    'imperva_official.png',
    'perimeterx_official.png',
    'reblaze_official.png',
    'recaptcha_official.png',
    'shape_security_official.png',
    'sucuri_official.png',
    // Fingerprint icons
    'audio_fingerprint.png',
    'battery_fingerprint.png',
    'canvas_fingerprint.png',
    'clipboard_fingerprint.png',
    'crypto_fingerprint.png',
    'css_fingerprint.png',
    'font_fingerprint.png',
    'gamepads_fingerprint.png',
    'geolocation_fingerprint.png',
    'hardware_fingerprint.png',
    'indexeddb_fingerprint.png',
    'media_fingerprint.png',
    'navigator_fingerprint.png',
    'orientation_fingerprint.png',
    'performance_fingerprint.png',
    'screen_fingerprint.png',
    'storage_fingerprint.png',
    'timezone_fingerprint.png',
    'usb_fingerprint.png',
    'webgl_fingerprint.png',
    'webrtc_fingerprint.png'
  ];

  // Helper to check if icon is fingerprint type
  const localIsFingerprint = (glyph) => glyph.includes('_fingerprint.png');

  // Create modal HTML with Default option first, then Custom, then others
  const consoleGlyph = chrome.runtime.getURL('brand/toolbar-128.png');
  const dialogMarkup = `
    <div class="icon-picker-modal rule-modal">
      <div class="icon-picker-backdrop rule-modal-backdrop"></div>
      <div class="icon-picker-content rule-modal-content">
        <div class="icon-picker-header rule-modal-header">
          <h2>Choose Icon</h2>
          <button class="icon-picker-close rule-modal-close" aria-label="Close icon picker" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
            </svg>
          </button>
        </div>
        <div class="icon-picker-body rule-modal-body">
          <div class="icon-grid">
            ${[
              { icon: 'default', label: 'Default', image: consoleGlyph, className: 'icon-option icon-option-default icon-option-special', isFingerprint: false },
              ...availableGlyphs.map(glyph => ({
                icon: glyph,
                label: glyph.replace('_official.png', '').replace('_fingerprint.png', '').replace('.png', '').replace(/_/g, ' '),
                image: chrome.runtime.getURL('detectors/icons/' + glyph),
                className: 'icon-option',
                isFingerprint: localIsFingerprint(glyph),
                svg: (typeof FingerprintGlyphs !== 'undefined' ? FingerprintGlyphs.resolve(glyph) : '')
                  || (typeof BrandGlyphs !== 'undefined' ? BrandGlyphs.resolve(glyph) : '')
              }))
            ].map(({ icon: glyph, label: localLabel, image: localImage, className: classLabel, isFingerprint: localIsFp, svg: localSvg }) => `
              <div class="${classLabel}" data-icon="${glyph}">
                ${localSvg
                  ? `<div class="icon-option-fingerprint-preview ${localIsFp ? 'fingerprint-icon fingerprint-icon-shell' : 'vendor-icon vendor-icon-shell'}">${localSvg}</div>`
                  : `<img src="${localImage}" alt="${localLabel}" class="icon-option-image ${glyph === 'default' ? 'icon-option-image-default' : ''}">`}
                <div class="icon-option-label">${localLabel}</div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="icon-picker-footer rule-modal-footer">
          <button id="uploadCustomIcon" class="icon-picker-upload-btn" type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload Custom
          </button>
          <button id="cancelIconPicker" class="icon-picker-cancel-btn rule-btn rule-btn-cancel" type="button">
            Cancel
          </button>
        </div>
      </div>
    </div>
  `;

  // Add modal to page
  const dialogRegion = document.createElement('div');
  dialogRegion.innerHTML = dialogMarkup;
  document.body.appendChild(dialogRegion);

  const localEditBackdrop = document.querySelector('#editRuleModal .rule-modal-backdrop');
  const priorEditBackdropVisibility = localEditBackdrop ? localEditBackdrop.style.visibility : '';
  if (localEditBackdrop) {
    localEditBackdrop.style.visibility = 'hidden';
  }

  let localIsClosed = false;
  const closeDialog = () => {
    if (localIsClosed) return;
    localIsClosed = true;
    if (localEditBackdrop) {
      localEditBackdrop.style.visibility = priorEditBackdropVisibility;
    }
    dialogRegion.remove();
  };

  // Add click handlers
  const glyphChoices = dialogRegion.querySelectorAll('.icon-option');
  glyphChoices.forEach(choice => {
    choice.addEventListener('click', () => {
      const glyphLabel = choice.dataset.icon;

      if (glyphLabel === 'default') {
        // Handle default icon - set to null or 'default'
        this.selectGlyph('default');
      } else {
        // Handle regular icon selection
        this.selectGlyph(glyphLabel);
      }
      closeDialog();
    });
  });

  // Upload custom icon button
  const localUploadBtn = dialogRegion.querySelector('#uploadCustomIcon');
  localUploadBtn.addEventListener('click', () => {
    closeDialog();
    this.uploadCustomGlyph();
  });

  // Cancel button
  const localCancelBtn = dialogRegion.querySelector('#cancelIconPicker');
  localCancelBtn.addEventListener('click', () => {
    closeDialog();
  });

  // Close on backdrop click
  const localBackdrop = dialogRegion.querySelector('.icon-picker-backdrop');
  if (localBackdrop) {
    localBackdrop.addEventListener('click', () => closeDialog());
  }

  // Close button
  const localCloseBtn = dialogRegion.querySelector('.icon-picker-close');
  if (localCloseBtn) {
    localCloseBtn.addEventListener('click', () => closeDialog());
  }
};

/**
 * Select an icon from the available icons
 */
CatalogPresenter.prototype.selectGlyph = function(glyphLabel) {
  // Update current icon display in modal
  const activeGlyph = document.querySelector('#currentDetectorIcon');
  if (activeGlyph) {
    const isFingerprintTaxonomy = (this.currentEditDetector?.category || '').toLowerCase() === 'fingerprint';
    let glyphOriginKind = 'default';

    if (glyphLabel === 'default') {
      // Use Scrapeless icon for default
      activeGlyph.src = chrome.runtime.getURL('brand/toolbar-128.png');
      glyphOriginKind = 'default';
    } else {
      const fingerprintGlyphOrigin = typeof FingerprintGlyphs !== 'undefined'
        ? FingerprintGlyphs.resolvePayloadAddress(glyphLabel)
        : '';
      const vendorGlyphOrigin = typeof BrandGlyphs !== 'undefined'
        ? BrandGlyphs.resolvePayloadAddress(glyphLabel)
        : '';
      activeGlyph.src = fingerprintGlyphOrigin || vendorGlyphOrigin || chrome.runtime.getURL('detectors/icons/' + glyphLabel);
      glyphOriginKind = glyphLabel.toLowerCase().includes('_fingerprint.') ? 'builtin' : 'default';
    }

    if (isFingerprintTaxonomy) {
      this.assignActiveRuleGlyphOriginClass?.(glyphOriginKind);
    } else {
      activeGlyph.classList.remove(
        'fingerprint-icon-image',
        'fingerprint-icon-image--builtin',
        'fingerprint-icon-image--custom',
        'fingerprint-icon-image--default'
      );
    }
  }

  // Store the icon in the detector
  if (this.currentEditDetector) {
    if (glyphLabel === 'default') {
      // Set icon to 'default' or remove it entirely
      this.currentEditDetector.detector.icon = 'default';
    } else {
      this.currentEditDetector.detector.icon = glyphLabel;
    }
    // Remove custom icon if one was set
    delete this.currentEditDetector.detector.customIcon;
    delete this.currentEditDetector.customIcon;
  }
};

/**
 * Upload a custom icon file
 */
CatalogPresenter.prototype.uploadCustomGlyph = function() {
  const field = document.createElement('input');
  field.type = 'file';
  field.accept = 'image/*';

  field.onchange = async (failure) => {
    const resource = failure.target.files[0];
    if (resource) {
      // Check file size (limit to 100KB)
      if (resource.size > 100 * 1024) {
        Toasts.failure('Icon file size must be less than 100KB');
        return;
      }

      // Read file as data URL
      const localReader = new FileReader();
      localReader.onload = (signal) => {
        const payloadAddress = signal.target.result;

        // Update current icon display in modal
        const activeGlyph = document.querySelector('#currentDetectorIcon');
        if (activeGlyph) {
          activeGlyph.src = payloadAddress;
          const isFingerprintTaxonomy = (this.currentEditDetector?.category || '').toLowerCase() === 'fingerprint';
          if (isFingerprintTaxonomy) {
            this.assignActiveRuleGlyphOriginClass?.('custom');
          } else {
            activeGlyph.classList.remove(
              'fingerprint-icon-image',
              'fingerprint-icon-image--builtin',
              'fingerprint-icon-image--custom',
              'fingerprint-icon-image--default'
            );
          }
        }

        // Store the new icon data URL in the detector
        if (this.currentEditDetector) {
          this.currentEditDetector.customIcon = payloadAddress;
          this.currentEditDetector.detector.customIcon = payloadAddress;
        }
      };
      localReader.readAsDataURL(resource);
    }
  };

  field.click();
};
