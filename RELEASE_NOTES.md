# Release v2.2.0 (Sofya backend + pluggable web_read reader)

## 🚀 New
- **Sofya** ([sofya.co](https://sofya.co)): adds a `web_search` backend (`POST /v1/search`, full extracted page content at `basic` depth) AND a `web_read` reader (`POST /v1/fetch`, 250+ site-specific parsers), both from a single API key.
- **Pluggable `web_read` reader**: `web_read` is no longer hardcoded to Jina. Choose `jina` (default, free) or `sofya` via the new top-level `"reader"` config setting, or per-call with the `reader` tool param.

## 📊 Stats
- 17 backends total (was 16)
- 70 tests passing (was 65), added `parseSofya` coverage

## 🔧 Changes
- `extensions/backends/sofya.ts`: New adapter exporting `searchSofya` + `fetchSofya`.
- `parsers.ts`: Added `parseSofya` (full `content` + `description` snippet).
- `registry.ts`: Registered `sofya` BACKEND_DEF (honors `searchDepth`, `topic`).
- `types.ts`: Added `sofya` to SearchConfig, top-level `reader`, and `searchDepth`/`topic` per-backend options.
- `credentials.ts`: Added `SEARCH_SOFYA_API_KEY` convenience env var.
- `search-hub.ts`: `web_read` branches on reader (Jina vs Sofya Fetch); `web_search` backend enum completed (added the 4 v2.1.0 backends that were missing from the enum, plus `sofya`).
- `package.json`: Description/keywords updated to 17 backends.

---

# Release v2.1.0 (4 new backends)

## 🚀 New Backends
- **Brave LLM Context** — pre-extracted AI-grounding chunks, token-budget aware. Same API key as Brave Search.
- **Linkup** — EU/GDPR-compliant AI-native search. x402 crypto payment support. $20/mo free credit.
- **You.com** — web + news search. Up to 100 results per call. Built-in news intent detection. $100 free credits.
- **fastCRW** — Firecrawl-compatible search + scrape. Self-hostable (AGPL-3.0). 500 free credits/mo.

## 📊 Stats
- 16 backends total (was 12)
- 65 tests passing (was 47)
- 27 `.ts` files (4 new adapters)

## 🔧 Changes
- `types.ts`: Added `braveLLM`, `linkup`, `youcom`, `fastcrw` to SearchConfig. Added `tokenBudget`, `depth`, `baseUrl` per-backend options.
- `registry.ts`: Registered 4 new BACKEND_DEFS with proper key resolution.
- `parsers.ts`: Added `parseBraveLLM`, `parseLinkup`, `parseYoucom`, `parseFastcrw`.
- `package.json`: Updated description to reflect 16 backends.

---

# Release v2.0.1 (fix broken 2.0.0 tarball)

**v2.0.0 was deprecated.** NPM tarball was missing module files due to restrictive `.npmignore`.

Features same as 2.0.0:
- Smart backend scoring (composite: success rate + latency + quality)
- Search result caching (LRU with TTL, configurable)
- DuckDuckGo v9.x metasearch (backend, region, timelimit)
- Per-backend config (timeout, maxResults, headers)
- Combine mode config option in search.json
- Modular architecture (20 files from 1 monolith)
- 21 new integration tests

Fixes:
- `.npmignore` now includes all extension module files
- Publish workflow skips if version already on registry
