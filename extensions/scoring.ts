/**
 * Smart backend scoring — tracks success rates, latency, and quality.
 * Used by the "best-latency" selection strategy for auto-ranking backends.
 *
 * Score = (success_rate * 0.5) + (speed_score * 0.3) + (quality_score * 0.2)
 * - success_rate: percentage of successful calls in the last 60s
 * - speed_score: normalized inverse latency (faster = higher)
 * - quality_score: average result count as fraction of requested
 */

// ---------------------------------------------------------------------------
// Score tracking
// ---------------------------------------------------------------------------

interface BackendMetrics {
	/** Successful calls in the current window */
	successes: number;
	/** Failed calls in the current window */
	failures: number;
	/** Average latency in ms for successful calls */
	avgLatency: number;
	/** Total latency samples */
	latencySamples: number;
	/** Average result count as fraction of requested (0-1) */
	avgResultRatio: number;
	/** Result ratio samples */
	resultSamples: number;
	/** Timestamp of last reset */
	windowStart: number;
}

const METRICS_WINDOW_MS = 60_000;
const metricsMap = new Map<string, BackendMetrics>();

function getMetrics(backend: string): BackendMetrics {
	const now = Date.now();
	let metrics = metricsMap.get(backend);
	if (!metrics || now - metrics.windowStart > METRICS_WINDOW_MS) {
		metrics = {
			successes: 0,
			failures: 0,
			avgLatency: 0,
			latencySamples: 0,
			avgResultRatio: 0,
			resultSamples: 0,
			windowStart: now,
		};
		metricsMap.set(backend, metrics);
	}
	return metrics;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export function recordBackendSuccess(backend: string, latencyMs: number, resultCount: number, requestedCount: number): void {
	const m = getMetrics(backend);
	m.successes++;
	// Running average for latency
	m.latencySamples++;
	m.avgLatency = m.avgLatency + (latencyMs - m.avgLatency) / m.latencySamples;
	// Running average for result ratio
	m.resultSamples++;
	const ratio = requestedCount > 0 ? resultCount / requestedCount : 0;
	m.avgResultRatio = m.avgResultRatio + (ratio - m.avgResultRatio) / m.resultSamples;
}

export function recordBackendFailure(backend: string): void {
	const m = getMetrics(backend);
	m.failures++;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface BackendScore {
	backend: string;
	compositeScore: number;
	successRate: number;
	avgLatency: number;
	resultRatio: number;
}

/**
 * Compute a composite score for each backend (0-1, higher is better).
 *
 * Composite = (successRate * 0.5) + (speedScore * 0.3) + (qualityScore * 0.2)
 * - successRate: successes / (successes + failures)
 * - speedScore: 1 - (latency / MAX_EXPECTED_LATENCY), clamped to [0, 1]
 * - qualityScore: avgResultRatio
 */
export function scoreBackends(backendNames: string[]): BackendScore[] {
	const MAX_LATENCY = 5_000; // ms — backends slower than this get speedScore = 0

	return backendNames.map(backend => {
		const m = metricsMap.get(backend);
		if (!m) {
			return { backend, compositeScore: 0.5, successRate: 0.5, avgLatency: 0, resultRatio: 0.5 };
		}

		const total = m.successes + m.failures;
		const successRate = total > 0 ? m.successes / total : 0.5;
		const speedScore = Math.max(0, 1 - (m.avgLatency / MAX_LATENCY));
		const qualityScore = m.resultSamples > 0 ? m.avgResultRatio : 0.5;
		const compositeScore = (successRate * 0.5) + (speedScore * 0.3) + (qualityScore * 0.2);

		return {
			backend,
			compositeScore,
			successRate,
			avgLatency: m.avgLatency,
			resultRatio: qualityScore,
		};
	}).sort((a, b) => b.compositeScore - a.compositeScore);
}

/**
 * Get the best N backends by composite score.
 */
export function getBestBackends(backendNames: string[], n: number): string[] {
	return scoreBackends(backendNames).slice(0, n).map(s => s.backend);
}
