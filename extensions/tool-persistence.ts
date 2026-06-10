/**
 * Tool selection persistence for pi-search-hub.
 *
 * Saves enabled backends to a file so they persist across sessions.
 * Inspired by pi-firecrawl pattern.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_PERSISTENCE_FILE = "tool-persistence.json";

/** Default backends when nothing is persisted. */
const DEFAULT_BACKENDS = ["duckduckgo"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolPersistenceData {
	version: 1;
	enabledBackends: string[];
	lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPersistencePath(): string {
	return join(getAgentDir(), "extensions", TOOL_PERSISTENCE_FILE);
}

function ensureDir(): void {
	const dir = join(getAgentDir(), "extensions");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Load persisted tool selection.
 * Returns default backends if no persistence file exists.
 */
export function loadToolSelection(): string[] {
	try {
		const path = getPersistencePath();
		if (!existsSync(path)) {
			return DEFAULT_BACKENDS;
		}
		const data = JSON.parse(readFileSync(path, "utf-8")) as ToolPersistenceData;
		if (!data.enabledBackends || !Array.isArray(data.enabledBackends)) {
			return DEFAULT_BACKENDS;
		}
		return data.enabledBackends;
	} catch {
		return DEFAULT_BACKENDS;
	}
}

/**
 * Save tool selection to persistence file.
 */
export function saveToolSelection(enabledBackends: string[]): void {
	ensureDir();
	const data: ToolPersistenceData = {
		version: 1,
		enabledBackends,
		lastUpdated: new Date().toISOString(),
	};
	const path = getPersistencePath();
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Add a backend to persisted selection.
 */
export function enableBackend(backend: string): string[] {
	const current = loadToolSelection();
	if (!current.includes(backend)) {
		current.push(backend);
		saveToolSelection(current);
	}
	return current;
}

/**
 * Remove a backend from persisted selection.
 */
export function disableBackend(backend: string): string[] {
	const current = loadToolSelection();
	const updated = current.filter(b => b !== backend);
	if (updated.length === 0) {
		// Don't allow empty selection — keep at least duckduckgo
		saveToolSelection(DEFAULT_BACKENDS);
		return DEFAULT_BACKENDS;
	}
	saveToolSelection(updated);
	return updated;
}

/**
 * Toggle a backend on/off in persisted selection.
 */
export function toggleBackend(backend: string): string[] {
	const current = loadToolSelection();
	if (current.includes(backend)) {
		return disableBackend(backend);
	} else {
		return enableBackend(backend);
	}
}

/**
 * Get persisted tool selection as a Map (for config merging).
 */
export function getPersistedConfig(): Record<string, { enabled: boolean }> {
	const backends = loadToolSelection();
	const result: Record<string, { enabled: boolean }> = {};
	for (const backend of backends) {
		result[backend] = { enabled: true };
	}
	return result;
}

/**
 * Merge persisted selection with existing config.
 * Persisted backends that aren't in config get added with enabled: true.
 * Config backends that are disabled get preserved.
 */
export function mergeWithConfig(
	configBackends: Record<string, { enabled?: boolean }>,
): Record<string, { enabled?: boolean }> {
	const persisted = loadToolSelection();
	const merged = { ...configBackends };

	// Add persisted backends that aren't in config
	for (const backend of persisted) {
		if (!merged[backend]) {
			merged[backend] = { enabled: true };
		}
	}

	// Remove persisted backends that are explicitly disabled in config
	for (const backend of persisted) {
		if (merged[backend]?.enabled === false) {
			delete merged[backend];
		}
	}

	return merged;
}

/**
 * Format persisted selection for display.
 */
export function formatToolSelection(): string {
	const backends = loadToolSelection();
	const lines = [
		"**Enabled backends:**",
		...backends.map(b => `  - ${b}`),
		"",
		`Last updated: ${new Date().toISOString()}`,
	];
	return lines.join("\n");
}