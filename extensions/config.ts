/**
 * Config loading and module-level mutable state for pi-search-hub extension.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendConfig, SearchConfig } from "./types.js";
import { getAgentDir } from "./utils.js";
import { clearCredentialCache, FALLBACK_ENV_MAP } from "./credentials.js";

// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------

/** Module-level config accessible from helper functions. */
export let config: SearchConfig = { defaultBackend: "duckduckgo", backends: {} };

/** Round-robin counter — increments on each call, never resets until pi restarts. */
export let roundRobinIndex = 0;

export function incrementRoundRobin(): number {
	return roundRobinIndex++;
}

/**
 * Latency samples per backend. Each sample is { ms, timestamp }.
 * Samples older than LATENCY_TTL_MS are pruned on every write.
 * Used by the "best-latency" selection strategy.
 */
const LATENCY_TTL_MS = 60_000;
export const latencyMap = new Map<string, { ms: number; timestamp: number }[]>();

export function recordLatency(backend: string, ms: number): void {
	const samples = latencyMap.get(backend) ?? [];
	const now = Date.now();
	// Prune stale samples
	const fresh = samples.filter(s => now - s.timestamp < LATENCY_TTL_MS);
	fresh.push({ ms, timestamp: now });
	latencyMap.set(backend, fresh);
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadConfig(cwd: string): SearchConfig {
	const globalPath = join(getAgentDir(), "extensions", "search.json");
	const projectPath = join(cwd, ".pi", "search.json");

	let config: SearchConfig = { defaultBackend: "duckduckgo", backends: {} };

	if (existsSync(globalPath)) {
		try {
			config = { ...config, ...JSON.parse(readFileSync(globalPath, "utf-8")) };
		} catch {
			// ignore
		}
	}

	// Save global backends before project config overwrites them
	const preProjectBackends = { ...(config.backends ?? {}) };

	if (existsSync(projectPath)) {
		try {
			const project = JSON.parse(readFileSync(projectPath, "utf-8"));
			config = { ...config, ...project };
			// Guard: if project config set backends to null/undefined, restore global backends
			if (config.backends == null) {
				config.backends = preProjectBackends;
			}
			if (project.backends && typeof project.backends === "object") {
				// Deep merge: merge per-backend so global backends not re-listed in project config are preserved
				const merged = { ...preProjectBackends, ...config.backends };
				for (const [key, val] of Object.entries(project.backends)) {
					const bc = val as BackendConfig | undefined;
					if (bc && merged[key]) {
						merged[key] = { ...merged[key], ...bc };
					} else {
						merged[key] = bc;
					}
				}
				config.backends = merged;
			}
		} catch {
			// ignore
		}
	}

	// Auto-enable backends that have a convenience env var but no explicit config yet.
	// Only enables if the backend is not explicitly disabled (enabled !== false).
	for (const [backend, envVar] of Object.entries(FALLBACK_ENV_MAP)) {
		const envValue = process.env[envVar];
		if (envValue && envValue.trim().length > 0) {
			const configBackends = config.backends as Record<string, BackendConfig> ?? {};
			const existing = configBackends[backend];
			if (!existing || existing.enabled === undefined) {
				if (!config.backends) config.backends = {};
				(config.backends as Record<string, BackendConfig>)[backend] = {
					...existing,
					enabled: true,
				};
			}
		}
	}

	return config;
}

// ---------------------------------------------------------------------------
// Config refresh
// ---------------------------------------------------------------------------

let activeBackendsList: string[] = [];
let configCacheTime = 0;
const CONFIG_TTL_MS = 10_000; // re-read config at most every 10s

export function refreshConfig(cwd: string, force = false): string[] {
	const now = Date.now();
	if (!force && now - configCacheTime < CONFIG_TTL_MS) return activeBackendsList;

	config = loadConfig(cwd);
	configCacheTime = now;

	activeBackendsList = Object.entries(config.backends || {})
		.filter(([_, bc]) => bc?.enabled)
		.map(([name]) => name);

	// Always add duckduckgo if no backends explicitly enabled, since it needs no key
	if (activeBackendsList.length === 0) {
		activeBackendsList.push("duckduckgo");
	}

	// Honor defaultBackend: put it first in the auto-try order
	if (config.defaultBackend && activeBackendsList.includes(config.defaultBackend)) {
		activeBackendsList = [
			config.defaultBackend,
			...activeBackendsList.filter(b => b !== config.defaultBackend),
		];
	} else {
		config.defaultBackend = activeBackendsList[0];
	}

	// Invalidate credential cache so shell-command keys refresh after config reload
	clearCredentialCache();

	return activeBackendsList;
}

export function getActiveBackends(): string[] {
	return activeBackendsList;
}
