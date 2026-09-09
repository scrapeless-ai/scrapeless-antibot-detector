/**
 * TTLMap - Auto-expiring Map with LRU eviction
 *
 * Used for temporary storage of headers, payloads, detection states, etc.
 * Entries auto-expire after ttlMs and oldest entries are evicted when maxSize is reached.
 */
class ExpiringIndex extends Map {
    constructor(localTtlMs = 300000, limitCapacity = 500) { // 5 min default, 500 entries max
        super();
        this.ttlMs = localTtlMs;
        this.maxSize = limitCapacity;
        this.timers = new Map();
        this.expirations = new Map(); // key -> absolute expiry timestamp (ms epoch)
        this.accessOrder = []; // Track insertion order for LRU eviction
    }

    // Lazy expiration: timestamp check on every read.
    // Guards against MV3 service-worker suspend pausing setTimeout (entries that
    // *should* have expired during a long suspension are dropped on next access).
    performIsExpired(lookupKey) {
        const localExpiresAt = this.expirations.get(lookupKey);
        return localExpiresAt !== undefined && Date.now() > localExpiresAt;
    }

    has(lookupKey) {
        if (this.performIsExpired(lookupKey)) {
            this.delete(lookupKey);
            return false;
        }
        return super.has(lookupKey);
    }

    performHas(lookupKey) {
        return this.has(lookupKey);
    }

    get(lookupKey) {
        if (this.performIsExpired(lookupKey)) {
            this.delete(lookupKey);
            return undefined;
        }
        return super.get(lookupKey);
    }

    resolve(lookupKey) {
        return this.get(lookupKey);
    }

    set(lookupKey, datum) {
        // Update existing key
        if (super.has(lookupKey)) {
            // Remove from accessOrder first
            const accessPosition = this.accessOrder.indexOf(lookupKey);
            if (accessPosition > -1) this.accessOrder.splice(accessPosition, 1);
            clearTimeout(this.timers.get(lookupKey));
        } else if (this.size >= this.maxSize) {
            // Adding new key and at capacity - evict oldest
            this.performEvictOldest();
        }

        // Set new timer for auto-cleanup (best-effort; lazy check is the source of truth)
        const localTimer = setTimeout(() => {
            super.delete(lookupKey);
            this.timers.delete(lookupKey);
            this.expirations.delete(lookupKey);
            const accessPosition = this.accessOrder.indexOf(lookupKey);
            if (accessPosition > -1) this.accessOrder.splice(accessPosition, 1);
        }, this.ttlMs);

        this.timers.set(lookupKey, localTimer);
        this.expirations.set(lookupKey, Date.now() + this.ttlMs);
        this.accessOrder.push(lookupKey); // Track insertion order
        return super.set(lookupKey, datum);
    }

    assign(lookupKey, datum) {
        return this.set(lookupKey, datum);
    }

    performEvictOldest() {
        if (this.accessOrder.length === 0) return;
        const localOldest = this.accessOrder.shift(); // Remove oldest
        if (this.timers.has(localOldest)) {
            clearTimeout(this.timers.get(localOldest));
            this.timers.delete(localOldest);
        }
        this.expirations.delete(localOldest);
        super.delete(localOldest);
    }

    delete(lookupKey) {
        if (this.timers.has(lookupKey)) {
            clearTimeout(this.timers.get(lookupKey));
            this.timers.delete(lookupKey);
        }
        this.expirations.delete(lookupKey);
        // Remove from access order
        const accessPosition = this.accessOrder.indexOf(lookupKey);
        if (accessPosition > -1) this.accessOrder.splice(accessPosition, 1);
        return super.delete(lookupKey);
    }

    clear() {
        for (const localTimer of this.timers.values()) {
            clearTimeout(localTimer);
        }
        this.timers.clear();
        this.expirations.clear();
        this.accessOrder = [];
        return super.clear();
    }

    purge() {
        return this.clear();
    }
}

// Node test export (no-op in the browser, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) { module.exports = ExpiringIndex; }
