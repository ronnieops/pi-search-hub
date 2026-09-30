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

const PROVIDER_CANDIDATES = ["google-antigravity", "google-gemini-cli", "google"];
const DEFAULT_MODEL_ID = "gemini-2.5-flash";
const LOGIN_HINT = "Sign in to the selected Google provider in Pi (Antigravity uses /ag login).";

// Cloud Code Assist needs an OpenAPI `parameters` declaration, not the
// `parametersJsonSchema` form emitted by some host tool converters.
// Keep this minimal wire schema in sync with SUBMIT_SEARCH_RESULTS_TOOL.
const SUBMIT_DECLARATION = {
	name: "submit_search_results",
	description: "Submit structured search results based on the available source evidence.",
	parameters: {
		type: "object",
		properties: {
			results: {
				type: "array",
				items: {
					type: "object",
					properties: {
						title: { type: "string" },
						url: { type: "string" },
						snippet: { type: "string" },
					},
					required: ["title", "url", "snippet"],
				},
			},
		},
		required: ["results"],
	},
};

/** Gemini grounding via Pi's provider runtime — Pi owns transport and OAuth refresh. */
export async function searchGemini(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	backendConfig?: BackendConfig,
	hostContext?: unknown,
): Promise<{ results: SearchResult[] }> {
	if (signal?.aborted) throw new Error("Gemini search cancelled");

	const modelId = backendConfig?.model?.trim() || DEFAULT_MODEL_ID;
	const providerOverride = backendConfig?.provider?.trim();
	const providers = providerOverride ? [providerOverride] : PROVIDER_CANDIDATES;
	let streamFn: StreamFn | undefined;
	let model: any;
	let apiKey: string | undefined;

	for (const provider of providers) {
		const host = resolveHostModel(hostContext, provider, modelId);
		if (!host) continue;
		model = host.model;
		streamFn = host.stream;
		break;
	}

	if (!model) {
		// Compatibility path for classic Pi hosts. Select the stream matching
		// the model API, never send Cloud Code Assist OAuth to the public API.
		const piAi = await loadPiAi();
		const getModel = pickGetModel(piAi);
		let foundWithoutCredentials = false;
		for (const provider of providers) {
			const resolved = getModel?.(provider, modelId);
			if (!resolved) continue;
			const names = resolved.api === "google-gemini-cli"
				? ["streamGoogleGeminiCli", "streamSimpleGoogleGeminiCli"]
				: resolved.api === "google-generative-ai"
					? ["streamGoogle", "streamGoogleGenerativeAI", "streamSimpleGoogle"]
					: [];
			const piStream = pickFn(piAi, names);
			if (!piStream) throw missingStreamError("Gemini", piAi);
			const key = await resolveProviderApiKey(provider);
			if (!key) {
				foundWithoutCredentials = true;
				continue;
			}
			model = resolved;
			streamFn = piStream;
			apiKey = key;
			break;
		}
		if (!model && foundWithoutCredentials) {
			throw new Error(`Gemini credentials unavailable. ${LOGIN_HINT} Pi-managed OAuth requires a host with ModelRegistry streaming.`);
		}
	}
	if (!model || !streamFn) {
		throw new Error(`Gemini model not found (tried ${providers.map(p => `${p}/${modelId}`).join(", ")}). Set gemini.provider and gemini.model in search.json. ${LOGIN_HINT}`);
	}
	if (model.api !== "google-gemini-cli" && model.api !== "google-generative-ai") {
		throw new Error(`Gemini search requires a Google API model, received ${model.api}. Set gemini.provider in search.json.`);
	}

	return runLlmSearch({
		label: "Gemini",
		streamFn,
		model,
		query,
		numResults,
		signal,
		timeoutMs: backendConfig?.timeout,
		...(apiKey ? { apiKey } : {}),
		groundingPrompt: `Research the user's query with Google Search. Prefer primary sources. ` +
			`Summarize at most ${numResults} sources with each full http/https URL and concrete source-grounded facts. ` +
			`Do not invent URLs or unsupported details. Return the evidence as text for conversion in a separate turn.`,
		injectSearch: injectGeminiSearchPayload,
		injectSecond: injectGeminiSubmitPayload,
		closingNudge: "Convert the above research into exactly one submit_search_results call now.",
		notSubmittedError: "Gemini search did not submit structured results",
		emptyResultsError: "Gemini search returned no valid URL results",
		cancelledError: "Gemini search cancelled",
	});
}

export function injectGeminiSubmitPayload(payload: unknown): unknown {
	const body = isRecord(payload) ? payload : {};
	if (isRecord(body.request)) {
		body.request = { ...body.request, tools: [{ functionDeclarations: [SUBMIT_DECLARATION] }] };
	}
	// The native Google SDK already has function declarations from the transcript.
	return body;
}

export function injectGeminiSearchPayload(payload: unknown): unknown {
	const body = isRecord(payload) ? payload : {};
	if (isRecord(body.request)) {
		// Built-in search cannot be combined with functions on Cloud Code Assist.
		body.request = { ...body.request, tools: [{ google_search: {} }] };
		delete body.request.toolConfig;
	} else {
		// The public Google SDK uses camelCase, not the CLI wire format.
		body.config = { ...(isRecord(body.config) ? body.config : {}), tools: [{ googleSearch: {} }] };
		delete body.config.toolConfig;
	}
	return body;
}
