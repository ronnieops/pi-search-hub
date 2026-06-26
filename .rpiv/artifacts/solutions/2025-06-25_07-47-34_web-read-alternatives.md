---
date: 2026-06-25T07:47:34-0400
author: Red Team
commit: a669864
branch: main
repository: pi-search-hub
topic: "Add Firecrawl Scrape, Exa Content API, Exa MCP web_fetch as web_read readers"
confidence: high
complexity: low
status: ready
verdict: pass
tags: [solutions, web-read, firecrawl, exa, mcp, content-extraction]
last_updated: 2026-06-25T07:47:34-0400
last_updated_by: Red Team
---

# Solution Analysis: Add Firecrawl Scrape, Exa Content API, Exa MCP web_fetch as web_read readers

**Date**: 2026-06-25T07:47:34-0400
**Author**: Red Team
**Commit**: a669864
**Branch**: main
**Repository**: pi-search-hub

## Research Question

Add Firecrawl Scrape API, Exa Content API, and Exa MCP web_fetch as alternative web_read readers because the user's device can't access Jina directly.

## Summary

**Problem**: `web_read` currently only supports Jina Reader (default, free) and Sofya Fetch (needs API key). User's device can't reach Jina's `r.jina.ai` endpoint. Need alternative URL-to-markdown readers.

**Recommended**: Implement all 3 candidates — they're complementary, not competing. Each fills a different niche: Firecrawl Scrape (keyless, 1000 credits/mo), Exa Content API (needs key, 1000 req/mo), Exa MCP web_fetch (zero-config, no key). Total ~150 lines of new code across 3 new backend functions + ~40 lines of wiring.

**Effort**: Low (~2 days)
**Confidence**: High

## Problem Statement

**Requirements:**
- Add Firecrawl's `/v2/scrape` endpoint as a `web_read` reader option
- Add Exa's `/contents` endpoint as a `web_read` reader option
- Add Exa MCP's `web_fetch_exa` tool as a `web_read` reader option
- Each must follow the existing reader dispatch pattern (Jina/Sofya branches in `search-hub.ts`)
- Each must return `{ title, url, content }` matching the existing `fetchSofya` contract

**Constraints:**
- No new npm dependencies — all backends use raw `fetch()`
- Must support keyless mode where available (Firecrawl Scrape, Exa MCP web_fetch)
- Must reuse existing credential resolution (`resolveBackendKey`, `FALLBACK_ENV_MAP`)
- Must not break existing Jina/Sofya readers
- SSRF guard already applied upstream in `web_read` handler — no redundant guard needed

**Success criteria:**
- `web_read(url, reader: "firecrawl")` returns markdown content from Firecrawl Scrape
- `web_read(url, reader: "exa")` returns text content from Exa Contents API
- `web_read(url, reader: "exa_mcp")` returns content from Exa MCP web_fetch
- All 3 pass through the existing `reader` config default and `reader` parameter
- All 3 are selectable in the `/search-setup` global settings UI
- All 3 have unit tests following existing patterns (`tests/firecrawl.test.ts`, `tests/integration.test.ts`)

## Current State

**Existing implementation:**
- `extensions/search-hub.ts:340-370` — `web_read` execute handler branches on `reader === "sofya"` vs Jina default
- `extensions/search-hub.ts:230` — `reader` parameter typed as `StringEnum(["jina", "sofya"])`
- `extensions/types.ts:30` — `SearchConfig.reader` typed as `"jina" | "sofya"`
- `extensions/backends/sofya.ts:51-90` — `fetchSofya()` is the canonical fetch function template
- `extensions/backends/firecrawl.ts:11-38` — `searchFirecrawl()` shows Firecrawl API pattern (keyless mode)
- `extensions/backends/exa.ts:8-55` — `searchExa()` shows Exa API pattern (`x-api-key` auth, usage tracking)
- `extensions/backends/exa-mcp.ts:44-120` — `callMCP()` helper handles JSON-RPC 2.0 framing for Exa MCP
- `extensions/backends/exa-mcp.ts:126-137` — `searchExaMCP()` calls `web_search_exa` tool

**Relevant patterns:**
- `fetchSofya()`: `extensions/backends/sofya.ts:51-90` — Template for all fetch functions (POST, parse, return `{title, url, content}`)
- `searchFirecrawl()`: `extensions/backends/firecrawl.ts:11-38` — Shows keyless auth pattern (optional `Authorization` header)
- `searchExa()`: `extensions/backends/exa.ts:8-55` — Shows `x-api-key` auth + usage tracking
- `callMCP()`: `extensions/backends/exa-mcp.ts:44-120` — Reusable JSON-RPC 2.0 helper for MCP tools
- Reader dispatch: `extensions/search-hub.ts:340-370` — `if/else` chain for reader selection
- Reader config: `extensions/types.ts:30` — Union type for reader values
- Reader UI: `extensions/search-hub.ts:440` — Interactive reader selector in `/search-setup`

**Integration points:**
- `extensions/search-hub.ts:230` — Add new values to `StringEnum` for `reader` parameter
- `extensions/search-hub.ts:340-370` — Add `else if` branches for each new reader
- `extensions/types.ts:30` — Extend `SearchConfig.reader` union type
- `extensions/search-hub.ts:440` — Add reader options to `configureGlobalSettings` UI
- `extensions/backends/firecrawl.ts` — Add `fetchFirecrawl()` function (or new file)
- `extensions/backends/exa.ts` — Add `fetchExaContents()` function (or new file)
- `extensions/backends/exa-mcp.ts` — Add `fetchExaMCP()` function

## Solution Options

### Option 1: Firecrawl Scrape
**How it works:**
Add `fetchFirecrawl()` function that POSTs to `https://api.firecrawl.dev/v2/scrape` with `{ url, formats: ["markdown"] }`. Keyless mode: omit `Authorization` header when no key configured (1,000 free credits/month). Follows exact pattern of `fetchSofya()` in `sofya.ts:51-90` and `searchFirecrawl()` in `firecrawl.ts:11-38`.

**Pros:**
- Keyless mode — works with no API key (1,000 credits/mo free)
- Firecrawl search backend already exists — credential resolution via `resolveBackendKey("firecrawl", config)` works today
- `SEARCH_FIRECRAWL_API_KEY` already in `FALLBACK_ENV_MAP` (`credentials.ts:72`)
- Returns clean markdown — ideal for LLM consumption
- Low deprecation risk — v2 API is stable, keyless mode is strategic

**Cons:**
- 1,000 credits/month hard cap for keyless mode — less generous than Jina (unlimited, rate-limited)
- Shares credit pool with Firecrawl search — heavy search users have fewer scrape credits
- No existing scrape parser — need new response parsing for `data.markdown` field

**Complexity:** Low (~0.5 days)
- Files to create: 0 (add to existing `extensions/backends/firecrawl.ts`)
- Files to modify: 3 (`firecrawl.ts`, `search-hub.ts`, `types.ts`)
- Lines of code: ~40-50
- Risk level: Low

### Option 2: Exa Content API
**How it works:**
Add `fetchExaContents()` function that POSTs to `https://api.exa.ai/contents` with `{ urls: [url], text: true }`. Uses `x-api-key` header (same auth as existing Exa search). Shares the 1,000 req/month free quota with Exa search. Follows pattern of `searchExa()` in `exa.ts:8-55`.

**Pros:**
- Same auth as existing Exa search — `x-api-key` header, `resolveBackendKey("exa", config)` works
- Usage tracking already exists (`checkExaUsage()` / `incrementExaUsage()` in `utils.ts`)
- Returns clean text content — good for LLM consumption
- Stable, mature endpoint — low deprecation risk
- Exa ecosystem actively growing (MCP added recently)

**Cons:**
- Needs API key — not zero-config (unlike Firecrawl keyless or Exa MCP)
- Shares 1,000 req/month quota with Exa search — heavy search users have fewer content reads
- Usage tracking needs to be shared between search and read (currently only wired to search)
- Response parsing differs from search results — needs separate parser

**Complexity:** Low (~0.5 days)
- Files to create: 0 (add to existing `extensions/backends/exa.ts`)
- Files to modify: 3 (`exa.ts`, `search-hub.ts`, `types.ts`)
- Lines of code: ~55-65
- Risk level: Low

### Option 3: Exa MCP web_fetch
**How it works:**
Add `fetchExaMCP()` function that calls `callMCP("tools/call", { name: "web_fetch_exa", arguments: { url } })`. Reuses the existing `callMCP()` helper in `exa-mcp.ts:44-120` which handles JSON-RPC 2.0 framing, HTTP POST, error handling, and response parsing. Zero-config — no API key needed (rate-limited free plan).

**Pros:**
- Zero-config — no API key, no credit card, no pricing tier needed
- Reuses existing `callMCP()` helper — ~20 lines of new code
- Exa MCP search backend already exists and is stable (v2.3.0 through v2.6.1)
- `exa_mcp` already registered in `BACKEND_DEFS`, `SearchConfig.backends`, and `web_search` enum
- Already in "enable all free backends" quick-setup list
- Lowest implementation cost of all 3 options

**Cons:**
- Rate-limited free plan — exact limits not documented in codebase
- MCP response parsing is less mature than REST API parsing (current parser handles JSON + tab-delimited fallback)
- Depends on MCP protocol availability — if Exa changes MCP endpoint, breaks

**Complexity:** Very Low (~0.25 days)
- Files to create: 0 (add to existing `extensions/backends/exa-mcp.ts`)
- Files to modify: 3 (`exa-mcp.ts`, `search-hub.ts`, `types.ts`)
- Lines of code: ~20-30
- Risk level: Very Low

## Comparison

| Criteria | Firecrawl Scrape | Exa Content API | Exa MCP web_fetch |
|----------|-----------------|-----------------|-------------------|
| Complexity | Low | Low | Very Low |
| Codebase fit | High | High | High |
| Risk | Low | Low | Very Low |
| Key needed | No (keyless) | Yes | No |
| Free quota | 1,000 credits/mo | 1,000 req/mo (shared) | Rate-limited (unclear) |
| New code | ~45 lines | ~60 lines | ~25 lines |
| Files touched | 3 | 3 | 3 |
| Test effort | ~60 lines | ~60 lines | ~60 lines |

## Recommendation

**Selected:** All 3 — implement in parallel as complementary readers.

**Rationale:**
- Each fills a different niche: Firecrawl Scrape (keyless, generous quota), Exa Content API (keyed, high quality), Exa MCP web_fetch (zero-config, lowest effort)
- All 3 follow the exact same established pattern — `fetchSofya()` template + reader dispatch branch
- All 3 have existing backend infrastructure in the codebase (search backends, credential resolution, types)
- Total implementation cost is ~130 lines across 3 backend files + ~40 lines of wiring — very low for 3 new readers
- The user specifically requested all 3 — implementing all satisfies the issue completely
- No conflicts between them — they're independent reader options the LLM can choose via the `reader` parameter

**Why not alternatives:**
- Jina Reader: Already exists but user can't access it. These 3 provide alternatives.
- Sofya Fetch: Already exists but needs API key. These 3 add free/no-key options.

**Trade-offs:**
- Accepting 3 separate implementations instead of 1 unified abstraction — the reader dispatch is a simple `if/else` chain, and each backend has different API shapes. A unified abstraction would add complexity without benefit.
- Accepting shared quota for Exa (Content API + search share 1,000 req/mo) — users who need both should get an API key for higher limits.

**Implementation approach:**
1. Add `fetchFirecrawl()` to `extensions/backends/firecrawl.ts` — POST `/v2/scrape`, keyless mode, parse `data.markdown`
2. Add `fetchExaContents()` to `extensions/backends/exa.ts` — POST `/contents`, `x-api-key` auth, share usage tracking
3. Add `fetchExaMCP()` to `extensions/backends/exa-mcp.ts` — call `web_fetch_exa` via existing `callMCP()` helper
4. Update `extensions/types.ts:30` — extend `reader` union to `"jina" | "sofya" | "firecrawl" | "exa" | "exa_mcp"`
5. Update `extensions/search-hub.ts:230` — extend `StringEnum` for `reader` parameter
6. Update `extensions/search-hub.ts:340-370` — add 3 `else if` branches in reader dispatch
7. Update `extensions/search-hub.ts:440` — add reader options to `configureGlobalSettings` UI
8. Write unit tests for each new fetch function

**Integration points:**
- `extensions/search-hub.ts:230` — `StringEnum` for `reader` parameter
- `extensions/search-hub.ts:340-370` — Reader dispatch `if/else` chain
- `extensions/types.ts:30` — `SearchConfig.reader` type
- `extensions/search-hub.ts:440` — `configureGlobalSettings` reader selector

**Patterns to follow:**
- Fetch function pattern: `extensions/backends/sofya.ts:51-90` — `fetchSofya()`
- Keyless auth pattern: `extensions/backends/firecrawl.ts:20-24` — optional `Authorization` header
- Exa auth pattern: `extensions/backends/exa.ts:22` — `x-api-key` header
- MCP call pattern: `extensions/backends/exa-mcp.ts:44-120` — `callMCP()` helper
- Reader dispatch pattern: `extensions/search-hub.ts:340-370` — `if/else` chain
- Test pattern: `tests/firecrawl.test.ts` — `vi.spyOn(global, "fetch")` for HTTP layer tests

**Risks:**
- Firecrawl 1,000 credit cap: Mitigate by adding quota tracking (like Exa's `checkExaUsage()`)
- Exa shared quota: Mitigate by extending existing usage tracking to cover both search and content reads
- Exa MCP rate limits: Mitigate by documenting as "rate-limited" in setup menu (already done for search)

## Scope Boundaries
- **What we're building:** 3 new `web_read` reader options (Firecrawl Scrape, Exa Content API, Exa MCP web_fetch)
- **What we're NOT doing:** Refactoring the reader dispatch into a plugin system. Adding a unified fetch abstraction. Adding new npm dependencies. Changing the existing Jina or Sofya readers.

## Testing Strategy

**Unit tests:**
- Each fetch function: correct endpoint URL, correct auth headers, correct request body
- Each fetch function: success path (parse response → return `{title, url, content}`)
- Each fetch function: error path (HTTP error → sanitized error message)
- Each fetch function: keyless mode (Firecrawl, Exa MCP) — no auth header sent
- Reader dispatch: correct fetch function called for each `reader` value

**Integration tests:**
- `web_read(url, reader: "firecrawl")` dispatches to `fetchFirecrawl()`
- `web_read(url, reader: "exa")` dispatches to `fetchExaContents()`
- `web_read(url, reader: "exa_mcp")` dispatches to `fetchExaMCP()`

**Manual verification:**
- [ ] `web_read("https://example.com", reader: "firecrawl")` returns markdown
- [ ] `web_read("https://example.com", reader: "exa")` returns text
- [ ] `web_read("https://example.com", reader: "exa_mcp")` returns content
- [ ] Config `reader: "firecrawl"` sets default reader
- [ ] `/search-setup` shows all 3 as selectable reader options

## Open Questions
**Resolved during research:**
- Firecrawl `/v2/scrape` endpoint: POST with `{ url, formats: ["markdown"] }`, returns `{ success, data: { markdown, metadata } }` — confirmed from API docs
- Exa `/contents` endpoint: POST with `{ urls: [url], text: true }`, returns `{ results: [{ title, url, text }] }` — confirmed from API docs
- Exa MCP `web_fetch_exa` tool: calls `tools/call` with `{ name: "web_fetch_exa", arguments: { url } }` — confirmed from Exa MCP docs
- All 3 follow the same `fetchSofya()` pattern — no architectural changes needed
- All 3 have existing backend infrastructure in the codebase

**Requires user input:**
- None — all technical decisions resolved during research

**Blockers:**
- None

## References

- `extensions/search-hub.ts:340-370` — Existing reader dispatch (Jina vs Sofya)
- `extensions/backends/sofya.ts:51-90` — `fetchSofya()` template function
- `extensions/backends/firecrawl.ts:11-38` — `searchFirecrawl()` with keyless auth pattern
- `extensions/backends/exa.ts:8-55` — `searchExa()` with `x-api-key` auth + usage tracking
- `extensions/backends/exa-mcp.ts:44-120` — `callMCP()` JSON-RPC 2.0 helper
- `extensions/types.ts:30` — `SearchConfig.reader` type
- `extensions/credentials.ts:72` — `FALLBACK_ENV_MAP` with `firecrawl` and `exa` entries
- `tests/firecrawl.test.ts` — Test pattern for HTTP layer tests
- `tests/integration.test.ts:268-348` — Test pattern for `fetchSofya`
- `https://docs.firecrawl.dev/api-reference/endpoint/scrape` — Firecrawl Scrape API docs
- `https://exa.ai/docs/reference/contents-api-guide-for-coding-agents` — Exa Contents API docs
- `https://exa.ai/docs/reference/exa-mcp` — Exa MCP docs
