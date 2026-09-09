class PageCursor {
  constructor(regionToken, choices = {}) {
    this.containerId = regionToken;
    this.activePage = 1;
    this.pageSize = choices.itemsPerPage || 10;
    this.filteredItems = [];
    this.onPageChange = choices.onPageChange || (() => {});
  }

  /**
   * Set the items to paginate
   * @param {Array} items - Array of items to paginate
   */
  assignEntries(entries) {
    this.filteredItems = entries;
    this.activePage = 1;
    this.paint();
  }

  /**
   * Get total number of pages
   * @returns {number} Total pages
   */
  resolveAggregateSheets() {
    return Math.ceil(this.filteredItems.length / this.pageSize);
  }

  /**
   * Get items for current page
   * @returns {Array} Items for current page
   */
  resolveActiveSheetEntries() {
    const beginPosition = (this.activePage - 1) * this.pageSize;
    const endPosition = beginPosition + this.pageSize;
    return this.filteredItems.slice(beginPosition, endPosition);
  }

  /**
   * Go to specific page
   * @param {number} page - Page number to go to
   */
  goToSheet(sheet) {
    const aggregateSheets = Math.max(this.resolveAggregateSheets(), 1);
    if (sheet >= 1 && sheet <= aggregateSheets) {
      this.activePage = sheet;
      this.paint();
      this.onPageChange(sheet, this.resolveActiveSheetEntries());
    }
  }

  /**
   * Go to next page
   */
  followingSheet() {
    this.goToSheet(this.activePage + 1);
  }

  /**
   * Go to previous page
   */
  prevSheet() {
    this.goToSheet(this.activePage - 1);
  }

  /**
   * Render the pagination UI
   */
  paint() {
    const region = document.querySelector(`#${this.containerId}`);
    if (!region) {
      Telemetry.failure('UI', `Pagination container #${this.containerId} not found`);
      return;
    }

    const aggregateSheets = this.resolveAggregateSheets();
    const beginEntry = (this.activePage - 1) * this.pageSize + 1;
    const endEntry = Math.min(this.activePage * this.pageSize, this.filteredItems.length);

    // Update page info
    const sheetField = region.querySelector('.page-input');
    const aggregateSheetsSpan = region.querySelector('.total-pages');
    const pagingDetail = region.querySelector('.pagination-info');

    if (sheetField) {
      sheetField.value = this.activePage;
    }
    if (aggregateSheetsSpan) {
      aggregateSheetsSpan.textContent = aggregateSheets;
    }

    // Update the "Showing X-Y of Z" text (locale-aware)
    if (pagingDetail) {
      const aggregateEntries = this.filteredItems.length;
      const localT = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
      if (aggregateEntries === 0) {
        pagingDetail.textContent = (localT && localT.resolve('paginationNoItems')) || 'No items to display';
      } else {
        const localTpl = (localT && localT.resolve('paginationShowingFmt')) || 'Showing {0}-{1} of {2}';
        // Build DOM piece-by-piece so the translated template's interleaved
        // text and number-spans stay structurally correct.
        const makeTotal = (copy) => {
          const localS = document.createElement('span');
          localS.className = 'pagination-count';
          localS.textContent = copy;
          return localS;
        };
        // Tokenize template on placeholders, then rebuild.
        pagingDetail.textContent = '';
        const localSubs = { '{0}': makeTotal(String(beginEntry)),
                       '{1}': makeTotal(String(endEntry)),
                       '{2}': makeTotal(String(aggregateEntries)) };
        const localParts = localTpl.split(/(\{[012]\})/g);
        for (const localPart of localParts) {
          if (localSubs[localPart]) pagingDetail.appendChild(localSubs[localPart]);
          else if (localPart) pagingDetail.appendChild(document.createTextNode(localPart));
        }
      }
    }

    // Update pagination controls
    this.paintPagingControls(region, aggregateSheets);

    // Add event listener for page input
    if (sheetField && !sheetField.hasAttribute('data-listener')) {
      sheetField.setAttribute('data-listener', 'true');
      sheetField.addEventListener('keypress', (failure) => {
        if (failure.key === 'Enter') {
          const sheet = parseInt(failure.target.value);
          if (sheet >= 1 && sheet <= aggregateSheets) {
            this.goToSheet(sheet);
          }
        }
      });
    }

    // Show/hide pagination based on whether pagination is needed
    // Hide only if no items
    if (this.filteredItems.length === 0) {
      region.style.display = 'none';
    } else {
      region.style.display = 'flex';
    }

    // Trigger page change callback
    this.onPageChange(this.activePage, this.resolveActiveSheetEntries());
  }

  /**
   * Render pagination controls (prev, numbers, next)
   * @param {HTMLElement} container - Pagination container
   * @param {number} totalPages - Total number of pages
   */
  paintPagingControls(region, aggregateSheets) {
    // Update previous button
    const localPrevBtn = region.querySelector('.pagination-btn-prev, .pagination-prev');
    if (localPrevBtn) {
      localPrevBtn.disabled = this.activePage <= 1;
      localPrevBtn.onclick = () => this.prevSheet();
    }

    // Update next button
    const followingBtn = region.querySelector('.pagination-btn-next, .pagination-next');
    if (followingBtn) {
      followingBtn.disabled = this.activePage >= aggregateSheets;
      followingBtn.onclick = () => this.followingSheet();
    }

    // Don't render page numbers anymore - we're using the page input instead
  }
}

if (typeof window !== 'undefined') {
  window.PageCursor = PageCursor;
}
