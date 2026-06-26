/**
 * Exa MCP backend — zero-config, no API key needed.
 * 
 * Uses the MCP (Model Context Protocol) endpoint at https://mcp.exa.ai/mcp
 * This is a different approach from the direct API - it uses MCP tool calls.
 */

import { timeoutSignal, sanitizeError } from "../utils.js";
import { parseExa } from "../../backends/parsers.js";
import type { SearchResult } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MCPRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: {
		name?: string;
		arguments?: Record<string, unknown>;
	};
}

interface MCPResponse {
	jsonrpc: "2.0";
	id: number;
	result?: {
		content?: Array<{ type: string; text?: string }>;
	};
	error?: {
		code: number;
		message: string;
	};
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

let requestId = 0;

async function callMCP(
	method: string,
	params?: Record<string, unknown>,
	fetchFn: typeof fetch = fetch,
): Promise<{ results: SearchResult[] }> {
	const id = ++requestId;
	
	const request: MCPRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params: params ? { arguments: params } : undefined,
	};

	const response = await fetchFn(EXA_MCP_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(request),
		signal: timeoutSignal(undefined, 30000),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Exa MCP ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as MCPResponse;

	if (data.error) {
		throw new Error(`Exa MCP error: ${data.error.message}`);
	}

	if (!data.result?.content) {
		return { results: [] };
	}

	// Parse the response content
	// Exa MCP returns results as text that needs to be parsed
	const text = data.result.content
		.filter(c => c.type === "text")
		.map(c => c.text || "")
		.join("\n");

	// Try to parse as JSON (Exa returns structured results)
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) {
			return { 
				results: parsed.map((item: Record<string, unknown>) => ({
					title: (item.title as string) || "",
					url: (item.url as string) || "",
					snippet: (item.snippet as string) || (item.description as string) || "",
					content: (item.content as string) || "",
				})) as SearchResult[]
			};
		}
		if (parsed.results && Array.isArray(parsed.results)) {
			return { 
				results: parsed.results.map((item: Record<string, unknown>) => ({
					title: (item.title as string) || "",
					url: (item.url as string) || "",
					snippet: (item.snippet as string) || (item.description as string) || "",
					content: (item.content as string) || "",
				})) as SearchResult[]
			};
		}
	} catch {
		// Not JSON, try line-by-line parsing
	}

	// Fallback: parse line-by-line (url\t title\t snippet)
	const results: SearchResult[] = [];
	for (const line of text.split("\n")) {
		const parts = line.split("\t");
		if (parts.length >= 2) {
			results.push({
				title: parts[1] || "",
				url: parts[0] || "",
				snippet: parts[2] || "",
			});
		}
	}

	return { results };
}

// ---------------------------------------------------------------------------
// Search function
// ---------------------------------------------------------------------------

export async function searchExaMCP(
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	return callMCP("tools/call", {
		name: "web_search_exa",
		arguments: {
			query,
			numResults: Math.min(numResults, 20),
		},
	});
}

/**
 * Fetch a single URL as clean content via Exa MCP web_fetch_exa tool.
 * Zero-config — no API key needed (rate-limited free plan).
 * Docs: https://exa.ai/docs/reference/exa-mcp
 */
export async function fetchExaMCP(
	url: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string }> {
	const result = await callMCP("tools/call", {
		name: "web_fetch_exa",
		arguments: { url },
	});
	const first = result.results[0];
	if (!first) {
		throw new Error(`Exa MCP fetch returned no content for ${url}`);
	}
	return {
		title: first.title || "",
		url: first.url || url,
		content: first.content || first.snippet || "",
	};
}