/**
 * Cache system with TTL for pi-search-hub backends.
 * 
 * Features:
 * - Per-backend TTL configuration
 * - LRU eviction with max size
 * - Cache statistics (hits, misses, size)
 * - Stale fallback on network failures
 * - Persistent disk cache option
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_ENTRIES = 100;
const DISK_CACHE_DIR = "cache";
const DISK_CACHE_FILE = "search-cache.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheEntry<T> {
	value: T;
	timestamp: number;
	expiresAt: number;
	hits: number;
}

export interface CacheStats {
	hits: number;
	misses: number;
	size: number;
	maxSize: number;
	evictions: number;
	ttl: number;
}

export interface BackendCacheConfig {
	/** TTL in milliseconds (default: 5 minutes) */
	ttlMs?: number;
	/** Max entries (default: 100) */
	maxEntries?: number;
	/** Enable persistent disk cache (default: false) */
	persistent?: boolean;
	/** Stale TTL multiplier (return stale data this many times longer than TTL) */
	staleMultiplier?: number;
}

// ---------------------------------------------------------------------------
// Cache class
// ---------------------------------------------------------------------------

export class BackendCache<T> {
	private cache = new Map<string, CacheEntry<T>>();
	private readonly ttlMs: number;
	private readonly maxSize: number;
	private readonly persistent: boolean;
	private readonly staleMultiplier: number;
	private stats = { hits: 0, misses: 0, evictions: 0 };

	constructor(config: BackendCacheConfig = {}) {
		this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
		this.maxSize = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.persistent = config.persistent ?? false;
		this.staleMultiplier = config.staleMultiplier ?? 2;
	}

	/**
	 * Get value from cache. Returns undefined if not found or expired.
	 */
	get(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) {
			this.stats.misses++;
			return undefined;
		}

		const now = Date.now();
		
		// Check if fresh
		if (now < entry.expiresAt) {
			this.stats.hits++;
			entry.hits++;
			// LRU: move to end
			this.cache.delete(key);
			this.cache.set(key, entry);
			return entry.value;
		}

		// Check if stale (but still usable)
		const staleExpiry = entry.expiresAt * this.staleMultiplier;
		if (now < staleExpiry) {
			this.stats.hits++;
			entry.hits++;
			return entry.value;
		}

		// Expired, remove
		this.cache.delete(key);
		this.stats.misses++;
		return undefined;
	}

	/**
	 * Get value, returning stale data on failure (stale fallback).
	 */
	getWithStaleFallback(key: string): { value: T | undefined; stale: boolean } {
		const entry = this.cache.get(key);
		if (!entry) {
			this.stats.misses++;
			return { value: undefined, stale: false };
		}

		const now = Date.now();
		
		// Fresh
		if (now < entry.expiresAt) {
			this.stats.hits++;
			entry.hits++;
			return { value: entry.value, stale: false };
		}

		// Stale but usable
		const staleExpiry = entry.expiresAt * this.staleMultiplier;
		if (now < staleExpiry) {
			this.stats.hits++;
			entry.hits++;
			return { value: entry.value, stale: true };
		}

		// Expired
		this.cache.delete(key);
		this.stats.misses++;
		return { value: undefined, stale: false };
	}

	/**
	 * Set value in cache.
	 */
	set(key: string, value: T): void {
		// Evict oldest if at capacity
		if (this.cache.size >= this.maxSize) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
				this.stats.evictions++;
			}
		}

		const now = Date.now();
		this.cache.set(key, {
			value,
			timestamp: now,
			expiresAt: now + this.ttlMs,
			hits: 0,
		});
	}

	/**
	 * Check if key exists (fresh only).
	 */
	has(key: string): boolean {
		const entry = this.cache.get(key);
		if (!entry) return false;
		return Date.now() < entry.expiresAt;
	}

	/**
	 * Delete key from cache.
	 */
	delete(key: string): boolean {
		return this.cache.delete(key);
	}

	/**
	 * Clear all entries.
	 */
	clear(): void {
		this.cache.clear();
	}

	/**
	 * Get cache statistics.
	 */
	getStats(): CacheStats {
		return {
			hits: this.stats.hits,
			misses: this.stats.misses,
			size: this.cache.size,
			maxSize: this.maxSize,
			evictions: this.stats.evictions,
			ttl: this.ttlMs,
		};
	}

	/**
	 * Prune expired entries.
	 */
	prune(): number {
		const now = Date.now();
		let pruned = 0;
		for (const [key, entry] of this.cache.entries()) {
			if (now > entry.expiresAt * this.staleMultiplier) {
				this.cache.delete(key);
				pruned++;
			}
		}
		return pruned;
	}

	/**
	 * Get size (number of entries).
	 */
	get size(): number {
		return this.cache.size;
	}

	/**
	 * Persist cache to disk.
	 */
	persist(name: string): void {
		if (!this.persistent) return;
		
		const dir = join(getAgentDir(), "extensions", DISK_CACHE_DIR);
		const file = join(dir, `${name}.json`);

		try {
			mkdirSync(dir, { recursive: true });
			const data = Array.from(this.cache.entries()).map(([k, v]) => ({
				key: k,
				value: v.value,
				timestamp: v.timestamp,
				expiresAt: v.expiresAt,
				hits: v.hits,
			}));
			writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
		} catch {
			// ignore
		}
	}

	/**
	 * Load cache from disk.
	 */
	load(name: string): void {
		if (!this.persistent) return;

		const dir = join(getAgentDir(), "extensions", DISK_CACHE_DIR);
		const file = join(dir, `${name}.json`);

		try {
			if (!existsSync(file)) return;
			const data = JSON.parse(readFileSync(file, "utf-8")) as Array<{
				key: string;
				value: T;
				timestamp: number;
				expiresAt: number;
				hits: number;
			}>;

			const now = Date.now();
			for (const entry of data) {
				// Only load if not expired
				if (now < entry.expiresAt * this.staleMultiplier) {
					this.cache.set(entry.key, {
						value: entry.value,
						timestamp: entry.timestamp,
						expiresAt: entry.expiresAt,
						hits: entry.hits,
					});
				}
			}
		} catch {
			// ignore
		}
	}
}

// ---------------------------------------------------------------------------
// Cache registry
// ---------------------------------------------------------------------------

/** Per-backend cache instances */
const backendCaches = new Map<string, BackendCache<unknown>>();

/** Default cache configs per backend */
const DEFAULT_BACKEND_CONFIGS: Record<string, BackendCacheConfig> = {
	// Free backends: shorter TTL (rate limited anyway)
	duckduckgo: { ttlMs: 2 * 60 * 1000, maxEntries: 50 },
	jina: { ttlMs: 5 * 60 * 1000, maxEntries: 100 },
	marginalia: { ttlMs: 5 * 60 * 1000, maxEntries: 100 },

	// API backends: longer TTL
	serper: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	tavily: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	exa: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	brave: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	firecrawl: { ttlMs: 15 * 60 * 1000, maxEntries: 150 },
	langsearch: { ttlMs: 5 * 60 * 1000, maxEntries: 100 },
	websearchapi: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	perplexity: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	searxng: { ttlMs: 5 * 60 * 1000, maxEntries: 100 },
	linkup: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	youcom: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	fastcrw: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	sofya: { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
	"brave-llm": { ttlMs: 10 * 60 * 1000, maxEntries: 200 },
};

/**
 * Get or create cache for a backend.
 */
export function getBackendCache<T>(backend: string, config?: BackendCacheConfig): BackendCache<T> {
	let cache = backendCaches.get(backend) as BackendCache<T> | undefined;
	if (!cache) {
		const defaultConfig = DEFAULT_BACKEND_CONFIGS[backend] ?? {};
		cache = new BackendCache<T>({ ...defaultConfig, ...config });
		cache.load(backend);
		backendCaches.set(backend, cache);
	}
	return cache;
}

/**
 * Clear all backend caches.
 */
export function clearAllCaches(): void {
	for (const cache of backendCaches.values()) {
		cache.clear();
	}
	backendCaches.clear();
}

/**
 * Prune all backend caches.
 */
export function pruneAllCaches(): number {
	let total = 0;
	for (const cache of backendCaches.values()) {
		total += cache.prune();
	}
	return total;
}

/**
 * Get stats for all caches.
 */
export function getAllCacheStats(): Record<string, CacheStats> {
	const stats: Record<string, CacheStats> = {};
	for (const [backend, cache] of backendCaches.entries()) {
		stats[backend] = cache.getStats();
	}
	return stats;
}

/**
 * Build cache key from query + backend + numResults.
 */
export function buildCacheKey(query: string, backend: string, numResults: number): string {
	// Normalize query for better cache hits
	const normalized = query.toLowerCase().trim().replace(/\s+/g, " ");
	return `${backend}:${numResults}:${normalized}`;
}

/**
 * Format cache stats for display.
 */
export function formatCacheStats(stats: Record<string, CacheStats>): string {
	const lines = ["**Cache Statistics:**", ""];
	
	for (const [backend, s] of Object.entries(stats)) {
		if (s.size === 0 && s.hits === 0 && s.misses === 0) continue;
		
		const hitRate = s.hits + s.misses > 0
			? ((s.hits / (s.hits + s.misses)) * 100).toFixed(1) + "%"
			: "N/A";
		
		lines.push(`**${backend}**`);
		lines.push(`  - Size: ${s.size}/${s.maxSize}`);
		lines.push(`  - Hits: ${s.hits} (${hitRate})`);
		lines.push(`  - Misses: ${s.misses}`);
		lines.push(`  - Evictions: ${s.evictions}`);
		lines.push(`  - TTL: ${(s.ttl / 1000).toFixed(0)}s`);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Persist all caches to disk.
 */
export function persistAllCaches(): void {
	for (const [backend, cache] of backendCaches.entries()) {
		cache.persist(backend);
	}
}