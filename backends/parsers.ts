/**
 * Pure response parsers for search backends.
 * Each takes raw JSON data and returns normalized results.
 * No HTTP, no side effects — easy to unit test.
 */

export interface ParsedResult {
	title: string;
	url: string;
	snippet: string;
}

// ---------------------------------------------------------------------------
// Marginalia Search
// Response: { results: [{ title, url, description }] }
// ---------------------------------------------------------------------------

export function parseMarginalia(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const results = (data.results || []) as Array<Record<string, unknown>>;
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.description as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// WebSearchAPI.ai
// Response: { organic: [{ title, url, description }] }
// ---------------------------------------------------------------------------

export function parseWebSearchAPI(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawResults = data.organic;
	const organic = Array.isArray(rawResults) ? rawResults : [];
	return organic.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.description as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// Serper.dev (Google)
// Response: { organic: [{ title, link, snippet }] }
// ---------------------------------------------------------------------------

export function parseSerper(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawResults = data.organic;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.link as string) || "",
		snippet: (r.snippet as string) || "",
	}));
}

// ---------------------------------------------------------------------------
// Tavily
// Response: { results: [{ title, url, content }] }
// ---------------------------------------------------------------------------

export interface TavilyParsedResult extends ParsedResult {
	content?: string;
}

export function parseTavily(
	data: Record<string, unknown>,
	numResults: number,
): TavilyParsedResult[] {
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: (r.content as string) || "",
		content: r.content as string,
	}));
}

// ---------------------------------------------------------------------------
// Exa
// Response: { results: [{ title, url, text, highlight }] }
// ---------------------------------------------------------------------------

export function parseExa(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.text as string) || (r.highlight as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// Brave Search
// Response: { web: { results: [{ title, url, description }] } }
// ---------------------------------------------------------------------------

export function parseBrave(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const web = data.web;
	if (!web || typeof web !== "object") {
		return [];
	}
	const rawResults = (web as Record<string, unknown>).results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.description as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// LangSearch
// Response: { data: { webPages: { value: [{ name, url, snippet, description }] } } }
// ---------------------------------------------------------------------------

export function parseLangSearch(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const pages = (data.data as Record<string, unknown>)?.webPages as Record<string, unknown> | undefined;
	const results = (pages?.value || data.results || data.data || []) as Array<Record<string, unknown>>;
	return results.slice(0, numResults).map((r) => ({
		title: (r.name as string) || (r.title as string) || "",
		url: (r.url as string) || (r.link as string) || "",
		snippet: ((r.snippet as string) || (r.description as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// Firecrawl v2
// Response: { data: { web: [...] } or data: [...] or { results: [...] } (v1 fallback)
// ---------------------------------------------------------------------------

export function parseFirecrawl(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawData = data.data;
	let results: Array<Record<string, unknown>> = [];
	if (Array.isArray(rawData)) {
		results = rawData;
	} else if (typeof rawData === "object" && rawData !== null) {
		const obj = rawData as Record<string, unknown>;
		results = Array.isArray(obj.web) ? obj.web : [];
		if (results.length === 0) {
			if (Array.isArray(obj.images)) results = obj.images as Array<Record<string, unknown>>;
			else if (Array.isArray(obj.news)) results = obj.news as Array<Record<string, unknown>>;
		}
	} else if (Array.isArray(data.results)) {
		results = data.results;
	}
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.description as string) || (r.snippet as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// Perplexity Sonar
// Response: { citations: string[], choices: [{ message: { content } }] }
// ---------------------------------------------------------------------------

export function parsePerplexity(
	data: Record<string, unknown>,
	query: string,
	numResults: number,
): ParsedResult[] {
	const citations = (data.citations as string[]) || [];
	const message = (data.choices as Array<Record<string, unknown>>)?.[0]?.message as Record<string, unknown> | undefined;
	const answerText = (message?.content as string) || "";

	const results: ParsedResult[] = [];

	if (answerText) {
		results.push({
			title: `Answer: ${query}`,
			url: citations[0] || "",
			snippet: answerText.slice(0, 500),
		});
	}

	for (const url of citations) {
		try {
			const u = new URL(url);
			const title = u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname.slice(0, 60) : "");
			results.push({ title: title || url, url, snippet: "" });
		} catch {
			results.push({ title: url, url, snippet: "" });
		}
	}

	return results.slice(0, numResults);
}

// ---------------------------------------------------------------------------
// SearXNG
// Response: { results: [{ title, url, content, snippet }] }
// ---------------------------------------------------------------------------

export function parseSearXNG(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawResults = data.results as Array<Record<string, unknown>> | undefined;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.content as string) || (r.snippet as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// Brave LLM Context
// Response: { chunks: [{ content, relevance_score, source: { url, title }, type }] }
// ---------------------------------------------------------------------------

export function parseBraveLLM(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawChunks = data.chunks;
	const chunks = Array.isArray(rawChunks) ? rawChunks : [];
	return chunks.slice(0, numResults).map((c) => {
		const source = (c.source as Record<string, unknown>) || {};
		return {
			title: (source.title as string) || "",
			url: (source.url as string) || "",
			snippet: ((c.content as string) || "").slice(0, 500),
		};
	});
}

// ---------------------------------------------------------------------------
// Linkup
// Response: { searchResults: [{ url, title, content }] } or nested
// ---------------------------------------------------------------------------

export function parseLinkup(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawResults = data.searchResults || data.results || data.data;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.content as string) || (r.snippet as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// You.com
// Response: { hits: [{ url, title, description, snippets }] }
// ---------------------------------------------------------------------------

export function parseYoucom(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawHits = data.hits || data.results;
	const hits = Array.isArray(rawHits) ? rawHits : [];
	return hits.slice(0, numResults).map((r) => {
		const snippets = Array.isArray(r.snippets) ? (r.snippets as string[]).join(" ") : "";
		return {
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: ((r.description as string) || snippets || "").slice(0, 500),
		};
	});
}

// ---------------------------------------------------------------------------
// fastCRW (Firecrawl-compatible)
// Response: { success: true, data: [{ url, title, description }] }
// ---------------------------------------------------------------------------

export function parseFastcrw(
	data: Record<string, unknown>,
	numResults: number,
): ParsedResult[] {
	const rawData = data.data;
	const results = Array.isArray(rawData) ? rawData : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		snippet: ((r.description as string) || (r.snippet as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// Jina AI (s.jina.ai)
// Response: { data: [{ title, url, content, description }] }
// ---------------------------------------------------------------------------

export interface JinaParsedResult extends ParsedResult {
	content: string;
}

export function parseJina(
	data: Record<string, unknown>,
	numResults: number,
): JinaParsedResult[] {
	const rawData = data.data as Array<Record<string, unknown>> | undefined;
	const results = Array.isArray(rawData) ? rawData : [];
	return results.slice(0, numResults).map((r) => ({
		title: (r.title as string) || "",
		url: (r.url as string) || "",
		content: ((r.content as string) || (r.description as string) || "").slice(0, 2000),
		snippet: ((r.content as string) || (r.description as string) || "").slice(0, 500),
	}));
}

// ---------------------------------------------------------------------------
// Sofya (sofya.co)
// Response: { results: [{ title, url, content, description, published_date }] }
// `content` is full extracted page text (basic depth); `description` is the SERP snippet.
// ---------------------------------------------------------------------------

export interface SofyaParsedResult extends ParsedResult {
	content: string;
}

export function parseSofya(
	data: Record<string, unknown>,
	numResults: number,
): SofyaParsedResult[] {
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return results.slice(0, numResults).map((r) => {
		const content = (r.content as string) || (r.description as string) || "";
		return {
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: ((r.description as string) || content).slice(0, 500),
			content: content.slice(0, 2000),
		};
	});
}
