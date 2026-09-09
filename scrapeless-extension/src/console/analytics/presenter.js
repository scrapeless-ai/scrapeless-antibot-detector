/**
 * Translate a runtime string, falling back to the English literal.
 *
 * The analytics board builds chart axes, table headers and empty-state copy in
 * JavaScript, so those strings never pass through data-i18n and were the last
 * part of this page left untranslated.
 */
// Guarded: these files load as classic scripts into one global scope, so a
// bare `const` here is a redeclaration the second time it is parsed.
if (typeof localTr === 'undefined') {
    // eslint-disable-next-line no-var
    var localTr = (lookupKey, localFallback) =>
        (typeof LocaleRuntime !== 'undefined')
            ? LocaleRuntime.performTr(lookupKey, localFallback)
            : localFallback;
}

/**
 * Analytics presenter - binds the filter rail to the aggregates and paints
 * every figure on the page.
 *
 * One filter row scopes every chart, so a slice is always consistent across the
 * page rather than each card carrying its own controls.
 */
class AnalyticsPresenter {

    constructor() {
        this.archive = [];
        this.frame = null;
        this.hasBridge = true;
        this.filters = { since: 0, until: 0, taxonomy: 'all', host: '' };
        this.tablesOpen = false;
        // Raised only for the length of a print. Paginated charts draw every
        // row while it is set - see pageSize().
        this.printing = false;
        this.tip = null;
        // Page index per paginated chart, keyed by chart id. Clamped on every
        // render, so a filter that shrinks a list cannot strand the reader on a
        // page that no longer exists.
        this.pages = {};
    }

    /** Rows per page on the paginated bar charts. */
    static get PAGE_SIZE() { return 8; }

    /**
     * Rows per page on paper. Bigger than the screen's, because a sheet has no
     * next button and every row it can hold is a row the reader keeps - but
     * bounded, and that bound is not a taste call: a card taller than the page
     * cannot paginate, because Chrome paints an SVG once and leaves the sheets
     * it spans blank. 20 rows keeps the tallest card inside one A4 landscape
     * page. Beyond that the pager's count still says what was left off.
     */
    static get PRINT_PAGE_SIZE() { return 20; }

    /** Rows per page for the medium currently being rendered. */
    pageSize() {
        return this.printing ? AnalyticsPresenter.PRINT_PAGE_SIZE : AnalyticsPresenter.PAGE_SIZE;
    }

    // ---- palette -------------------------------------------------------
    // Read from CSS custom properties so the stylesheet stays the one place a
    // colour is defined. The values there are validated - see analytics.css.

    token(name, fallback) {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value || fallback;
    }

    get taxonomyPalette() {
        return {
            antibot: this.token('--viz-slot-1', '#F15214'),
            captcha: this.token('--viz-slot-2', '#2A8EFF'),
            fingerprint: this.token('--viz-slot-3', '#9F43A8'),
            other: this.token('--viz-slot-4', '#8A8A8A')
        };
    }

    get gradePalette() {
        return {
            low: this.token('--viz-grade-low', '#56d2c0'),
            medium: this.token('--viz-grade-medium', '#ffb224'),
            high: this.token('--viz-grade-high', '#ef5f64')
        };
    }

    get ramp() {
        return ['--viz-ramp-1', '--viz-ramp-2', '--viz-ramp-3', '--viz-ramp-4', '--viz-ramp-5']
            .map((name, index) => this.token(name, ['#085E55', '#007A6E', '#009788', '#00B5A3', '#08D7C3'][index]));
    }

    // ---- boot ----------------------------------------------------------

    async start() {
        this.mountTip();
        this.mountControls();

        const archive = await AnalyticsFrame.readArchive();
        this.hasBridge = archive !== null;
        this.archive = archive || [];
        this.render();
    }

    mountTip() {
        this.tip = document.getElementById('vizTip');
        const show = (event) => {
            const mark = event.target.closest('[data-tip]');
            if (!mark) return;
            this.tip.textContent = mark.dataset.tip;
            this.tip.hidden = false;
            const bounds = mark.getBoundingClientRect();
            const tipBounds = this.tip.getBoundingClientRect();
            const left = Math.min(
                window.innerWidth - tipBounds.width - 10,
                Math.max(10, bounds.left + bounds.width / 2 - tipBounds.width / 2)
            );
            const above = bounds.top - tipBounds.height - 10;
            this.tip.style.left = `${left}px`;
            this.tip.style.top = `${above > 8 ? above : bounds.bottom + 10}px`;
        };
        const hide = () => { this.tip.hidden = true; };

        document.addEventListener('mouseover', show);
        document.addEventListener('mouseout', hide);
        document.addEventListener('focusin', show);
        document.addEventListener('focusout', hide);
        document.addEventListener('scroll', hide, true);
    }

    mountControls() {
        document.querySelectorAll('[data-span]').forEach((control) => {
            control.addEventListener('click', () => {
                document.querySelectorAll('[data-span]').forEach((sibling) => sibling.classList.remove('is-on'));
                control.classList.add('is-on');
                if (control.dataset.span === 'custom') {
                    this.openCustomRange(control);
                    return;
                }
                this.closeCustomRange();
                const days = Number(control.dataset.span);
                this.filters.since = days > 0 ? Date.now() - days * 86400000 : 0;
                this.filters.until = 0;
                this.pages = {};
                this.render();
            });
        });

        for (const id of ['vizFrom', 'vizTo']) {
            document.getElementById(id).addEventListener('change', () => this.applyCustomRange());
        }
        document.getElementById('vizRangeClear').addEventListener('click', () => {
            document.getElementById('vizFrom').value = '';
            document.getElementById('vizTo').value = '';
            this.applyCustomRange();
        });

        document.querySelectorAll('[data-taxon]').forEach((control) => {
            control.addEventListener('click', () => {
                document.querySelectorAll('[data-taxon]').forEach((sibling) => sibling.classList.remove('is-on'));
                control.classList.add('is-on');
                this.filters.taxonomy = control.dataset.taxon;
                this.pages = {};
                this.render();
            });
        });

        const search = document.getElementById('vizSearch');
        search.addEventListener('input', () => {
            this.filters.host = search.value;
            this.pages = {};
            this.render();
        });

        const tables = document.getElementById('vizTables');
        tables.addEventListener('click', () => {
            this.tablesOpen = !this.tablesOpen;
            tables.setAttribute('aria-pressed', String(this.tablesOpen));
            tables.textContent = this.tablesOpen ? localTr('vizHideTables', 'Hide data tables') : localTr('vizBtnShowTables', 'Show data tables');
            document.body.classList.toggle('tables-open', this.tablesOpen);
        });

        document.getElementById('vizExport').addEventListener('click', () => this.exportReport());
        document.getElementById('vizPrint').addEventListener('click', () => this.exportPdf());

        const picker = document.getElementById('vizFile');
        picker.addEventListener('change', () => {
            const file = picker.files && picker.files[0];
            if (file) this.adoptFile(file);
        });

        const drop = document.getElementById('vizDrop');
        if (drop) {
            ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => {
                event.preventDefault();
                drop.classList.add('is-hot');
            }));
            ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, () => drop.classList.remove('is-hot')));
            drop.addEventListener('drop', (event) => {
                event.preventDefault();
                const file = event.dataTransfer.files && event.dataTransfer.files[0];
                if (file) this.adoptFile(file);
            });
        }
    }

    // ---- custom range --------------------------------------------------
    // The presets are rolling windows that always end now, so none of them can
    // frame a fortnight in the past. These two fields pin both ends instead.

    /** Local midnight of a YYYY-MM-DD field value, or 0 when it is blank. */
    static dayOpen(value) {
        if (!value) return 0;
        // Bare '2026-08-01' is parsed as UTC; with a time appended it is parsed
        // as local, which is what a date somebody typed into a form means.
        const moment = new Date(`${value}T00:00:00`);
        return Number.isNaN(moment.getTime()) ? 0 : moment.getTime();
    }

    /** The last millisecond of that day, so the To date is inclusive. */
    static dayClose(value) {
        if (!value) return 0;
        const moment = new Date(`${value}T23:59:59.999`);
        return Number.isNaN(moment.getTime()) ? 0 : moment.getTime();
    }

    /** YYYY-MM-DD in local time - the only format a date input accepts. */
    static dayField(stamp) {
        const moment = new Date(stamp);
        const month = String(moment.getMonth() + 1).padStart(2, '0');
        const day = String(moment.getDate()).padStart(2, '0');
        return `${moment.getFullYear()}-${month}-${day}`;
    }

    openCustomRange(control) {
        document.getElementById('vizCustomRange').hidden = false;
        if (control) control.setAttribute('aria-expanded', 'true');

        // Open on the window already on screen. The first edit is then an
        // adjustment to something real rather than an empty form to fill in.
        const from = document.getElementById('vizFrom');
        const to = document.getElementById('vizTo');
        if (!from.value && !to.value && this.frame && this.frame.span.from) {
            from.value = AnalyticsPresenter.dayField(this.frame.span.from);
            to.value = AnalyticsPresenter.dayField(this.frame.span.to);
        }
        this.applyCustomRange();
    }

    closeCustomRange() {
        document.getElementById('vizCustomRange').hidden = true;
        const control = document.querySelector('[data-span="custom"]');
        if (control) control.setAttribute('aria-expanded', 'false');
    }

    applyCustomRange() {
        const since = AnalyticsPresenter.dayOpen(document.getElementById('vizFrom').value);
        const until = AnalyticsPresenter.dayClose(document.getElementById('vizTo').value);
        // Refuse rather than silently return nothing: an empty board would read
        // as "no detections in that window", which is a different claim.
        if (since && until && since > until) {
            this.flash(localTr('vizRangeEndsBeforeStart', 'That range ends before it starts.'));
            return;
        }
        this.filters.since = since;
        this.filters.until = until;
        this.pages = {};
        this.render();
    }

    async adoptFile(file) {
        try {
            const text = await file.text();
            const entries = AnalyticsFrame.adoptArchivePayload(text);
            if (entries.length === 0) {
                this.flash(localTr('vizFileNoEntries', 'That file carried no history entries.'));
                return;
            }
            this.archive = entries;
            this.hasBridge = true;
            this.flash(`Loaded ${entries.length} entries from ${file.name}.`);
            this.render();
        } catch (failure) {
            this.flash(`Could not read that file: ${failure.message}`);
        }
    }

    flash(message) {
        const rail = document.getElementById('vizFlash');
        rail.textContent = message;
        rail.hidden = false;
    }

    // ---- render --------------------------------------------------------

    render() {
        this.frame = AnalyticsFrame.compile(this.archive, this.filters);

        const empty = this.frame.totals.pages === 0;
        document.getElementById('vizEmpty').hidden = !empty;
        document.getElementById('vizBoard').hidden = empty;
        document.getElementById('vizImport').hidden = this.hasBridge && this.archive.length > 0;

        document.getElementById('vizEmptyNote').textContent = this.hasBridge
            ? (this.archive.length === 0
                ? localTr('vizEmptyNoScans', 'No scans are stored yet. Browse a few protected sites and they will land here.')
                : localTr('vizEmptyNoMatch', 'No scans match the current filter.'))
            : 'This page is open outside the extension, so it cannot reach stored history. Drop a history export below.';

        if (empty) return;

        this.paintSpan();
        this.paintTiles();
        this.paintTimeline();
        this.paintCoverage();
        this.paintRate();
        this.paintTaxonomy();
        this.paintGrades();
        this.paintLayering();
        this.paintVendors();
        this.paintSites();
        this.paintSuffixes();
        this.paintHeatmap();
        this.paintSignals();
        this.paintSignalMatrix();
        this.paintEvidence();
        this.paintConfidence();
        this.paintConfidenceSpread();
        this.paintPerPage();
        this.paintPairs();
    }

    /** Cards that only make sense with enough data hide rather than mislead. */
    setCardVisible(id, visible) {
        const card = document.getElementById(id);
        if (card) card.hidden = !visible;
    }

    paintSpan() {
        const { from, to } = this.frame.span;
        const covered = from ? `${AnalyticsPresenter.stampDay(from)} - ${AnalyticsPresenter.stampDay(to)}` : '';
        document.getElementById('vizSpan').textContent = covered;
        // The printed header reads from the same source as the masthead, so a
        // report can never disagree with the screen it was taken from.
        document.getElementById('printSpan').textContent = covered || localTr('vizNoDataInRange', 'No data in range');
        document.getElementById('printFootSpan').textContent = covered;
        document.getElementById('printFilters').textContent = this.describeFilters();
    }

    static stampDay(value) {
        return new Date(value).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    /**
     * The active slice in one line for the printed header. Taken from the
     * controls rather than from `filters`, so a preset reads as "last 30d"
     * instead of the instant it happened to resolve to.
     */
    describeFilters() {
        const span = document.querySelector('[data-span].is-on');
        const label = span ? span.textContent.trim() : 'All';
        const parts = [];

        if (label === 'Custom' && (this.filters.since || this.filters.until)) {
            const opens = this.filters.since ? AnalyticsPresenter.stampDay(this.filters.since) : 'the beginning';
            const closes = this.filters.until ? AnalyticsPresenter.stampDay(this.filters.until) : 'now';
            parts.push(`Range ${opens} to ${closes}`);
        } else if (label === 'Custom') {
            // Custom selected with both fields empty is every row, and saying
            // "the beginning to now" in a report only invites the question.
            parts.push(localTr('vizRangeAllTime', 'Range all time'));
        } else {
            parts.push(`Range ${label === 'All' ? 'all time' : `last ${label}`}`);
        }

        const taxon = document.querySelector('[data-taxon].is-on');
        parts.push(`Category ${taxon ? taxon.textContent.trim() : 'All'}`);
        if (this.filters.host) parts.push(`Site matching "${this.filters.host}"`);
        return parts.join(' · ');
    }

    paintTiles() {
        const totals = this.frame.totals;
        const tiles = [
            ['tilePages', ChartKit.formatCount(totals.pages)],
            ['tileDetections', ChartKit.formatCount(totals.detections)],
            ['tileVendors', ChartKit.formatCount(totals.vendors)],
            ['tileSites', ChartKit.formatCount(totals.sites)],
            ['tileRate', `${totals.protectedRate}%`],
            ['tilePerPage', totals.perPage.toFixed(1)]
        ];
        for (const [id, value] of tiles) document.getElementById(id).textContent = value;

        document.getElementById('tileRateNote').textContent =
            `${ChartKit.formatCount(totals.protectedPages)} protected · ${ChartKit.formatCount(totals.cleanPages)} clean`;
        document.getElementById('tilePerPageNote').textContent = totals.avgConfidence === null
            ? 'confidence not recorded'
            : `avg confidence ${totals.avgConfidence}%`;

        const busiest = this.frame.byDay.reduce(
            (best, row) => (best === null || row.total > best.total ? row : best),
            null
        );
        document.getElementById('tileBusiest').textContent = busiest
            ? new Date(busiest.stamp).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
            : '—';
        document.getElementById('tileBusiestNote').textContent = busiest
            ? `${ChartKit.formatCount(busiest.total)} detections over ${ChartKit.formatCount(busiest.pages)} scans`
            : '';

        // "Layered" means two or more categories stacked on one page, measured
        // against protected pages rather than all scans - a clean page is not
        // evidence either way.
        const layered = this.frame.layering
            .filter((row) => row.layers >= 2)
            .reduce((sum, row) => sum + row.pages, 0);
        document.getElementById('tileLayered').textContent = totals.protectedPages
            ? `${Math.round((layered / totals.protectedPages) * 100)}%`
            : '0%';
        document.getElementById('tileLayeredNote').textContent =
            `${ChartKit.formatCount(layered)} of ${ChartKit.formatCount(totals.protectedPages)} protected pages`;
    }

    paintTimeline() {
        const palette = this.taxonomyPalette;
        const series = AnalyticsFrame.TAXONOMY_ORDER
            .filter((key) => this.frame.byDay.some((row) => row[key] > 0))
            .map((key) => ({ key, label: AnalyticsFrame.TAXONOMY_LABELS[key], color: palette[key] }));

        ChartKit.stackedColumns(document.getElementById('chartTimeline'), {
            data: this.frame.byDay,
            series
        });
        this.paintLegend('legendTimeline', series.map((one) => ({ label: one.label, color: one.color })));
        this.paintTable('tableTimeline', ['Day', ...series.map((one) => one.label), 'Total'],
            this.frame.byDay.map((row) => [row.day, ...series.map((one) => row[one.key]), row.total]));
    }

    paintCoverage() {
        // A one-day slice has nothing to trend, so the card stands down.
        this.setCardVisible('cardCoverage', this.frame.coverage.length > 1);
        if (this.frame.coverage.length <= 1) return;

        ChartKit.line(document.getElementById('chartCoverage'), {
            data: this.frame.coverage,
            valueKey: 'vendors',
            color: this.token('--viz-slot-3', '#9F43A8'),
            suffix: ' vendors'
        });
        this.paintTable('tableCoverage', ['Day', localTr('vizDistinctVendorsSeen', 'Distinct vendors seen')],
            this.frame.coverage.map((row) => [row.day, row.vendors]));
    }

    paintRate() {
        this.setCardVisible('cardRate', this.frame.rateByDay.length > 1);
        if (this.frame.rateByDay.length <= 1) return;

        ChartKit.line(document.getElementById('chartRate'), {
            data: this.frame.rateByDay,
            valueKey: 'rate',
            color: this.token('--viz-slot-2', '#2A8EFF'),
            suffix: '%'
        });
        this.paintTable('tableRate', ['Day', 'Scans', localTr('vizWithDetections', 'With detections'), 'Rate'],
            this.frame.rateByDay.map((row) => [row.day, row.scans, row.hits, `${row.rate}%`]));
    }

    paintLayering() {
        const labels = {
            0: 'None',
            1: localTr('vizOneCategory', 'One category'),
            2: localTr('vizTwoCategories', 'Two categories'),
            3: localTr('vizAllThree', 'All three')
        };
        const data = this.frame.layering.map((row) => ({
            ...row,
            band: labels[row.layers] || `${row.layers} categories`
        }));

        ChartKit.bars(document.getElementById('chartLayering'), {
            data,
            labelKey: 'band',
            valueKey: 'pages',
            colorFor: () => this.token('--viz-slot-1', '#F15214'),
            subLabel: (row) => `${Math.round((row.pages / (this.frame.totals.pages || 1)) * 100)}% of scans`
        });
        this.paintTable('tableLayering', [localTr('vizCategoriesOnPage', 'Categories on the page'), 'Scans', 'Share'],
            data.map((row) => [row.band, row.pages, `${Math.round((row.pages / (this.frame.totals.pages || 1)) * 100)}%`]));
    }

    paintSuffixes() {
        const page = this.paginate('Suffixes', this.frame.suffixes);
        ChartKit.bars(document.getElementById('chartSuffixes'), {
            data: page.rows,
            minRows: page.minRows,
            labelKey: 'ending',
            valueKey: 'count',
            colorFor: () => this.token('--viz-slot-1', '#F15214'),
            subLabel: (row) => `${row.sites} site${row.sites === 1 ? '' : 's'} over ${row.scans} scan${row.scans === 1 ? '' : 's'}`,
            labelWidth: 84
        });
        this.paintTable('tableSuffixes', ['Domain ending', 'Detections', 'Sites', 'Scans'],
            this.frame.suffixes.map((row) => [`.${row.ending}`, row.count, row.sites, row.scans]));
    }

    paintSignalMatrix() {
        const grid = this.frame.signalMatrix;
        this.setCardVisible('cardMatrix', grid.rows.length > 0 && grid.columns.length > 0);
        if (grid.rows.length === 0 || grid.columns.length === 0) return;

        // The ramp spans the observed share range, not a theoretical 0-100:
        // shares cluster in a narrow band, and stretching the ramp over the
        // full scale collapses every cell onto one step.
        const peak = Math.max(1, ...grid.shares.flat());
        this.paintScale('legendMatrix', this.ramp, '0%', `${peak}%`);

        ChartKit.heatmap(document.getElementById('chartMatrix'), {
            matrix: grid.shares,
            max: peak,
            ramp: this.ramp,
            rowLabels: grid.rows,
            colLabels: grid.columns.map((column) => column.label),
            cellWidth: 62,
            cellHeight: 32,
            padLeft: 78,
            tip: (taxonomy, signal, share, rowIndex, columnIndex) => {
                const count = grid.matrix[rowIndex][columnIndex];
                return `${taxonomy} found by ${signal}: ${share}% of its matches (${ChartKit.formatCount(count)})`;
            }
        });
        this.paintTable('tableMatrix', ['Category', ...grid.columns.map((column) => column.label)],
            grid.shares.map((row, index) => [
                grid.rows[index],
                ...row.map((share, columnIndex) => `${share}% (${grid.matrix[index][columnIndex]})`)
            ]));
    }

    paintEvidence() {
        this.setCardVisible('cardEvidence', this.frame.evidence.length > 0);
        if (this.frame.evidence.length === 0) return;

        const page = this.paginate('Evidence', this.frame.evidence);
        ChartKit.bars(document.getElementById('chartEvidence'), {
            data: page.rows,
            minRows: page.minRows,
            labelKey: 'token',
            valueKey: 'count',
            colorFor: () => this.token('--viz-slot-2', '#2A8EFF'),
            subLabel: (row) => `${AnalyticsFrame.SIGNAL_LABELS[row.type] || 'Other'} · ${row.vendors} vendor${row.vendors === 1 ? '' : 's'}`,
            labelWidth: 170
        });
        this.paintTable('tableEvidence', ['Matched value', 'Type', 'Matches', 'Vendors'],
            this.frame.evidence.map((row) => [
                row.token,
                AnalyticsFrame.SIGNAL_LABELS[row.type] || 'Other',
                row.count,
                row.vendors
            ]));
    }

    paintConfidenceSpread() {
        const palette = this.taxonomyPalette;
        const data = this.frame.confidenceByTaxonomy;
        this.setCardVisible('cardSpread', data.length > 0);
        if (data.length === 0) return;

        ChartKit.ranges(document.getElementById('chartSpread'), {
            data,
            colorFor: (row) => palette[row.key],
            suffix: '%'
        });
        this.paintTable('tableSpread', ['Category', 'Lowest', 'Average', 'Highest', 'Detections'],
            data.map((row) => [row.label, `${row.low}%`, `${row.average}%`, `${row.high}%`, row.count]));
    }

    paintTaxonomy() {
        const palette = this.taxonomyPalette;
        ChartKit.donut(document.getElementById('chartTaxonomy'), {
            data: this.frame.byTaxonomy,
            valueKey: 'count',
            labelKey: 'label',
            colorFor: (row) => palette[row.key],
            centreValue: ChartKit.formatCount(this.frame.totals.detections),
            centreLabel: 'detections'
        });
        const total = this.frame.totals.detections || 1;
        this.paintLegend('legendTaxonomy', this.frame.byTaxonomy.map((row) => ({
            label: row.label,
            color: palette[row.key],
            value: `${ChartKit.formatCount(row.count)} · ${Math.round((row.count / total) * 100)}%`
        })));
        this.paintTable('tableTaxonomy', ['Category', 'Detections', 'Share'],
            this.frame.byTaxonomy.map((row) => [row.label, row.count, `${Math.round((row.count / total) * 100)}%`]));
    }

    paintGrades() {
        const palette = this.gradePalette;
        const labels = { low: 'Low', medium: 'Medium', high: 'High' };
        const data = this.frame.byGrade.map((row) => ({ ...row, label: labels[row.key] }));

        ChartKit.meter(document.getElementById('chartGrades'), {
            data,
            valueKey: 'count',
            labelKey: 'label',
            colorFor: (row) => palette[row.key]
        });
        const total = data.reduce((sum, row) => sum + row.count, 0) || 1;
        this.paintLegend('legendGrades', data.map((row) => ({
            label: row.label,
            color: palette[row.key],
            value: `${ChartKit.formatCount(row.count)} · ${Math.round((row.count / total) * 100)}%`
        })));
        this.paintTable('tableGrades', [localTr('vizCardBypassDifficulty', 'Bypass difficulty'), 'Detections', 'Share'],
            data.map((row) => [row.label, row.count, `${Math.round((row.count / total) * 100)}%`]));
    }

    paintVendors() {
        const palette = this.taxonomyPalette;
        const page = this.paginate('Vendors', this.frame.vendors);
        ChartKit.bars(document.getElementById('chartVendors'), {
            data: page.rows,
            minRows: page.minRows,
            labelKey: 'name',
            valueKey: 'count',
            colorFor: (row) => palette[row.taxonomy],
            subLabel: (row) => `${row.sites} site${row.sites === 1 ? '' : 's'}`
        });
        // Fixed slot order, not the order the vendors happened to rank in - a
        // legend that reshuffles as the data moves teaches the reader nothing.
        const seen = AnalyticsFrame.TAXONOMY_ORDER
            .filter((key) => this.frame.vendors.some((row) => row.taxonomy === key));
        this.paintLegend('legendVendors', seen.map((key) => ({
            label: AnalyticsFrame.TAXONOMY_LABELS[key],
            color: palette[key]
        })));
        this.paintTable('tableVendors', ['Vendor', 'Category', 'Detections', 'Sites', localTr('vizAvgConfidence', 'Avg confidence')],
            this.frame.vendors.map((row) => [
                row.name,
                AnalyticsFrame.TAXONOMY_LABELS[row.taxonomy],
                row.count,
                row.sites,
                row.avgConfidence === null ? '-' : `${row.avgConfidence}%`
            ]));
    }

    paintSites() {
        const page = this.paginate('Sites', this.frame.sites);
        ChartKit.bars(document.getElementById('chartSites'), {
            data: page.rows,
            minRows: page.minRows,
            labelKey: 'host',
            valueKey: 'count',
            colorFor: () => this.token('--viz-slot-1', '#F15214'),
            subLabel: (row) => `${row.vendors} vendor${row.vendors === 1 ? '' : 's'} over ${row.pages} scan${row.pages === 1 ? '' : 's'}`
        });
        this.paintTable('tableSites', ['Site', 'Detections', 'Scans', 'Vendors', localTr('vizLastSeen', 'Last seen')],
            this.frame.sites.map((row) => [
                row.host,
                row.count,
                row.pages,
                row.vendors,
                new Date(row.lastSeen).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
            ]));
    }

    paintHeatmap() {
        const rowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const colLabels = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
        const ramp = this.ramp;

        ChartKit.heatmap(document.getElementById('chartHeat'), {
            matrix: this.frame.heat.matrix,
            max: this.frame.heat.max,
            ramp,
            rowLabels,
            colLabels,
            labelEvery: 3,
            cellWidth: 44,
            cellHeight: 26,
            tip: (day, hour, value) => `${day} ${hour}:00 - ${ChartKit.formatCount(value)} scan${value === 1 ? '' : 's'}`
        });

        this.paintScale('legendHeat', ramp, '1', ChartKit.formatCount(this.frame.heat.max));

        this.paintTable('tableHeat', ['Day', ...colLabels],
            this.frame.heat.matrix.map((row, day) => [rowLabels[day], ...row]));
    }

    paintSignals() {
        const page = this.paginate('Signals', this.frame.signals);
        ChartKit.bars(document.getElementById('chartSignals'), {
            data: page.rows,
            minRows: page.minRows,
            labelKey: 'label',
            valueKey: 'count',
            colorFor: () => this.token('--viz-slot-1', '#F15214')
        });
        this.paintTable('tableSignals', [localTr('vizSignalType', 'Signal type'), 'Matches'],
            this.frame.signals.map((row) => [row.label, row.count]));
    }

    paintConfidence() {
        const data = this.frame.confidence.map((row) => ({ ...row, band: `${row.from}` }));
        ChartKit.histogram(document.getElementById('chartConfidence'), {
            data,
            labelKey: 'band',
            valueKey: 'count',
            color: this.token('--viz-slot-2', '#2A8EFF')
        });
        this.paintTable('tableConfidence', [localTr('vizConfidenceBand', 'Confidence band'), 'Detections'],
            this.frame.confidence.map((row) => [`${row.from}-${row.to}%`, row.count]));
    }

    paintPerPage() {
        const data = this.frame.perPage.map((row) => ({ ...row, band: String(row.findings) }));
        ChartKit.histogram(document.getElementById('chartPerPage'), {
            data,
            labelKey: 'band',
            valueKey: 'pages',
            color: this.token('--viz-slot-3', '#9F43A8')
        });
        this.paintTable('tablePerPage', [localTr('vizDetectionsOnPage', 'Detections on the page'), 'Scans'],
            this.frame.perPage.map((row) => [row.findings, row.pages]));
    }

    paintPairs() {
        const labelled = this.frame.pairs
            .map((row) => ({ ...row, label: `${row.left} + ${row.right}` }));
        this.setCardVisible('cardPairs', labelled.length > 0);
        if (labelled.length === 0) return;

        // This card sits alone on its row, so it spans the board and takes a
        // chart wide enough to fill it rather than a 560px chart adrift in it.
        const page = this.paginate('Pairs', labelled);
        ChartKit.bars(document.getElementById('chartPairs'), {
            data: page.rows,
            minRows: page.minRows,
            labelKey: 'label',
            valueKey: 'count',
            colorFor: () => this.token('--viz-slot-2', '#2A8EFF'),
            width: 1140,
            labelWidth: 330,
            truncateAt: 46
        });
        this.paintTable('tablePairs', [localTr('vizVendorPair', 'Vendor pair'), localTr('vizCardSeenTogether', 'Seen together')],
            this.frame.pairs.map((row) => [`${row.left} + ${row.right}`, row.count]));
    }

    // ---- shared chrome -------------------------------------------------

    paintLegend(id, items) {
        const host = document.getElementById(id);
        host.textContent = '';
        for (const item of items) {
            const entry = document.createElement('span');
            entry.className = 'viz-key';
            const swatch = document.createElement('i');
            swatch.className = 'viz-key-dot';
            swatch.style.background = item.color;
            entry.appendChild(swatch);
            const label = document.createElement('span');
            label.className = 'viz-key-label';
            label.textContent = item.label;
            entry.appendChild(label);
            if (item.value) {
                const value = document.createElement('span');
                value.className = 'viz-key-value';
                value.textContent = item.value;
                entry.appendChild(value);
            }
            host.appendChild(entry);
        }
    }

    /**
     * Slice one page out of a list and draw its pager. Returns the rows to
     * render; the pager hides itself when everything fits on one page, so a
     * short list carries no chrome it does not need.
     */
    paginate(key, rows) {
        const size = this.pageSize();
        const pages = Math.max(1, Math.ceil(rows.length / size));
        const current = Math.min(Math.max(0, this.pages[key] || 0), pages - 1);
        this.pages[key] = current;

        this.paintPager(`pager${key}`, key, current, pages, rows.length);
        return {
            rows: rows.slice(current * size, current * size + size),
            // Hold the full page height only when there is a page to turn to.
            // Reserving it for a list that fits pads a short card with space it
            // will never use.
            minRows: pages > 1 ? size : 0
        };
    }

    paintPager(hostId, key, current, pages, total) {
        const host = document.getElementById(hostId);
        if (!host) return;
        host.textContent = '';
        if (pages <= 1) {
            host.hidden = true;
            return;
        }
        host.hidden = false;

        const step = (delta, label, disabled) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'viz-page-btn';
            button.textContent = label;
            button.disabled = disabled;
            button.setAttribute('aria-label', delta < 0 ? localTr('vizPrevPage', 'Previous page') : localTr('vizNextPage', 'Next page'));
            button.addEventListener('click', () => {
                this.pages[key] = current + delta;
                this.render();
            });
            return button;
        };

        host.appendChild(step(-1, '\u2039', current === 0));
        const count = document.createElement('span');
        count.className = 'viz-page-count';
        const size = this.pageSize();
        const from = current * size + 1;
        const to = Math.min(total, from + size - 1);
        count.textContent = `${from}\u2013${to} of ${ChartKit.formatCount(total)}`;
        host.appendChild(count);
        host.appendChild(step(1, '\u203a', current >= pages - 1));
    }

    /** The key for a sequential ramp: low cap, the steps, high cap. */
    paintScale(id, ramp, lowLabel, highLabel) {
        const host = document.getElementById(id);
        if (!host) return;
        host.textContent = '';

        const low = document.createElement('span');
        low.className = 'viz-scale-cap';
        low.textContent = lowLabel;
        host.appendChild(low);

        ramp.forEach((step) => {
            const swatch = document.createElement('span');
            swatch.className = 'viz-scale-step';
            swatch.style.background = step;
            host.appendChild(swatch);
        });

        const high = document.createElement('span');
        high.className = 'viz-scale-cap';
        high.textContent = highLabel;
        host.appendChild(high);
    }

    /** The WCAG-clean twin of every chart - no value is reachable only by hover. */
    paintTable(id, columns, rows) {
        const host = document.getElementById(id);
        host.textContent = '';
        const table = document.createElement('table');

        const head = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const column of columns) {
            const cell = document.createElement('th');
            cell.textContent = column;
            headRow.appendChild(cell);
        }
        head.appendChild(headRow);
        table.appendChild(head);

        const body = document.createElement('tbody');
        for (const row of rows) {
            const line = document.createElement('tr');
            row.forEach((value, index) => {
                const cell = document.createElement(index === 0 ? 'th' : 'td');
                cell.textContent = String(value);
                line.appendChild(cell);
            });
            body.appendChild(line);
        }
        table.appendChild(body);
        host.appendChild(table);
    }

    /**
     * The report is Chrome's own print-to-PDF, driven by the @media print block
     * in analytics.css. This project ships no dependencies and runs under MV3's
     * CSP, so bundling a PDF writer would be a large permanent cost for one
     * button; printing gives a vector PDF with the SVG charts intact, and the
     * stylesheet supplies the masthead and the running footer.
     *
     * What is on screen is what comes out, data tables included or not.
     */
    exportPdf() {
        document.getElementById('printStamp').textContent =
            new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });

        // A report that stops at row 8 is worse than a long one. Print draws
        // 20 to a card and keeps the pager's count, so a list that still does
        // not fit says so on the sheet instead of ending without a word. The
        // board goes back to the reader's own view afterwards.
        this.printing = true;
        this.render();

        const restore = () => {
            window.removeEventListener('afterprint', restore);
            this.printing = false;
            this.render();
        };
        window.addEventListener('afterprint', restore);
        window.print();
    }

    exportReport() {
        const report = {
            v: 1,
            savedAt: new Date().toISOString(),
            filters: {
                span: this.filters.since ? new Date(this.filters.since).toISOString() : 'all',
                until: this.filters.until ? new Date(this.filters.until).toISOString() : 'now',
                taxonomy: this.filters.taxonomy,
                search: this.filters.host || null
            },
            span: this.frame.span,
            totals: this.frame.totals,
            byTaxonomy: this.frame.byTaxonomy,
            byGrade: this.frame.byGrade,
            byDay: this.frame.byDay,
            coverage: this.frame.coverage,
            rateByDay: this.frame.rateByDay,
            vendors: this.frame.vendors,
            sites: this.frame.sites,
            suffixes: this.frame.suffixes,
            layering: this.frame.layering,
            evidence: this.frame.evidence,
            signals: this.frame.signals,
            signalMatrix: this.frame.signalMatrix,
            confidenceByTaxonomy: this.frame.confidenceByTaxonomy,
            confidence: this.frame.confidence,
            perPage: this.frame.perPage,
            pairs: this.frame.pairs,
            heat: this.frame.heat
        };
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const address = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = address;
        link.download = `scrapeless-analytics-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(address), 2000);
    }
}

if (typeof window !== 'undefined') {
    window.AnalyticsPresenter = AnalyticsPresenter;
    document.addEventListener('DOMContentLoaded', async () => {
        // Apply translations before the first render, so the page never flashes
        // English at a user who chose another language. Mirrors the console's
        // boot in src/entry/console.js: read the override, then auto-apply.
        if (typeof LocaleRuntime !== 'undefined') {
            try {
                let localOverride = null;
                try {
                    const localR = await chrome.storage.local.get(['scrapeless_language_override']);
                    localOverride = localR && localR.scrapeless_language_override;
                } catch (local) { /* storage not ready, fall back to browser locale */ }
                if (localOverride && localOverride !== 'auto') {
                    await LocaleRuntime.readOverride(localOverride);
                }
                LocaleRuntime.beginAutoApply();
            } catch (failure) { /* i18n is best-effort */ }
        }
        new AnalyticsPresenter().start();
    });
}
if (typeof module !== 'undefined' && module.exports) module.exports = AnalyticsPresenter;
