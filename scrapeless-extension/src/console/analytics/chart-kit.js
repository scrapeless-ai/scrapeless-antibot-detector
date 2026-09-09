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
 * Chart kit - the SVG primitives the analytics page draws with.
 *
 * Everything is built by hand. The extension's CSP is `script-src 'self'`, so a
 * charting library from a CDN could not load even if we wanted one, and the repo
 * ships no build step to vendor one in. Hand-rolled SVG keeps the page at zero
 * runtime dependencies like the rest of the extension.
 *
 * Mark specs are fixed across every chart here: bars cap at 24px with a 4px
 * rounded data-end squared at the baseline, lines are 2px, markers are >= 8px,
 * grid and axis rules are solid hairlines, and touching fills are separated by a
 * 2px gap in the surface colour rather than by a stroke.
 */
class ChartKit {

    static get NS() { return 'http://www.w3.org/2000/svg'; }

    /** 2px of surface between touching marks - the separator, never a stroke. */
    static get GAP() { return 2; }

    static get BAR_CAP() { return 24; }

    static node(name, attributes = {}) {
        const element = document.createElementNS(ChartKit.NS, name);
        for (const [key, value] of Object.entries(attributes)) {
            if (value === null || value === undefined) continue;
            element.setAttribute(key, String(value));
        }
        return element;
    }

    /**
     * A fluid canvas scales to its card; a fixed one keeps its natural pixel
     * size and scrolls instead. Charts whose width grows with the data (the
     * daily timeline, the heatmap) must be fixed - scaling them down shrinks
     * the tick text and the 2px separators along with the marks.
     */
    static canvas(width, height, extra = {}, fluid = true) {
        const svg = ChartKit.node('svg', {
            viewBox: `0 0 ${width} ${height}`,
            width: fluid ? '100%' : width,
            height,
            preserveAspectRatio: 'xMidYMid meet',
            role: 'img',
            ...extra
        });
        if (fluid) {
            // Cap at the natural width so the chart never scales *up* (which
            // would blow the type up with it), and let the height follow the
            // aspect ratio so a narrowed chart never letterboxes inside a
            // fixed-height box.
            svg.style.maxWidth = `${width}px`;
            svg.style.height = 'auto';
        }
        return svg;
    }

    /**
     * A rectangle with the two data-end corners rounded and the baseline corners
     * square, drawn as a path so the radius never bleeds onto the baseline.
     * @param {string} grow - 'up' | 'right'
     */
    static barPath(x, y, width, height, radius, grow) {
        const r = Math.max(0, Math.min(radius, grow === 'up' ? width / 2 : height / 2, grow === 'up' ? height : width));
        if (r <= 0.5) return `M${x} ${y}h${width}v${height}h${-width}z`;

        if (grow === 'up') {
            return `M${x} ${y + height}`
                + `V${y + r}`
                + `a${r} ${r} 0 0 1 ${r} ${-r}`
                + `h${width - 2 * r}`
                + `a${r} ${r} 0 0 1 ${r} ${r}`
                + `V${y + height}z`;
        }
        return `M${x} ${y}`
            + `h${width - r}`
            + `a${r} ${r} 0 0 1 ${r} ${r}`
            + `v${height - 2 * r}`
            + `a${r} ${r} 0 0 1 ${-r} ${r}`
            + `H${x}z`;
    }

    /**
     * Clean axis ticks: 0 / 5 / 10 rather than 0 / 3.7 / 7.4.
     * Every axis on this board counts things, so the step never drops below 1 -
     * a scale reading 0.25 / 0.5 / 0.75 detections is nonsense, and that is
     * exactly what a small maximum produces without the floor.
     */
    static niceTicks(max, count = 4, integral = true) {
        if (!(max > 0)) return { top: 1, ticks: [0, 1] };
        const raw = max / count;
        const magnitude = Math.max(integral ? 1 : 0, Math.pow(10, Math.floor(Math.log10(raw))));
        const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude)
            .filter((candidate) => !integral || Number.isInteger(candidate))
            .find((candidate) => candidate >= raw) || 10 * magnitude;
        const top = Math.ceil(max / step) * step;
        const ticks = [];
        for (let value = 0; value <= top + step / 2; value += step) ticks.push(Math.round(value * 1000) / 1000);
        return { top, ticks };
    }

    static formatCount(value) {
        return Number(value).toLocaleString('en-US');
    }

    /**
     * Attach the hover/focus layer to a mark. Tooltips enhance - they never gate
     * a value, which is why every chart also ships a table view.
     */
    static bindTip(element, text) {
        element.setAttribute('tabindex', '0');
        element.setAttribute('role', 'listitem');
        element.setAttribute('aria-label', text);
        element.dataset.tip = text;
        return element;
    }

    // ---- grid ----------------------------------------------------------

    static gridLines(target, { left, top, width, height, ticks, topValue, orient = 'y' }) {
        const group = ChartKit.node('g', { class: 'chart-grid' });
        for (const tick of ticks) {
            if (orient === 'y') {
                const y = top + height - (tick / topValue) * height;
                group.appendChild(ChartKit.node('line', { x1: left, y1: y, x2: left + width, y2: y }));
                const label = ChartKit.node('text', { x: left - 8, y: y + 3.5, class: 'chart-tick', 'text-anchor': 'end' });
                label.textContent = ChartKit.formatCount(tick);
                group.appendChild(label);
            }
        }
        target.appendChild(group);
        return group;
    }

    // ---- stacked columns ----------------------------------------------

    /**
     * Stacked columns over a time axis. One column per day, segments in fixed
     * series order so a filtered-out series never repaints its neighbours.
     */
    static stackedColumns(host, { data, series, height = 210, padLeft = 46, padRight = 12, padTop = 12, padBottom = 26 }) {
        host.textContent = '';
        const columns = data.length;
        const width = Math.max(560, columns * 26 + padLeft + padRight);
        const plotWidth = width - padLeft - padRight;
        const plotHeight = height - padTop - padBottom;

        const max = Math.max(0, ...data.map((row) => series.reduce((sum, one) => sum + (row[one.key] || 0), 0)));
        const { top, ticks } = ChartKit.niceTicks(max);

        const svg = ChartKit.canvas(width, height, { class: 'chart-svg', 'aria-label': localTr('vizDetectionsPerDayByCategory', 'Detections per day by category') }, false);
        ChartKit.gridLines(svg, { left: padLeft, top: padTop, width: plotWidth, height: plotHeight, ticks, topValue: top });

        const band = plotWidth / Math.max(1, columns);
        const barWidth = Math.min(ChartKit.BAR_CAP, Math.max(3, band - 6));

        const marks = ChartKit.node('g', { role: 'list' });
        data.forEach((row, index) => {
            const x = padLeft + band * index + (band - barWidth) / 2;
            let cursor = padTop + plotHeight;
            const total = series.reduce((sum, one) => sum + (row[one.key] || 0), 0);

            series.forEach((one) => {
                const value = row[one.key] || 0;
                if (value <= 0) return;
                const rawHeight = (value / top) * plotHeight;
                // The 2px gap is carved out of the segment, so the stack total
                // still lands exactly on its gridline.
                const drawn = Math.max(1, rawHeight - ChartKit.GAP);
                const y = cursor - rawHeight;
                const isCap = cursor >= padTop + plotHeight - 0.5;
                const path = ChartKit.node('path', {
                    d: ChartKit.barPath(x, y, barWidth, drawn + (isCap ? ChartKit.GAP : 0), 4, 'up'),
                    fill: one.color,
                    class: 'chart-mark'
                });
                ChartKit.bindTip(path, `${row.day} - ${one.label}: ${ChartKit.formatCount(value)} of ${ChartKit.formatCount(total)}`);
                marks.appendChild(path);
                cursor = y;
            });
        });
        svg.appendChild(marks);

        // Label the first and last day only - a date under every column collides.
        const axis = ChartKit.node('g', { class: 'chart-axis' });
        const stamp = (index) => {
            const row = data[index];
            const moment = new Date(row.stamp);
            return `${moment.getDate()} ${moment.toLocaleString('en-US', { month: 'short' })}`;
        };
        if (columns > 0) {
            const first = ChartKit.node('text', { x: padLeft, y: height - 8, class: 'chart-tick', 'text-anchor': 'start' });
            first.textContent = stamp(0);
            axis.appendChild(first);
        }
        if (columns > 1) {
            const last = ChartKit.node('text', { x: padLeft + plotWidth, y: height - 8, class: 'chart-tick', 'text-anchor': 'end' });
            last.textContent = stamp(columns - 1);
            axis.appendChild(last);
        }
        svg.appendChild(axis);

        host.appendChild(svg);
        return svg;
    }

    // ---- horizontal bars ----------------------------------------------

    /**
     * Horizontal bars with the value at the tip. `colorFor` returns a hue per
     * row so identity follows the entity, never its rank.
     */
    static bars(host, { data, labelKey, valueKey, colorFor, subLabel, rowHeight = 26, labelWidth = 132, valueWidth = 54, width = 560, minRows = 0, truncateAt = 20 }) {
        host.textContent = '';
        // `minRows` reserves the full page height, so a short last page does not
        // shrink the card and shuffle every neighbour's height with it.
        const rows = Math.max(data.length, minRows, 1);
        const height = rows * rowHeight + 4;
        const trackLeft = labelWidth + 10;
        const trackWidth = width - trackLeft - valueWidth - 8;
        const max = Math.max(1, ...data.map((row) => row[valueKey] || 0));
        const barHeight = Math.min(ChartKit.BAR_CAP, rowHeight - 10);

        const svg = ChartKit.canvas(width, height, { class: 'chart-svg', role: 'list' });

        data.forEach((row, index) => {
            const y = index * rowHeight + 2;
            const value = row[valueKey] || 0;
            const barWidth = Math.max(2, (value / max) * trackWidth);

            const label = ChartKit.node('text', {
                x: labelWidth,
                y: y + barHeight / 2 + 4,
                class: 'chart-rowlabel',
                'text-anchor': 'end'
            });
            label.textContent = ChartKit.truncate(row[labelKey], truncateAt);
            svg.appendChild(label);

            const track = ChartKit.node('rect', {
                x: trackLeft, y, width: trackWidth, height: barHeight, rx: 2, class: 'chart-track'
            });
            svg.appendChild(track);

            const bar = ChartKit.node('path', {
                d: ChartKit.barPath(trackLeft, y, barWidth, barHeight, 4, 'right'),
                fill: colorFor ? colorFor(row) : 'var(--viz-slot-1)',
                class: 'chart-mark'
            });
            ChartKit.bindTip(bar, `${row[labelKey]}: ${ChartKit.formatCount(value)}${subLabel ? ` - ${subLabel(row)}` : ''}`);
            svg.appendChild(bar);

            const tip = ChartKit.node('text', {
                x: trackLeft + trackWidth + 8,
                y: y + barHeight / 2 + 4,
                class: 'chart-value'
            });
            tip.textContent = ChartKit.formatCount(value);
            svg.appendChild(tip);
        });

        host.appendChild(svg);
        return svg;
    }

    // ---- donut ---------------------------------------------------------

    /** Part-to-whole at a glance. Six segments is the ceiling; we carry three. */
    static donut(host, { data, valueKey, labelKey, colorFor, size = 190, thickness = 26, centreValue, centreLabel }) {
        host.textContent = '';
        const total = data.reduce((sum, row) => sum + (row[valueKey] || 0), 0);
        const radius = (size - thickness) / 2;
        const centre = size / 2;
        const svg = ChartKit.canvas(size, size, { class: 'chart-svg chart-donut', role: 'list' });

        if (total <= 0) {
            svg.appendChild(ChartKit.node('circle', { cx: centre, cy: centre, r: radius, class: 'chart-track', fill: 'none', 'stroke-width': thickness }));
        } else {
            const circumference = 2 * Math.PI * radius;
            // The 2px separator is a dash gap, so no stroke is drawn around a segment.
            let offset = 0;
            data.forEach((row) => {
                const value = row[valueKey] || 0;
                if (value <= 0) return;
                const length = (value / total) * circumference;
                const arc = ChartKit.node('circle', {
                    cx: centre,
                    cy: centre,
                    r: radius,
                    fill: 'none',
                    stroke: colorFor(row),
                    'stroke-width': thickness,
                    'stroke-dasharray': `${Math.max(0.5, length - ChartKit.GAP)} ${circumference - Math.max(0.5, length - ChartKit.GAP)}`,
                    'stroke-dashoffset': -offset,
                    transform: `rotate(-90 ${centre} ${centre})`,
                    class: 'chart-mark'
                });
                const share = Math.round((value / total) * 100);
                ChartKit.bindTip(arc, `${row[labelKey]}: ${ChartKit.formatCount(value)} (${share}%)`);
                svg.appendChild(arc);
                offset += length;
            });
        }

        const figure = ChartKit.node('text', { x: centre, y: centre + 2, class: 'chart-centre-value', 'text-anchor': 'middle' });
        figure.textContent = centreValue;
        svg.appendChild(figure);
        const caption = ChartKit.node('text', { x: centre, y: centre + 20, class: 'chart-centre-label', 'text-anchor': 'middle' });
        caption.textContent = centreLabel;
        svg.appendChild(caption);

        host.appendChild(svg);
        return svg;
    }

    // ---- meter ---------------------------------------------------------

    /** A single stacked rail - part-to-whole where a donut would be overkill. */
    static meter(host, { data, valueKey, labelKey, colorFor, height = 26 }) {
        host.textContent = '';
        const width = 560;
        const total = data.reduce((sum, row) => sum + (row[valueKey] || 0), 0);
        const svg = ChartKit.canvas(width, height + 4, { class: 'chart-svg', role: 'list' });

        if (total <= 0) {
            svg.appendChild(ChartKit.node('rect', { x: 0, y: 2, width, height, rx: 3, class: 'chart-track' }));
            host.appendChild(svg);
            return svg;
        }

        let cursor = 0;
        data.forEach((row) => {
            const value = row[valueKey] || 0;
            if (value <= 0) return;
            const raw = (value / total) * width;
            const drawn = Math.max(2, raw - ChartKit.GAP);
            const segment = ChartKit.node('rect', {
                x: cursor, y: 2, width: drawn, height, rx: 3, fill: colorFor(row), class: 'chart-mark'
            });
            const share = Math.round((value / total) * 100);
            ChartKit.bindTip(segment, `${row[labelKey]}: ${ChartKit.formatCount(value)} (${share}%)`);
            svg.appendChild(segment);

            // Only label inside the fill when the text genuinely fits, never clipped.
            const share_text = `${share}%`;
            if (drawn > share_text.length * 8 + 16) {
                const inside = ChartKit.node('text', {
                    x: cursor + drawn / 2,
                    y: 2 + height / 2 + 4,
                    class: 'chart-inlay',
                    'text-anchor': 'middle',
                    fill: ChartKit.readableInk(colorFor(row))
                });
                inside.textContent = share_text;
                svg.appendChild(inside);
            }
            cursor += raw;
        });

        host.appendChild(svg);
        return svg;
    }

    // ---- histogram -----------------------------------------------------

    static histogram(host, { data, labelKey, valueKey, color, height = 170, padLeft = 40, padBottom = 28, padTop = 10 }) {
        host.textContent = '';
        const width = 560;
        const plotWidth = width - padLeft - 12;
        const plotHeight = height - padTop - padBottom;
        const max = Math.max(0, ...data.map((row) => row[valueKey] || 0));
        const { top, ticks } = ChartKit.niceTicks(max);

        const svg = ChartKit.canvas(width, height, { class: 'chart-svg', role: 'list' });
        ChartKit.gridLines(svg, { left: padLeft, top: padTop, width: plotWidth, height: plotHeight, ticks, topValue: top });

        const band = plotWidth / Math.max(1, data.length);
        const barWidth = Math.min(ChartKit.BAR_CAP, Math.max(4, band - ChartKit.GAP * 2));

        data.forEach((row, index) => {
            const value = row[valueKey] || 0;
            const x = padLeft + band * index + (band - barWidth) / 2;
            const barHeight = value > 0 ? Math.max(2, (value / top) * plotHeight) : 0;
            if (barHeight > 0) {
                const bar = ChartKit.node('path', {
                    d: ChartKit.barPath(x, padTop + plotHeight - barHeight, barWidth, barHeight, 4, 'up'),
                    fill: color,
                    class: 'chart-mark'
                });
                ChartKit.bindTip(bar, `${row[labelKey]}: ${ChartKit.formatCount(value)}`);
                svg.appendChild(bar);
            }
            const tick = ChartKit.node('text', {
                x: padLeft + band * index + band / 2,
                y: height - 9,
                class: 'chart-tick',
                'text-anchor': 'middle'
            });
            tick.textContent = row[labelKey];
            svg.appendChild(tick);
        });

        host.appendChild(svg);
        return svg;
    }

    // ---- heatmap -------------------------------------------------------

    /** Weekday x hour. One hue, stepped - magnitude, so a sequential ramp. */
    /**
     * A value grid. Dimensions come from the matrix, so the same primitive
     * draws weekday x hour and category x signal-type.
     * @param {function} tip - (rowLabel, colLabel, value, rowIndex, colIndex) => text
     */
    static heatmap(host, { matrix, max, ramp, rowLabels, colLabels, cell = 20, cellWidth, cellHeight, padLeft = 34, labelEvery = 1, tip }) {
        host.textContent = '';
        const gap = ChartKit.GAP;
        const padTop = 16;
        // Width and height are separable: a column axis with word labels needs
        // wider cells than a square grid, and squashing the labels together is
        // worse than a rectangular tile.
        const stepX = cellWidth || cell;
        const stepY = cellHeight || cell;
        const columns = matrix.length ? matrix[0].length : 0;
        const width = padLeft + columns * stepX;
        const height = padTop + matrix.length * stepY + 6;
        const svg = ChartKit.canvas(width, height, { class: 'chart-svg', role: 'list' }, false);

        colLabels.forEach((label, column) => {
            if (column % labelEvery !== 0) return;
            const tick = ChartKit.node('text', {
                x: padLeft + column * stepX + (stepX - gap) / 2,
                y: padTop - 5,
                class: 'chart-tick',
                'text-anchor': 'middle'
            });
            tick.textContent = label;
            svg.appendChild(tick);
        });

        matrix.forEach((row, rowIndex) => {
            const tick = ChartKit.node('text', {
                x: padLeft - 7,
                y: padTop + rowIndex * stepY + (stepY - gap) / 2 + 4,
                class: 'chart-tick',
                'text-anchor': 'end'
            });
            tick.textContent = rowLabels[rowIndex];
            svg.appendChild(tick);

            row.forEach((value, column) => {
                const step = value <= 0
                    ? -1
                    : Math.min(ramp.length - 1, Math.floor(((value - 1) / Math.max(1, max)) * ramp.length));
                const tile = ChartKit.node('rect', {
                    x: padLeft + column * stepX,
                    y: padTop + rowIndex * stepY,
                    width: stepX - gap,
                    height: stepY - gap,
                    rx: 2,
                    fill: step < 0 ? 'var(--viz-empty)' : ramp[step],
                    class: value > 0 ? 'chart-mark' : 'chart-cell-empty'
                });
                ChartKit.bindTip(tile, tip(rowLabels[rowIndex], colLabels[column], value, rowIndex, column));
                svg.appendChild(tile);
            });
        });

        host.appendChild(svg);
        return svg;
    }

    // ---- line ----------------------------------------------------------

    /**
     * A single series over time: a 2px line on a 10% wash, with the end point
     * marked and directly labelled. One series, so no legend box - the card
     * title names what is plotted.
     */
    static line(host, { data, valueKey, color, height = 190, padLeft = 46, padRight = 52, padTop = 14, padBottom = 26, suffix = '' }) {
        host.textContent = '';
        // Fixed design width, scaled to the card. A line has no per-point
        // minimum the way a stacked column does, and the end point carries the
        // headline value - putting it behind a horizontal scroll would hide
        // the one number the chart exists to show.
        const width = 560;
        const plotWidth = width - padLeft - padRight;
        const plotHeight = height - padTop - padBottom;

        const values = data.map((row) => row[valueKey] || 0);
        const max = Math.max(0, ...values);
        const { top, ticks } = ChartKit.niceTicks(max, 4);

        const svg = ChartKit.canvas(width, height, { class: 'chart-svg' });
        ChartKit.gridLines(svg, { left: padLeft, top: padTop, width: plotWidth, height: plotHeight, ticks, topValue: top });

        const step = data.length > 1 ? plotWidth / (data.length - 1) : 0;
        const pointX = (index) => padLeft + (data.length > 1 ? step * index : plotWidth / 2);
        const pointY = (value) => padTop + plotHeight - (value / top) * plotHeight;
        const points = values.map((value, index) => [pointX(index), pointY(value)]);

        if (points.length > 0) {
            const spine = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x} ${y}`).join('');
            const wash = ChartKit.node('path', {
                d: `${spine}L${points[points.length - 1][0]} ${padTop + plotHeight}L${points[0][0]} ${padTop + plotHeight}z`,
                fill: color,
                'fill-opacity': 0.1,
                stroke: 'none'
            });
            svg.appendChild(wash);

            svg.appendChild(ChartKit.node('path', {
                d: spine,
                fill: 'none',
                stroke: color,
                'stroke-width': 2,
                'stroke-linejoin': 'round',
                'stroke-linecap': 'round'
            }));

            // Hit targets ride the line rather than the 2px stroke, so hovering
            // does not demand pixel accuracy.
            const targets = ChartKit.node('g', { role: 'list' });
            points.forEach(([x, y], index) => {
                const target = ChartKit.node('circle', { cx: x, cy: y, r: Math.max(7, step / 2), fill: 'transparent', class: 'chart-hit' });
                ChartKit.bindTip(target, `${data[index].day} - ${ChartKit.formatCount(values[index])}${suffix}`);
                targets.appendChild(target);
            });
            svg.appendChild(targets);

            const [endX, endY] = points[points.length - 1];
            svg.appendChild(ChartKit.node('circle', {
                cx: endX, cy: endY, r: 4.5, fill: color, stroke: 'var(--viz-surface)', 'stroke-width': 2
            }));

            const endLabel = ChartKit.node('text', {
                x: endX + 9, y: endY + 4, class: 'chart-value', 'text-anchor': 'start'
            });
            endLabel.textContent = `${ChartKit.formatCount(values[values.length - 1])}${suffix}`;
            svg.appendChild(endLabel);
        }

        const axis = ChartKit.node('g', { class: 'chart-axis' });
        const stamp = (index) => {
            const moment = new Date(data[index].stamp);
            return `${moment.getDate()} ${moment.toLocaleString('en-US', { month: 'short' })}`;
        };
        if (data.length > 0) {
            const first = ChartKit.node('text', { x: padLeft, y: height - 8, class: 'chart-tick', 'text-anchor': 'start' });
            first.textContent = stamp(0);
            axis.appendChild(first);
        }
        if (data.length > 1) {
            const last = ChartKit.node('text', { x: padLeft + plotWidth, y: height - 8, class: 'chart-tick', 'text-anchor': 'end' });
            last.textContent = stamp(data.length - 1);
            axis.appendChild(last);
        }
        svg.appendChild(axis);

        host.appendChild(svg);
        return svg;
    }

    // ---- ranges --------------------------------------------------------

    /**
     * Low-to-high spans with the average marked. An average alone hides how
     * wide the spread underneath it is, which is the whole question here.
     */
    static ranges(host, { data, colorFor, rowHeight = 30, labelWidth = 96, domain = [0, 100], suffix = '' }) {
        host.textContent = '';
        const width = 560;
        const height = Math.max(rowHeight, data.length * rowHeight) + 16;
        const trackLeft = labelWidth + 10;
        const trackWidth = width - trackLeft - 52;
        const [floor, ceiling] = domain;
        const scale = (value) => trackLeft + ((value - floor) / (ceiling - floor)) * trackWidth;

        const svg = ChartKit.canvas(width, height, { class: 'chart-svg', role: 'list' });

        // One shared scale rule under the spans.
        for (const tick of [0, 25, 50, 75, 100]) {
            const x = scale(tick);
            svg.appendChild(ChartKit.node('line', {
                x1: x, y1: 2, x2: x, y2: data.length * rowHeight, class: 'chart-gridline'
            }));
            const label = ChartKit.node('text', {
                x, y: height - 3, class: 'chart-tick', 'text-anchor': 'middle'
            });
            label.textContent = `${tick}${suffix}`;
            svg.appendChild(label);
        }

        data.forEach((row, index) => {
            const y = index * rowHeight + rowHeight / 2 - 4;
            const label = ChartKit.node('text', {
                x: labelWidth, y: y + 4, class: 'chart-rowlabel', 'text-anchor': 'end'
            });
            label.textContent = ChartKit.truncate(row.label, 14);
            svg.appendChild(label);

            const span = ChartKit.node('rect', {
                x: scale(row.low),
                y: y - 3,
                width: Math.max(3, scale(row.high) - scale(row.low)),
                height: 7,
                rx: 3.5,
                fill: colorFor(row),
                'fill-opacity': 0.32
            });
            svg.appendChild(span);

            const marker = ChartKit.node('circle', {
                cx: scale(row.average), cy: y + 0.5, r: 4.5,
                fill: colorFor(row), stroke: 'var(--viz-surface)', 'stroke-width': 2, class: 'chart-mark'
            });
            ChartKit.bindTip(marker, `${row.label}: ${row.low}${suffix} to ${row.high}${suffix}, average ${row.average}${suffix} across ${ChartKit.formatCount(row.count)}`);
            svg.appendChild(marker);

            const value = ChartKit.node('text', {
                x: width - 44, y: y + 4, class: 'chart-value', 'text-anchor': 'start'
            });
            value.textContent = `${row.average}${suffix}`;
            svg.appendChild(value);
        });

        host.appendChild(svg);
        return svg;
    }

    // ---- helpers -------------------------------------------------------

    static truncate(text, limit) {
        const value = String(text ?? '');
        return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
    }

    /** Pick ink or paper for a label set inside a coloured fill. */
    static readableInk(hex) {
        const token = String(hex).replace('#', '');
        if (token.length !== 6) return '#0d0d0d';
        const channel = (offset) => {
            const value = parseInt(token.slice(offset, offset + 2), 16) / 255;
            return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
        };
        const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
        return luminance > 0.42 ? '#101010' : '#ffffff';
    }
}

if (typeof window !== 'undefined') window.ChartKit = ChartKit;
if (typeof module !== 'undefined' && module.exports) module.exports = ChartKit;
