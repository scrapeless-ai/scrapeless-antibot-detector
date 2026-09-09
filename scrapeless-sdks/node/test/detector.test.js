'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ScrapelessDetector, buildResult, categoryKeyOf, unavailable } = require('..');
const { INIT_SCRIPT, INSTALLED, AWAIT_DETECTION, SNAPSHOT, READY } = require('../lib/bridge.js');

const SDK_ROOT = path.resolve(__dirname, '..', '..');
const VECTORS = JSON.parse(fs.readFileSync(path.join(SDK_ROOT, 'conformance.json'), 'utf8'));

/* ── the shared vectors ─────────────────────────────────────────────────── */

test('category fold matches every shared vector', () => {
    for (const vector of VECTORS.categoryFold) {
        assert.strictEqual(categoryKeyOf({ category: vector.raw }), vector.expect,
            `${JSON.stringify(vector.raw)} should fold to ${vector.expect}`);
    }
});

test('result shape matches every shared vector', () => {
    for (const vector of VECTORS.results) {
        const result = buildResult(true, vector.detail);
        const want = vector.expect;
        assert.strictEqual(result.available, want.available, vector.name + ': available');
        assert.strictEqual(result.total, want.total, vector.name + ': total');
        assert.strictEqual(result.reportedTotal, want.reportedTotal, vector.name + ': reportedTotal');
        assert.deepStrictEqual(result.categories, want.categories, vector.name + ': categories');
        assert.strictEqual(result.isAntibot, want.isAntibot, vector.name + ': isAntibot');
        assert.strictEqual(result.isProtected, want.isProtected, vector.name + ': isProtected');
        if (want.firstName !== undefined) {
            assert.strictEqual(result.detections[0].name, want.firstName, vector.name + ': firstName');
            assert.strictEqual(result.detections[0].categoryKey, want.firstCategoryKey,
                vector.name + ': firstCategoryKey');
        }
        if (want.lastConfidenceIsNull) {
            assert.strictEqual(result.detections[result.detections.length - 1].confidence, null,
                vector.name + ': a non-numeric confidence must be null, not NaN');
        }
    }
});

test('unavailable matches the shared vector, and is not "clean"', () => {
    const result = unavailable();
    const want = VECTORS.unavailable.expect;
    assert.strictEqual(result.available, want.available);
    assert.strictEqual(result.reason, want.reason);
    assert.strictEqual(result.total, want.total);
    assert.deepStrictEqual(result.categories, want.categories);
    // false here must never be read as "clean" — available says which it is.
    assert.strictEqual(result.isAntibot, want.isAntibot);
    assert.strictEqual(result.isProtected, want.isProtected);
});

/* ── drift guard across every SDK ───────────────────────────────────────── */

test('every SDK embeds the canonical bridge script byte-for-byte', () => {
    const canonical = fs.readFileSync(path.join(SDK_ROOT, 'bridge.js'), 'utf8').trim();

    // One entry per embedded copy: where it lives, how to cut it out, and any
    // dedent the host language's literal syntax applies.
    const embeds = [
        ['node/lib/bridge.js', /const INIT_SCRIPT = ("(?:[^"\\]|\\.)*");/s, (m) => JSON.parse(m[1])],
        ['python/scrapeless_detector/_bridge.py', /INIT_SCRIPT = """\n(.*?)"""/s, (m) => m[1]],
        ['go/bridge.go', /const bridgeScript = `\n?(.*?)`/s, (m) => m[1]],
        // Ruby's <<~ strips the common leading indentation at runtime, so the
        // file text carries it and the comparison has to remove it too.
        ['ruby/lib/scrapeless_detector/browser.rb', /INIT_SCRIPT = <<~'JAVASCRIPT'\n(.*?)\n\s*JAVASCRIPT/s,
            (m) => m[1].split('\n').map((line) => line.replace(/^ {4}/, '')).join('\n')],
        ['php/src/Bridge.php', /<<<'JAVASCRIPT'\n(.*?)\nJAVASCRIPT;/s, (m) => m[1]],
        ['rust/src/bridge.rs', /INIT_SCRIPT: &str = r#"\n(.*?)\n"#;/s, (m) => m[1]],
        ['java/src/main/java/io/scrapeless/detector/Bridge.java',
            /INIT_SCRIPT = """\n(.*?)\n""";/s, (m) => m[1]],
        ['csharp/src/ScrapelessDetector/Bridge.cs',
            /InitScript = """\n(.*?)\n""";/s, (m) => m[1]]
    ];

    const missing = [];
    let checked = 0;
    for (const [relative, pattern, extract] of embeds) {
        const full = path.join(SDK_ROOT, relative);
        if (!fs.existsSync(full)) { missing.push(relative); continue; }
        const found = fs.readFileSync(full, 'utf8').match(pattern);
        assert.ok(found, `could not locate the embedded bridge in ${relative}`);
        assert.strictEqual(extract(found).trim(), canonical,
            `${relative} has drifted from scrapeless-sdks/bridge.js`);
        checked += 1;
    }
    assert.deepStrictEqual(missing, [], 'an SDK exists but its bridge was not found');
    assert.strictEqual(checked, embeds.length,
        `expected ${embeds.length} embedded copies, checked ${checked}`);
});

/* ── the public surface, with Chrome faked at its one seam ──────────────── */

function fakePage(detection, options = {}) {
    const settings = { installed: true, ready: null, ...options };
    return {
        initScripts: [],
        async addInitScript(script) { this.initScripts.push(script); },
        async evaluate(expression) {
            if (expression === INSTALLED) { return settings.installed; }
            if (expression === SNAPSHOT) { return detection; }
            if (expression === READY) { return settings.ready; }
            if (expression === AWAIT_DETECTION) { return detection; }
            return null;
        }
    };
}

const SAMPLE = VECTORS.results[0].detail;

test('attach installs the listener at document_start', async () => {
    const page = fakePage(SAMPLE);
    await ScrapelessDetector.attach(page);
    assert.strictEqual(page.initScripts.length, 1, 'must go in via addInitScript');
    assert.match(page.initScripts[0], /__scrapelessSdkBridge/);
});

test('detect answers, and the helpers agree with it', async () => {
    const detector = await ScrapelessDetector.attach(fakePage(SAMPLE));
    const result = await detector.detect();
    assert.strictEqual(result.available, true);
    assert.strictEqual(await detector.isAntibot(), true);
    assert.strictEqual(await detector.isCaptcha(), true);
    assert.strictEqual(await detector.isFingerprinted(), true);
    assert.strictEqual(await detector.isProtected(), true);
});

test('no extension resolves unavailable rather than hanging', async () => {
    const detector = await ScrapelessDetector.attach(fakePage(null, { installed: false }));
    const result = await detector.detect();
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.reason, 'unavailable');
    assert.strictEqual(await detector.isAntibot(), false);
    assert.deepStrictEqual(await detector.ready(), { available: false, version: null });
    assert.strictEqual(await detector.snapshot(), null);
});

test('bridge installed but nothing ever arrives is still unavailable', async () => {
    // Page signals switched off: the bounded wait expires and returns null.
    const detector = await ScrapelessDetector.attach(fakePage(null));
    assert.strictEqual((await detector.detect()).available, false);
});

test('ready reports the extension announcement', async () => {
    const detector = await ScrapelessDetector.attach(fakePage(SAMPLE, { ready: { version: '1.0.1' } }));
    assert.deepStrictEqual(await detector.ready(), { available: true, version: '1.0.1' });
});

test('snapshot never waits', async () => {
    const detector = await ScrapelessDetector.attach(fakePage(SAMPLE));
    assert.strictEqual((await detector.snapshot()).total, 3);
});

test('ofCategory filters to one bucket', async () => {
    const result = buildResult(true, SAMPLE);
    assert.deepStrictEqual(result.ofCategory('antibot').map((d) => d.name),
        ['Cloudflare Bot Management']);
});

test('original detection fields survive normalization', () => {
    const result = buildResult(true, { detections: [{ name: 'Akamai', vendorNote: 'keep me' }] });
    assert.strictEqual(result.detections[0].vendorNote, 'keep me');
});
