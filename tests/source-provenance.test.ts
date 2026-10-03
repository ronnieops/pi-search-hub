/**
 * Multi-source provenance for combined results.
 *
 * URL dedup keeps the richest copy of a result, but the merged result lists
 * every backend that returned the URL in `sources`, primary label first.
 */

import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../extensions/dispatch.js";
import { formatCombinedResults, formatCombinedResultsCompact } from "../extensions/formatters.js";
import type { BackendRunner, SearchResult, SearchResultWithBackend } from "../extensions/types.js";

function hit(title: string, url: string, content?: string): SearchResult {
	return { title, url, content };
}

function tagged(backend: string, results: SearchResult[]): SearchResultWithBackend[] {
	return results.map((r) => ({ ...r, backend }));
}

function stubRunner(label: string): BackendRunner {
	return {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label,
		setupLabel: null,
		search: () => Promise.resolve({ results: [] }),
	};
}

const defs: Record<string, BackendRunner> = {
	exa: stubRunner("Exa"),
	tavily: stubRunner("Tavily"),
};

describe("reciprocalRankFusion sources", () => {
	it("lists every backend that returned the URL", () => {
		const fused = reciprocalRankFusion([
			{ backend: "exa", results: tagged("exa", [hit("A", "https://example.com/a")]) },
			{ backend: "tavily", results: tagged("tavily", [hit("A again", "https://example.com/a")]) },
		], 10);

		expect(fused).toHaveLength(1);
		expect(fused[0].sources).toEqual(["exa", "tavily"]);
	});

	it("puts the primary label first even when another backend contributed first", () => {
		const fused = reciprocalRankFusion([
			{ backend: "exa", results: tagged("exa", [hit("A", "https://example.com/a", "short")]) },
			{ backend: "tavily", results: tagged("tavily", [hit("A rich", "https://example.com/a", "much richer content")]) },
		], 10);

		expect(fused[0].backend).toBe("tavily");
		expect(fused[0].sources).toEqual(["tavily", "exa"]);
	});

	it("lists a lone contributor once", () => {
		const fused = reciprocalRankFusion([
			{ backend: "exa", results: tagged("exa", [hit("A", "https://example.com/a")]) },
		], 10);

		expect(fused[0].sources).toEqual(["exa"]);
	});
});

describe("combined formatting provenance", () => {
	const results: SearchResultWithBackend[] = [
		{ title: "A", url: "https://example.com/a", snippet: "s", backend: "exa", sources: ["exa", "tavily"] },
	];

	it("labels every source with its display name", () => {
		const text = formatCombinedResults("q", results, new Map([["exa", { success: true, count: 1 }]]), defs);
		expect(text).toContain("*Source: Exa, Tavily*");
	});

	it("falls back to the primary backend when sources are absent", () => {
		const text = formatCombinedResults("q", [
			{ title: "A", url: "https://example.com/a", backend: "exa" },
		], new Map(), defs);
		expect(text).toContain("*Source: Exa*");
	});

	it("lists all sources in compact mode", () => {
		const text = formatCombinedResultsCompact(results);
		expect(text).toContain("[exa, tavily]");
	});
});
