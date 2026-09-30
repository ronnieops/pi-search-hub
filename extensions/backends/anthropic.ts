import type { BackendConfig, SearchResult } from "../types.js";
import type { StreamFn } from "../shared-llm-results.js";
import {
	isRecord,
	loadPiAi,
	missingStreamError,
	pickFn,
	pickGetModel,
	resolveHostModel,
	resolveProviderApiKey,
	runLlmSearch,
} from "../shared-llm-results.js";

const PROVIDER_ID = "anthropic";
const DEFAULT_MODEL_ID = "claude-haiku-4-5";
const ANTHROPIC_SEARCH_TOOL_TYPE = "web_search_20250305";
const MAX_USES = 5;
const LOGIN_HINT = "Run /login and select Anthropic.";

/**
 * Anthropic backend — mirrors `openai-codex.ts`, but drives a Claude model
 * with Anthropic's server-side `web_search` tool injected at the payload
 * layer, then collects one structured `submit_search_results` call.
 *
 * Auth is Pi-managed (no apiKey in search.json). Uses `backendConfig.model`
 * when set. When the host cannot resolve auth or streams, it throws a
 * descriptive error so dispatch falls back to the next backend.
 */
export async function searchAnthropic(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	backendConfig?: BackendConfig,
	hostContext?: unknown,
): Promise<{ results: SearchResult[] }> {
	if (signal?.aborted) {
		throw new Error("Anthropic search cancelled");
	}

	const modelId = backendConfig?.model?.trim() || DEFAULT_MODEL_ID;
	const host = resolveHostModel(hostContext, PROVIDER_ID, modelId);
	let streamFn: StreamFn;
	let model: any;
	let apiKey: string | undefined;
	if (host) {
		model = host.model;
		streamFn = host.stream;
	} else {
		const piAi = await loadPiAi();
		const piStream = pickFn(piAi, [
			"streamAnthropic",
			"streamSimpleAnthropic",
			"streamAnthropicMessages",
		]);
		const getModel = pickGetModel(piAi);
		if (!getModel || !piStream) {
			throw missingStreamError("Anthropic", piAi);
		}
		apiKey = await resolveProviderApiKey(PROVIDER_ID);
		model = getModel(PROVIDER_ID, modelId);
		if (!model) {
			throw new Error(
				`Anthropic model not found: ${modelId}. Set "model" for the anthropic backend in search.json (e.g. claude-haiku-4-5). ${LOGIN_HINT}`,
			);
		}
		if (!apiKey) {
			throw new Error(`Anthropic credentials unavailable. ${LOGIN_HINT} Pi-managed OAuth requires a host with ModelRegistry streaming.`);
		}
		streamFn = piStream;
	}

	return runLlmSearch({
		label: "Anthropic",
		streamFn,
		model,
		query,
		numResults,
		signal,
		timeoutMs: backendConfig?.timeout,
		...(apiKey ? { apiKey } : {}),
		injectSearch: injectAnthropicSearchPayload,
		notSubmittedError: "Anthropic search did not submit structured results",
		emptyResultsError: "Anthropic search returned no valid URL results",
		cancelledError: "Anthropic search cancelled",
	});
}

export function injectAnthropicSearchPayload(payload: unknown): unknown {
	const body = isRecord(payload) ? payload : {};
	const existingTools = Array.isArray(body.tools) ? body.tools.filter(Boolean) : [];
	const filteredTools = existingTools.filter((tool) => {
		if (!isRecord(tool)) return true;
		return tool.type !== ANTHROPIC_SEARCH_TOOL_TYPE && tool.name !== "web_search";
	});

	body.tools = [
		{
			type: ANTHROPIC_SEARCH_TOOL_TYPE,
			name: "web_search",
			max_uses: MAX_USES,
		},
		...filteredTools,
	];

	return body;
}
