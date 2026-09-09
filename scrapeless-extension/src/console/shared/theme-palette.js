/**
 * ColorManager Module
 * Handles all color-related functionality including:
 * - Color picker UI management
 * - Advanced canvas-based color picker
 * - Color conversion utilities (RGB, HSL, Hex)
 * - Preset color management
 */
class ThemePalette {
  constructor() {
    this.presetColors = [
      '#3b82f6', // Blue
      '#10b981', // Green
      '#f59e0b', // Yellow
      '#ef4444', // Red
      '#8b5cf6', // Purple
      '#ec4899', // Pink
      '#6366f1', // Indigo
      '#06b6d4', // Cyan
      '#64748b'  // Gray
    ];

    this.currentColor = '#3b82f6';
    this.colorPickerInitialized = false;
    this.currentHue = 0;
    this.selectedColor = { r: 255, g: 0, b: 0 };

    // Callbacks for color selection
    this.onColorSelect = null;
    this.onColorChange = null;
  }

  /**
   * Initialize color picker functionality
   * @param {Object} options - Configuration options
   * @param {Function} options.onColorSelect - Callback when color is selected
   * @param {Function} options.onColorChange - Callback when color changes
   */
  start(choices = {}) {
    this.onColorSelect = choices.onColorSelect || null;
    this.onColorChange = choices.onColorChange || null;

    this.wirePalettePicker();
  }

  /**
   * Setup color picker UI and event listeners
   */
  wirePalettePicker() {
    const paletteGrid = document.querySelector('.color-picker-grid');

    if (paletteGrid) {
      paletteGrid.addEventListener('click', (failure) => {
        failure.stopPropagation();
        const paletteChoice = failure.target.closest('.color-option');
        if (!paletteChoice) return;

        if (paletteChoice.id === 'rainbowPicker') {
          if (paletteChoice.dataset.customColor) {
            this.currentColor = paletteChoice.dataset.customColor;
            // Parse the color for the picker
            const localRgb = this.performHexToRgb(this.currentColor);
            if (localRgb) {
              this.selectedColor = localRgb;
            }
          }
          this.openCapturePalettePicker();
          return;
        }

        const palette = paletteChoice.dataset.color;
        if (palette) {
          this.selectPresetPalette(palette, paletteChoice);
        }
      });
    }
  }

  /**
   * Select a preset color
   * @param {string} color - The hex color value
   * @param {HTMLElement} colorOption - The color option element
   */
  selectPresetPalette(palette, paletteChoice) {
    // Update selected state
    document.querySelectorAll('.color-option').forEach(choice => {
      choice.classList.remove('selected');
    });
    if (paletteChoice) {
      paletteChoice.classList.add('selected');
    }

    this.currentColor = palette;

    // Update badge color preview
    const palettePreview = document.querySelector('#badgeColorPreview');
    if (palettePreview) {
      palettePreview.style.background = palette;
    }

    // Trigger callback
    if (this.onColorSelect) {
      this.onColorSelect(palette);
    }
  }

  /**
   * Set color programmatically
   * @param {string} color - The hex color value
   */
  assignPalette(palette) {
    this.currentColor = palette;

    document.querySelectorAll('.color-option').forEach(choice => {
      choice.classList.remove('selected');
    });

    const matchingChoice = document.querySelector(`[data-color="${palette}"]`);
    if (matchingChoice) {
      matchingChoice.classList.add('selected');
    } else {
      // No preset match -- mark rainbow picker as selected with custom color
      const localRainbowPicker = document.querySelector('#rainbowPicker');
      if (localRainbowPicker) {
        localRainbowPicker.classList.add('selected');
        localRainbowPicker.dataset.customColor = palette;
      }
    }

    // Update badge color preview
    const palettePreview = document.querySelector('#badgeColorPreview');
    if (palettePreview) {
      palettePreview.style.background = palette;
    }

    // Update custom color picker value
    const customPalettePicker = document.querySelector('#customColorPicker');
    if (customPalettePicker) {
      customPalettePicker.value = palette;
    }
  }

  /**
   * Get current selected color
   * @returns {string} Current hex color value
   */
  resolvePalette() {
    return this.currentColor;
  }

  /**
   * Open advanced color picker modal
   */
  openCapturePalettePicker() {
    const captureDialog = document.querySelector('#advancedColorModal');
    if (!captureDialog) return;

    // Initialize color picker if not done already
    if (!this.colorPickerInitialized) {
      this.startCapturePalettePicker();
      this.colorPickerInitialized = true;
    } else {
      // Update the picker with the current color
      this.refreshPickerToActivePalette();
    }

    captureDialog.style.display = 'flex';
  }

  /**
   * Update picker to show current color
   */
  refreshPickerToActivePalette() {
    const paletteCanvas = document.querySelector('#colorCanvas');
    const localHueCanvas = document.querySelector('#hueCanvas');
    const paletteCursor = document.querySelector('#colorPickerCursor');
    const localHueCursor = document.querySelector('#hueSliderCursor');
    const palettePreview = document.querySelector('#selectedColorPreview');
    const rField = document.querySelector('#rInput');
    const gField = document.querySelector('#gInput');
    const bField = document.querySelector('#bInput');

    if (!this.selectedColor) {
      this.selectedColor = this.performHexToRgb(this.currentColor) || { r: 255, g: 0, b: 0 };
    }

    this.refreshPalettePresent(this.selectedColor, palettePreview, rField, gField, bField);

    const localHsv = this.performRgbToHsv(this.selectedColor.r, this.selectedColor.g, this.selectedColor.b);
    this.currentHue = localHsv.h;

    if (paletteCanvas) {
      const executionScope = paletteCanvas.getContext('2d');
      if (executionScope) {
        this.drawPaletteCanvas(executionScope, this.currentHue);
      }
    }

    if (localHueCanvas) {
      const localHueCtx = localHueCanvas.getContext('2d');
      if (localHueCtx) {
        this.performDrawHueStrip(localHueCtx);
      }
    }

    if (localHueCursor) {
      const localHueY = (this.currentHue / 360) * 160;
      localHueCursor.style.top = `${localHueY}px`;
      localHueCursor.style.display = 'block';
    }

    if (paletteCursor) {
      const paletteX = localHsv.s * 240;
      const paletteY = (1 - localHsv.v) * 160;
      paletteCursor.style.left = `${paletteX}px`;
      paletteCursor.style.top = `${paletteY}px`;
      paletteCursor.style.display = 'block';
    }
  }

  /**
   * Close advanced color picker modal
   */
  closeCapturePalettePicker() {
    const captureDialog = document.querySelector('#advancedColorModal');
    if (captureDialog) {
      captureDialog.style.display = 'none';
    }
  }

  /**
   * Initialize canvas-based advanced color picker
   */
  startCapturePalettePicker() {
    const paletteCanvas = document.querySelector('#colorCanvas');
    const localHueCanvas = document.querySelector('#hueCanvas');
    const paletteCursor = document.querySelector('#colorPickerCursor');
    const localHueCursor = document.querySelector('#hueSliderCursor');
    const palettePreview = document.querySelector('#selectedColorPreview');
    const rField = document.querySelector('#rInput');
    const gField = document.querySelector('#gInput');
    const bField = document.querySelector('#bInput');
    const localCancelBtn = document.querySelector('#cancelAdvancedColor');
    const localSelectBtn = document.querySelector('#selectAdvancedColor');

    if (!paletteCanvas || !localHueCanvas) {
      Telemetry.failure('UI', 'Color picker canvas elements not found');
      return;
    }

    const paletteCtx = paletteCanvas.getContext('2d');
    const localHueCtx = localHueCanvas.getContext('2d');

    if (!paletteCtx || !localHueCtx) {
      Telemetry.failure('UI', 'Cannot get canvas contexts');
      return;
    }

    // Initialize selectedColor from current color if not set
    if (!this.selectedColor || !this.selectedColor.r) {
      this.selectedColor = this.performHexToRgb(this.currentColor) || { r: 255, g: 0, b: 0 };
    }

    // Draw hue strip
    this.performDrawHueStrip(localHueCtx);

    // Calculate HSV from current color to set initial hue and position
    const localInitialHsv = this.performRgbToHsv(this.selectedColor.r, this.selectedColor.g, this.selectedColor.b);
    this.currentHue = localInitialHsv.h;

    // Draw initial color canvas
    this.drawPaletteCanvas(paletteCtx, this.currentHue);

    // Update initial color display
    this.refreshPalettePresent(this.selectedColor, palettePreview, rField, gField, bField);

    // Position cursors based on current color using HSV
    if (paletteCursor) {
      const paletteX = localInitialHsv.s * 240;
      const paletteY = (1 - localInitialHsv.v) * 160;
      paletteCursor.style.left = `${paletteX}px`;
      paletteCursor.style.top = `${paletteY}px`;
      paletteCursor.style.display = 'block';
    }
    if (localHueCursor) {
      const localHueY = (this.currentHue / 360) * 160;
      localHueCursor.style.top = `${localHueY}px`;
      localHueCursor.style.display = 'block';
    }

    if (localHueCanvas && localHueCursor) {
      let localIsHueDragging = false;

      const refreshHueFromPosition = (failure) => {
        const localRect = localHueCanvas.getBoundingClientRect();
        const verticalValue = Math.max(0, Math.min(160, failure.clientY - localRect.top));        this.currentHue = (verticalValue / 160) * 360;
        // Update hue cursor
        localHueCursor.style.top = `${verticalValue}px`;

        // Redraw color canvas with new hue
        this.drawPaletteCanvas(paletteCtx, this.currentHue);

        // Update color at current position
        const paletteRect = paletteCanvas.getBoundingClientRect();
        const paletteX = parseInt(paletteCursor.style.left) || 120;
        const paletteY = parseInt(paletteCursor.style.top) || 80;
        const localSaturation = paletteX / 240;
        const datum = 1 - (paletteY / 160);
        this.selectedColor = this.performHsvToRgb(this.currentHue, localSaturation, datum);
        this.refreshPalettePresent(this.selectedColor, palettePreview, rField, gField, bField);
      };

      // Mouse down - start dragging
      localHueCanvas.addEventListener('mousedown', (failure) => {
        localIsHueDragging = true;
        refreshHueFromPosition(failure);
      });

      localHueCanvas.addEventListener('mousemove', (failure) => {
        if (localIsHueDragging) {
          refreshHueFromPosition(failure);
        }
      });

      document.addEventListener('mouseup', () => {
        localIsHueDragging = false;
      });

      localHueCanvas.addEventListener('click', (failure) => {
        refreshHueFromPosition(failure);
      });
    }

    if (paletteCanvas && paletteCursor) {
      let localIsDragging = false;

      const refreshPaletteFromPosition = (failure) => {
        const localRect = paletteCanvas.getBoundingClientRect();
        const horizontalValue = Math.max(0, Math.min(240, failure.clientX - localRect.left));        const verticalValue = Math.max(0, Math.min(160, failure.clientY - localRect.top));
        const localSaturation = horizontalValue / 240;
        const datum = 1 - (verticalValue / 160);
        this.selectedColor = this.performHsvToRgb(this.currentHue, localSaturation, datum);

        paletteCursor.style.left = `${horizontalValue}px`;
        paletteCursor.style.top = `${verticalValue}px`;

        this.refreshPalettePresent(this.selectedColor, palettePreview, rField, gField, bField);
      };

      paletteCanvas.addEventListener('mousedown', (failure) => {
        localIsDragging = true;
        refreshPaletteFromPosition(failure);
      });

      paletteCanvas.addEventListener('mousemove', (failure) => {
        if (localIsDragging) {
          refreshPaletteFromPosition(failure);
        }
      });

      document.addEventListener('mouseup', () => {
        localIsDragging = false;
      });

      paletteCanvas.addEventListener('click', (failure) => {
        refreshPaletteFromPosition(failure);
      });
    }

    const refreshFromRgb = () => {
      this.selectedColor = {
        r: parseInt(rField?.value) || 0,
        g: parseInt(gField?.value) || 0,
        b: parseInt(bField?.value) || 0
      };
      this.refreshPalettePresent(this.selectedColor, palettePreview, rField, gField, bField);

      const localHsv = this.performRgbToHsv(this.selectedColor.r, this.selectedColor.g, this.selectedColor.b);
      this.currentHue = localHsv.h;

      if (localHueCursor) {
        const localHueY = (localHsv.h / 360) * 160;
        localHueCursor.style.top = `${localHueY}px`;
      }

      if (paletteCursor) {
        const paletteX = localHsv.s * 240;
        const paletteY = (1 - localHsv.v) * 160;
        paletteCursor.style.left = `${paletteX}px`;
        paletteCursor.style.top = `${paletteY}px`;
      }

      this.drawPaletteCanvas(paletteCtx, this.currentHue);

      if (this.onColorChange) {
        this.onColorChange(this.performRgbToHex(this.selectedColor));
      }
    };

    rField?.addEventListener('input', refreshFromRgb);
    gField?.addEventListener('input', refreshFromRgb);
    bField?.addEventListener('input', refreshFromRgb);

    // Modal control buttons
    localCancelBtn?.addEventListener('click', () => this.closeCapturePalettePicker());
    localSelectBtn?.addEventListener('click', () => {
      const localHex = this.performRgbToHex(this.selectedColor);
      this.applyChosenPalette(localHex);
      this.closeCapturePalettePicker();
    });
  }

  /**
   * Draw the hue gradient strip
   * @param {CanvasRenderingContext2D} ctx - The canvas context
   */
  performDrawHueStrip(executionScope) {
    const localGradient = executionScope.createLinearGradient(0, 0, 0, 160);    localGradient.addColorStop(0, '#ff0000');
    localGradient.addColorStop(0.17, '#ff00ff');
    localGradient.addColorStop(0.33, '#0000ff');
    localGradient.addColorStop(0.5, '#00ffff');
    localGradient.addColorStop(0.67, '#00ff00');
    localGradient.addColorStop(0.83, '#ffff00');
    localGradient.addColorStop(1, '#ff0000');

    executionScope.fillStyle = localGradient;
    executionScope.fillRect(0, 0, 20, 160);  }

  /**
   * Draw the saturation/lightness canvas
   * @param {CanvasRenderingContext2D} ctx - The canvas context
   * @param {number} hue - The current hue value
   */
  drawPaletteCanvas(executionScope, localHue) {
    // Clear canvas
    executionScope.clearRect(0, 0, 240, 160);
    // Create gradients
    // White to color (saturation)
    const localSatGradient = executionScope.createLinearGradient(0, 0, 240, 0);    localSatGradient.addColorStop(0, '#ffffff');
    const basePalette = this.performHsvToRgb(localHue, 1, 1);
    localSatGradient.addColorStop(1, `rgb(${basePalette.r}, ${basePalette.g}, ${basePalette.b})`);

    executionScope.fillStyle = localSatGradient;
    executionScope.fillRect(0, 0, 240, 160);
    // Transparent to black (lightness)
    const localLightGradient = executionScope.createLinearGradient(0, 0, 0, 160);    localLightGradient.addColorStop(0, 'rgba(0,0,0,0)');
    localLightGradient.addColorStop(1, 'rgba(0,0,0,1)');

    executionScope.fillStyle = localLightGradient;
    executionScope.fillRect(0, 0, 240, 160);  }

  /**
   * Update color display in UI
   * @param {Object} color - RGB color object
   * @param {HTMLElement} preview - Preview element
   * @param {HTMLInputElement} rInput - Red input
   * @param {HTMLInputElement} gInput - Green input
   * @param {HTMLInputElement} bInput - Blue input
   */
  refreshPalettePresent(palette, localPreview, rField, gField, bField) {
    const localR = Math.max(0, Math.min(255, Math.round(palette.r)));
    const localG = Math.max(0, Math.min(255, Math.round(palette.g)));
    const rightValue = Math.max(0, Math.min(255, Math.round(palette.b)));

    const localHex = this.performRgbToHex({ r: localR, g: localG, b: rightValue });

    if (localPreview) localPreview.style.background = localHex;
    if (rField) rField.value = localR;
    if (gField) gField.value = localG;
    if (bField) bField.value = rightValue;
  }

  /**
   * Apply selected color from advanced picker
   * @param {string} hex - The hex color value
   */
  applyChosenPalette(localHex) {
    const palettePreview = document.querySelector('#badgeColorPreview');

    if (palettePreview) {
      palettePreview.style.background = localHex;
    }

    this.currentColor = localHex;

    document.querySelectorAll('.color-option').forEach(choice => {
      choice.classList.remove('selected');
    });

    const localMatchingPreset = document.querySelector(`[data-color="${localHex}"]`);
    if (localMatchingPreset) {
      localMatchingPreset.classList.add('selected');
    } else {
      const localRainbowPicker = document.querySelector('#rainbowPicker');
      if (localRainbowPicker) {
        localRainbowPicker.classList.add('selected');
        localRainbowPicker.dataset.customColor = localHex;
      }
    }

    // Trigger callback
    if (this.onColorSelect) {
      this.onColorSelect(localHex);
    }
  }

  /**
   * Convert RGB to HSV
   * @param {number} r - Red (0-255)
   * @param {number} g - Green (0-255)
   * @param {number} b - Blue (0-255)
   * @returns {Object} HSV values
   */
  performRgbToHsv(localR, localG, rightValue) {
    localR /= 255;
    localG /= 255;
    rightValue /= 255;

    const limit = Math.max(localR, localG, rightValue);
    const floor = Math.min(localR, localG, rightValue);
    const localDiff = limit - floor;
    const entryValue = limit;

    if (localDiff === 0) {
      return { h: 0, s: 0, v: entryValue };
    }

    const localS = localDiff / limit;

    let localH;
    switch (limit) {
      case localR:
        localH = ((localG - rightValue) / localDiff + (localG < rightValue ? 6 : 0)) / 6;
        break;
      case localG:
        localH = ((rightValue - localR) / localDiff + 2) / 6;
        break;
      case rightValue:
        localH = ((localR - localG) / localDiff + 4) / 6;
        break;
    }

    return { h: localH * 360, s: localS, v: entryValue };
  }

  /**
   * Convert HSV to RGB
   * @param {number} h - Hue (0-360)
   * @param {number} s - Saturation (0-1)
   * @param {number} v - Value (0-1)
   * @returns {Object} RGB values
   */
  performHsvToRgb(localH, localS, entryValue) {
    localH = localH / 360;
    const cursor = Math.floor(localH * 6);
    const localF = localH * 6 - cursor;
    const localP = entryValue * (1 - localS);
    const localQ = entryValue * (1 - localF * localS);
    const localT = entryValue * (1 - (1 - localF) * localS);

    let localR, localG, rightValue;
    switch (cursor % 6) {
      case 0: localR = entryValue; localG = localT; rightValue = localP; break;
      case 1: localR = localQ; localG = entryValue; rightValue = localP; break;
      case 2: localR = localP; localG = entryValue; rightValue = localT; break;
      case 3: localR = localP; localG = localQ; rightValue = entryValue; break;
      case 4: localR = localT; localG = localP; rightValue = entryValue; break;
      case 5: localR = entryValue; localG = localP; rightValue = localQ; break;
    }

    return {
      r: Math.round(localR * 255),
      g: Math.round(localG * 255),
      b: Math.round(rightValue * 255)
    };
  }

  /**
   * Convert RGB to Hex
   * @param {Object} rgb - RGB color object
   * @returns {string} Hex color value
   */
  performRgbToHex(localRgb) {
    const localR = Math.max(0, Math.min(255, Math.round(localRgb.r)));
    const localG = Math.max(0, Math.min(255, Math.round(localRgb.g)));
    const rightValue = Math.max(0, Math.min(255, Math.round(localRgb.b)));
    return `#${localR.toString(16).padStart(2, '0')}${localG.toString(16).padStart(2, '0')}${rightValue.toString(16).padStart(2, '0')}`;
  }

  /**
   * Convert Hex to RGB
   * @param {string} hex - Hex color value
   * @returns {Object} RGB color object
   */
  performHexToRgb(localHex) {
    const outcome = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(localHex);
    return outcome ? {
      r: parseInt(outcome[1], 16),
      g: parseInt(outcome[2], 16),
      b: parseInt(outcome[3], 16)
    } : null;
  }

  /**
   * Get preset colors array
   * @returns {Array} Array of preset hex colors
   */
  resolvePresetPalette() {
    return this.presetColors;
  }
}

if (typeof window !== 'undefined') {
  window.ThemePalette = ThemePalette;
}