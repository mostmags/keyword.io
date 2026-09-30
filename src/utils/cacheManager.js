/**
 * Layered Caching and Request Deduplication Engine for Keyword Finder.
 * - Level 1: In-memory Map
 * - Level 2: Persistent localStorage with TTL expiration
 * - Level 3: In-flight request deduplication (promise sharing)
 */

export const CACHE_TTLS = {
  SUGGESTIONS: 24 * 60 * 60 * 1000,      // 24 hours
  ANALYZE: 6 * 60 * 60 * 1000,           // 6 hours
  CHANNEL_INDEX: 24 * 60 * 60 * 1000,    // 24 hours
  ACTION_WORDS: 7 * 24 * 60 * 60 * 1000  // 7 days
};

class CacheManager {
  constructor() {
    this.memoryCache = new Map();
    this.inFlightRequests = new Map();
  }

  /**
   * Get an item from memory or localStorage if valid.
   */
  get(key, ttl = CACHE_TTLS.ANALYZE) {
    // 1. Check in-memory cache
    if (this.memoryCache.has(key)) {
      const entry = this.memoryCache.get(key);
      if (Date.now() - entry.timestamp < ttl) {
        return entry.data;
      }
      this.memoryCache.delete(key);
    }

    // 2. Check localStorage (persistent)
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const itemStr = window.localStorage.getItem(`kf_cache_${key}`);
        if (itemStr) {
          const entry = JSON.parse(itemStr);
          if (Date.now() - entry.timestamp < ttl) {
            // Restore to memory cache
            this.memoryCache.set(key, entry);
            return entry.data;
          }
          window.localStorage.removeItem(`kf_cache_${key}`);
        }
      } catch {
        // localStorage quota exceeded or parse error
      }
    }

    return null;
  }

  /**
   * Store an item into memory and localStorage.
   */
  set(key, data) {
    const entry = {
      timestamp: Date.now(),
      data
    };

    // Store in memory
    this.memoryCache.set(key, entry);

    // Store in localStorage
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(`kf_cache_${key}`, JSON.stringify(entry));
      } catch {
        // Handle storage quota by clearing old kf_cache items
        this._pruneStorage();
      }
    }
  }

  /**
   * Deduplicate concurrent in-flight requests.
   * If a fetch for `key` is already in-flight, return the existing promise.
   */
  async deduplicate(key, fetchFn) {
    if (this.inFlightRequests.has(key)) {
      return this.inFlightRequests.get(key);
    }

    const promise = (async () => {
      try {
        const result = await fetchFn();
        return result;
      } finally {
        this.inFlightRequests.delete(key);
      }
    })();

    this.inFlightRequests.set(key, promise);
    return promise;
  }

  /**
   * Clear expired entries from localStorage
   */
  _pruneStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const keysToRemove = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith('kf_cache_')) {
          keysToRemove.push(k);
        }
      }
      // Remove oldest entries
      keysToRemove.slice(0, 20).forEach(k => window.localStorage.removeItem(k));
    } catch {
      // Ignore
    }
  }

  /**
   * Clear all caches
   */
  clear() {
    this.memoryCache.clear();
    this.inFlightRequests.clear();
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        for (let i = window.localStorage.length - 1; i >= 0; i--) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith('kf_cache_')) {
            window.localStorage.removeItem(k);
          }
        }
      } catch {
        // Ignore
      }
    }
  }
}

export const globalCache = new CacheManager();
