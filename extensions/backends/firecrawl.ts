/**
 * Firecrawl backend — search+crawl, needs API key.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseFirecrawl } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchFirecrawl(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const body = { query, limit: Math.min(numResults, 20) };

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	// Add Firecrawl Keyless mode support
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	const response = await fetch("https://api.firecrawl.dev/v2/search", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Firecrawl ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseFirecrawl(data, numResults) };
}
