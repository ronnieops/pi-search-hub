import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
	getModel,
	streamOpenAICodexResponses,
	type Context,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { timeoutSignal } from "../utils.js";
import type { BackendConfig, SearchResult } from "../types.js";

const DEFAULT_MODEL_ID = "gpt-5.4-mini";
const DEFAULT_SEARCH_CONTEXT_SIZE = "low";
const MAX_TOOL_RESULTS = 20;
const MAX_TITLE_LENGTH = 200;
const MAX_SNIPPET_LENGTH = 1000;

const SUBMIT_SEARCH_RESULTS_TOOL = {
	name: "submit_search_results",
	description: "Submit structured search results based on the available source evidence.",
	parameters: Type.Object({
		results: Type.Array(
			Type.Object({
				title: Type.String({
					description: "Page title or clearest source title for the URL.",
				}),
				url: Type.String({
					description: "Canonical http/https URL for the result.",
				}),
				snippet: Type.String({
					description:
						"A dense 450-500 character, multi-sentence paragraph with the most query-relevant facts, claims, numbers, dates, caveats, scope limits, and source-specific details from the available source evidence. Prefer completeness and concrete details over brevity while staying within normal search-result display. Shorter is acceptable only when evidence is thin. Do not write an opinion about usefulness.",
				}),
			}),
			{ maxItems: MAX_TOOL_RESULTS },
		),
	}),
} as const;

export async function searchOpenAICodex(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	backendConfig?: BackendConfig,
): Promise<{ results: SearchResult[] }> {
	if (signal?.aborted) {
		throw new Error("OpenAI Codex search cancelled");
	}

	const apiKey = await resolveOpenAICodexAccessToken();
	const modelId = backendConfig?.model?.trim() || DEFAULT_MODEL_ID;
	const model = getModel("openai-codex", modelId) as Model<"openai-codex-responses"> | undefined;
	if (!model) {
		throw new Error(`OpenAI Codex model not found: ${modelId}`);
	}

	const context: Context = {
		systemPrompt: buildSystemPrompt(numResults),
		messages: [
			{
				role: "user",
				content: query,
				timestamp: Date.now(),
			},
		],
		tools: [SUBMIT_SEARCH_RESULTS_TOOL],
	};

	const message = await streamOpenAICodexResponses(model, context, {
		apiKey,
		signal: timeoutSignal(signal),
		transport: "sse",
		reasoningEffort: "minimal",
		textVerbosity: "low",
		onPayload: (payload) => injectCodexSearchPayload(payload),
	}).result();

	if (message.stopReason === "error") {
		throw new Error(message.errorMessage || "OpenAI Codex search failed");
	}
	if (message.stopReason === "aborted") {
		throw new Error("OpenAI Codex search cancelled");
	}

	const submitCall = message.content.find(
		(block) => block.type === "toolCall" && block.name === "submit_search_results",
	);
	if (!submitCall || submitCall.type !== "toolCall") {
		throw new Error("OpenAI Codex search did not submit structured results");
	}

	const results = normalizeSubmitSearchResults(submitCall.arguments, numResults);
	if (results.length === 0) {
		throw new Error("OpenAI Codex search returned no valid URL results");
	}

	return { results };
}

async function resolveOpenAICodexAccessToken(): Promise<string> {
	const authStorage = AuthStorage.create();
	const apiKey = await authStorage.getApiKey("openai-codex", {
		includeFallback: false,
	});

	if (!apiKey) {
		throw new Error("OpenAI Codex authentication not found. Run /login and select OpenAI Codex.");
	}

	return apiKey;
}

function buildSystemPrompt(numResults: number): string {
	return [
		`Research the user's query with hosted web_search and call submit_search_results exactly once with at most ${numResults} results.`,
		"Return only real http/https URLs.",
		"Prefer primary sources.",
		"For snippet, write a dense 450-500 character, multi-sentence paragraph with the most query-relevant facts, claims, numbers, dates, caveats, scope limits, and source-specific details from the available source evidence. Prefer completeness and concrete details over brevity while staying within normal search-result display. Shorter is acceptable only when evidence is thin.",
		"Do not invent details or present unsupported text as source content.",
		"No prose.",
		"No internal references.",
	].join(" ");
}

export function injectCodexSearchPayload(payload: unknown): unknown {
	const body = isRecord(payload) ? payload : {};
	const existingTools = Array.isArray(body.tools) ? body.tools.filter(Boolean) : [];
	const filteredTools = existingTools.filter((tool) => {
		if (!isRecord(tool)) return true;
		return tool.type !== "web_search";
	});

	body.tools = [
		{
			type: "web_search",
			external_web_access: true,
			search_context_size: DEFAULT_SEARCH_CONTEXT_SIZE,
		},
		...filteredTools,
	];
	body.tool_choice = "auto";
	body.parallel_tool_calls = false;

	const include = Array.isArray(body.include)
		? body.include.filter((value): value is string => typeof value === "string")
		: [];
	body.include = Array.from(new Set([...include, "web_search_call.action.sources"]));

	return body;
}

export function normalizeSubmitSearchResults(args: unknown, numResults: number): SearchResult[] {
	if (!isRecord(args) || !Array.isArray(args.results)) {
		return [];
	}

	const limit = Math.max(1, Math.min(numResults, MAX_TOOL_RESULTS));
	const deduped = new Set<string>();
	const results: SearchResult[] = [];

	for (const rawResult of args.results) {
		const normalized = normalizeSearchResult(rawResult);
		if (!normalized) continue;

		const dedupeKey = normalizeUrlForDedup(normalized.url);
		if (deduped.has(dedupeKey)) continue;

		deduped.add(dedupeKey);
		results.push(normalized);
		if (results.length >= limit) break;
	}

	return results;
}

export function normalizeSearchResult(rawResult: unknown): SearchResult | null {
	if (!isRecord(rawResult)) return null;

	const url = normalizeHttpUrl(rawResult.url);
	if (!url) return null;

	const fallbackTitle = safeUrlHostname(url);
	const title = truncateText(cleanString(rawResult.title) || fallbackTitle, MAX_TITLE_LENGTH);
	const snippet = truncateText(cleanString(rawResult.snippet), MAX_SNIPPET_LENGTH);
	const content = truncateText(cleanString(rawResult.content), MAX_SNIPPET_LENGTH);
	const display = snippet || content;
	if (!display) return null;

	return {
		title,
		url,
		snippet: display,
		content: display,
	};
}

export function normalizeHttpUrl(value: unknown): string | undefined {
	const input = cleanString(value);
	if (!input) return undefined;

	const candidate = hasUrlScheme(input)
		? input
		: looksLikeDomainOrPath(input)
			? `https://${input}`
			: input;

	try {
		const url = new URL(candidate);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return undefined;
		}
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

export function normalizeUrlForDedup(url: string): string {
	try {
		const normalized = new URL(url);
		normalized.hash = "";
		normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";
		return normalized.toString().toLowerCase();
	} catch {
		return url.trim().toLowerCase();
	}
}

function safeUrlHostname(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function cleanString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function truncateText(value: string, maxLength: number): string {
	return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function hasUrlScheme(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

export function looksLikeDomainOrPath(value: string): boolean {
	return /^[^\s/]+\.[^\s]+(?:\/.*)?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
