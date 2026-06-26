/**
 * Dispatch logic: selection strategies, RRF combiner, fallback ordering.
 */

import type { SearchResult, SearchResultWithBackend } from "./types.js";

export type BackendStats = { success: boolean; count: number; error?: string };
import { config, roundRobinIndex, incrementRoundRobin } from "./config.js";
import { scoreBackends } from "./scoring.js";

// ---------------------------------------------------------------------------
// Selection strategies
// ---------------------------------------------------------------------------

export function selectBackendsForFallback(
	strategy: "sequential" | "random" | "round-robin" | "best-latency",
	activeBackends: string[],
): string[] {
	const backends = [...activeBackends];
	switch (strategy) {
		case "random": {
			for (let i = backends.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[backends[i], backends[j]] = [backends[j], backends[i]];
			}
			return backends;
		}
		case "round-robin": {
			if (backends.length === 0) return [];
			const index = roundRobinIndex % backends.length;
			incrementRoundRobin();
			const selected = backends[index];
			// Put selected first, then the rest
			return [selected, ...backends.filter((b) => b !== selected)];
		}
		case "best-latency": {
			// Use smart composite scoring (success rate + latency + quality)
			return scoreBackends(backends).map(s => s.backend);
		}
		case "sequential":
		default:
			return backends;
	}
}

// ---------------------------------------------------------------------------
// Targeted combine
// ---------------------------------------------------------------------------

export async function runTargetedCombine({
	orderedBackends,
	query,
	numResults,
	signal,
	targetUsableBackends = 3,
	runBackend,
}: {
	orderedBackends: string[];
	query: string;
	numResults: number;
	signal?: AbortSignal;
	targetUsableBackends?: number;
	runBackend: (backend: string, query: string, numResults: number, signal?: AbortSignal) => Promise<SearchResult[]>;
}): Promise<{
	results: SearchResultWithBackend[];
	backendStats: Map<string, BackendStats>;
	usableBackendCount: number;
}> {
	const backendStats = new Map<string, BackendStats>();
	const usableBackends: Array<{ backend: string; results: SearchResultWithBackend[] }> = [];
	const perBackendResults = Math.max(1, Math.ceil(numResults / targetUsableBackends));
	let cursor = 0;

	while (usableBackends.length < targetUsableBackends && cursor < orderedBackends.length) {
		const needed = targetUsableBackends - usableBackends.length;
		const remaining = orderedBackends.length - cursor;
		const batchSize = Math.min(needed, remaining);
		const batch = orderedBackends.slice(cursor, cursor + batchSize);
		cursor += batchSize;

		const batchResults = await Promise.all(
			batch.map(async (backend) => {
				try {
					const results = await runBackend(backend, query, perBackendResults, signal);
					return {
						backend,
						results: results.map((r) => ({ ...r, backend })) as SearchResultWithBackend[],
						success: true,
					};
				} catch (err) {
					return {
						backend,
						results: [] as SearchResultWithBackend[],
						success: false,
						error: (err as Error).message,
					};
				}
			}),
		);

		for (const { backend, results, success, error } of batchResults) {
			backendStats.set(backend, {
				success,
				count: results.length,
				error,
			});
			if (success && results.length > 0) {
				usableBackends.push({ backend, results });
			}
		}
	}

	return {
		results: usableBackends.length > 1
			? reciprocalRankFusion(usableBackends, numResults)
			: (usableBackends[0]?.results.slice(0, numResults) ?? []),
		backendStats,
		usableBackendCount: usableBackends.length,
	};
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF)
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
	try {
		const u = new URL(url);
		u.hash = "";
		u.pathname = u.pathname.replace(/\/+$/, "") || "/";
		return u.toString().toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}

/**
 * Merge results from multiple backends using Reciprocal Rank Fusion (k=60).
 * URL dedup keeps the result with the richest content.
 */
export function reciprocalRankFusion(
	backendResults: Array<{ backend: string; results: SearchResultWithBackend[] }>,
	maxResults: number,
): SearchResultWithBackend[] {
	const K = 60;
	const urlMap = new Map<string, { rrfScore: number; result: SearchResultWithBackend; backends: string[] }>();

	for (const { backend, results } of backendResults) {
		for (let rank = 0; rank < results.length; rank++) {
			const r = results[rank];
			const key = normalizeUrl(r.url);

			const existing = urlMap.get(key);
			const rrfContribution = 1 / (K + rank + 1);

			if (existing) {
				existing.rrfScore += rrfContribution;
				existing.backends.push(backend);
				// Prefer result with richer content
				const existingLen = (existing.result.content ?? existing.result.snippet ?? "").length;
				const newLen = (r.content ?? r.snippet ?? "").length;
				if (newLen > existingLen) {
					existing.result = r;
				}
				// Keep backend label from higher-ranked result
			} else {
				urlMap.set(key, {
					rrfScore: rrfContribution,
					result: { ...r, backend },
					backends: [backend],
				});
			}
		}
	}

	return Array.from(urlMap.values())
		.sort((a, b) => {
			// Primary: RRF score descending
			if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
			// Secondary: number of backends that found it
			return b.backends.length - a.backends.length;
		})
		.slice(0, maxResults)
		.map(entry => entry.result);
}
