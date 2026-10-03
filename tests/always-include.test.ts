/**
 * Targeted combine always-include tier.
 *
 * Free backends are queried beside the quality wave, not as quality slots,
 * and their results join the same RRF fusion — free hits rank, dedup, and
 * confirm on equal footing with quality hits. Each free backend contributes
 * at most its maxResults hits.
 */

import { describe, it, expect } from "vitest";
import type { SearchResult } from "../extensions/types.js";
import {
	resolveAlwaysInclude,
	runTieredTargetedCombine,
} from "../extensions/dispatch.js";

function hit(title: string, url: string): SearchResult {
	return { title, url, snippet: title };
}

describe("resolveAlwaysInclude", () => {
	const active = ["exa", "tavily", "searxng", "langsearch"];

	it("preserves config key order", () => {
		expect(resolveAlwaysInclude({
			searxng: { timeoutMs: 3000 },
			langsearch: { timeoutMs: 5000, maxResults: 3 },
		}, active)).toEqual([
			{ backend: "searxng", timeoutMs: 3000, maxResults: undefined },
			{ backend: "langsearch", timeoutMs: 5000, maxResults: 3 },
		]);
	});

	it("rejects a backend that is missing or disabled", () => {
		expect(() => resolveAlwaysInclude({
			searxng: { timeoutMs: 3000 },
		}, ["exa"])).toThrow(/not an enabled backend/);
	});

	it("rejects a non-positive timeout", () => {
		expect(() => resolveAlwaysInclude({
			searxng: { timeoutMs: 0 },
		}, active)).toThrow(/positive timeoutMs/);
	});

	it("rejects a non-positive or fractional maxResults", () => {
		for (const maxResults of [0, -1, 1.5]) {
			expect(() => resolveAlwaysInclude({
				searxng: { timeoutMs: 3000, maxResults },
			}, active)).toThrow(/positive integer/);
		}
	});
});

describe("runTieredTargetedCombine", () => {
	it("does not spend a quality slot on an always-include backend", async () => {
		const calls: string[] = [];
		let qualityFinished = false;
		let freeSawQualityFinished = true;

		const result = await runTieredTargetedCombine({
			orderedBackends: ["exa", "tavily", "serper", "searxng", "brave"],
			alwaysInclude: [{ backend: "searxng", timeoutMs: 3000 }],
			query: "q",
			numResults: 6,
			runBackend: (backend) => {
				calls.push(backend);
				if (backend === "searxng") {
					freeSawQualityFinished = qualityFinished;
					return Promise.resolve([hit("S", "https://s.example/a")]);
				}
				if (backend === "brave") {
					return Promise.resolve([hit("B", "https://b.example/a")]);
				}
				return new Promise((resolve) => {
					setTimeout(() => {
						qualityFinished = true;
						resolve([]);
					}, 20);
				});
			},
		});

		expect(calls.filter((backend) => backend === "searxng")).toEqual(["searxng"]);
		expect(calls).toContain("brave");
		expect(freeSawQualityFinished).toBe(false);
		expect(result.qualityUsableCount).toBe(1);
		expect(result.freeUsableCount).toBe(1);
		expect(result.results.map((r) => r.url)).toContain("https://s.example/a");
	});

	it("drops only the free backend that misses its own deadline", async () => {
		const result = await runTieredTargetedCombine({
			orderedBackends: ["exa", "searxng", "langsearch"],
			alwaysInclude: [
				{ backend: "searxng", timeoutMs: 2000 },
				{ backend: "langsearch", timeoutMs: 40 },
			],
			query: "q",
			numResults: 5,
			runBackend: (backend, _query, _numResults, signal) => {
				if (backend === "langsearch") {
					return new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")));
					});
				}
				if (backend === "searxng") return Promise.resolve([hit("S", "https://s.example/a")]);
				return Promise.resolve([hit("E", "https://exa.example/a")]);
			},
		});

		expect(result.backendStats.get("langsearch")).toMatchObject({
			success: false,
			error: "timed out after 40ms",
		});
		expect(result.backendStats.get("searxng")?.success).toBe(true);
		expect(result.results.map((r) => r.url)).toContain("https://s.example/a");
		expect(result.results.map((r) => r.url)).not.toContain("https://lang.example/a");
	});

	it("ranks a free-only hit at full weight among quality hits", async () => {
		// Free rank 1 ties quality rank 1 (both 1/61) and beats quality rank 2
		// (1/62). Under the old appended-tail design the free hit would land
		// after every quality hit instead.
		const result = await runTieredTargetedCombine({
			orderedBackends: ["exa", "searxng"],
			alwaysInclude: [{ backend: "searxng", timeoutMs: 3000 }],
			query: "q",
			numResults: 5,
			runBackend: (backend) => {
				if (backend === "searxng") return Promise.resolve([hit("Z", "https://z.example/")]);
				return Promise.resolve([hit("X", "https://x.example/"), hit("Y", "https://y.example/")]);
			},
		});

		expect(result.results.map((r) => r.url)).toEqual([
			"https://x.example/",
			"https://z.example/",
			"https://y.example/",
		]);
	});

	it("gives a URL found by both tiers two rank terms", async () => {
		const result = await runTieredTargetedCombine({
			orderedBackends: ["exa", "searxng"],
			alwaysInclude: [{ backend: "searxng", timeoutMs: 3000 }],
			query: "q",
			numResults: 5,
			runBackend: (backend) => {
				if (backend === "searxng") return Promise.resolve([hit("Y again", "https://y.example/")]);
				return Promise.resolve([hit("X", "https://x.example/"), hit("Y", "https://y.example/")]);
			},
		});

		// Y: 1/62 + 1/61 beats X: 1/61 despite trailing in the quality list.
		expect(result.results.map((r) => r.url)).toEqual([
			"https://y.example/",
			"https://x.example/",
		]);
	});

	it("caps one backend's contribution with maxResults", async () => {
		const result = await runTieredTargetedCombine({
			orderedBackends: ["exa", "searxng"],
			alwaysInclude: [{ backend: "searxng", timeoutMs: 3000, maxResults: 2 }],
			query: "q",
			numResults: 5,
			runBackend: (backend) => {
				if (backend === "searxng") {
					return Promise.resolve([1, 2, 3].map((n) => hit(`S${n}`, `https://s.example/${n}`)));
				}
				return Promise.resolve([hit("P", "https://paid.example/one")]);
			},
		});

		expect(result.results.map((r) => r.url)).toEqual([
			"https://paid.example/one",
			"https://s.example/1",
			"https://s.example/2",
		]);
	});

	it("returns free results when the quality tier produces nothing", async () => {
		const result = await runTieredTargetedCombine({
			orderedBackends: ["exa", "searxng"],
			alwaysInclude: [{ backend: "searxng", timeoutMs: 3000 }],
			query: "q",
			numResults: 10,
			runBackend: (backend) => {
				if (backend === "exa") return Promise.reject(new Error("exa down"));
				return Promise.resolve([1, 2, 3, 4, 5].map((n) => hit(`S${n}`, `https://s.example/${n}`)));
			},
		});

		expect(result.qualityUsableCount).toBe(0);
		expect(result.results).toHaveLength(5);
		expect(result.results[0].url).toBe("https://s.example/1");
	});
});
