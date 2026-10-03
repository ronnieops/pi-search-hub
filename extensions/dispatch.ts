/**
 * Dispatch logic: selection strategies, RRF combiner, fallback ordering.
 */

import type { AlwaysIncludeBackendConfig, SearchResult, SearchResultWithBackend } from "./types.js";

export type BackendStats = { success: boolean; count: number; error?: string };
import { config, roundRobinIndex, incrementRoundRobin } from "./config.js";
import { scoreBackends } from "./scoring.js";

/** One backend's ranked result list as fed into the RRF combiner. */
export interface RankedBackendList {
	backend: string;
	results: SearchResultWithBackend[];
}

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
	usableLists: RankedBackendList[];
}> {
	const backendStats = new Map<string, BackendStats>();
	const usableBackends: RankedBackendList[] = [];
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
		results: fuseRanked(usableBackends, numResults),
		backendStats,
		usableBackendCount: usableBackends.length,
		usableLists: usableBackends,
	};
}

// ---------------------------------------------------------------------------
// Always-include tier (beside targeted combine)
// ---------------------------------------------------------------------------

export interface AlwaysIncludeEntry {
	backend: string;
	/** Deadline from query start, in milliseconds. A miss drops this backend only. */
	timeoutMs: number;
	/** Cap on results contributed to the fusion pool. Unbounded when omitted. */
	maxResults?: number;
}

/**
 * Validate alwaysInclude against the enabled backend list. Object key order
 * is the query order. A missing or disabled name is a config error.
 */
export function resolveAlwaysInclude(
	alwaysInclude: Record<string, AlwaysIncludeBackendConfig> | undefined,
	activeBackends: string[],
): AlwaysIncludeEntry[] {
	if (alwaysInclude === undefined) return [];
	if (!alwaysInclude || typeof alwaysInclude !== "object" || Array.isArray(alwaysInclude)) {
		throw new Error("alwaysInclude must be an object of backend name to { timeoutMs }");
	}
	const active = new Set(activeBackends);
	const entries: AlwaysIncludeEntry[] = [];
	for (const [backend, cfg] of Object.entries(alwaysInclude)) {
		if (!active.has(backend)) {
			throw new Error(`alwaysInclude backend "${backend}" is not an enabled backend`);
		}
		if (!cfg || typeof cfg !== "object" || !Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs <= 0) {
			throw new Error(`alwaysInclude backend "${backend}" requires a positive timeoutMs`);
		}
		if (cfg.maxResults !== undefined && (!Number.isInteger(cfg.maxResults) || cfg.maxResults <= 0)) {
			throw new Error(`alwaysInclude backend "${backend}" requires maxResults to be a positive integer`);
		}
		entries.push({ backend, timeoutMs: cfg.timeoutMs, maxResults: cfg.maxResults });
	}
	return entries;
}

function abortError(abortSignal: AbortSignal): Promise<never> {
	if (abortSignal.aborted) return Promise.reject(abortSignal.reason ?? new Error("aborted"));
	return new Promise((_, reject) => {
		abortSignal.addEventListener("abort", () => {
			reject(abortSignal.reason ?? new Error("aborted"));
		}, { once: true });
	});
}

export async function runAlwaysInclude({
	entries,
	query,
	numResults,
	signal,
	runBackend,
}: {
	entries: AlwaysIncludeEntry[];
	query: string;
	numResults: number;
	signal?: AbortSignal;
	runBackend: (backend: string, query: string, numResults: number, signal?: AbortSignal) => Promise<SearchResult[]>;
}): Promise<{
	lists: RankedBackendList[];
	stats: Map<string, BackendStats>;
}> {
	const stats = new Map<string, BackendStats>();
	const lists: RankedBackendList[] = [];
	if (entries.length === 0) return { lists, stats };

	const settled = await Promise.all(entries.map(async (entry) => {
		const deadline = AbortSignal.timeout(entry.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
		const count = entry.maxResults ?? numResults;
		try {
			const results = await Promise.race([
				runBackend(entry.backend, query, count, combined),
				abortError(combined),
			]);
			return { entry, results, error: undefined as string | undefined };
		} catch (err) {
			if (signal?.aborted) throw err;
			const timedOut = deadline.aborted;
			return {
				entry,
				results: [] as SearchResult[],
				error: timedOut ? `timed out after ${entry.timeoutMs}ms` : (err as Error).message,
			};
		}
	}));

	for (const { entry, results, error } of settled) {
		if (error) {
			stats.set(entry.backend, { success: false, count: 0, error });
			continue;
		}
		const tagged = results
			.slice(0, entry.maxResults ?? numResults)
			.map((r) => ({ ...r, backend: entry.backend }));
		stats.set(entry.backend, { success: true, count: tagged.length });
		if (tagged.length > 0) lists.push({ backend: entry.backend, results: tagged });
	}
	return { lists, stats };
}

/**
 * Query alwaysInclude backends in parallel with the quality wave and fuse
 * their results into the same RRF pool — free hits rank, dedup, and confirm
 * on equal footing with quality hits. When the quality wave produced nothing,
 * the free lists alone are the result, cut to numResults.
 */
export async function runTieredTargetedCombine({
	orderedBackends,
	alwaysInclude,
	query,
	numResults,
	signal,
	targetUsableBackends,
	runBackend,
}: {
	orderedBackends: string[];
	alwaysInclude: AlwaysIncludeEntry[];
	query: string;
	numResults: number;
	signal?: AbortSignal;
	targetUsableBackends?: number;
	runBackend: (backend: string, query: string, numResults: number, signal?: AbortSignal) => Promise<SearchResult[]>;
}): Promise<{
	results: SearchResultWithBackend[];
	backendStats: Map<string, BackendStats>;
	usableBackendCount: number;
	qualityUsableCount: number;
	freeUsableCount: number;
}> {
	const excluded = new Set(alwaysInclude.map((entry) => entry.backend));
	const qualityBackends = orderedBackends.filter((backend) => !excluded.has(backend));

	const freePromise = runAlwaysInclude({
		entries: alwaysInclude,
		query,
		numResults,
		signal,
		runBackend,
	});
	const quality = await runTargetedCombine({
		orderedBackends: qualityBackends,
		query,
		numResults,
		signal,
		targetUsableBackends,
		runBackend,
	});
	const free = await freePromise;

	const backendStats = new Map<string, BackendStats>(quality.backendStats);
	for (const [backend, stats] of free.stats) backendStats.set(backend, stats);

	return {
		results: fuseRanked([...quality.usableLists, ...free.lists], numResults),
		backendStats,
		usableBackendCount: quality.usableBackendCount + free.lists.length,
		qualityUsableCount: quality.usableBackendCount,
		freeUsableCount: free.lists.length,
	};
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF)
// ---------------------------------------------------------------------------

const RRF_K = 60;

interface ScoredHit {
	rrfScore: number;
	result: SearchResultWithBackend;
	backends: string[];
}

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

function preferRicher(existing: SearchResultWithBackend, incoming: SearchResultWithBackend): SearchResultWithBackend {
	const existingLen = (existing.content ?? existing.snippet ?? "").length;
	const newLen = (incoming.content ?? incoming.snippet ?? "").length;
	return newLen > existingLen ? incoming : existing;
}

function scoreLists(backendResults: RankedBackendList[]): Map<string, ScoredHit> {
	const urlMap = new Map<string, ScoredHit>();
	for (const { backend, results } of backendResults) {
		for (let rank = 0; rank < results.length; rank++) {
			const result = results[rank];
			const key = normalizeUrl(result.url);
			const contribution = 1 / (RRF_K + rank + 1);
			const existing = urlMap.get(key);
			if (existing) {
				existing.rrfScore += contribution;
				existing.backends.push(backend);
				existing.result = preferRicher(existing.result, result);
				continue;
			}
			urlMap.set(key, {
				rrfScore: contribution,
				result: { ...result, backend },
				backends: [backend],
			});
		}
	}
	return urlMap;
}

function rankedFrom(urlMap: Map<string, ScoredHit>): ScoredHit[] {
	return Array.from(urlMap.values()).sort((a, b) => {
		// Primary: RRF score descending
		if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
		// Secondary: number of backends that found it
		return b.backends.length - a.backends.length;
	});
}

function fuseRanked(backendResults: RankedBackendList[], maxResults: number): SearchResultWithBackend[] {
	if (backendResults.length === 0) return [];
	if (backendResults.length === 1) return backendResults[0].results.slice(0, maxResults);
	return rankedFrom(scoreLists(backendResults)).slice(0, maxResults).map((entry) => entry.result);
}

/**
 * Merge results from multiple backends using Reciprocal Rank Fusion (k=60).
 * URL dedup keeps the result with the richest content.
 */
export function reciprocalRankFusion(
	backendResults: RankedBackendList[],
	maxResults: number,
): SearchResultWithBackend[] {
	return fuseRanked(backendResults, maxResults);
}
