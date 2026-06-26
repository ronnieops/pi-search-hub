# Release v2.7.1

## Bug Fixes
- **24 TypeScript compilation errors resolved.** `config.ts` had implicit `any` on backends index (5 errors), `tls-fingerprint.ts` had type mismatches on `Headers` vs `Record` union (10 errors), `content-negotiation.ts` had implicit `any` callback params (4 errors), `duckduckgo.test.ts` had mock type issues (5 errors). All fixed.
- **3 unused imports removed.** `BackendConfig` from `scoring.ts`, `timeoutSignal` from `gfm-support.ts`, `latencyMap` from `dispatch.ts`.
- **Duplicate SSRF guard removed from `sofya.ts`.** Caller (`web_read`) already validates — defense-in-depth was running validation twice.
- **Duplicate Exa quota check removed from `exa.ts`.** `checkExaUsage()` was called before every request, but `incrementExaUsage()` already handles the check internally. Warning was returned twice.
- **`require()` replaced with ESM imports in `utils.ts`.** Last 2 `require()` calls in production code now use top-level ESM imports. Zero `require()` calls remain.

## Maintenance
- **7 dead-code modules removed (~3,500 lines).** `cache-system`, `tool-persistence`, `gfm-support`, `content-negotiation`, `sibling-probe`, `spillover`, `tls-fingerprint` — all fully implemented and tested but never imported by the main extension. Reduces maintenance surface significantly.

## Stats
- 0 TypeScript errors (was 24)
- 143 tests passing (8 test files)
- 0 `require()` calls in production code
- ~3,500 lines removed

---

# Release v2.6.1

## Bug Fixes
- **runBackend had orphaned try block.** The v2.5.0 scoring-wiring change added an inner `try/catch/finally` around `def.search()` but left a stray outer `try {` wrapping key/URL resolution. The orphaned try had no catch/finally and shadowed a `const key` declaration, causing TypeScript error TS1472 at registry.ts:328. Vitest uses esbuild for transforms (no type checking), so this was silent in CI. Removed the outer try and inlined the `cacheKey()` call to avoid the variable conflict.

---

# Release v2.6.0

## Bug Fixes
- **persist() omitted staleAt from serialized cache entries.** Cache entries saved to disk were missing the `staleAt` field. On reload, the stale window was recomputed as `expiresAt + (ttlMs * staleMultiplier)`, drifting forward if `ttlMs` or `staleMultiplier` differed between processes. Fixed by adding `staleAt: v.staleAt` to the persist serialization map.
- **round-robin with empty backends returned `[undefined]`.** When `selectBackendsForFallback("round-robin", [])` was called, `backends.length === 0` caused `NaN` index (`roundRobinIndex % 0`), returning `undefined` as the first element. Added an early guard: `if (backends.length === 0) return []`.

## Tests
- **speedScore=0 clamping now asserted.** The "very slow backends" test in scoring.test.ts recorded 10s latency but only asserted `avgLatency`. Now also asserts `compositeScore ≈ 0.6` and verifies a fast backend scores higher than the slow one.
- **best-latency dispatch integration test added.** `selectBackendsForFallback("best-latency", ...)` now exercised in the integration suite, verifying fast backend ranks first, broken backend last.
- **round-robin threshold strengthened.** Integration test now uses 12 calls instead of 6, requiring all 3 backends to appear as first element.
- **262/262 tests passing** (13 files, up from 260/260).

## Maintenance
- **Window reset test notes code-inspection approach.** Full time-progression testing of the 60s window reset requires fake timers that reliably patch `Date.now()` across ESM module boundaries in Vitest. A code-inspection comment documents the correct reset logic in scoring.ts.

---

# Release v2.5.0 (Correctness & Test Coverage)

## Bug Fixes
- **Cache stale expiry calculation was catastrophically wrong.** BackendCache computed staleExpiry = expiresAt * staleMultiplier (multiplying an absolute Unix timestamp by 2), producing a date in 2106. This made the stale window effectively infinite -- stale entries were never evicted, prune() never removed anything, and load() loaded all expired entries from disk. Fixed by storing a dedicated staleAt timestamp at entry-creation time and comparing now < entry.staleAt consistently. Memory leak on long-running processes resolved.
- **DuckDuckGo cryptic error when ddgs Python package missing.** When ddgs import failed, users saw an opaque ModuleNotFoundError with no actionable guidance. Now the Python script detects the missing module specifically and prints: Install ddgs: pip3 install ddgs.
- **best-latency selection strategy was dead code.** recordBackendSuccess and recordBackendFailure in scoring.ts were defined but never called, so the composite scoring subsystem always returned 0.5 for every backend. Now wired into runBackend() in the registry.

## Tests
- **New scoring.test.ts** -- 10 test cases covering all scoring.ts functions: running average convergence, success/failure recording, window reset, speed clamping, composite scoring, getBestBackends edge cases.
- **New duckduckgo.test.ts** -- 11 test cases covering the Python subprocess backend: successful search, spawn error, missing ddgs module, exception stderr, non-zero exit, malformed JSON, timeout, abort signal, options injection, platform detection.
- **Improved integration.test.ts** -- TTL eviction test now verifies entry exists before TTL expires. Random selection test now verifies actual shuffling across 20 calls.

## Maintenance
- **sibling-probe.ts**: Removed duplicate timeoutSignal() function, now imported from utils.js.
- **FALLBACK_ENV_MAP**: Added brave-llm, youcom, linkup, fastcrw convenience env var fallbacks.
- **README**: Removed stale Firecrawl curl comment referencing v1.

## Stats
- 260 tests (up from 236), 13 test files (up from 11)

---

# Release v2.4.0 (Firecrawl Keyless)

## 🚀 New Features
- **Firecrawl Keyless mode** — `apiKey` is now optional on the Firecrawl backend. Firecrawl launched hosted keyless access on 2026-06-16 (1,000 free credits/month, no `Authorization` header required). The backend now runs zero-config like Jina and Marginalia; bring your own key only for higher volume.
  - `searchFirecrawl()`: `apiKey` param optional, `Authorization: Bearer` header attached only when a key is present.
  - Registry flipped to `optionalKey: true`; setup label updated to reflect the keyless tier.
  - New test for the headerless request path.
  - README tier table updated: Firecrawl now "No" key required, 1k keyless credits/mo.

## 🔁 Reverts / Corrected Decisions
- **Issue #18 reopened and resolved.** Previously closed as "not planned" on the rationale that the hosted Firecrawl API required a key on every request. Firecrawl Keyless invalidated that assumption; the fix shipped in this release.
- **PR #20 closed** (superseded). It guarded the `Authorization` header but left `apiKey` required, so keyless wouldn't work end-to-end through the registry's `MISSING_KEY_HELP` gate. Credit to @CoderTCY for both the original report and the PR.

## 📊 Stats
- 18 backends total (Firecrawl now keyless-capable)
- 236 tests passing (was 235)

---

# Release v2.3.3 (Bug fix release)

## 🐛 Fixes
- Fixed duplicate `configDir` variable in setup menu.

## 📊 Stats
- 18 backends total
- 228 tests passing

---

# Release v2.3.2 (Bug fix release)

## 🐛 Fixes
- Fixed duplicate `option` variable in setup menu that caused parse error.

## 📊 Stats
- 18 backends total
- 228 tests passing

---

# Release v2.3.1 (Bug fix release)

## 🐛 Fixes
- Fixed missing closing brace in `exa_mcp` backend that caused pi to fail loading.
- Fixed orphaned `return` block in `search-hub.ts` that caused parse errors.

## 📊 Stats
- 18 backends total
- 228 tests passing

---

# Release v2.3.0 (Major feature release)

## 🚀 New Features
- **Exa MCP** — Zero-config backend using MCP endpoint (no API key needed).
- **SSRF guard** — `isPrivateHost()`, `validateUrl()`, `assertSafeUrl()` in utils.ts.
- **Large-page spillover** — `spillover.ts` handles oversized responses.
- **Statusline activity** — Search tools show activity in status line.
- **Tool selection persistence** — `tool-persistence.ts` remembers last used tool.
- **Sibling URL probing** — `sibling-probe.ts` tries .md, README.md variants.
- **GFM support** — Tables, task lists, strikethrough, code blocks in `gfm-support.ts`.
- **Content negotiation pipeline** — Markdown detection in `content-negotiation.ts`.
- **Cache system with TTL** — `cache-system.ts` with configurable TTL.
- **TLS fingerprinting** — `tls-fingerprint.ts` for Cloudflare bypass.
- **Exa usage tracking** — Monthly quota tracking (1000/mo, warns at 800).

## ⚙️ Setup Menu Enhancements
- Added "⚡ Enable all free backends" quick option.
- Added "⚙️ Global settings" to configure: compact, showStatus, combine, cacheTtl, cacheMax, reader, selectionStrategy.
- Show rate limits in backend list.
- Free backends auto-enable without prompting.

## 📊 Stats
- 18 backends total (added Exa MCP)
- 228 tests passing (was 198)
- 26 new files (10 new modules + test files)

---

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
