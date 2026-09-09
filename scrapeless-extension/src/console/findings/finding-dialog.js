/**
 * Detection modal/copy methods.
 * Dependencies: `Detection` class must be loaded first.
 */
const FindingDialog = (typeof self !== 'undefined' && self.FindingDialog) ? self.FindingDialog : {};

FindingDialog.copyScan = function(positionOrScan, triggerNode = null) {
    const findingsPane = typeof positionOrScan === 'object'
      ? positionOrScan
      : this.resolveScanByPosition(positionOrScan);

    if (!findingsPane) {
      return;
    }
    const detailsCopy = `
Security System: ${findingsPane.detector?.name || 'Unknown'}
Category: ${findingsPane.category || 'Unknown'}
Confidence: ${findingsPane.confidence || 0}%
Detection Methods: ${findingsPane.signals?.map(localM => `${localM.type}: ${localM.pattern || localM.name || localM.selector}`).join(', ') || 'Unknown'}
    `.trim();

    TextCodec.performCopyToClipboard(detailsCopy, {
      element: triggerNode,
      notificationMessage: 'Copied',
      inlineMessage: '✓ Copied!'
    });
};

FindingDialog.copyScanOverview = async function() {
    const findings = Array.isArray(this.findings) ? this.findings : [];
    const aggregateFindings = findings.length;

    const avgEvidence = FindingMetrics.measureAverageEvidence(findings);
    const { difficulty: localDifficulty } = this.resolveDifficultyDetail(findings, avgEvidence);

    const siteAddressNode = document.querySelector('#siteUrl');
    let address = (this.cacheMetadata?.url || siteAddressNode?.title || '').trim();
    const localHost = (siteAddressNode?.textContent || '').trim();

    if (!address) {
      try {
        const [page] = await chrome.tabs.query({ active: true, currentWindow: true });
        address = (page?.url || '').trim();
      } catch {
        // ignore
      }
    }

    const memoBoundary = (document.querySelector('#memoScopeDisplay')?.textContent || '').trim();
    const memoExpiry = (document.querySelector('#cacheExpiry')?.textContent || '').trim();

    const encodePhaseCounts = (findingsPane) => {
      const hits = Array.isArray(findingsPane?.signals) ? findingsPane.signals : [];
      if (hits.length === 0) return '';

      const phaseCounts = new Map();
      for (const hit of hits) {
        const kind = hit?.type;
        if (!kind) continue;
        phaseCounts.set(kind, (phaseCounts.get(kind) || 0) + 1);
      }

      if (phaseCounts.size === 0) return '';

      return Array.from(phaseCounts.entries()).map(([kind, total]) => {
        const localLabel = String(kind).replace(/_/g, ' ').toUpperCase();
        return total > 1 ? `${localLabel} (${total})` : localLabel;
      }).join(', ');
    };

    const sortedFindings = this.sortFindingsByTaxonomy(findings);

    let copy = '';
    copy += `URL: ${address || localHost || 'Unknown'}\n`;
    if (address && localHost && address !== localHost) {
      copy += `Host: ${localHost}\n`;
    }
    copy += `Detections: ${aggregateFindings}\n`;
    copy += `Confidence: ${avgEvidence}%\n`;
    copy += `Difficulty: ${localDifficulty}\n`;
    if (memoBoundary && memoBoundary !== '-') copy += `Cache Scope: ${memoBoundary}\n`;
    if (memoExpiry && memoExpiry !== '-') copy += `Cache Expiration: ${memoExpiry}\n`;

    if (sortedFindings.length > 0) {
      copy += `\nDetections (${sortedFindings.length}):\n`;
      copy += `${'-'.repeat(50)}\n\n`;

      sortedFindings.forEach((findingsPane, position) => {
        const label = findingsPane?.detector?.name || findingsPane?.detector || findingsPane?.name || 'Unknown';
        const taxonomy = findingsPane?.category || findingsPane?.detector?.category || '';
        const evidence = findingsPane?.confidence || 0;
        const phases = encodePhaseCounts(findingsPane);

        copy += `${position + 1}. ${label}\n`;
        if (taxonomy) copy += `   Category: ${taxonomy}\n`;
        copy += `   Confidence: ${evidence}%\n`;
        if (phases) copy += `   Methods: ${phases}\n`;
        copy += '\n';
      });
    }

    await TextCodec.performCopyToClipboard(copy.trim(), { notificationMessage: 'Copied' });
};

FindingDialog.copyPhaseDatum = function(datum, kind, triggerNode = null) {
    const copyToCopy = `[${kind}] ${datum}`;
    TextCodec.performCopyToClipboard(copyToCopy, {
      element: triggerNode,
      notificationMessage: 'Copied',
      inlineMessage: '✓ Copied!'
    });
};

FindingDialog.resolveScanByPosition = function(position) {
    if (typeof position !== 'number') {
      return null;
    }

    if (this.pageCursor && Array.isArray(this.pageCursor.filteredItems)) {
      const filteredScan = this.pageCursor.filteredItems[position];
      if (filteredScan) {
        return filteredScan;
      }
    }

    return this.findings[position] || null;
};

FindingDialog.resolveGlobalScanPosition = function(findingsPane, fallbackPosition = 0) {
    if (this.pageCursor && Array.isArray(this.pageCursor.filteredItems)) {
      const position = this.pageCursor.filteredItems.indexOf(findingsPane);
      if (position !== -1) {
        return position;
      }
    }
    return fallbackPosition;
};

FindingDialog.startDialogNodes = function() {
    const dialog = document.querySelector('#detectionDetailModal');
    if (!dialog) {
      return;
    }

    const localOverlay = dialog.querySelector('.detection-modal-overlay');
    const localCloseBtn = dialog.querySelector('#closeDetectionModal');
    const localCopyBtn = dialog.querySelector('#copyDetectionModal');

    this.modalElements = {
      modal: dialog,
      overlay: localOverlay,
      closeBtn: localCloseBtn,
      copyBtn: localCopyBtn,
      icon: dialog.querySelector('#detectionModalIcon'),
      name: dialog.querySelector('#detectionModalName'),
      categories: dialog.querySelector('#detectionModalCategories'),
      confidence: dialog.querySelector('#detectionModalConfidence'),
      detections: dialog.querySelector('#detectionModalDetections'),
      difficulty: dialog.querySelector('#detectionModalDifficulty'),
      description: dialog.querySelector('#detectionModalDescription'),
      methods: dialog.querySelector('#detectionModalMethods')
    };

    const closeRoute = () => this.closeScanDialog();

    if (localOverlay) {
      localOverlay.addEventListener('click', closeRoute);
    }

    if (localCloseBtn) {
      localCloseBtn.addEventListener('click', closeRoute);
    }

    if (localCopyBtn) {
      localCopyBtn.addEventListener('click', () => {
        if (this.activeModalIndex !== null) {
          const findingsPane = this.resolveScanByPosition(this.activeModalIndex);
          this.copyScan(findingsPane, localCopyBtn);
        }
      });
    }

    if (!this.handleModalKeyDown) {
      this.handleModalKeyDown = (signal) => {
        if (signal.key === 'Escape') {
          this.closeScanDialog();
        }
      };
      document.addEventListener('keydown', this.handleModalKeyDown);
    }
};

FindingDialog.openScanDialog = function(position) {
    if (!this.modalElements) {
      this.startDialogNodes();
    }

    if (!this.modalElements) {
      return;
    }

    const findingsPane = this.resolveScanByPosition(position);
    if (!findingsPane) {
      return;
    }

    this.activeModalIndex = position;
    this.paintScanDialogContent(findingsPane);

    this.modalElements.modal.style.display = 'flex';
    requestAnimationFrame(() => {
      this.modalElements.modal.classList.add('is-open');
    });
};

FindingDialog.closeScanDialog = function() {
    if (!this.modalElements) {
      return;
    }

    this.modalElements.modal.classList.remove('is-open');
    this.modalElements.modal.style.display = 'none';
    this.activeModalIndex = null;
};

FindingDialog.paintScanDialogContent = function(findingsPane) {
    if (!this.modalElements) {
      return;
    }

    const evidence = findingsPane.confidence || 0;
    let evidenceClass = 'confidence-low';
    if (evidence >= 90) evidenceClass = 'confidence-high';
    else if (evidence >= 70) evidenceClass = 'confidence-medium';

    const difficultyDetail = this.resolveDifficultyDetail([findingsPane], evidence);
    const localManualDifficulty = (typeof FindingMetrics !== 'undefined' && typeof FindingMetrics.canonicalizeDifficulty === 'function')
      ? FindingMetrics.canonicalizeDifficulty(findingsPane?.difficulty || findingsPane?.detector?.difficulty)
      : null;
    const localDifficulty = localManualDifficulty || difficultyDetail.difficulty;

    if (this.modalElements.icon) {
      this.modalElements.icon.innerHTML = this.resolveRuleGlyph(findingsPane);
    }

    if (this.modalElements.name) {
      this.modalElements.name.textContent = findingsPane.detector?.name || findingsPane.detector || 'Unknown Detection';
    }

    if (this.modalElements.categories) {
      this.modalElements.categories.innerHTML = this.resolveTaxonomyBadges(findingsPane);
    }

    // The sheet carries the finding's category so it can be coloured the same
    // way its row is, instead of arriving as an unrelated neutral panel.
    if (this.modalElements.modal) {
      this.modalElements.modal.setAttribute(
        'data-category',
        String(findingsPane.category || 'other').toLowerCase()
      );
    }

    if (this.modalElements.confidence) {
      this.modalElements.confidence.textContent = `${evidence}%`;
      this.modalElements.confidence.className = `meta-value ${evidenceClass}`;
    }

    if (this.modalElements.detections) {
      const hitTotal = Array.isArray(findingsPane.signals) ? findingsPane.signals.length : 0;
      if (hitTotal > 0) {
        const hitLookup = hitTotal === 1 ? 'matchSingular' : 'matchPlural';
        const hitFallback = hitTotal === 1 ? 'match' : 'matches';
        const hitLabel = (typeof LocaleRuntime !== 'undefined')
          ? LocaleRuntime.performTr(hitLookup, hitFallback)
          : hitFallback;
        this.modalElements.detections.textContent = `${hitTotal} ${hitLabel}`;
      } else {
        this.modalElements.detections.textContent = (typeof LocaleRuntime !== 'undefined')
          ? LocaleRuntime.performTr('noMatchesRecorded', 'No matches recorded')
          : 'No matches recorded';
      }
    }

    if (this.modalElements.difficulty) {
      const localDifficultyClass = `difficulty-${localDifficulty.toLowerCase()}`;
      this.modalElements.difficulty.textContent = localDifficulty;
      this.modalElements.difficulty.className = `meta-value ${localDifficultyClass}`;
    }

    // Populate author field
    const authorNode = document.querySelector('#detectionModalAuthor');
    if (authorNode) {
      const localAuthor = findingsPane.detector?.author || 'Scrapeless';
      // 'scrapeless' still counts as upstream so rules exported from an older
      // build keep their badge after the bundled ones were reauthored.
      const authorLookup = localAuthor.toLowerCase();
      const localIsUpstream = authorLookup === 'scrapeless' || authorLookup === 'scrapeless';
      const presentAuthor = localIsUpstream ? 'Scrapeless' : localAuthor;

      // Clear previous content
      authorNode.textContent = '';

      // Add author text (using textContent to prevent XSS)
      const authorCopy = document.createTextNode(presentAuthor);
      authorNode.appendChild(authorCopy);

      // Add verified badge for the bundled upstream detectors
      if (localIsUpstream) {
        const localVerifiedBadge = document.createElement('i');
        localVerifiedBadge.className = 'fas fa-check-circle verified-badge';
        localVerifiedBadge.title = 'Official Scrapeless detector';
        localVerifiedBadge.style.marginLeft = '6px';
        authorNode.appendChild(localVerifiedBadge);
      }
    }

    if (this.modalElements.description) {
      const localDescription = findingsPane.detector?.description || 'No additional details provided for this detection.';
      this.modalElements.description.textContent = localDescription;
    }

    if (this.modalElements.methods) {
      if (findingsPane.signals && findingsPane.signals.length) {
        this.modalElements.methods.innerHTML = this.resolvePhaseBadges(findingsPane.signals);
        this.attachDialogPhaseRoutes();
      } else {
        this.modalElements.methods.innerHTML = '<div class="detection-modal-empty">No detection methods recorded for this detector.</div>';
      }
    }
};

FindingDialog.attachDialogPhaseRoutes = function() {
    const phaseCards = document.querySelectorAll('#detectionModalMethods .method-item-card');
    phaseCards.forEach(localCard => {
      const encodedDatum = localCard.getAttribute('data-copy-value') || '';
      const phaseKind = localCard.getAttribute('data-method-type') || 'Unknown';
      const decodedDatum = encodedDatum ? decodeURIComponent(encodedDatum) : '';
      const datumControl = localCard.querySelector('.method-value-btn');

      const routeCopy = (signal) => {
        signal.stopPropagation();
        this.copyPhaseDatum(decodedDatum, phaseKind, datumControl || localCard);
      };

      localCard.addEventListener('click', routeCopy);

      if (datumControl) {
        datumControl.addEventListener('click', routeCopy);
      }
    });
};

if (typeof self !== 'undefined') {
    self.FindingDialog = FindingDialog;
}
