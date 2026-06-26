/**
 * Firecrawl backend — search+crawl. API key optional: Firecrawl Keyless
 * (https://www.firecrawl.dev/blog/firecrawl-keyless-launch) grants 1,000
 * free credits/month with no key. Bring your own key for higher volume.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseFirecrawl } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

/**
 * Fetch a single URL as clean markdown via Firecrawl Scrape API.
 * Keyless mode: omit Authorization header when no key configured.
 * Docs: https://docs.firecrawl.dev/api-reference/endpoint/scrape
 */
export async function fetchFirecrawl(
	url: string,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string }> {
	const body = { url, formats: ["markdown"] };
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}
	const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Firecrawl scrape ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const result = data.data as Record<string, unknown> | undefined;
	if (!result) {
		throw new Error(`Firecrawl scrape returned no data for ${url}`);
	}
	const metadata = result.metadata as Record<string, unknown> | undefined;
	return {
		title: (metadata?.title as string) || "",
		url: (metadata?.sourceURL as string) || url,
		content: (result.markdown as string) || "",
	};
}

export async function searchFirecrawl(
	query: string,
	numResults: number,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const body = { query, limit: Math.min(numResults, 20) };
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		// Keyless mode (no header) is supported on the hosted API; only attach
		// the Authorization header when a key is actually provided.
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
