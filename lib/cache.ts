/**
 * Smart caching system for API responses
 * Provides in-memory caching with TTL and stale-while-revalidate support
 */

type CacheEntry<T> = {
  data: T;
  timestamp: number;
  ttl: number;
};

class SmartCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private pendingRequests: Map<string, Promise<any>> = new Map();

  /**
   * Get cached data or fetch fresh data
   * @param key - Cache key
   * @param fetcher - Function to fetch fresh data
   * @param options - Cache options
   */
  async get<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: {
      ttl?: number; // Time to live in ms (default: 5 minutes)
      staleWhileRevalidate?: boolean; // Return stale data while fetching fresh
      forceRefresh?: boolean; // Bypass cache
    } = {}
  ): Promise<T> {
    const { ttl = 5 * 60 * 1000, staleWhileRevalidate = true, forceRefresh = false } = options;

    // Check for cached data
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && !forceRefresh) {
      const age = now - cached.timestamp;
      const isStale = age > cached.ttl;

      if (!isStale) {
        // Fresh data - return immediately
        return cached.data;
      }

      if (staleWhileRevalidate) {
        // Stale data - return immediately but trigger background refresh
        this.refreshInBackground(key, fetcher, ttl);
        return cached.data;
      }
    }

    // No cache or forceRefresh - fetch fresh data
    return this.fetchAndCache(key, fetcher, ttl);
  }

  /**
   * Fetch and cache data, deduplicating concurrent requests
   */
  private async fetchAndCache<T>(key: string, fetcher: () => Promise<T>, ttl: number): Promise<T> {
    // Check if there's already a pending request for this key
    const pending = this.pendingRequests.get(key);
    if (pending) {
      return pending;
    }

    // Create new request
    const request = fetcher()
      .then((data) => {
        this.cache.set(key, { data, timestamp: Date.now(), ttl });
        this.pendingRequests.delete(key);
        return data;
      })
      .catch((error) => {
        this.pendingRequests.delete(key);
        throw error;
      });

    this.pendingRequests.set(key, request);
    return request;
  }

  /**
   * Refresh cache in background without blocking
   */
  private refreshInBackground<T>(key: string, fetcher: () => Promise<T>, ttl: number): void {
    // Don't refresh if already refreshing
    if (this.pendingRequests.has(key)) return;

    this.fetchAndCache(key, fetcher, ttl).catch((err) => {
      console.warn(`[Cache] Background refresh failed for ${key}:`, err.message);
    });
  }

  /**
   * Invalidate a specific cache entry
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Invalidate all entries matching a pattern
   */
  invalidatePattern(pattern: RegExp): void {
    const keys = Array.from(this.cache.keys());
    for (const key of keys) {
      if (pattern.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache stats
   */
  stats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

// Singleton instance
export const apiCache = new SmartCache();

// Cache key generators
export const cacheKeys = {
  user: () => 'user:me',
  userProfile: (userId: string) => `user:${userId}:profile`,
  job: (jobId: string) => `job:${jobId}`,
  jobArtifacts: (jobId: string) => `job:${jobId}:artifacts`,
  jobLogs: (jobId: string) => `job:${jobId}:logs`,
  projects: (page?: number) => `projects:${page || 1}`,
  entitlements: () => 'user:entitlements',
  counts: () => 'user:counts',
};

// TTL presets (in milliseconds)
export const cacheTTL = {
  short: 30 * 1000,        // 30 seconds - for frequently changing data
  medium: 5 * 60 * 1000,   // 5 minutes - default
  long: 30 * 60 * 1000,    // 30 minutes - for rarely changing data
  veryLong: 60 * 60 * 1000, // 1 hour - for static data
};
