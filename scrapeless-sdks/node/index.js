'use strict';

/**
 * Scrapeless Anti-Bot Detector — Node SDK.
 *
 *     const { ScrapelessDetector } = require('scrapeless-detector');
 *
 *     await ScrapelessDetector.withBrowser('./scrapeless-extension', async (session) => {
 *         const result = await session.detect('https://example.com/checkout');
 *         if (result.isAntibot) { console.log(result.ofCategory('antibot')); }
 *     });
 *
 * Node cannot hear the extension directly — the extension talks to the *page*,
 * by dispatching CustomEvents at window. So this SDK drives a real Chrome with
 * the extension loaded and reads the result back out of the document.
 *
 * That is the difference between this and ../browser. The browser SDK is UMD, so
 * it imports fine under require() — but in Node there is no window and no
 * extension, so every call would return available:false. This one works because
 * it brings its own browser.
 *
 * Two things decide whether you get an answer, and neither announces itself: the
 * page API ships disabled (Settings -> Detection -> Page signals), and Chrome
 * may not have loaded the extension. Neither is distinguishable from "nothing
 * detected" by listening, so every wait is bounded and resolves to a result
 * carrying available:false. Check available before trusting a false.
 */

const {
    AWAIT_DETECTION, INIT_SCRIPT, INSTALLED, READY, SNAPSHOT, chromiumExtensionArgs
} = require('./lib/bridge.js');
const core = require('./lib/core.js');

const DEFAULT_TIMEOUT_MS = 8000;

class ScrapelessDetector {
    constructor(page, timeoutMs) {
        this._page = page;
        this._timeoutMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    }

    get page() { return this._page; }

    /**
     * Install the listener on `page`. Attach BEFORE navigating: the script goes
     * in via addInitScript so it runs at document_start on every subsequent
     * document. It is also evaluated against the current document, so attaching
     * to an already-loaded page works — at the cost of possibly having missed
     * the detection that already fired.
     */
    static async attach(page, timeoutMs) {
        const detector = new ScrapelessDetector(page, timeoutMs);
        await page.addInitScript(INIT_SCRIPT);
        try {
            await page.evaluate(INIT_SCRIPT);
        } catch (ignored) {
            // No document yet (about:blank before any goto). The init script
            // still covers every real navigation, which is the case that counts.
        }
        return detector;
    }

    /** Wait for the detection result, bounded. Replays if it already fired. */
    async detect(timeoutMs) {
        const budget = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : this._timeoutMs;
        if (!(await this._page.evaluate(INSTALLED))) { return core.unavailable(); }
        const detail = await this._page.evaluate(AWAIT_DETECTION, budget);
        return detail == null ? core.unavailable() : core.buildResult(true, detail);
    }

    /** The last result already seen, or null. Never waits. */
    async snapshot() {
        if (!(await this._page.evaluate(INSTALLED))) { return null; }
        const detail = await this._page.evaluate(SNAPSHOT);
        return detail == null ? null : core.buildResult(true, detail);
    }

    /** What the extension announced about itself, if anything. */
    async ready() {
        if (!(await this._page.evaluate(INSTALLED))) { return { available: false, version: null }; }
        const detail = await this._page.evaluate(READY);
        if (!detail) { return { available: false, version: null }; }
        return { available: true, version: detail.version || null };
    }

    async isAntibot(timeoutMs) { return (await this.detect(timeoutMs)).isAntibot; }
    async isCaptcha(timeoutMs) { return (await this.detect(timeoutMs)).isCaptcha; }
    async isFingerprinted(timeoutMs) { return (await this.detect(timeoutMs)).isFingerprinted; }
    async isProtected(timeoutMs) { return (await this.detect(timeoutMs)).isProtected; }

    /**
     * Launch Chromium with the extension loaded, run `body(session)`, shut down.
     *
     * Extensions require a persistent context, and classic headless Chrome
     * cannot load them at all — so headless defaults to false. On a machine with
     * no display, run under xvfb-run.
     */
    static async withBrowser(extensionPath, body, options) {
        const settings = options || {};
        const { chromium } = require('playwright');
        const os = require('os');
        const fs = require('fs');
        const path = require('path');

        let userDataDir = settings.userDataDir;
        let temporary = null;
        if (!userDataDir) {
            temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapeless-sdk-'));
            userDataDir = temporary;
        }

        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: settings.headless === true,
            args: (settings.args || []).concat(chromiumExtensionArgs(extensionPath))
        });
        try {
            await context.addInitScript(INIT_SCRIPT);
            return await body(new BrowserSession(context, settings.timeout || DEFAULT_TIMEOUT_MS));
        } finally {
            await context.close();
            if (temporary) { fs.rmSync(temporary, { recursive: true, force: true }); }
        }
    }
}

/** A launched browser plus the one call most callers want: URL -> result. */
class BrowserSession {
    constructor(context, timeoutMs) {
        this._context = context;
        this._timeoutMs = timeoutMs;
    }

    get context() { return this._context; }

    async detect(url, timeoutMs) {
        const page = await this._context.newPage();
        try {
            const detector = await ScrapelessDetector.attach(page, this._timeoutMs);
            await page.goto(url);
            return await detector.detect(timeoutMs);
        } finally {
            await page.close();
        }
    }
}

module.exports = {
    ScrapelessDetector,
    BrowserSession,
    categoryKeyOf: core.categoryKeyOf,
    buildResult: core.buildResult,
    unavailable: core.unavailable,
    DEFAULT_TIMEOUT_MS,
    CATEGORY_ANTIBOT: core.CATEGORY_ANTIBOT,
    CATEGORY_CAPTCHA: core.CATEGORY_CAPTCHA,
    CATEGORY_FINGERPRINT: core.CATEGORY_FINGERPRINT,
    CATEGORY_OTHER: core.CATEGORY_OTHER
};
