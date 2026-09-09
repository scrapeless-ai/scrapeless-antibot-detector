// Blacklist UI methods for SettingsUI — extracted from settings-ui.js.
// Requires settings-ui.js to load first (defines const SettingsUI).

PreferenceForm.paintBlacklistUi = function() {
    const region = document.querySelector('#blacklistContainer');
    const pagingRegion = document.querySelector('#blacklistPagination');
    const sheetNumEl = document.querySelector('#blacklistPageNum');
    const aggregateSheetsEl = document.querySelector('#blacklistTotalPages');
    const localPrevBtn = document.querySelector('#blacklistPrevBtn');
    const followingBtn = document.querySelector('#blacklistNextBtn');
    const filterField = document.querySelector('#blacklistSearchInput');

    if (!region) return;

    const localAllDomains = this.preferences.scanning?.skippedDomains || [];
    const entriesPerSheet = 3;

    if (typeof this.blacklistPage === 'undefined') {
      this.blacklistPage = 1;
    }
    if (typeof this.blacklistSearch === 'undefined') {
      this.blacklistSearch = '';
    }

    const filterTerm = this.blacklistSearch.toLowerCase().trim();
    const localFilteredDomains = filterTerm
      ? localAllDomains.filter(localD => localD.toLowerCase().includes(filterTerm))
      : localAllDomains;

    const aggregateSheets = Math.ceil(localFilteredDomains.length / entriesPerSheet) || 1;

    if (this.blacklistPage > aggregateSheets) this.blacklistPage = aggregateSheets;
    if (this.blacklistPage < 1) this.blacklistPage = 1;

    if (pagingRegion) {
      pagingRegion.style.display = localFilteredDomains.length > entriesPerSheet ? 'flex' : 'none';
    }

    if (sheetNumEl) sheetNumEl.textContent = this.blacklistPage;
    if (aggregateSheetsEl) aggregateSheetsEl.textContent = aggregateSheets;

    if (localPrevBtn) localPrevBtn.disabled = this.blacklistPage <= 1;
    if (followingBtn) followingBtn.disabled = this.blacklistPage >= aggregateSheets;

    if (localFilteredDomains.length === 0) {
      region.innerHTML = filterTerm
        ? '<div class="blacklist-empty">No domains match your search</div>'
        : '<div class="blacklist-empty">No domains blacklisted</div>';
      return;
    }

    const beginPosition = (this.blacklistPage - 1) * entriesPerSheet;
    const endPosition = beginPosition + entriesPerSheet;
    const activeDomains = localFilteredDomains.slice(beginPosition, endPosition);

    const markup = activeDomains.map(localDomain => `
      <div class="blacklist-item">
        <span class="blacklist-item-domain">${TextCodec.escapeMarkup(localDomain)}</span>
        <button class="remove-blacklist-btn" data-domain="${localDomain}">
          <svg width="14" height="14" viewBox="0 0 24 24">
            <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    `).join('');

    region.innerHTML = markup;

    region.querySelectorAll('.remove-blacklist-btn').forEach(localBtn => {
      localBtn.addEventListener('click', async () => {
        const localDomain = localBtn.getAttribute('data-domain');
        this.preferences.scanning.skippedDomains = this.preferences.scanning.skippedDomains.filter(localD => localD !== localDomain);
        this.paintBlacklistUi();
        const persisted = await this.persistPreferences({ notify: false });
        if (!persisted) {
          return;
        }

        const localTBL = (typeof LocaleRuntime !== 'undefined') ? LocaleRuntime : null;
        Toasts.completion((localTBL && localTBL.encode('removedDomainFromBlacklistFmt', localDomain)) || `Removed ${localDomain} from blacklist`);
      });
    });
};

PreferenceForm.wireBlacklistSignalSubscriptions = function() {
    const filterField = document.querySelector('#blacklistSearchInput');
    const localPrevBtn = document.querySelector('#blacklistPrevBtn');
    const followingBtn = document.querySelector('#blacklistNextBtn');

    if (filterField) {
      filterField.addEventListener('input', (failure) => {
        this.blacklistSearch = failure.target.value;
        this.blacklistPage = 1; // Reset to first page on search
        this.paintBlacklistUi();
      });
    }

    if (localPrevBtn) {
      localPrevBtn.addEventListener('click', () => {
        if (this.blacklistPage > 1) {
          this.blacklistPage--;
          this.paintBlacklistUi();
        }
      });
    }

    if (followingBtn) {
      followingBtn.addEventListener('click', () => {
        const localAllDomains = this.preferences.scanning?.skippedDomains || [];
        const filterTerm = (this.blacklistSearch || '').toLowerCase().trim();
        const localFilteredDomains = filterTerm
          ? localAllDomains.filter(localD => localD.toLowerCase().includes(filterTerm))
          : localAllDomains;
        const aggregateSheets = Math.ceil(localFilteredDomains.length / 3) || 1;

        if (this.blacklistPage < aggregateSheets) {
          this.blacklistPage++;
          this.paintBlacklistUi();
        }
      });
    }
};

if (typeof self !== 'undefined') {
    self.PreferenceForm = PreferenceForm;
}
