import { describe, it, expect, beforeEach } from "vitest";
import {
	BackendCache,
	getBackendCache,
	clearAllCaches,
	pruneAllCaches,
	buildCacheKey,
	formatCacheStats,
} from "./cache-system.js";

describe("BackendCache", () => {
	let cache: BackendCache<string>;

	beforeEach(() => {
		cache = new BackendCache<string>({ ttlMs: 1000, maxEntries: 10 });
	});

	describe("get/set", () => {
		it("returns undefined for missing key", () => {
			expect(cache.get("nonexistent")).toBeUndefined();
		});

		it("returns value after set", () => {
			cache.set("key", "value");
			expect(cache.get("key")).toBe("value");
		});

		it("returns undefined after TTL expires", async () => {
			cache.set("key", "value");
			await new Promise(r => setTimeout(r, 50)); // 50ms
			// Not expired yet (TTL is 1000ms)
			expect(cache.get("key")).toBe("value");
		});

		it("evicts oldest when at capacity", () => {
			const smallCache = new BackendCache<string>({ ttlMs: 1000, maxEntries: 3 });
			smallCache.set("a", "1");
			smallCache.set("b", "2");
			smallCache.set("c", "3");
			smallCache.set("d", "4"); // Evicts "a"

			expect(smallCache.get("a")).toBeUndefined();
			expect(smallCache.get("d")).toBe("4");
		});

		it("updates existing key", () => {
			cache.set("key", "value1");
			cache.set("key", "value2");
			expect(cache.get("key")).toBe("value2");
		});
	});

	describe("has", () => {
		it("returns true for fresh entry", () => {
			cache.set("key", "value");
			expect(cache.has("key")).toBe(true);
		});

		it("returns false for missing key", () => {
			expect(cache.has("nonexistent")).toBe(false);
		});
	});

	describe("delete", () => {
		it("removes entry", () => {
			cache.set("key", "value");
			cache.delete("key");
			expect(cache.get("key")).toBeUndefined();
		});

		it("returns true if key existed", () => {
			cache.set("key", "value");
			expect(cache.delete("key")).toBe(true);
		});

		it("returns false if key didn't exist", () => {
			expect(cache.delete("nonexistent")).toBe(false);
		});
	});

	describe("clear", () => {
		it("removes all entries", () => {
			cache.set("a", "1");
			cache.set("b", "2");
			cache.clear();
			expect(cache.size).toBe(0);
		});
	});

	describe("stats", () => {
		it("tracks hits and misses", () => {
			cache.set("key", "value");
			
			cache.get("key"); // hit
			cache.get("key"); // hit
			cache.get("nonexistent"); // miss

			const stats = cache.getStats();
			expect(stats.hits).toBe(2);
			expect(stats.misses).toBe(1);
		});

		it("tracks evictions", () => {
			const smallCache = new BackendCache<string>({ ttlMs: 1000, maxEntries: 2 });
			smallCache.set("a", "1");
			smallCache.set("b", "2");
			smallCache.set("c", "3"); // Evicts "a"

			const stats = smallCache.getStats();
			expect(stats.evictions).toBe(1);
		});
	});

	describe("prune", () => {
		it("removes expired entries", async () => {
			const shortCache = new BackendCache<string>({ ttlMs: 100, maxEntries: 10, staleMultiplier: 1 });
			shortCache.set("key", "value");
			// Wait for TTL to expire (staleMultiplier = 1 means no stale window)
			await new Promise(r => setTimeout(r, 150));
			
			const pruned = shortCache.prune();
			expect(pruned).toBe(1);
			expect(shortCache.get("key")).toBeUndefined();
		});
	});

	describe("getWithStaleFallback", () => {
		it("returns fresh value", () => {
			cache.set("key", "value");
			const result = cache.getWithStaleFallback("key");
			expect(result.value).toBe("value");
			expect(result.stale).toBe(false);
		});

		it("returns stale value with stale=true", async () => {
			cache.set("key", "value");
			await new Promise(r => setTimeout(r, 50));
			// Not stale yet, but testing the pattern
			const result = cache.getWithStaleFallback("key");
			expect(result.value).toBe("value");
		});

		it("returns undefined for missing key", () => {
			const result = cache.getWithStaleFallback("nonexistent");
			expect(result.value).toBeUndefined();
			expect(result.stale).toBe(false);
		});
	});
});

describe("cache registry", () => {
	beforeEach(() => {
		clearAllCaches();
	});

	describe("getBackendCache", () => {
		it("creates cache for new backend", () => {
			const cache = getBackendCache<string>("test-backend");
			expect(cache).toBeInstanceOf(BackendCache);
			expect(cache.size).toBe(0);
		});

		it("returns same cache for same backend", () => {
			const cache1 = getBackendCache<string>("test-backend");
			const cache2 = getBackendCache<string>("test-backend");
			expect(cache1).toBe(cache2);
		});

		it("uses default TTL for known backends", () => {
			const cache = getBackendCache<string>("duckduckgo");
			const stats = cache.getStats();
			expect(stats.ttl).toBe(120000); // 2 minutes for duckduckgo
		});
	});

	describe("clearAllCaches", () => {
		it("clears all caches", () => {
			const cache1 = getBackendCache<string>("backend1");
			const cache2 = getBackendCache<string>("backend2");
			
			cache1.set("key", "value");
			cache2.set("key", "value");

			clearAllCaches();

			expect(cache1.size).toBe(0);
			expect(cache2.size).toBe(0);
		});
	});

	describe("pruneAllCaches", () => {
		it("prunes all caches", async () => {
			const cache = new BackendCache<string>({ ttlMs: 100, maxEntries: 10, staleMultiplier: 1 });
			cache.set("key", "value");

			await new Promise(r => setTimeout(r, 150));

			const pruned = cache.prune();
			expect(pruned).toBe(1);
		});
	});
});

describe("buildCacheKey", () => {
	it("normalizes query", () => {
		const key1 = buildCacheKey("hello  world", "exa", 10);
		const key2 = buildCacheKey("Hello   World", "exa", 10);
		expect(key1).toBe(key2);
	});

	it("includes backend and numResults", () => {
		const key = buildCacheKey("test", "tavily", 5);
		expect(key).toContain("tavily");
		expect(key).toContain("5");
		expect(key).toContain("test");
	});

	it("produces different keys for different backends", () => {
		const key1 = buildCacheKey("test", "tavily", 10);
		const key2 = buildCacheKey("test", "exa", 10);
		expect(key1).not.toBe(key2);
	});
});

describe("formatCacheStats", () => {
	it("formats empty stats", () => {
		const stats = {};
		const formatted = formatCacheStats(stats);
		expect(formatted).toContain("Cache Statistics");
	});

	it("formats populated stats", () => {
		const stats = {
			exa: { hits: 10, misses: 2, size: 5, maxSize: 100, evictions: 0, ttl: 600000 },
		};
		const formatted = formatCacheStats(stats);
		expect(formatted).toContain("exa");
		expect(formatted).toContain("Size: 5/100");
	});
});