/**
 * Backend registry and dispatcher for pi-search-hub extension.
 */

import type { BackendRunner, BackendConfig, SearchResult } from "../types.js";
import { MISSING_KEY_HELP, waitForCooldown, markCooldown, searchCache, cacheKey } from "../utils.js";
import { resolveBackendKey } from "../credentials.js";
import { config } from "../config.js";
import { recordBackendSuccess, recordBackendFailure } from "../scoring.js";

import { searchDuckDuckGo } from "./duckduckgo.js";
import { searchMarginalia } from "./marginalia.js";
import { searchSerper } from "./serper.js";
import { searchTavily } from "./tavily.js";
import { searchExa } from "./exa.js";
import { searchExaMCP } from "./exa-mcp.js";
import { searchOpenAICodex } from "./openai-codex.js";
import { searchBrave } from "./brave.js";
import { searchLangSearch } from "./langsearch.js";
import { searchFirecrawl } from "./firecrawl.js";
import { searchWebSearchAPI } from "./websearchapi.js";
import { searchPerplexity } from "./perplexity.js";
import { searchSearXNG } from "./searxng.js";
import { searchJina } from "./jina.js";
import { searchBraveLLM } from "./brave-llm.js";
import { searchLinkup } from "./linkup.js";
import { searchYoucom } from "./youcom.js";
import { searchFastcrw } from "./fastcrw.js";
import { searchSofya } from "./sofya.js";

// ---------------------------------------------------------------------------
// Backend Registry
// ---------------------------------------------------------------------------

export const BACKEND_DEFS: Record<string, BackendRunner> = {
	duckduckgo: {
		needsKey: false,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "DuckDuckGo",
		setupLabel: null,
		search: async (query, numResults, { signal }) => {
			const bc = (config.backends as Record<string, BackendConfig> | undefined)?.duckduckgo;
			const ddg = await searchDuckDuckGo(query, numResults, signal, {
				backend: bc?.ddgsBackend,
				region: bc?.ddgsRegion,
				timelimit: bc?.ddgsTimelimit,
			});
			return { results: ddg.results };
		},
	},
	jina: {
		needsKey: false,
		needsKeyFromConfig: false,
		optionalKey: true,
		needsInstanceUrl: false,
		label: "Jina AI",
		setupLabel: "Jina AI (free tier, optional key for higher rate limits)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchJina(query, numResults, key, signal);
			return { results: result.results };
		},
	},
	marginalia: {
		needsKey: false,
		needsKeyFromConfig: false,
		optionalKey: true,
		needsInstanceUrl: false,
		label: "Marginalia",
		setupLabel: "Marginalia (free, public key optional)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchMarginalia(query, numResults, key, signal);
			return { results: result.results };
		},
	},
	serper: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "Serper",
		setupLabel: "Serper (Google, 2500 free/mo)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchSerper(query, numResults, key!, signal);
			return { results: result.results };
		},
	},
	tavily: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "Tavily",
		setupLabel: "Tavily (AI search, 1000 free/mo)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchTavily(query, numResults, key!, signal);
			return { results: result.results };
		},
	},
	exa: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "Exa",
		setupLabel: "Exa (AI-native, 1000 free/mo)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchExa(query, numResults, key!, signal);
			return { results: result.results, warning: result.warning };
		},
	},
	exa_mcp: {
		needsKey: false,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "Exa MCP",
		setupLabel: "Exa MCP (zero-config, no API key needed)",
		search: async (query, numResults, { signal }) => {
			const result = await searchExaMCP(query, numResults, signal);
			return { results: result.results };
		},
	},
	"openai-codex": {
		needsKey: false,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "OpenAI Codex",
		setupLabel: "OpenAI Codex (draws from subscription)",
		search: async (query, numResults, { signal, backendConfig }) => {
			const result = await searchOpenAICodex(query, numResults, signal, backendConfig);
			return { results: result.results };
		},
	},
	brave: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "Brave",
		setupLabel: "Brave (2000 free/mo)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchBrave(query, numResults, key!, signal);
			return { results: result.results };
		},
	},
	langsearch: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "LangSearch",
		setupLabel: "LangSearch (free, no CC)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchLangSearch(query, numResults, key!, signal);
			return { results: result.results };
		},
	},
	firecrawl: {
		needsKey: false,
		needsKeyFromConfig: false,
		optionalKey: true,
		needsInstanceUrl: false,
		label: "Firecrawl",
		setupLabel: "Firecrawl (keyless: 1000 free credits/mo, optional key for more)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchFirecrawl(query, numResults, key, signal);
			return { results: result.results };
		},
	},
	websearchapi: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "WebSearchAPI",
		setupLabel: "WebSearchAPI (2000 free credits)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchWebSearchAPI(query, numResults, key!, signal);
			return { results: result.results };
		},
	},
	perplexity: {
		needsKey: true,
		needsKeyFromConfig: true,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "Perplexity",
		setupLabel: "Perplexity Sonar (unlimited free)",
		search: async (query, numResults, { key, signal }) => {
			const model = (config.backends?.perplexity as BackendConfig | undefined)?.model;
			const result = await searchPerplexity(query, numResults, key!, signal, model);
			return { results: result.results };
		},
	},
	searxng: {
		needsKey: false,
		needsKeyFromConfig: false,
		optionalKey: true,
		needsInstanceUrl: true,
		label: "SearXNG",
		setupLabel: "SearXNG (self-hosted metasearch)",
		search: async (query, numResults, { key, instanceUrl, signal }) => {
			const result = await searchSearXNG(query, numResults, key, instanceUrl, signal);
			return { results: result.results };
		},
	},
	"brave-llm": {
		needsKey: true,
		needsKeyFromConfig: true,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "Brave LLM",
		setupLabel: "Brave LLM Context (same key as Brave, pre-extracted AI chunks)",
		search: async (query, numResults, { key, signal }) => {
			const bc = (config.backends as Record<string, BackendConfig> | undefined)?.["brave-llm"];
			const result = await searchBraveLLM(query, numResults, key!, signal, bc?.tokenBudget);
			return { results: result.results };
		},
	},
	linkup: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "Linkup",
		setupLabel: "Linkup (EU/GDPR, AI-native, $20 free credit)",
		search: async (query, numResults, { key, signal }) => {
			const bc = (config.backends as Record<string, BackendConfig> | undefined)?.linkup;
			const result = await searchLinkup(query, numResults, key!, signal, bc?.depth);
			return { results: result.results };
		},
	},
	youcom: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "You.com",
		setupLabel: "You.com ($100 free credits, web+news)",
		search: async (query, numResults, { key, signal }) => {
			const result = await searchYoucom(query, numResults, key!, signal);
			return { results: result.results };
		},
	},
	fastcrw: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "fastCRW",
		setupLabel: "fastCRW (500 free/mo, self-hostable)",
		search: async (query, numResults, { key, signal }) => {
			const bc = (config.backends as Record<string, BackendConfig> | undefined)?.fastcrw;
			const result = await searchFastcrw(query, numResults, key!, signal, bc?.baseUrl);
			return { results: result.results };
		},
	},
	sofya: {
		needsKey: true,
		needsKeyFromConfig: false,
		optionalKey: false,
		needsInstanceUrl: false,
		label: "Sofya",
		setupLabel: "Sofya (search + fetch, full page content)",
		search: async (query, numResults, { key, signal, backendConfig }) => {
			const result = await searchSofya(query, numResults, key!, signal, {
				searchDepth: backendConfig?.searchDepth,
				topic: backendConfig?.topic,
			});
			return { results: result.results };
		},
	},
};

// ---------------------------------------------------------------------------
// Backend dispatcher
// ---------------------------------------------------------------------------

export async function runBackend(
	backend: string,
	query: string,
	numResults: number,
	signal?: AbortSignal,
	options?: { skipCache?: boolean },
): Promise<SearchResult[]> {
	// Check cache first (inline — no persistent key var needed here)
	if (!options?.skipCache) {
		const cached = searchCache.get(cacheKey(query, backend, numResults));
		if (cached) return cached;
	}

	await waitForCooldown(backend);
	const def = BACKEND_DEFS[backend];
	if (!def) throw new Error(`Unknown backend: ${backend}`);

	let key: string | undefined;
	if (def.needsKeyFromConfig) {
		const bc = (config.backends as Record<string, BackendConfig> | undefined)?.[backend];
		key = bc?.apiKey;
	} else if (def.needsKey) {
		key = resolveBackendKey(backend, config);
		if (!key) {
			const label = def.label;
			throw new Error(`${label} backend not configured. ${MISSING_KEY_HELP}`);
		}
	} else if (def.optionalKey) {
		// Optionally resolve key — don't throw if missing
		key = resolveBackendKey(backend, config);
	}

	let instanceUrl: string | undefined;
	if (def.needsInstanceUrl) {
		const bc = (config.backends as Record<string, BackendConfig> | undefined)?.[backend];
		instanceUrl = bc?.instanceUrl;
		if (!instanceUrl) {
			throw new Error(`SearXNG instance URL not configured. Set searxng.instanceUrl in search.json`);
		}
	}

	const bc = (config.backends as Record<string, BackendConfig> | undefined)?.[backend];
	const startTime = Date.now();
	try {
		const result = await def.search(query, numResults, { key, instanceUrl, signal, backendConfig: bc });
		const latencyMs = Date.now() - startTime;
		// Cache the result
		searchCache.set(cacheKey(query, backend, numResults), result.results);
		recordBackendSuccess(backend, latencyMs, result.results.length, numResults);
		return result.results;
	} catch (err) {
		recordBackendFailure(backend);
		throw err;
	} finally {
		markCooldown(backend);
	}
}
