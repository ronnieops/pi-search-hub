/**
 * Integration tests for dispatch, config, and combine logic.
 *
 * These tests verify:
 * - Selection strategies
 * - RRF combiner
 * - Credential resolution
 * - SearchCache
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reciprocalRankFusion, runTargetedCombine, selectBackendsForFallback } from "../extensions/dispatch.js";
import { recordBackendSuccess, recordBackendFailure } from "../extensions/scoring.js";
import { resolveConfigValue, clearCredentialCache } from "../extensions/credentials.js";
import { loadConfig } from "../extensions/config.js";
import { SearchCache } from "../extensions/utils.js";

// ---------------------------------------------------------------------------
// RRF combiner tests
// ---------------------------------------------------------------------------

describe("reciprocalRankFusion", () => {
	it("merges results from two backends and deduplicates by URL", () => {
		const results = reciprocalRankFusion(
			[
				{
					backend: "a",
					results: [
						{ title: "First", url: "https://example.com/1", snippet: "from a", backend: "a" },
						{ title: "Second", url: "https://example.com/2", snippet: "from a", backend: "a" },
					],
				},
				{
					backend: "b",
					results: [
						{ title: "First", url: "https://example.com/1", snippet: "from b", backend: "b" },
						{ title: "Third", url: "https://example.com/3", snippet: "from b", backend: "b" },
					],
				},
			],
			10,
		);

		// Should have 3 unique URLs
		expect(results).toHaveLength(3);

		// URL that appears in both backends should rank highest
		expect(results[0].url).toBe("https://example.com/1");

		// All URLs present
		const urls = results.map(r => r.url);
		expect(urls).toContain("https://example.com/1");
		expect(urls).toContain("https://example.com/2");
		expect(urls).toContain("https://example.com/3");
	});

	it("respects maxResults limit", () => {
		const results = reciprocalRankFusion(
			[
				{
					backend: "a",
					results: Array.from({ length: 10 }, (_, i) => ({
						title: "Result " + i,
						url: "https://example.com/" + i,
						snippet: "snippet " + i,
						backend: "a",
					})),
				},
			],
			5,
		);

		expect(results).toHaveLength(5);
	});

	it("normalizes URLs for dedup (trailing slash, lowercase)", () => {
		const results = reciprocalRankFusion(
			[
				{
					backend: "a",
					results: [
						{ title: "A", url: "https://Example.COM/page/", snippet: "a", backend: "a" },
					],
				},
				{
					backend: "b",
					results: [
						{ title: "B", url: "https://example.com/page", snippet: "b", backend: "b" },
					],
				},
			],
			10,
		);

		// Should deduplicate to 1 result
		expect(results).toHaveLength(1);
	});

	it("prefers result with richer content on dedup", () => {
		const results = reciprocalRankFusion(
			[
				{
					backend: "a",
					results: [
						{ title: "A", url: "https://example.com/1", snippet: "short", backend: "a" },
					],
				},
				{
					backend: "b",
					results: [
						{ title: "B", url: "https://example.com/1", content: "much longer content with more details", backend: "b" },
					],
				},
			],
			10,
		);

		expect(results).toHaveLength(1);
		expect(results[0].content).toBe("much longer content with more details");
	});

	it("returns empty array when no successful backends", () => {
		const results = reciprocalRankFusion([], 10);
		expect(results).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Targeted combine tests
// ---------------------------------------------------------------------------

describe("runTargetedCombine", () => {
	const resultFor = (backend: string) => [{
		title: `${backend} result`,
		url: `https://example.com/${backend}`,
		snippet: `${backend} snippet`,
	}];

	it("stops after the first three usable backends", async () => {
		const calls: Array<{ backend: string; numResults: number }> = [];
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b", "c", "d"],
			query: "test query",
			numResults: 10,
			runBackend: async (backend, _query, numResults) => {
				calls.push({ backend, numResults });
				return resultFor(backend);
			},
		});

		expect(calls).toEqual([
			{ backend: "a", numResults: 4 },
			{ backend: "b", numResults: 4 },
			{ backend: "c", numResults: 4 },
		]);
		expect(result.usableBackendCount).toBe(3);
		expect(result.results).toHaveLength(3);
		expect(Array.from(result.backendStats.keys())).toEqual(["a", "b", "c"]);
	});

	it("tops up only the missing usable backend count", async () => {
		const calls: string[] = [];
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b", "c", "d", "e"],
			query: "test query",
			numResults: 9,
			runBackend: async (backend) => {
				calls.push(backend);
				if (backend === "b") throw new Error("b failed");
				return resultFor(backend);
			},
		});

		expect(calls).toEqual(["a", "b", "c", "d"]);
		expect(result.usableBackendCount).toBe(3);
		expect(result.backendStats.get("b")).toMatchObject({ success: false, count: 0, error: "b failed" });
		expect(result.backendStats.has("e")).toBe(false);
	});

	it("runs the next three when the first three are not usable", async () => {
		const calls: string[] = [];
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b", "c", "d", "e", "f", "g"],
			query: "test query",
			numResults: 6,
			runBackend: async (backend) => {
				calls.push(backend);
				if (["a", "b", "c"].includes(backend)) return [];
				return resultFor(backend);
			},
		});

		expect(calls).toEqual(["a", "b", "c", "d", "e", "f"]);
		expect(result.usableBackendCount).toBe(3);
		expect(result.backendStats.get("a")).toMatchObject({ success: true, count: 0 });
		expect(result.backendStats.has("g")).toBe(false);
	});

	it("returns partial results when active backends are exhausted", async () => {
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b", "c"],
			query: "test query",
			numResults: 10,
			runBackend: async (backend) => {
				if (backend === "a") return resultFor(backend);
				if (backend === "b") return [];
				throw new Error("c failed");
			},
		});

		expect(result.usableBackendCount).toBe(1);
		expect(result.results).toEqual([{ ...resultFor("a")[0], backend: "a" }]);
		expect(result.backendStats.get("b")).toMatchObject({ success: true, count: 0 });
		expect(result.backendStats.get("c")).toMatchObject({ success: false, count: 0, error: "c failed" });
	});

	it("returns empty when all backends fail", async () => {
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b"],
			query: "test query",
			numResults: 10,
			runBackend: async () => { throw new Error("fail"); },
		});

		expect(result.usableBackendCount).toBe(0);
		expect(result.results).toEqual([]);
	});

	it("returns empty when orderedBackends is empty", async () => {
		const result = await runTargetedCombine({
			orderedBackends: [],
			query: "test query",
			numResults: 10,
			runBackend: async () => [],
		});

		expect(result.usableBackendCount).toBe(0);
		expect(result.results).toEqual([]);
	});

	it("distributes numResults across targetUsableBackends", async () => {
		const calls: number[] = [];
		await runTargetedCombine({
			orderedBackends: ["a", "b", "c"],
			query: "test query",
			numResults: 9,
			targetUsableBackends: 3,
			runBackend: async (_, __, numResults) => {
				calls.push(numResults);
				return [{ title: "x", url: "https://x.com", snippet: "x" }];
			},
		});

		expect(calls).toEqual([3, 3, 3]);
	});

	it("uses single backend results directly without RRF", async () => {
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b"],
			query: "test query",
			numResults: 10,
			runBackend: async (backend) => {
				if (backend === "a") return resultFor(backend);
				throw new Error("b fail");
			},
		});

		expect(result.usableBackendCount).toBe(1);
		expect(result.results).toHaveLength(1);
		expect(result.results[0].backend).toBe("a");
	});
});

// ---------------------------------------------------------------------------
// Selection strategy tests
// ---------------------------------------------------------------------------

describe("selectBackendsForFallback", () => {
	it("sequential returns backends in original order", () => {
		const backends = ["duckduckgo", "brave", "tavily"];
		const result = selectBackendsForFallback("sequential", backends);
		expect(result).toEqual(backends);
	});

	it("random returns all backends (possibly reordered)", () => {
		const backends = ["duckduckgo", "brave", "tavily"];
		const result = selectBackendsForFallback("random", backends);
		expect(result).toHaveLength(backends.length);
		// All backends should be present
		for (const b of backends) {
			expect(result).toContain(b);
		}
		// Verify some reordering happens across multiple calls (distribution check)
		const results: string[][] = [];
		for (let i = 0; i < 20; i++) {
			results.push(selectBackendsForFallback("random", [...backends]));
		}
		// At least one call should differ from the first result — confirms shuffling
		const first = JSON.stringify(results[0]);
		const shuffled = results.some((r) => JSON.stringify(r) !== first);
		expect(shuffled).toBe(true);
	});

	it("round-robin rotates starting backend", () => {
		const backends = ["duckduckgo", "brave", "tavily"];

		// Call multiple times — the first element should rotate
		const firsts = new Set<string>();
		for (let i = 0; i < 12; i++) {
			const result = selectBackendsForFallback("round-robin", backends);
			firsts.add(result[0]);
		}

		// With 3 backends and 12 calls, should see all 3 backends as first
		expect(firsts.size).toBe(3);
	});

	it("best-latency returns backends sorted by score", () => {
		const backends = ["slow-backend", "fast-backend", "broken-backend"];

		// Fast backend: fast + successful
		recordBackendSuccess("fast-backend", 100, 10, 10);
		// Slow backend: slow but successful
		recordBackendSuccess("slow-backend", 5000, 10, 10);
		// Broken backend: all failures
		recordBackendFailure("broken-backend");
		recordBackendFailure("broken-backend");

		const result = selectBackendsForFallback("best-latency", backends);

		// Should return all backends in score order (best first)
		expect(result).toHaveLength(3);
		// Fast backend should be first
		expect(result[0]).toBe("fast-backend");
		// Broken backend should be last
		expect(result[2]).toBe("broken-backend");
	});

	it("round-robin with empty backends returns empty array", () => {
		const result = selectBackendsForFallback("round-robin", []);
		expect(result).toEqual([]);
	});

	it("does not mutate original array", () => {
		const backends = ["duckduckgo", "brave", "tavily"];
		const copy = [...backends];
		selectBackendsForFallback("random", backends);
		expect(backends).toEqual(copy);
	});
});

// ---------------------------------------------------------------------------
// Credential resolution tests
// ---------------------------------------------------------------------------

describe("resolveConfigValue", () => {
	beforeEach(() => {
		clearCredentialCache();
	});

	afterEach(() => {
		clearCredentialCache();
	});

	it("returns undefined for undefined input", () => {
		expect(resolveConfigValue(undefined)).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(resolveConfigValue("")).toBeUndefined();
	});

	it("returns literal key for non-ALL_CAPS strings", () => {
		expect(resolveConfigValue("sk-abc123")).toBe("sk-abc123");
	});

	it("resolves ALL_CAPS from env var", () => {
		process.env.TEST_SEARCH_KEY_123 = "secret-value";
		try {
			expect(resolveConfigValue("TEST_SEARCH_KEY_123")).toBe("secret-value");
		} finally {
			delete process.env.TEST_SEARCH_KEY_123;
		}
	});

	it("warns for ALL_CAPS that is unset", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = resolveConfigValue("DEFINITELY_NOT_SET_XYZ");
		expect(result).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Config loading tests
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	it("returns default config when no config files exist", () => {
		const cfg = loadConfig("/nonexistent/path");
		expect(cfg.defaultBackend).toBe("duckduckgo");
		// May have auto-enabled backends from convenience env vars
		expect(typeof cfg.backends).toBe("object");
	});
});

// ---------------------------------------------------------------------------
// fetchSofya tests
// ---------------------------------------------------------------------------

import { fetchSofya } from "../extensions/backends/sofya.js";

describe("fetchSofya", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("throws on HTTP error response", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => "Unauthorized",
		} as Response);

		await expect(fetchSofya("https://example.com", "invalid-key")).rejects.toThrow("Sofya fetch");
	});

	it("throws when success is false in response", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ results: [{ success: false, error: "Rate limit exceeded" }] }),
		} as Response);

		await expect(fetchSofya("https://example.com", "valid-key")).rejects.toThrow("Sofya fetch failed");
	});

	it("throws when no results returned", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ results: [] }),
		} as Response);

		await expect(fetchSofya("https://example.com", "valid-key")).rejects.toThrow("no content returned");
	});

	it("returns content on success", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{
					success: true,
					url: "https://example.com",
					title: "Example",
					content: "Page content here",
				}],
			}),
		} as Response);

		const result = await fetchSofya("https://example.com", "valid-key");
		expect(result.content).toBe("Page content here");
		expect(result.title).toBe("Example");
	});

	it("sends include_raw_html:false by default", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ success: true, url: "https://example.com", content: "x" }],
			}),
		} as Response);

		await fetchSofya("https://example.com", "valid-key");
		const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
		expect(body.include_raw_html).toBe(false);
	});

	it("sends include_raw_html:true when opts.includeRawHtml set", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ success: true, url: "https://example.com", content: "<html>x</html>" }],
			}),
		} as Response);

		await fetchSofya("https://example.com", "valid-key", undefined, { includeRawHtml: true });
		const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
		expect(body.include_raw_html).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// SearchCache tests
// ---------------------------------------------------------------------------

describe("SearchCache", () => {
	it("stores and retrieves values", () => {
		const cache = new SearchCache<string>(60_000, 10);
		cache.set("key1", "value1");
		expect(cache.get("key1")).toBe("value1");
	});

	it("returns undefined for missing keys", () => {
		const cache = new SearchCache<string>(60_000, 10);
		expect(cache.get("missing")).toBeUndefined();
	});

	it("evicts entries after TTL", async () => {
		const cache = new SearchCache<string>(20, 10); // 20ms TTL
		cache.set("key1", "value1");
		// Verify entry exists just before TTL expires
		await new Promise((r) => setTimeout(r, 15));
		expect(cache.get("key1")).toBe("value1"); // still valid at 15ms < 20ms TTL
		// Verify entry is evicted after TTL
		await new Promise((r) => setTimeout(r, 10)); // now at 25ms > 20ms TTL
		expect(cache.get("key1")).toBeUndefined();
	});

	it("evicts oldest when at max capacity", () => {
		const cache = new SearchCache<string>(60_000, 3);
		cache.set("key1", "value1");
		cache.set("key2", "value2");
		cache.set("key3", "value3");
		cache.set("key4", "value4"); // should evict key1

		expect(cache.get("key1")).toBeUndefined();
		expect(cache.get("key4")).toBe("value4");
		expect(cache.size).toBe(3);
	});

	it("clear resets the cache", () => {
		const cache = new SearchCache<string>(60_000, 10);
		cache.set("key1", "value1");
		cache.clear();
		expect(cache.get("key1")).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it("LRU: accessing an entry moves it to end", () => {
		const cache = new SearchCache<string>(60_000, 2);
		cache.set("key1", "value1");
		cache.set("key2", "value2");

		// Access key1 to move it to end (most recently used)
		cache.get("key1");

		// Adding key3 should evict key2 (oldest), not key1
		cache.set("key3", "value3");
		expect(cache.get("key1")).toBe("value1");
		expect(cache.get("key2")).toBeUndefined();
	});
});
