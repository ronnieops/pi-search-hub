/**
 * Sofya backend: web search + content extraction (https://sofya.co).
 *
 * Two capabilities, both behind one API key (Bearer ay_live_...):
 *   • search (web_search): POST /v1/search, returns extracted page content
 *   • fetch  (web_read):   POST /v1/fetch, URL(s) to clean markdown (250+ parsers)
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseSofya } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

const SOFYA_BASE = "https://sofya.co";

export async function searchSofya(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
	opts?: { searchDepth?: "snippets" | "basic"; topic?: "general" | "news" },
): Promise<{ results: SearchResult[] }> {
	const body = {
		query,
		search_depth: opts?.searchDepth ?? "basic",
		max_results: Math.min(numResults, 20),
		include_answer: false,
		topic: opts?.topic ?? "general",
	};
	const response = await fetch(`${SOFYA_BASE}/v1/search`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Sofya ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	return { results: parseSofya(data, numResults) };
}

/**
 * Fetch a single URL as clean markdown via Sofya Fetch.
 * Returns the extracted content; throws on transport error or per-URL failure.
 * SSRF guard is handled by the caller (web_read tool).
 */
export async function fetchSofya(
	url: string,
	apiKey: string,
	signal?: AbortSignal,
	opts?: { includeRawHtml?: boolean },
): Promise<{ title: string; url: string; content: string }> {
	const includeRawHtml = opts?.includeRawHtml ?? false;
	const response = await fetch(`${SOFYA_BASE}/v1/fetch`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ urls: [url], include_raw_html: includeRawHtml }),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Sofya fetch ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const results = Array.isArray(data.results)
		? (data.results as Array<Record<string, unknown>>)
		: [];
	const first = results[0];
	if (!first || first.success === false) {
		const err = (first?.error as string) || "no content returned";
		throw new Error(`Sofya fetch failed for ${url}: ${err}`);
	}
	return {
		title: (first.title as string) || "",
		url: (first.url as string) || url,
		content: (first.content as string) || "",
	};
}
