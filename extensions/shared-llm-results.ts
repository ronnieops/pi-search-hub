import { Type } from "typebox";
import { timeoutSignal } from "./utils.js";

import type { SearchResult } from "./types.js";

export const MAX_TOOL_RESULTS = 20;
export const MAX_TITLE_LENGTH = 200;
export const MAX_SNIPPET_LENGTH = 1000;

/**
 * Shared `submit_search_results` function tool for LLM-backed search backends
 * (openai-codex, anthropic, gemini). The model does hosted/native retrieval
 * itself, then calls this tool exactly once with structured results.
 */
export const SUBMIT_SEARCH_RESULTS_TOOL = {
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

export function buildLlmSearchSystemPrompt(numResults: number): string {
	return [
		`Research the user's query with hosted web_search and call submit_search_results exactly once with at most ${numResults} results.`,
		"Return only real http/https URLs.",
		"Prefer primary sources.",
		"For snippet, write a dense 450-500 character, multi-sentence paragraph with the most query-relevant facts, claims, numbers, dates, caveats, scope limits, and source-specific details from the available source evidence. Prefer completeness and concrete details over brevity while staying within normal search-result display. Shorter is acceptable only when evidence is thin.",
		"Do not invent details or present unsupported text as source content.",
		"Never reply with prose: a prose reply without calling submit_search_results fails the task.",
		"No internal references.",
	].join(" ");
}

export type PiAiModule = Record<string, any>;
export type StreamFn = (...args: any[]) => { result: () => Promise<any> };
export type GetModelFn = (provider: string, id: string) => any;

export async function loadPiAi(): Promise<PiAiModule> {
	try {
		return (await import("@earendil-works/pi-ai")) as PiAiModule;
	} catch (error) {
		throw new Error(
			`LLM search backends need @earendil-works/pi-ai from the pi host: ${(error as Error).message}. Falls back to the next backend.`,
		);
	}
}

export function pickFn(obj: PiAiModule, names: string[]): StreamFn | undefined {
	for (const name of names) {
		try {
			const value = obj[name];
			if (typeof value === "function") return value as StreamFn;
		} catch {
			// Strict mocks throw on unknown exports — try the next candidate.
		}
	}
	return undefined;
}

export function pickGetModel(obj: PiAiModule): GetModelFn | undefined {
	try {
		return typeof obj.getModel === "function" ? (obj.getModel as GetModelFn) : undefined;
	} catch {
		return undefined;
	}
}

export interface HostStreamRef {
	model: any;
	stream: StreamFn;
}

/**
 * Resolve a model through the host ModelRegistry (visible to tool calls via
 * ctx.modelRegistry). Unlike pi-ai's static getModel, the registry includes
 * extension-registered providers such as google-antigravity, and its stream
 * performs request-time authentication (OAuth refresh handled by the host),
 * so no explicit apiKey is needed on the host path.
 */
export function resolveHostModel(
	hostContext: unknown,
	provider: string,
	modelId: string,
): HostStreamRef | undefined {
	try {
		const registry = (hostContext as Record<string, any> | null | undefined)?.modelRegistry;
		const model = registry?.find?.(provider, modelId);
		const stream = registry?.stream?.bind(registry);
		if (model && typeof stream === "function") return { model, stream: stream as StreamFn };
	} catch {
		// Host without a model registry (older builds, unit tests).
	}
	return undefined;
}

export function missingStreamError(label: string, piAi: PiAiModule): Error {
	let available: string[];
	try {
		available = Object.keys(piAi)
			.filter((k) => /stream/i.test(k))
			.sort();
	} catch {
		available = [];
	}
	return new Error(
		`${label} search is not supported natively by this pi build ` +
			`(stream exports: ${available.length > 0 ? available.join(", ") : "none"}). ` +
			"Falls back to the next backend.",
	);
}

/**
 * Legacy direct streams need an explicit credential. Prefer the legacy host's
 * getApiKey resolver (which handles OAuth refresh); the synchronous store
 * fallback is safe for API keys only. Never bypass refresh with raw OAuth
 * access tokens. Modern hosts use ModelRegistry.stream instead.
 */
export async function resolveProviderApiKey(providerId: string): Promise<string | undefined> {
	try {
		const codingAgent = (await import("@earendil-works/pi-coding-agent")) as Record<
			string,
			any
		>;
		try {
			const AuthStorage = codingAgent.AuthStorage;
			const store = AuthStorage?.create?.();
			if (store && typeof store.getApiKey === "function") {
				const key = await store.getApiKey(providerId, { includeFallback: false });
				if (typeof key === "string" && key.length > 0) return key;
			}
		} catch {
			// Try the legacy sync helper below.
		}
		try {
			if (typeof codingAgent.readStoredCredential === "function") {
				const cred = codingAgent.readStoredCredential(providerId);
				if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key) {
					return cred.key;
				}
			}
		} catch {
			// No compatible stored API key resolver.
		}
	} catch {
		// Module unavailable (unit tests without the mock, minimal hosts).
	}
	return undefined;
}

export interface LlmSearchRun {
	label: string;
	streamFn: StreamFn;
	model: any;
	query: string;
	numResults: number;
	signal?: AbortSignal;
	/** Total timeout for the complete search, including its conversion turn. Default: 120s. */
	timeoutMs?: number;
	apiKey?: string;
	extraOptions?: Record<string, any>;
	/** Grounding-only first turn for APIs that cannot mix native search with function calls. */
	groundingPrompt?: string;
	/** Appended as a final user message on turn 2 (APIs that reject histories ending on a model turn). */
	closingNudge?: string;
	injectSearch: (payload: unknown) => unknown;
	/** Optional payload conversion hook for the structured-result turn. */
	injectSecond?: (payload: unknown) => unknown;
	notSubmittedError: string;
	emptyResultsError: string;
	cancelledError: string;
}

/**
 * Two-step LLM search: (1) grounded retrieval with native search injected,
 * expecting one `submit_search_results` call; (2) if the model answered in
 * prose instead, a follow-up turn without search converts its own evidence
 * into the structured call. Throws when neither yields valid results, so
 * hub dispatch falls back to the next backend.
 */
export async function runLlmSearch(run: LlmSearchRun): Promise<{ results: SearchResult[] }> {
	const timeoutMs = run.timeoutMs ?? 120_000;
	const requestSignal = timeoutSignal(run.signal, timeoutMs);
	const baseOptions = {
		...(run.extraOptions ?? {}),
		...(run.apiKey ? { apiKey: run.apiKey } : {}),
		signal: requestSignal,
	};
	const checkAbort = () => {
		if (!requestSignal?.aborted) return;
		throw new Error(run.signal?.aborted
			? run.cancelledError
			: `${run.label} search timed out after ${timeoutMs}ms`);
	};
	const streamTurn = async (context: any, onPayload?: (payload: unknown) => unknown) => {
		checkAbort();
		try {
			const message = await run.streamFn(run.model, context, {
				...baseOptions,
				...(onPayload ? { onPayload } : {}),
			}).result();
			checkAbort();
			throwIfFailed(message, run);
			return message;
		} catch (error) {
			checkAbort();
			throw error;
		}
	};
	const baseMessages = [{ role: "user", content: run.query, timestamp: Date.now() }];

	const systemPrompt = run.groundingPrompt || buildLlmSearchSystemPrompt(run.numResults);
	const searchTools = run.groundingPrompt ? [] : [SUBMIT_SEARCH_RESULTS_TOOL];
	const first = await streamTurn(
		{
			// Support both classic contexts and transcript-based Pi hosts.
			systemPrompt,
			messages: withSystemMessage(baseMessages, systemPrompt, searchTools),
			tools: searchTools,
		},
		run.injectSearch,
	);
	const direct = extractSubmitResults(first, run.numResults);
	if (direct) return { results: direct };

	const evidence = extractAssistantText(first);
	if (!evidence) {
		throw new Error(run.notSubmittedError);
	}
	const convertPrompt =
		"Convert the research in this conversation into exactly one submit_search_results call. " +
		buildLlmSearchSystemPrompt(run.numResults);
	const turn2Messages: any[] = [
		...baseMessages,
		{
			role: "assistant",
			content: [{ type: "text", text: evidence }],
			timestamp: Date.now(),
		},
	];
	if (run.closingNudge) {
		turn2Messages.push({ role: "user", content: run.closingNudge, timestamp: Date.now() });
	}
	const second = await streamTurn(
		{
			systemPrompt: convertPrompt,
			messages: withSystemMessage(turn2Messages, convertPrompt),
			tools: [SUBMIT_SEARCH_RESULTS_TOOL],
		},
		run.injectSecond,
	);
	const converted = extractSubmitResults(second, run.numResults);
	if (converted) return { results: converted };
	const dbg =
		process.env.PI_SEARCH_DEBUG === "1"
			? ` first=${previewMessage(first)} second=${previewMessage(second)}`
			: "";
	throw new Error(`${run.emptyResultsError}.${dbg}`);
}

function previewMessage(message: any): string {
	try {
		const summary = {
			stopReason: message?.stopReason,
			blocks: (Array.isArray(message?.content) ? message.content : []).map((b: any) => ({
				type: b?.type,
				name: b?.name,
				textLen: typeof b?.text === "string" ? b.text.length : 0,
				argKeys:
					b?.arguments && typeof b.arguments === "object" ? Object.keys(b.arguments) : null,
			})),
		};
		const preview = JSON.stringify(summary);
		return preview.length > 600 ? `${preview.slice(0, 600)}…` : preview;
	} catch {
		return "unavailable";
	}
}


function withSystemMessage(messages: any[], systemPrompt: string, tools = [SUBMIT_SEARCH_RESULTS_TOOL]): any[] {
	return [
		{
			role: "system",
			content: systemPrompt,
			toolsAdded: tools,
			timestamp: Date.now(),
		},
		...messages,
	];
}

function throwIfFailed(message: any, run: LlmSearchRun): void {
	if (message?.stopReason === "error") {
		throw new Error(message?.errorMessage || `${run.label} search failed`);
	}
	if (message?.stopReason === "aborted") {
		throw new Error(run.cancelledError);
	}
}

function extractSubmitResults(message: any, numResults: number): SearchResult[] | undefined {
	const submitCall = message?.content?.find?.(
		(block: { type: string; name?: string }) =>
			block?.type === "toolCall" && block?.name === "submit_search_results",
	);
	if (!submitCall || submitCall.type !== "toolCall") return undefined;
	const results = normalizeSubmitSearchResults(submitCall.arguments, numResults);
	return results.length > 0 ? results : undefined;
}

function extractAssistantText(message: any): string {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	return blocks
		.filter((block: any) => block?.type === "text" && typeof block?.text === "string")
		.map((block: any) => block.text.trim())
		.filter((text: string) => text.length > 0)
		.join("\n\n")
		.slice(0, 8000);
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

export function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}
