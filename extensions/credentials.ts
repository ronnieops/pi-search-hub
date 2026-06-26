/**
 * Credential resolution for pi-search-hub extension.
 *
 * Supports three credential formats (following pi-web-providers convention):
 *   • "!command"   → execute shell command, return trimmed stdout (cached)
 *   • "ALL_CAPS"   → read process.env[ALL_CAPS]
 *   • otherwise     → return as literal string (actual key)
 */

import { execSync } from "node:child_process";
import { COMMAND_TIMEOUT_MS } from "./utils.js";
import type { BackendConfig, SearchConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Credential cache
// ---------------------------------------------------------------------------

const commandValueCache = new Map<string, { value?: string; errorMessage?: string }>();

/** Invalidate cached shell-command credentials so key rotation takes effect. */
export function clearCredentialCache(): void {
	commandValueCache.clear();
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a credential reference à la pi-web-providers:
 *   • "!command"   → execute shell command, return trimmed stdout (cached)
 *   • "ALL_CAPS"   → read process.env[ALL_CAPS]
 *   • otherwise     → return as literal string (actual key)
 */
export function resolveConfigValue(reference: string | undefined): string | undefined {
	if (!reference) return undefined;

	// !command — execute shell command, cache result
	if (reference.startsWith("!")) {
		const cached = commandValueCache.get(reference);
		if (cached) {
			if (cached.errorMessage) throw new Error(cached.errorMessage);
			return cached.value;
		}
		try {
			const output = execSync(reference.slice(1), {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: COMMAND_TIMEOUT_MS,
			})
				.trim();
			const value = output.length > 0 ? output : undefined;
			commandValueCache.set(reference, { value });
			return value;
		} catch (error) {
			const errorMessage = (error as Error).message;
			commandValueCache.set(reference, { errorMessage });
			throw error;
		}
	}

	// ALL_CAPS → env var lookup
	const envValue = process.env[reference];
	if (envValue !== undefined) return envValue;
	if (/^[A-Z][A-Z0-9_]*$/.test(reference)) {
		// Warn: value looks like an env var reference but the env var is unset.
		// If this was intended as a literal key, rename it or set the env var.
		console.warn(`[pi-search] Credential reference "${reference}" matches ALL_CAPS env-var pattern ` +
			`but process.env.${reference} is not set. If this is a literal key, ` +
			`use a different name to avoid confusion.`);
		return undefined;
	}

	// Otherwise → literal string (actual key in config)
	// Reject common accidental non-key literals that would otherwise leak into
	// Authorization headers as "Bearer null" / "Bearer undefined".
	if (reference === "null" || reference === "undefined" || reference === "none") {
		return undefined;
	}
	return reference;
}

// ---------------------------------------------------------------------------
// Convenience env vars
// ---------------------------------------------------------------------------

/** Convenience env vars checked as fallback when config has no apiKey for a backend. */
export const FALLBACK_ENV_MAP: Record<string, string> = {
	jina: "SEARCH_JINA_API_KEY",
	serper: "SEARCH_SERPER_API_KEY",
	tavily: "SEARCH_TAVILY_API_KEY",
	exa: "SEARCH_EXA_API_KEY",
	brave: "SEARCH_BRAVE_API_KEY",
	"brave-llm": "SEARCH_BRAVE_API_KEY",
	langsearch: "SEARCH_LANGSEARCH_API_KEY",
	firecrawl: "SEARCH_FIRECRAWL_API_KEY",
	websearchapi: "SEARCH_WEBSEARCHAPI_API_KEY",
	perplexity: "SEARCH_PERPLEXITY_API_KEY",
	sofya: "SEARCH_SOFYA_API_KEY",
	youcom: "SEARCH_YOUCOM_API_KEY",
	linkup: "SEARCH_LINKUP_API_KEY",
	fastcrw: "SEARCH_FASTCRW_API_KEY",
};

/** Lazy resolution: config.apiKey → resolveConfigValue() → FALLBACK_ENV_MAP fallback. */
export function resolveBackendKey(backend: string, config: SearchConfig): string | undefined {
	const bc = config.backends?.[backend as keyof typeof config.backends];
	if (bc?.apiKey) {
		const resolved = resolveConfigValue(bc.apiKey);
		if (resolved) return resolved;
	}
	const fallbackEnv = FALLBACK_ENV_MAP[backend];
	if (fallbackEnv) {
		const envValue = process.env[fallbackEnv];
		if (envValue && envValue.trim().length > 0) return envValue.trim();
	}
	return undefined;
}

/** Describe where a backend's key comes from (for search-status display). */
export function getKeySource(backend: string, config: SearchConfig): { configured: boolean; source: string } {
	const bc = config.backends?.[backend as keyof typeof config.backends];
	if (!bc?.apiKey) {
		const fallbackEnv = FALLBACK_ENV_MAP[backend];
		if (fallbackEnv && process.env[fallbackEnv]) {
			return { configured: true, source: `env:${fallbackEnv}` };
		}
		return { configured: false, source: "" };
	}
	const ref = bc.apiKey;
	if (ref.startsWith("!")) {
		return { configured: true, source: `shell:${ref.slice(0, 40)}...` };
	}
	if (/^[A-Z][A-Z0-9_]*$/.test(ref)) {
		const envValue = process.env[ref];
		if (envValue) return { configured: true, source: `env:${ref}` };
		return { configured: false, source: `env:${ref} (unset)` };
	}
	return { configured: true, source: "literal" };
}
