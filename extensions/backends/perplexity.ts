/**
 * Perplexity Sonar backend — citation-based answers, needs API key.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parsePerplexity } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

export async function searchPerplexity(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
	model?: string,
): Promise<{ results: SearchResult[] }> {
	const body = {
		model: model || "sonar",
		messages: [
			{
				role: "user",
				content: query,
			},
		],
		search_context_size: "high",
	};

	const response = await fetch("https://api.perplexity.ai/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${apiKey}`,
			"X-Pplx-Integration": "pi-search-hub",
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Perplexity ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	return { results: parsePerplexity(data, query, numResults) };
}
