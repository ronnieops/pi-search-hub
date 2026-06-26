/**
 * Exa backend — AI-native search, needs API key.
 * Tracks monthly usage (1000 req/month, warns at 800).
 */

import { timeoutSignal, sanitizeError, checkExaUsage, incrementExaUsage } from "../utils.js";
import { parseExa } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

/**
 * Fetch a single URL as clean text via Exa Contents API.
 * Shares the 1,000 req/month quota with Exa search.
 * Docs: https://exa.ai/docs/reference/contents-api-guide-for-coding-agents
 */
export async function fetchExaContents(
	url: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string; warning?: string }> {
	// Check quota before making request
	const preWarning = checkExaUsage();

	const response = await fetch("https://api.exa.ai/contents", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify({ urls: [url], text: true }),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		let detail = text;
		try {
			const json = JSON.parse(text);
			detail = json.error || json.message || text;
		} catch {
			// use raw
		}
		throw new Error(`Exa contents ${sanitizeError(response.status, detail)}`);
	}

	// Increment usage after successful request
	const warning = incrementExaUsage();

	const data = (await response.json()) as Record<string, unknown>;
	const results = Array.isArray(data.results)
		? (data.results as Array<Record<string, unknown>>)
		: [];
	const first = results[0];
	if (!first) {
		throw new Error(`Exa contents returned no results for ${url}`);
	}
	// Check per-URL status for errors (Exa returns HTTP 200 even on per-URL failures)
	const statuses = Array.isArray(data.statuses)
		? (data.statuses as Array<Record<string, unknown>>)
		: [];
	const urlStatus = statuses.find(s => s.id === url);
	if (urlStatus && urlStatus.status === "error") {
		const errTag = (urlStatus.error as Record<string, unknown>)?.tag || "unknown";
		throw new Error(`Exa contents failed for ${url}: ${errTag}`);
	}
	return {
		title: (first.title as string) || "",
		url: (first.url as string) || url,
		content: (first.text as string) || "",
		warning: warning || undefined,
	};
}

export async function searchExa(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[]; warning?: string }> {
	const body = {
		query,
		numResults: Math.min(numResults, 25),
		contents: { text: true, highlights: true },
	};
	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		let detail = text;
		try {
			const json = JSON.parse(text);
			detail = json.error || json.message || text;
		} catch {
			// use raw
		}
		throw new Error(`Exa ${sanitizeError(response.status, detail)}`);
	}

	// Increment usage after successful request
	const warning = incrementExaUsage();

	const data = (await response.json()) as Record<string, unknown>;
	return {
		results: parseExa(data, numResults),
		warning: warning || undefined,
	};
}
