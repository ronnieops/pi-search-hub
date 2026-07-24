/**
 * Single-reader fetch — one reader, no fallback.
 * Extracted so fetchWithFallback can import it and tests can mock it.
 */

import type { SearchConfig } from "../types.js";
import { timeoutSignal, sanitizeError, MISSING_KEY_HELP } from "../utils.js";
import { resolveBackendKey } from "../credentials.js";
import { fetchSofya } from "../backends/sofya.js";
import { fetchFirecrawl } from "../backends/firecrawl.js";
import { fetchExaContents } from "../backends/exa.js";
import { fetchExaMCP } from "../backends/exa-mcp.js";

/** Cap on a single web_read response body, in bytes, to bound memory use on heavy pages. */
const READ_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export interface FetchParams {
	fresh?: boolean;
	keywords?: string[];
	mode?: string;
	objective?: string;
}

export interface FetchResult {
	content: string;
	reader: string;
	warning?: string;
}

/** Human-readable label for each reader. */
export function readerLabel(reader: string): string {
	switch (reader) {
		case "sofya": return "Sofya";
		case "firecrawl": return "Firecrawl";
		case "exa": return "Exa";
		case "exa_mcp": return "Exa MCP";
		default: return "Jina";
	}
}

/**
 * Fetch a URL using the specified reader backend.
 *
 * @param url    - The URL to fetch (already validated for SSRF).
 * @param reader - Reader backend name ("jina", "sofya", "firecrawl", "exa", "exa_mcp").
 * @param params - Additional parameters (fresh, keywords, mode, objective).
 * @param signal - Optional abort signal.
 * @param config - Search config for credential resolution.
 * @returns The fetched content and the reader that served it.
 */
export async function fetchWithReader(
	url: string,
	reader: string,
	params: FetchParams,
	signal: AbortSignal | undefined,
	config: SearchConfig,
): Promise<FetchResult> {
	switch (reader) {
		case "sofya": {
			const sofyaKey = resolveBackendKey("sofya", config);
			if (!sofyaKey) {
				throw new Error(`Sofya reader selected but no API key configured. ${MISSING_KEY_HELP}`);
			}
			const result = await fetchSofya(url, sofyaKey, signal);
			return { content: result.content, reader: "sofya" };
		}

		case "firecrawl": {
			const firecrawlKey = resolveBackendKey("firecrawl", config);
			const result = await fetchFirecrawl(url, firecrawlKey, signal);
			return { content: result.content, reader: "firecrawl" };
		}

		case "exa": {
			const exaKey = resolveBackendKey("exa", config);
			if (!exaKey) {
				throw new Error(`Exa reader selected but no API key configured. ${MISSING_KEY_HELP}`);
			}
			const result = await fetchExaContents(url, exaKey, signal);
			return { content: result.content, reader: "exa", warning: result.warning };
		}

		case "exa_mcp": {
			const result = await fetchExaMCP(url, signal);
			return { content: result.content, reader: "exa_mcp" };
		}

		default: {
			// Jina Reader: free, supports keywords / mode / objective hints.
			const readerUrl = new URL("https://r.jina.ai/" + url);

			const headers: Record<string, string> = {
				"Accept": "text/plain",
			};

			// Optional Jina API key for higher rate limits (fallback to no-auth)
			const jinaKey = resolveBackendKey("jina", config);
			if (jinaKey) {
				headers["Authorization"] = `Bearer ${jinaKey}`;
			}

			if (params.fresh) {
				headers["x-no-cache"] = "true";
			}
			if (params.keywords && params.keywords.length > 0) {
				headers["x-keywords"] = params.keywords.join(", ");
			}
			if (params.mode) {
				headers["x-respond-with"] = params.mode === "rush" ? "text" : "markdown";
			}
			if (params.objective) {
				headers["x-target-selector"] = params.objective;
			}

			const response = await fetch(readerUrl.toString(), {
				signal: timeoutSignal(signal),
				headers,
			});

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`Failed to read ${url}: ${sanitizeError(response.status, text)}`);
			}

			// Size guard — refuse oversized payloads before buffering into memory.
			const contentLength = parseInt(response.headers.get("content-length") ?? "", 10);
			if (Number.isFinite(contentLength) && contentLength > READ_MAX_BYTES) {
				throw new Error(`Failed to read ${url}: response too large (${contentLength} bytes, limit ${READ_MAX_BYTES})`);
			}

			const content = await response.text();
			return { content, reader: "jina" };
		}
	}
}
