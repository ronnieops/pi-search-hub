---
date: 2026-06-25T08:02:58-0400
author: Red Team
commit: a669864
branch: main
repository: pi-search-hub
topic: "Add Firecrawl Scrape, Exa Content API, Exa MCP web_fetch as web_read readers"
status: ready
tags: [design, web-read, firecrawl, exa, mcp, content-extraction]
last_updated: 2026-06-25T08:02:58-0400
last_updated_by: Red Team
---

# Design: Add Firecrawl Scrape, Exa Content API, Exa MCP web_fetch as web_read readers

## Summary

Add 3 new `web_read` reader backends (Firecrawl Scrape, Exa Content API, Exa MCP web_fetch) to provide alternatives when Jina Reader is unavailable. Each reader follows the established `fetchSofya()` pattern: a standalone async function in the existing backend file, wired into the reader dispatch via an `else if` branch. The reader type union and `StringEnum` parameter are extended to include all 3 new values. Exa usage tracking is shared between search and content reads. No new files or dependencies.

## Requirements

- Add Firecrawl's `/v2/scrape` endpoint as a `web_read` reader option (`reader: "firecrawl"`)
- Add Exa's `/contents` endpoint as a `web_read` reader option (`reader: "exa"`)
- Add Exa MCP's `web_fetch_exa` tool as a `web_read` reader option (`reader: "exa_mcp"`)
- Each must follow the existing reader dispatch pattern (Jina/Sofya branches in `search-hub.ts:340-370`)
- Each must return `{ title, url, content }` matching the existing `fetchSofya` contract
- No new npm dependencies — all backends use raw `fetch()`
- Must support keyless mode where available (Firecrawl Scrape, Exa MCP web_fetch)
- Must reuse existing credential resolution (`resolveBackendKey`, `FALLBACK_ENV_MAP`)
- Must not break existing Jina/Sofya readers
- SSRF guard already applied upstream in `web_read` handler — no redundant guard needed

## Current State Analysis

### Existing Implementation

- `extensions/search-hub.ts:340-370` — `web_read` execute handler branches on `reader === "sofya"` vs Jina default
- `extensions/search-hub.ts:230` — `reader` parameter typed as `StringEnum(["jina", "sofya"])`
- `extensions/types.ts:30` — `SearchConfig.reader` typed as `"jina" | "sofya"`
- `extensions/backends/sofya.ts:51-90` — `fetchSofya()` is the canonical fetch function template
- `extensions/backends/firecrawl.ts:11-38` — `searchFirecrawl()` shows Firecrawl API pattern (keyless mode)
- `extensions/backends/exa.ts:8-55` — `searchExa()` shows Exa API pattern (`x-api-key` auth, usage tracking)
- `extensions/backends/exa-mcp.ts:44-120` — `callMCP()` helper handles JSON-RPC 2.0 framing for Exa MCP
- `extensions/backends/exa-mcp.ts:126-137` — `searchExaMCP()` calls `web_search_exa` tool

### Key Discoveries

- **Reader dispatch is a simple `if/else` chain** at `search-hub.ts:346-353` — adding `else if` branches is the established pattern
- **`fetchSofya()` at `sofya.ts:51-90`** is the exact template: `(url, apiKey, signal) => Promise<{title, url, content}>`
- **Firecrawl keyless auth** at `firecrawl.ts:20-24` — `apiKey` is optional, `Authorization` header only added when key provided
- **Exa `x-api-key` auth** at `exa.ts:22` — uses `"x-api-key"` header, not `Authorization: Bearer`
- **Exa usage tracking** at `utils.ts:120-175` — `checkExaUsage()` before request, `incrementExaUsage()` after success
- **`callMCP()` at `exa-mcp.ts:44-120`** — reusable JSON-RPC 2.0 helper, no auth needed
- **`searchExaMCP()` at `exa-mcp.ts:126-137`** — calls `callMCP("tools/call", { name: "web_search_exa", ... })`
- **`configureGlobalSettings` at `search-hub.ts:440`** — reader selector offers `["jina (free)", "sofya (needs key)", "Cancel"]`
- **`resolveBackendKey()` at `credentials.ts:82`** — checks config key first, then `FALLBACK_ENV_MAP` env var
- **`FALLBACK_ENV_MAP` at `credentials.ts:66`** — already has `firecrawl: "SEARCH_FIRECRAWL_API_KEY"` and `exa: "SEARCH_EXA_API_KEY"`
- **SSRF guard at `search-hub.ts:340`** — `validateUrl(url)` called before reader dispatch, shared across all readers
- **Content truncation at `search-hub.ts:400`** — content capped at 10,000 chars for LLM context window

### Constraints

- No new npm dependencies — all backends use raw `fetch()`
- No refactoring of existing reader dispatch into a plugin system
- No changes to existing Jina or Sofya readers
- Exa usage tracking must be shared between search and content reads (same 1,000 req/month pool)
- Reader dispatch stays as `if/else if/else` chain (no switch/dispatch map refactor)

## Scope

### Building

- `extensions/types.ts:30` — Extend `SearchConfig.reader` union to `"jina" | "sofya" | "firecrawl" | "exa" | "exa_mcp"`
- `extensions/backends/firecrawl.ts` — Add `fetchFirecrawl()` function (keyless, POST `/v2/scrape`)
- `extensions/backends/exa.ts` — Add `fetchExaContents()` function (needs key, POST `/contents`, shared usage tracking)
- `extensions/backends/exa-mcp.ts` — Add `fetchExaMCP()` function (zero-config, calls `web_fetch_exa` via `callMCP()`)
- `extensions/search-hub.ts:230` — Extend `StringEnum` with 3 new reader values
- `extensions/search-hub.ts:340-370` — Add 3 `else if` branches in reader dispatch
- `extensions/search-hub.ts:440` — Add 3 new reader options to `configureGlobalSettings` UI
- `tests/firecrawl.test.ts` — Add tests for `fetchFirecrawl()`
- `tests/exa-contents.test.ts` — New test file for `fetchExaContents()`
- `tests/exa-mcp-fetch.test.ts` — New test file for `fetchExaMCP()`

### Not Building

- Plugin system for reader dispatch — the `if/else if/else` chain is sufficient for 5 readers
- Unified fetch abstraction — each backend has different API shapes (REST vs MCP, keyless vs keyed)
- Firecrawl quota tracking — 1,000 credit cap is per-account, not per-extension; users who hit it should get an API key
- New npm dependencies — all backends use raw `fetch()`
- Changes to existing Jina or Sofya readers — untouched

## Decisions

### Decision 1: Fetch functions go in existing backend files

**Ambiguity**: Where to place the 3 new fetch functions — add to existing backend files or create new files?

**Explored**:
- Option A (Add to existing files): `fetchFirecrawl()` in `firecrawl.ts`, `fetchExaContents()` in `exa.ts`, `fetchExaMCP()` in `exa-mcp.ts` — follows `fetchSofya()` precedent at `sofya.ts:51-90` which lives alongside `searchSofya()` in the same file
- Option B (Create new files): Separate files per fetch function — more modular but breaks the established pattern

**Decision**: Option A — Add to existing backend files. Confirmed by developer at checkpoint.

### Decision 2: Share Exa usage tracking between search and content reads

**Ambiguity**: Exa Content API shares the 1,000 req/month quota with Exa search. Should usage tracking be shared or separate?

**Explored**:
- Option A (Share): Extend existing `checkExaUsage()`/`incrementExaUsage()` in `utils.ts:120-175` to count both search and content reads from the same pool
- Option B (Separate): Create independent counter for content reads — user sees two separate quotas for the same API

**Decision**: Option A — Share usage tracking. Confirmed by developer at checkpoint.

### Decision 3: Keep reader dispatch as `if/else if/else` chain

**Ambiguity**: Reader dispatch pattern — keep `if/else if/else` chain or refactor to switch/dispatch map?

**Explored**:
- Option A (Keep chain): Add `else if (reader === "firecrawl")` / `else if (reader === "exa")` / `else if (reader === "exa_mcp")` branches — follows existing pattern at `search-hub.ts:340-370`
- Option B (Refactor): Switch statement or dispatch map — cleaner for many readers but breaks from established pattern

**Decision**: Option A — Keep `if/else if/else` chain. Confirmed by developer at checkpoint.

## Architecture

### `extensions/types.ts:30` — MODIFY

Extend `SearchConfig.reader` union type to include the 3 new reader values.

```typescript
/** Reader backend for web_read. "jina" (default, free), "sofya" (250+ site parsers, needs key), "firecrawl" (keyless, 1000 credits/mo), "exa" (needs key, 1000 req/mo), or "exa_mcp" (zero-config, rate-limited). */
reader?: "jina" | "sofya" | "firecrawl" | "exa" | "exa_mcp";
```

### `extensions/backends/firecrawl.ts` — MODIFY

Add `fetchFirecrawl()` function after the existing `searchFirecrawl()` function. Follows `fetchSofya()` pattern at `sofya.ts:51-90`. Keyless mode: `apiKey` is optional, `Authorization` header only added when key provided. POSTs to `https://api.firecrawl.dev/v2/scrape` with `{ url, formats: ["markdown"] }`.

```typescript
/**
 * Fetch a single URL as clean markdown via Firecrawl Scrape API.
 * Keyless mode: omit Authorization header when no key configured.
 * Docs: https://docs.firecrawl.dev/api-reference/endpoint/scrape
 */
export async function fetchFirecrawl(
	url: string,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string }> {
	const body = { url, formats: ["markdown"] };
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}
	const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Firecrawl scrape ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const result = data.data as Record<string, unknown> | undefined;
	if (!result) {
		throw new Error(`Firecrawl scrape returned no data for ${url}`);
	}
	const metadata = result.metadata as Record<string, unknown> | undefined;
	return {
		title: (metadata?.title as string) || "",
		url: (metadata?.sourceURL as string) || url,
		content: (result.markdown as string) || "",
	};
}
```

### `extensions/backends/exa.ts` — MODIFY

Add `fetchExaContents()` function after the existing `searchExa()` function. Uses `x-api-key` header (same auth as `searchExa()`). Calls `checkExaUsage()` before request and `incrementExaUsage()` after success. POSTs to `https://api.exa.ai/contents` with `{ urls: [url], text: true }`.

```typescript
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
	const postWarning = incrementExaUsage();

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
		warning: preWarning || postWarning || undefined,
	};
}
```

### `extensions/backends/exa-mcp.ts` — MODIFY

Add `fetchExaMCP()` function after the existing `searchExaMCP()` function. Reuses the existing `callMCP()` helper. Calls `callMCP("tools/call", { name: "web_fetch_exa", arguments: { url } })`. Zero-config — no API key needed.

```typescript
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
```

### `extensions/search-hub.ts:230,340-370,440` — MODIFY

Three changes:
1. **Line 230**: Extend `StringEnum` to include `"firecrawl"`, `"exa"`, `"exa_mcp"`
2. **Lines 340-370**: Add 3 `else if` branches in reader dispatch, update `readerLabel` mapping, add imports
3. **Line 440**: Add 3 new reader options to `configureGlobalSettings` UI

```typescript
// Change 1 — Imports (add after existing imports)
import { fetchFirecrawl } from "./backends/firecrawl.js";
import { fetchExaContents } from "./backends/exa.js";
import { fetchExaMCP } from "./backends/exa-mcp.js";

// Change 2 — StringEnum (replace existing reader parameter)
			reader: Type.Optional(
				StringEnum(["jina", "sofya", "firecrawl", "exa", "exa_mcp"] as const, {
					description:
						"Reader backend: 'jina' (default, free, supports keywords/mode/objective), " +
						"'sofya' (250+ site-specific parsers, needs API key), " +
						"'firecrawl' (keyless, 1000 credits/mo), " +
						"'exa' (needs API key, 1000 req/mo), or " +
						"'exa_mcp' (zero-config, rate-limited). Overrides the configured default.",
				}),
			),

// Change 2b — readerLabel (replace existing line)
			const readerLabel = reader === "sofya" ? "Sofya" : reader === "firecrawl" ? "Firecrawl" : reader === "exa" ? "Exa" : reader === "exa_mcp" ? "Exa MCP" : "Jina";

// Change 2c — Dispatch branches (add after sofya block)
			} else if (reader === "firecrawl") {
				// Firecrawl Scrape: keyless mode (1000 free credits/mo).
				const firecrawlKey = resolveBackendKey("firecrawl", config);
				const result = await fetchFirecrawl(url, firecrawlKey, signal);
				content = result.content;
			} else if (reader === "exa") {
				// Exa Contents API: needs API key (1000 req/mo, shared with search).
				const exaKey = resolveBackendKey("exa", config);
				if (!exaKey) {
					throw new Error(`Exa reader selected but no API key configured. ${MISSING_KEY_HELP}`);
				}
				const result = await fetchExaContents(url, exaKey, signal);
				content = result.content;
			} else if (reader === "exa_mcp") {
				// Exa MCP web_fetch: zero-config, no API key needed.
				const result = await fetchExaMCP(url, signal);
				content = result.content;

// Change 3 — configureGlobalSettings UI (replace existing reader case)
			case "reader": {
				const choice = await ctx.ui.select(`${label} — current: ${selected.split(": ")[1]}`, [
					"jina (free)", "sofya (needs key)", "firecrawl (keyless)", "exa (needs key)", "exa_mcp (free)", "Cancel"
				]);
				if (choice === "Cancel" || !choice) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				value = choice.startsWith("jina") ? "jina" : choice.startsWith("firecrawl") ? "firecrawl" : choice.startsWith("exa_mcp") ? "exa_mcp" : choice.startsWith("exa") ? "exa" : "sofya";
				break;
			}
```

### `tests/firecrawl.test.ts` — MODIFY

Add test suite for `fetchFirecrawl()` following existing test patterns. Tests: auth header behavior (with/without key), correct endpoint URL, correct request body, success response parsing, error handling, sanitized error messages.

```typescript
describe("fetchFirecrawl", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("sends Authorization: Bearer <key> when a key is provided", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				success: true,
				data: { markdown: "# Hello", metadata: { title: "Test", sourceURL: "https://example.com" } },
			}),
		} as Response);

		const result = await fetchFirecrawl("https://example.com", "fc-key");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer fc-key");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com", formats: ["markdown"] });
		expect(result).toEqual({ title: "Test", url: "https://example.com", content: "# Hello" });
	});

	it("omits Authorization header in keyless mode", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				success: true,
				data: { markdown: "content", metadata: { title: "", sourceURL: "" } },
			}),
		} as Response);

		await fetchFirecrawl("https://example.com");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers["Authorization"]).toBeUndefined();
	});

	it("posts to the Firecrawl v2 scrape endpoint", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				success: true,
				data: { markdown: "", metadata: {} },
			}),
		} as Response);

		await fetchFirecrawl("https://example.com", "key");

		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
	});

	it("throws on non-ok response", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 429,
			text: async () => "Rate limited",
		} as Response);

		const err = await fetchFirecrawl("https://example.com", "key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/Firecrawl scrape/);
	});

	it("throws when data is missing", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ success: true }),
		} as Response);

		const err = await fetchFirecrawl("https://example.com", "key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/no data/);
	});

	it("sanitizes error messages", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => "Unauthorized: Bearer supersecrettoken123",
		} as Response);

		const err = await fetchFirecrawl("https://example.com", "bad-key").catch(e => e);
		expect(String(err.message)).not.toMatch(/supersecrettoken123/);
	});
});
```

### `tests/exa-contents.test.ts` — NEW

New test file for `fetchExaContents()`. Tests: `x-api-key` header, correct endpoint URL, correct request body, success response parsing, error handling, usage tracking integration, sanitized error messages.

```typescript
/**
 * Unit tests for Exa Contents API fetch function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchExaContents } from "../extensions/backends/exa.js";

describe("fetchExaContents", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("sends x-api-key header", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "Test", url: "https://example.com", text: "Hello" }],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		await fetchExaContents("https://example.com", "exa-key");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("exa-key");
	});

	it("posts to the Exa contents endpoint", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "T", url: "https://example.com", text: "c" }],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		await fetchExaContents("https://example.com", "key");

		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.exa.ai/contents");
	});

	it("sends correct request body", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "T", url: "https://example.com", text: "c" }],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		await fetchExaContents("https://example.com", "key");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ urls: ["https://example.com"], text: true });
	});

	it("returns content on success", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "Example", url: "https://example.com", text: "Page content here" }],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		const result = await fetchExaContents("https://example.com", "key");
		expect(result).toEqual({
			title: "Example",
			url: "https://example.com",
			content: "Page content here",
			warning: undefined,
		});
	});

	it("throws on HTTP error", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => '{"error":"Invalid API key"}',
		} as Response);

		const err = await fetchExaContents("https://example.com", "bad-key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/Exa contents/);
	});

	it("throws when per-URL status is error", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [],
				statuses: [{ id: "https://example.com", status: "error", error: { tag: "CRAWL_NOT_FOUND" } }],
			}),
		} as Response);

		const err = await fetchExaContents("https://example.com", "key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/CRAWL_NOT_FOUND/);
	});

	it("throws when no results returned", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		const err = await fetchExaContents("https://example.com", "key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/no results/);
	});
});
```

### `tests/exa-mcp-fetch.test.ts` — NEW

New test file for `fetchExaMCP()`. Tests: JSON-RPC 2.0 request format, correct tool name and arguments, success response parsing, MCP error handling, HTTP error handling.

```typescript
/**
 * Unit tests for Exa MCP web_fetch function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchExaMCP } from "../extensions/backends/exa-mcp.js";

describe("fetchExaMCP", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("sends valid JSON-RPC 2.0 request with web_fetch_exa tool", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: JSON.stringify([{ title: "Test", url: "https://example.com", content: "Hello" }]) }],
				},
			}),
		} as Response);

		await fetchExaMCP("https://example.com");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.jsonrpc).toBe("2.0");
		expect(body.method).toBe("tools/call");
		expect(body.params.arguments.name).toBe("web_fetch_exa");
		expect(body.params.arguments.arguments.url).toBe("https://example.com");
	});

	it("posts to the Exa MCP endpoint", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: JSON.stringify([{ title: "T", url: "https://example.com", content: "c" }]) }],
				},
			}),
		} as Response);

		await fetchExaMCP("https://example.com");

		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://mcp.exa.ai/mcp");
	});

	it("returns content on success", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: JSON.stringify([{ title: "Example", url: "https://example.com", content: "Page content" }]) }],
				},
			}),
		} as Response);

		const result = await fetchExaMCP("https://example.com");
		expect(result).toEqual({ title: "Example", url: "https://example.com", content: "Page content" });
	});

	it("throws on HTTP error", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 429,
			text: async () => "Rate limited",
		} as Response);

		const err = await fetchExaMCP("https://example.com").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/Exa MCP/);
	});

	it("throws on MCP error response", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32601, message: "Method not found" },
			}),
		} as Response);

		const err = await fetchExaMCP("https://example.com").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/Method not found/);
	});

	it("throws when no content returned", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [] },
			}),
		} as Response);

		const err = await fetchExaMCP("https://example.com").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/no content/);
	});
});
```

## Slices

### Slice 1: Foundation — Types

**Files**: `extensions/types.ts`

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit`
- [ ] `SearchConfig.reader` union includes all 5 values: `"jina" | "sofya" | "firecrawl" | "exa" | "exa_mcp"`

#### Manual Verification:
- [ ] No compilation errors in dependent files

### Slice 2: Firecrawl Scrape

**Files**: `extensions/backends/firecrawl.ts`, `extensions/search-hub.ts`, `tests/firecrawl.test.ts`

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit`
- [ ] Tests pass: `npx vitest run tests/firecrawl.test.ts`
- [ ] `fetchFirecrawl()` exported from `firecrawl.ts`
- [ ] `reader: "firecrawl"` accepted by `StringEnum` in `search-hub.ts`
- [ ] `else if (reader === "firecrawl")` branch present in dispatch
- [ ] `"firecrawl (keyless)"` option in `configureGlobalSettings` UI

#### Manual Verification:
- [ ] `web_read("https://example.com", reader: "firecrawl")` returns markdown content
- [ ] Keyless mode works without API key configured
- [ ] API key mode works when `SEARCH_FIRECRAWL_API_KEY` is set

### Slice 3: Exa Content API

**Files**: `extensions/backends/exa.ts`, `extensions/search-hub.ts`, `tests/exa-contents.test.ts`

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit`
- [ ] Tests pass: `npx vitest run tests/exa-contents.test.ts`
- [ ] `fetchExaContents()` exported from `exa.ts`
- [ ] `reader: "exa"` accepted by `StringEnum` in `search-hub.ts`
- [ ] `else if (reader === "exa")` branch present in dispatch
- [ ] `"exa (needs key)"` option in `configureGlobalSettings` UI
- [ ] `checkExaUsage()` called before request
- [ ] `incrementExaUsage()` called after success

#### Manual Verification:
- [ ] `web_read("https://example.com", reader: "exa")` returns text content
- [ ] Usage tracking increments correctly
- [ ] Warning shown when approaching 1,000 req/month quota

### Slice 4: Exa MCP web_fetch

**Files**: `extensions/backends/exa-mcp.ts`, `extensions/search-hub.ts`, `tests/exa-mcp-fetch.test.ts`

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit`
- [ ] Tests pass: `npx vitest run tests/exa-mcp-fetch.test.ts`
- [ ] `fetchExaMCP()` exported from `exa-mcp.ts`
- [ ] `reader: "exa_mcp"` accepted by `StringEnum` in `search-hub.ts`
- [ ] `else if (reader === "exa_mcp")` branch present in dispatch
- [ ] `"exa_mcp (free)"` option in `configureGlobalSettings` UI
- [ ] Reuses existing `callMCP()` helper

#### Manual Verification:
- [ ] `web_read("https://example.com", reader: "exa_mcp")` returns content
- [ ] Works without any API key configured
- [ ] Rate-limited behavior is graceful (error message, not crash)

## Desired End State

```typescript
// User calls web_read with new reader options
const result = await web_read("https://example.com", { reader: "firecrawl" });
// Returns: { content: "# Page Title\n\nPage content as markdown...", details: { url, reader: "firecrawl", length: 1234, truncated: false } }

// Or via config default:
// .pi/search.json: { "reader": "exa_mcp" }
const result = await web_read("https://example.com");
// Returns: { content: "Page content as text...", details: { url, reader: "exa_mcp", length: 567, truncated: false } }

// Or via /search-setup UI:
// User selects "firecrawl (keyless)" from the reader options
```

## File Map

```
extensions/types.ts                          # MODIFY — Extend SearchConfig.reader union
extensions/backends/firecrawl.ts             # MODIFY — Add fetchFirecrawl()
extensions/backends/exa.ts                   # MODIFY — Add fetchExaContents()
extensions/backends/exa-mcp.ts               # MODIFY — Add fetchExaMCP()
extensions/search-hub.ts                     # MODIFY — Extend StringEnum, dispatch, UI
tests/firecrawl.test.ts                      # MODIFY — Add fetchFirecrawl tests
tests/exa-contents.test.ts                   # NEW — fetchExaContents tests
tests/exa-mcp-fetch.test.ts                  # NEW — fetchExaMCP tests
```

## Ordering Constraints

- Slice 1 (types) must come first — all subsequent slices depend on the extended type
- Slices 2-4 are independent of each other but each depends on Slice 1
- Each slice modifies `search-hub.ts` — later slices must merge with earlier changes
- Tests for each slice can run independently

## Verification Notes

- **Type/registry key mismatch is the #1 recurring bug** — verify the `StringEnum` values in `search-hub.ts:230` match the `SearchConfig.reader` union in `types.ts:30` exactly
- **CI doesn't catch TypeScript errors** — Vitest uses esbuild which skips type checking. Run `npx tsc --noEmit` manually before committing
- **Keyless/optional-key backends require coordinated changes** — the function signature (`apiKey?: string`), the registry entry (`optionalKey: true`), and the setup UI must all agree
- **Exa usage tracking must be shared** — `fetchExaContents()` must call `checkExaUsage()` before and `incrementExaUsage()` after, same as `searchExa()`
- **SSRF guard is already upstream** — `validateUrl(url)` at `search-hub.ts:340` runs before reader dispatch, no redundant guard needed in fetch functions
- **Content truncation at 10,000 chars** — handled by `web_read` handler after dispatch, fetch functions return full content

## Performance Considerations

- Each fetch is a single HTTP request — no performance concerns
- Content already truncated to 10,000 chars in `web_read` handler (`search-hub.ts:400`)
- SSRF guard already applied upstream — no redundant validation
- No N+1 risks — each `web_read` call fetches exactly one URL
- Exa MCP uses 30s timeout (`timeoutSignal(undefined, 30000)` at `exa-mcp.ts:80`)

## Migration Notes

Not applicable — no existing data or schema changes. New reader options are additive.

## Pattern References

- `extensions/backends/sofya.ts:51-90` — `fetchSofya()`: canonical fetch function template (signature, SSRF guard, POST, parse, return `{title, url, content}`)
- `extensions/backends/firecrawl.ts:20-24` — Keyless auth pattern: optional `apiKey`, conditional `Authorization` header
- `extensions/backends/exa.ts:22` — Exa auth pattern: `"x-api-key"` header (not `Authorization: Bearer`)
- `extensions/backends/exa.ts:15,45` — Exa usage tracking: `checkExaUsage()` before, `incrementExaUsage()` after
- `extensions/backends/exa-mcp.ts:44-120` — `callMCP()`: JSON-RPC 2.0 helper (reusable for `web_fetch_exa`)
- `extensions/backends/exa-mcp.ts:126-137` — `searchExaMCP()`: MCP tool call pattern (`callMCP("tools/call", { name: "...", arguments: {...} })`)
- `extensions/search-hub.ts:340-370` — Reader dispatch: `if/else if/else` chain
- `extensions/search-hub.ts:230` — `StringEnum` parameter typing
- `extensions/types.ts:30` — `SearchConfig.reader` union type
- `extensions/search-hub.ts:440` — `configureGlobalSettings` reader selector
- `tests/firecrawl.test.ts` — HTTP layer test pattern (`vi.spyOn(global, "fetch")`)
- `tests/integration.test.ts:268-348` — Fetch function test pattern (`fetchSofya` tests)

## Developer Context

### Checkpoint 1: Directional confirms (2026-06-25T08:02:58-0400)

**Question**: Where to place the 3 new fetch functions? Follow `fetchSofya()` precedent (same file as search function) or create separate files?
**Decision**: Add to existing backend files (firecrawl.ts, exa.ts, exa-mcp.ts)

**Question**: Exa Content API shares the 1,000 req/month quota with Exa search. Should usage tracking be shared (single counter) or separate?
**Decision**: Share usage tracking

**Question**: Reader dispatch pattern: keep the existing `if/else if/else` chain or refactor to a switch/dispatch map?
**Decision**: Keep `if/else if/else` chain

### Checkpoint 2: Design summary confirmation (2026-06-25T08:02:58-0400)

**Question**: Design summary — 3 readers, 4 slices, 0 new files, 5 modified. Ready to proceed to decomposition?
**Decision**: Proceed

### Checkpoint 3: Decomposition confirmation (2026-06-25T08:02:58-0400)

**Question**: 4 slices — Slice 1: Foundation (types.ts), Slices 2-4: one complete vertical slice per reader. Approve decomposition?
**Decision**: Approve

## Design History

- Slice 1: Foundation — Types — approved as generated
- Slice 2: Firecrawl Scrape — approved as generated
- Slice 3: Exa Content API — approved as generated
- Slice 4: Exa MCP web_fetch — approved as generated

## References

- `.rpiv/artifacts/solutions/2025-06-25_07-47-34_web-read-alternatives.md` — Solution analysis (3 candidates, 6 dimensions, recommendation: implement all 3)
- `https://docs.firecrawl.dev/api-reference/endpoint/scrape` — Firecrawl Scrape API docs
- `https://exa.ai/docs/reference/contents-api-guide-for-coding-agents` — Exa Contents API docs
- `https://exa.ai/docs/reference/exa-mcp` — Exa MCP docs
