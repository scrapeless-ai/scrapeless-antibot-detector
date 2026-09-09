/**
 * Scrapeless Anti-Bot Detector — Node SDK types.
 *
 * `available` is the field that matters. A `false` from `isAntibot` means "no
 * anti-bot detection was reported", which is NOT "this page is clean" when
 * `available` is false.
 */

export type CategoryKey = 'antibot' | 'captcha' | 'fingerprint' | 'other';

export const CATEGORY_ANTIBOT: 'antibot';
export const CATEGORY_CAPTCHA: 'captcha';
export const CATEGORY_FINGERPRINT: 'fingerprint';
export const CATEGORY_OTHER: 'other';
export const DEFAULT_TIMEOUT_MS: number;

/** One detection. Every original field is preserved alongside the added ones. */
export interface Detection {
    name: string;
    categoryKey: CategoryKey;
    /** A number, or null when the extension sent something non-numeric. Never NaN. */
    confidence: number | null;
    [field: string]: unknown;
}

export interface CategoryCounts {
    antibot: number;
    captcha: number;
    fingerprint: number;
    other: number;
}

export interface Result {
    /** Was the extension actually heard from? Check this before trusting a false. */
    available: boolean;
    reason: 'unavailable' | 'destroyed' | null;
    url: string | null;
    timestamp: string | null;
    fromCache: boolean;
    /** Detections that actually arrived. */
    total: number;
    /** What the extension claimed; differs from `total` only if a payload was trimmed. */
    reportedTotal: number;
    categories: CategoryCounts;
    detections: Detection[];
    hasCategory(key: string): boolean;
    readonly isAntibot: boolean;
    readonly isCaptcha: boolean;
    readonly isFingerprinted: boolean;
    readonly isProtected: boolean;
    ofCategory(key: string): Detection[];
}

export interface ReadyState {
    available: boolean;
    version: string | null;
}

export interface BrowserOptions {
    /** Chrome cannot load extensions in classic headless. Defaults to false. */
    headless?: boolean;
    userDataDir?: string;
    args?: string[];
    timeout?: number;
}

/** Minimal shape this SDK needs from a Playwright Page. */
export interface PageLike {
    addInitScript(script: string): Promise<void>;
    evaluate(expression: string, arg?: unknown): Promise<any>;
}

export class BrowserSession {
    readonly context: unknown;
    detect(url: string, timeoutMs?: number): Promise<Result>;
}

export class ScrapelessDetector {
    constructor(page: PageLike, timeoutMs?: number);
    readonly page: PageLike;
    /** Install the listener. Call BEFORE navigating. */
    static attach(page: PageLike, timeoutMs?: number): Promise<ScrapelessDetector>;
    static withBrowser<T>(
        extensionPath: string,
        body: (session: BrowserSession) => Promise<T>,
        options?: BrowserOptions
    ): Promise<T>;
    detect(timeoutMs?: number): Promise<Result>;
    snapshot(): Promise<Result | null>;
    ready(): Promise<ReadyState>;
    isAntibot(timeoutMs?: number): Promise<boolean>;
    isCaptcha(timeoutMs?: number): Promise<boolean>;
    isFingerprinted(timeoutMs?: number): Promise<boolean>;
    isProtected(timeoutMs?: number): Promise<boolean>;
}

export function categoryKeyOf(detection: unknown): CategoryKey;
export function buildResult(available: boolean, detail: unknown, reason?: string): Result;
export function unavailable(reason?: string): Result;
