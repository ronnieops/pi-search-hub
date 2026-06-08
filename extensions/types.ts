/**
 * Shared types for pi-search-hub extension.
 */

export interface BackendConfig {
	enabled?: boolean;
	apiKey?: string;
	/** Per-backend timeout override in milliseconds. Default: 30000 */
	timeout?: number;
	/** Per-backend max results override. Default: 10 */
	maxResults?: number;
	/** Per-backend extra headers */
	headers?: Record<string, string>;
	/** SearXNG-specific: base URL of the self-hosted instance (e.g. http://localhost:8888) */
	instanceUrl?: string;
	/** Perplexity-specific: model variant (sonar, sonar-pro, sonar-deep-research, sonar-reasoning). Default: sonar */
	model?: string;
	/** DuckDuckGo-specific: ddgs backend(s) — "auto", "duckduckgo", "bing", "brave", "google", comma-delimited */
	ddgsBackend?: string;
	/** DuckDuckGo-specific: region (e.g. "us-en"). Default: "us-en" */
	ddgsRegion?: string;
	/** DuckDuckGo-specific: timelimit — "d" (day), "w" (week), "m" (month), "y" (year) */
	ddgsTimelimit?: string;
	/** Brave LLM Context-specific: token budget for response chunks */
	tokenBudget?: number;
	/** Linkup-specific: search depth — "standard" (fast) or "deep" (comprehensive). Default: standard */
	depth?: "standard" | "deep";
	/** fastCRW-specific: base URL override (for self-hosted). Default: https://api.fastcrw.com */
	baseUrl?: string;
	/** Sofya-specific: search depth. "snippets" (1cr, SERP only) or "basic" (3cr, full page content). Default: basic */
	searchDepth?: "snippets" | "basic";
	/** Sofya-specific: topic. "general" or "news". Default: general */
	topic?: "general" | "news";
}

export interface SearchConfig {
	defaultBackend?: string;
	combine?: boolean;
	selectionStrategy?: "sequential" | "random" | "round-robin" | "best-latency";
	/** Reader backend for web_read. "jina" (default, free) or "sofya" (250+ site parsers, needs key). */
	reader?: "jina" | "sofya";
	/** Cache TTL in milliseconds. Default: 300000 (5 min). Set to 0 to disable. */
	cacheTtl?: number;
	/** Max cached queries. Default: 100. */
	cacheMax?: number;
	backends?: {
		duckduckgo?: BackendConfig;
		marginalia?: BackendConfig;

		serper?: BackendConfig;
		tavily?: BackendConfig;
		exa?: BackendConfig;
		brave?: BackendConfig;
		braveLLM?: BackendConfig;
		langsearch?: BackendConfig;
		firecrawl?: BackendConfig;
		websearchapi?: BackendConfig;
		perplexity?: BackendConfig;
		searxng?: BackendConfig;
		linkup?: BackendConfig;
		youcom?: BackendConfig;
		fastcrw?: BackendConfig;
		sofya?: BackendConfig;
	};
}

export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
	content?: string;
}

export interface SearchResultWithBackend extends SearchResult {
	backend?: string;
}

export interface BackendRunner {
	needsKey: boolean;
	needsKeyFromConfig: boolean;
	optionalKey: boolean;
	needsInstanceUrl: boolean;
	label: string;
	setupLabel: string | null;
	search: (
		query: string,
		numResults: number,
		deps: { key?: string; instanceUrl?: string; signal?: AbortSignal; backendConfig?: BackendConfig },
	) => Promise<{ results: SearchResult[] }>;
}
