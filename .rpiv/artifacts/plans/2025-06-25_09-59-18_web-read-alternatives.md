---
date: 2026-06-25T09:59:18-0400
author: Red Team
commit: a669864
branch: main
repository: pi-search-hub
topic: "Add Firecrawl Scrape, Exa Content API, Exa MCP web_fetch as web_read readers"
tags: [plan, web-read, firecrawl, exa, mcp, content-extraction]
status: ready
parent: ".rpiv/artifacts/designs/2025-06-25_08-02-58_web-read-alternatives.md"
phase_count: 4
phases:
  - { n: 1, title: "Foundation — Types" }
  - { n: 2, title: "Firecrawl Scrape" }
  - { n: 3, title: "Exa Content API" }
  - { n: 4, title: "Exa MCP web_fetch" }
last_updated: 2026-06-25T09:59:18-0400
last_updated_by: Red Team
---

# Add Firecrawl Scrape, Exa Content API, Exa MCP web_fetch as web_read readers — Implementation Plan

## Overview

Add 3 new `web_read` reader backends (Firecrawl Scrape, Exa Content API, Exa MCP web_fetch) to provide alternatives when Jina Reader is unavailable. Each reader follows the established `fetchSofya()` pattern: a standalone async function in the existing backend file, wired into the reader dispatch via an `else if` branch. The reader type union and `StringEnum` parameter are extended to include all 3 new values. Exa usage tracking is shared between search and content reads. No new files or dependencies.

Design: `.rpiv/artifacts/designs/2025-06-25_08-02-58_web-read-alternatives.md`

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

## What We're NOT Doing

- Plugin system for reader dispatch — the `if/else if/else` chain is sufficient for 5 readers
- Unified fetch abstraction — each backend has different API shapes (REST vs MCP, keyless vs keyed)
- Firecrawl quota tracking — 1,000 credit cap is per-account, not per-extension; users who hit it should get an API key
- New npm dependencies — all backends use raw `fetch()`
- Changes to existing Jina or Sofya readers — untouched

## Phase 1: Foundation — Types

### Overview

Extend `SearchConfig.reader` union type to include the 3 new reader values. This is the foundation that all subsequent phases depend on.

### Changes Required:

#### 1. Type extension
**File**: `extensions/types.ts:30`
**Changes**: Extend `SearchConfig.reader` union from `"jina" | "sofya"` to `"jina" | "sofya" | "firecrawl" | "exa" | "exa_mcp"`

```typescript
/** Reader backend for web_read. "jina" (default, free), "sofya" (250+ site parsers, needs key), "firecrawl" (keyless, 1000 credits/mo), "exa" (needs key, 1000 req/mo), or "exa_mcp" (zero-config, rate-limited). */
reader?: "jina" | "sofya" | "firecrawl" | "exa" | "exa_mcp";
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npx tsc --noEmit`
- [x] `SearchConfig.reader` union includes all 5 values: `"jina" | "sofya" | "firecrawl" | "exa" | "exa_mcp"`
- [ ] StringEnum values in `search-hub.ts` match `SearchConfig.reader` union values in `types.ts` exactly — verified by comparing the two arrays at runtime

#### Manual Verification:
- [x] No compilation errors in dependent files

---

## Phase 2: Firecrawl Scrape

### Overview

Add `fetchFirecrawl()` function to `extensions/backends/firecrawl.ts`, wire it into the reader dispatch in `extensions/search-hub.ts`, and add tests to `tests/firecrawl.test.ts`. Keyless mode: `apiKey` is optional, `Authorization` header only added when key provided.

### Changes Required:

#### 1. Fetch function
**File**: `extensions/backends/firecrawl.ts`
**Changes**: Add `fetchFirecrawl()` after existing `searchFirecrawl()`. POSTs to `https://api.firecrawl.dev/v2/scrape` with `{ url, formats: ["markdown"] }`. Keyless mode.

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

#### 2. Reader dispatch wiring
**File**: `extensions/search-hub.ts`
**Changes**: Add import for `fetchFirecrawl`, extend `StringEnum` with `"firecrawl"`, add `else if (reader === "firecrawl")` branch, update `readerLabel`, add `"firecrawl (keyless)"` to `configureGlobalSettings` UI.

```typescript
// Import (add after existing imports)
import { fetchFirecrawl } from "./backends/firecrawl.js";

// StringEnum (replace existing reader parameter)
			reader: Type.Optional(
				StringEnum(["jina", "sofya", "firecrawl"] as const, {
					description:
						"Reader backend: 'jina' (default, free, supports keywords/mode/objective), " +
						"'sofya' (250+ site-specific parsers, needs API key), or " +
						"'firecrawl' (keyless, 1000 credits/mo). Overrides the configured default.",
				}),
			),

// readerLabel (replace existing line)
			const readerLabel = reader === "sofya" ? "Sofya" : reader === "firecrawl" ? "Firecrawl" : "Jina";

// Dispatch branch (add after sofya block)
			} else if (reader === "firecrawl") {
				// Firecrawl Scrape: keyless mode (1000 free credits/mo).
				const firecrawlKey = resolveBackendKey("firecrawl", config);
				const result = await fetchFirecrawl(url, firecrawlKey, signal);
				content = result.content;

// configureGlobalSettings UI (replace existing reader case)
			case "reader": {
				const choice = await ctx.ui.select(`${label} — current: ${selected.split(": ")[1]}`, [
					"jina (free)", "sofya (needs key)", "firecrawl (keyless)", "Cancel"
				]);
				if (choice === "Cancel" || !choice) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				value = choice.startsWith("jina") ? "jina" : choice.startsWith("firecrawl") ? "firecrawl" : "sofya";
				break;
			}
```

#### 3. Tests
**File**: `tests/firecrawl.test.ts`
**Changes**: Add `describe("fetchFirecrawl", ...)` test suite after existing `searchFirecrawl` tests.

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

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit`
- [ ] Tests pass: `npx vitest run tests/firecrawl.test.ts`
- [ ] `fetchFirecrawl()` exported from `firecrawl.ts`
- [ ] `reader: "firecrawl"` accepted by `StringEnum` in `search-hub.ts`
- [ ] `else if (reader === "firecrawl")` branch present in dispatch
- [ ] `"firecrawl (keyless)"` option in `configureGlobalSettings` UI
- [ ] Registry entry for `firecrawl` has `optionalKey: true`

#### Manual Verification:
- [ ] `web_read("https://example.com", reader: "firecrawl")` returns markdown content
- [ ] Keyless mode works without API key configured
- [ ] API key mode works when `SEARCH_FIRECRAWL_API_KEY` is set

---

## Phase 3: Exa Content API

### Overview

Add `fetchExaContents()` function to `extensions/backends/exa.ts` with shared Exa usage tracking, wire into reader dispatch, and add tests. Uses `x-api-key` header. Shares the 1,000 req/month quota with Exa search.

### Changes Required:

#### 1. Fetch function
**File**: `extensions/backends/exa.ts`
**Changes**: Add `fetchExaContents()` after existing `searchExa()`. POSTs to `https://api.exa.ai/contents` with `{ urls: [url], text: true }`. Calls `checkExaUsage()` before and `incrementExaUsage()` after.

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

#### 2. Reader dispatch wiring
**File**: `extensions/search-hub.ts`
**Changes**: Add import for `fetchExaContents`, extend `StringEnum` with `"exa"`, add `else if (reader === "exa")` branch, update `readerLabel`, add `"exa (needs key)"` to `configureGlobalSettings` UI.

```typescript
// Import (add after existing imports)
import { fetchExaContents } from "./backends/exa.js";

// StringEnum (replace existing — merge with Phase 2 changes)
			reader: Type.Optional(
				StringEnum(["jina", "sofya", "firecrawl", "exa"] as const, {
					description:
						"Reader backend: 'jina' (default, free, supports keywords/mode/objective), " +
						"'sofya' (250+ site-specific parsers, needs API key), " +
						"'firecrawl' (keyless, 1000 credits/mo), or " +
						"'exa' (needs API key, 1000 req/mo). Overrides the configured default.",
				}),
			),

// readerLabel (replace existing — merge with Phase 2 changes)
			const readerLabel = reader === "sofya" ? "Sofya" : reader === "firecrawl" ? "Firecrawl" : reader === "exa" ? "Exa" : "Jina";

// Dispatch branch (add after firecrawl block)
			} else if (reader === "exa") {
				// Exa Contents API: needs API key (1000 req/mo, shared with search).
				const exaKey = resolveBackendKey("exa", config);
				if (!exaKey) {
					throw new Error(`Exa reader selected but no API key configured. ${MISSING_KEY_HELP}`);
				}
				const result = await fetchExaContents(url, exaKey, signal);
				if (result.warning) {
					ctx.ui.notify(result.warning, "warn");
				}
				content = result.content;

// configureGlobalSettings UI (replace existing — merge with Phase 2 changes)
			case "reader": {
				const choice = await ctx.ui.select(`${label} — current: ${selected.split(": ")[1]}`, [
					"jina (free)", "sofya (needs key)", "firecrawl (keyless)", "exa (needs key)", "Cancel"
				]);
				if (choice === "Cancel" || !choice) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				value = choice.startsWith("jina") ? "jina" : choice.startsWith("firecrawl") ? "firecrawl" : choice.startsWith("exa") ? "exa" : "sofya";
				break;
			}
```

#### 3. Tests
**File**: `tests/exa-contents.test.ts` (NEW)
**Changes**: New test file for `fetchExaContents()`.

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

### Success Criteria:

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

---

## Phase 4: Exa MCP web_fetch

### Overview

Add `fetchExaMCP()` function to `extensions/backends/exa-mcp.ts` reusing the existing `callMCP()` helper, wire into reader dispatch, and add tests. Zero-config — no API key needed.

### Changes Required:

#### 1. Fetch function
**File**: `extensions/backends/exa-mcp.ts`
**Changes**: Add `fetchExaMCP()` after existing `searchExaMCP()`. Calls `callMCP("tools/call", { name: "web_fetch_exa", arguments: { url } })`.

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

#### 2. Reader dispatch wiring
**File**: `extensions/search-hub.ts`
**Changes**: Add import for `fetchExaMCP`, extend `StringEnum` with `"exa_mcp"`, add `else if (reader === "exa_mcp")` branch, update `readerLabel`, add `"exa_mcp (free)"` to `configureGlobalSettings` UI.

```typescript
// Import (add after existing imports)
import { fetchExaMCP } from "./backends/exa-mcp.js";

// StringEnum (replace existing — merge with Phases 2-3 changes)
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

// readerLabel (replace existing — merge with Phases 2-3 changes)
			const readerLabel = reader === "sofya" ? "Sofya" : reader === "firecrawl" ? "Firecrawl" : reader === "exa" ? "Exa" : reader === "exa_mcp" ? "Exa MCP" : "Jina";

// Dispatch branch (add after exa block)
			} else if (reader === "exa_mcp") {
				// Exa MCP web_fetch: zero-config, no API key needed.
				const result = await fetchExaMCP(url, signal);
				content = result.content;

// configureGlobalSettings UI (replace existing — merge with Phases 2-3 changes)
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

#### 3. Tests
**File**: `tests/exa-mcp-fetch.test.ts` (NEW)
**Changes**: New test file for `fetchExaMCP()`.

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

### Success Criteria:

#### Automated Verification:
- [ ] Type checking passes: `npx tsc --noEmit`
- [ ] Tests pass: `npx vitest run tests/exa-mcp-fetch.test.ts`
- [ ] `fetchExaMCP()` exported from `exa-mcp.ts`
- [ ] `reader: "exa_mcp"` accepted by `StringEnum` in `search-hub.ts`
- [ ] `else if (reader === "exa_mcp")` branch present in dispatch
- [ ] `"exa_mcp (free)"` option in `configureGlobalSettings` UI
- [ ] Reuses existing `callMCP()` helper
- [ ] Registry entry for `exa_mcp` has `needsKey: false`

#### Manual Verification:
- [ ] `web_read("https://example.com", reader: "exa_mcp")` returns content
- [ ] Works without any API key configured
- [ ] Rate-limited behavior is graceful (error message, not crash)

---

## Testing Strategy

### Automated:
- Type checking: `npx tsc --noEmit` (per phase)
- Unit tests: `npx vitest run tests/firecrawl.test.ts` (Phase 2)
- Unit tests: `npx vitest run tests/exa-contents.test.ts` (Phase 3)
- Unit tests: `npx vitest run tests/exa-mcp-fetch.test.ts` (Phase 4)
- All tests: `npm test` (final)

### Manual Testing Steps:
1. `web_read("https://example.com", reader: "firecrawl")` returns markdown content
2. `web_read("https://example.com", reader: "exa")` returns text content
3. `web_read("https://example.com", reader: "exa_mcp")` returns content
4. Keyless mode works without API key configured (Firecrawl, Exa MCP)
5. API key mode works when env var is set (Firecrawl, Exa)
6. Usage tracking increments correctly (Exa)
7. Warning shown when approaching 1,000 req/month quota (Exa)
8. `/search-setup` shows all 3 as selectable reader options

## Performance Considerations

- Each fetch is a single HTTP request — no performance concerns
- Content already truncated to 10,000 chars in `web_read` handler (`search-hub.ts:400`)
- SSRF guard already applied upstream — no redundant validation
- No N+1 risks — each `web_read` call fetches exactly one URL
- Exa MCP uses 30s timeout (`timeoutSignal(undefined, 30000)` at `exa-mcp.ts:80`)

## Migration Notes

Not applicable — no existing data or schema changes. New reader options are additive.

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

| source   | plan-loc          | codebase-loc                | severity   | dimension             | finding   | recommendation   | resolution         |
| -------- | ----------------- | --------------------------- | ---------- | --------------------- | --------- | ---------------- | ------------------ |
| coverage | ## Verification Notes §1 | <n/a> | blocker | verification-coverage | Note "verify the StringEnum values in search-hub.ts:230 match the SearchConfig.reader union in types.ts:30 exactly" — no Success Criteria bullet cross-verifies the two locations are in sync, and no code-level guard or test enforces the match. Individual checks exist for each file separately but no cross-file consistency check. | Add an Automated Verification bullet under Phase 1 (or a final integration phase) that reads: "StringEnum values in search-hub.ts match SearchConfig.reader union values in types.ts exactly — verified by a unit test that compares the two arrays at runtime" | applied: added cross-file consistency check bullet to Phase 1 Automated Verification |
| coverage | ## Verification Notes §3 | <n/a> | blocker | verification-coverage | Note "the function signature (apiKey?: string), the registry entry (optionalKey: true), and the setup UI must all agree" — no Success Criteria bullet verifies the registry entry has `optionalKey: true` for keyless backends (Firecrawl, Exa MCP), and no code fence shows the registry entry configuration. Function signatures and UI options are shown in code fences, but the registry entry is absent. | Add an Automated Verification bullet under Phase 2 and Phase 4: "Registry entry for firecrawl/exa_mcp has `optionalKey: true`" — or show the registry entry code in the Changes Required section so it is visible as a code mirror | applied: added registry entry verification bullets to Phase 2 (optionalKey: true) and Phase 4 (needsKey: false) |
| code | Phase 3 §1 (exa.ts) | extensions/search-hub.ts:355-358 | concern | code-quality | `fetchExaContents` returns a `warning` field (from `checkExaUsage`/`incrementExaUsage`) but the `web_read` dispatch branch for `reader === "exa"` assigns only `content = result.content` and silently drops the warning — the user will not see Exa quota warnings when using `web_read` with the Exa reader | Surface the warning in the dispatch, e.g. `if (result.warning) ctx.ui.notify(result.warning, "warn")` before the `content` assignment, matching how the search path propagates warnings through `registry.ts:109` | applied: added warning surfacing via ctx.ui.notify() in Phase 3 dispatch branch |

## Developer Context

(Reserved for Step 4 review findings and post-write developer interactions.)

## References

- Design: `.rpiv/artifacts/designs/2025-06-25_08-02-58_web-read-alternatives.md`
- Solutions: `.rpiv/artifacts/solutions/2025-06-25_07-47-34_web-read-alternatives.md`
- `https://docs.firecrawl.dev/api-reference/endpoint/scrape` — Firecrawl Scrape API docs
- `https://exa.ai/docs/reference/contents-api-guide-for-coding-agents` — Exa Contents API docs
- `https://exa.ai/docs/reference/exa-mcp` — Exa MCP docs
