---
date: 2026-06-26T15:37:54-0400
reviewer: Red Team
commit: 3e9266b
branch: pr-19-codex
repository: pi-search-hub
topic: "Add OpenAI Codex search backend + targeted combine mode"
tags: [review, code-review, openai-codex, targeted-combine]
status: ready
blockers_count: 3
verification: "I1 V, I2 V, I3 V, I4 W, Q2 V, Q7 V, Q8 V, Q9 V, Q10 V"
---

# Code Review: Add OpenAI Codex search backend + targeted combine mode

PR #19 — 5 commits, 10 files changed, +671 -12 lines

## Scope

| | |
|---|---|
| Review type | pr |
| Range | `b71e187..3e9266b` |
| Strategy | explicit-range |
| Manifest changed | yes (version bumps only, no dep changes) |
| Lockstep self-review | no |
| HasGatingPredicate | no |

## Summary

Adds OpenAI Codex as a 19th search backend using Pi-managed authentication (`AuthStorage.getApiKey`), plus a targeted combine mode that caps combine fan-out to 3 usable backends instead of querying all enabled backends. 3 important findings, 4 suggestions, 1 discussion point.

## 🔴 Critical

*None.*

## 🟡 Important

### I1 — combineMode validation gap: type-level constraint promises closed set, runtime silently accepts any value

**Files**: `extensions/types.ts:40`, `extensions/search-hub.ts:128`, `extensions/search-hub.ts:160`

The `SearchConfig` interface at `extensions/types.ts:40` constrains `combineMode` to the union `"all" | "targeted"`. At runtime, `extensions/search-hub.ts:128` (`const combineMode = config.combineMode ?? "all"`) only catches `undefined`/`null`. The branch guard at `extensions/search-hub.ts:160` (`if (combineMode === "targeted")`) evaluates to `false` for any unrecognized value, causing silent fallthrough to the "all" path.

**Reproducer**: User sets `combineMode: "smart"` in `search.json` → `config.combineMode` is `"smart"` → `"smart" ?? "all"` yields `"smart"` → `"smart" === "targeted"` is `false` → falls through to "all" combine with no warning.

**Recommendation**: Add a validation/normalization step after config load that rejects or warns on unrecognized `combineMode` values. Either validate at `extensions/config.ts:loadConfig` or add a guard at `extensions/search-hub.ts:128`.

### I2 — openai-codex status display shows "key: ✓" when auth may not be configured

**Files**: `extensions/search-hub.ts:835`, `extensions/credentials.ts:112-127`

The `search-status` command at `extensions/search-hub.ts:835` unconditionally emits `"✓ enabled, key: ✓"` for enabled backends that are not `duckduckgo`, `marginalia`, or `searxng`. For `openai-codex`, `getKeySource` at `extensions/credentials.ts:112-127` returns `{ configured: false, source: "" }` because there is no `apiKey` in config and no `FALLBACK_ENV_MAP` entry. The `configured` boolean is destructured at line 820 but never checked in the display logic.

**Reproducer**: User enables `openai-codex` in config but has not run `/login` → `search-status` shows `"✓ enabled, key: ✓"` → user assumes auth is configured → backend fails at runtime with `"OpenAI Codex authentication not found. Run /login and select OpenAI Codex."`

**Recommendation**: Check the `configured` boolean from `getKeySource` in the status display branch. For backends using Pi-managed auth (no `apiKey` in config), show `"key: ✓ (Pi auth)"` or similar instead of the generic checkmark.

### I3 — openai-codex has no explicit timeout guard

**Files**: `extensions/backends/openai-codex.ts:71`, `extensions/utils.ts:55-58`

The `streamOpenAICodexResponses` call at `extensions/backends/openai-codex.ts:71` passes the raw `signal` parameter directly — no `timeoutSignal` wrapper. `extensions/utils.ts:55-58` defines `timeoutSignal` which guarantees a 30-second timeout by combining the caller's signal with `AbortSignal.timeout(30000)`. Every other backend (e.g., `extensions/backends/jina.ts:24`, `tavily.ts:27`) uses `timeoutSignal(signal)`.

**Reproducer**: LLM tool execution context does not enforce a timeout → `streamOpenAICodexResponses` hangs indefinitely → no timeout guard at `openai-codex.ts:71` or `registry.ts` dispatch layer.

**Recommendation**: Wrap `signal` with `timeoutSignal(signal)` at `extensions/backends/openai-codex.ts:71`, consistent with all other backends.

## 🔵 Suggestion

### Q2 — targeted combine branching not tested end-to-end

**Files**: `extensions/search-hub.ts:160-220`, `tests/integration.test.ts:100-195`

The config-driven branching at `extensions/search-hub.ts:160` (`if (combineMode === "targeted")`) and the full execute-path integration for targeted combine are not tested. `runTargetedCombine` is tested in isolation in `tests/integration.test.ts:100-195`, but the config wiring, status display, and error handling in the `web_search` tool's `execute` handler are uncovered.

**Recommendation**: Add an integration test that exercises the `combineMode === "targeted"` branch through the `web_search` tool's execute path.

### Q7 — results without snippet silently dropped

**Files**: `extensions/backends/openai-codex.ts:179`

`normalizeSearchResult` at `extensions/backends/openai-codex.ts:179` (`if (!snippet) return null`) drops results without a snippet. If Codex omits the `snippet` field for a valid URL result, that result is silently discarded.

**Recommendation**: Consider using `content` as a fallback when `snippet` is absent, or at minimum log a warning when a valid URL result is dropped due to missing snippet.

### Q8-Q10 — helper functions not directly tested

**Files**: `extensions/backends/openai-codex.ts:100-252`

The following helper functions are not directly tested:
- `resolveOpenAICodexAccessToken` (line 100)
- `normalizeSearchResult` (line 176)
- `normalizeHttpUrl` (line 195)
- `normalizeUrlForDedup` (line 217)
- `safeUrlHostname` (line 228)
- `cleanString` (line 236)
- `truncateText` (line 240)
- `hasUrlScheme` (line 244)
- `looksLikeDomainOrPath` (line 248)
- `isRecord` (line 252)

These are small utility functions, but several contain non-trivial URL normalization logic that would benefit from direct unit tests.

**Recommendation**: Add direct unit tests for `normalizeHttpUrl`, `normalizeUrlForDedup`, and `looksLikeDomainOrPath` which contain the most risk (URL parsing edge cases).

## 💭 Discussion

### I4 — runTargetedCombine + cache interaction (weakened)

**Files**: `extensions/dispatch.ts:60-97`, `extensions/backends/registry.ts:327`

Empty results are cached at `extensions/backends/registry.ts:327` and `runTargetedCombine` at `extensions/dispatch.ts:86` passes no `skipCache` option. However, the "try next batch" loop at `extensions/dispatch.ts:74-97` still iterates through ordered backends regardless of cache hits, so the logic is not made inert. The impact is limited: a cached empty result from a prior call within the 5-minute TTL window prevents re-evaluation of that specific backend, but the loop continues to the next backend.

**Recommendation**: Low priority. Consider adding a `skipCache` option to `runTargetedCombine` if cache-masking of backend unavailability becomes a real issue.

## Pattern Analysis

No peer-mirror pairs existed for this diff (new file `openai-codex.ts` has no suitable peer with ≥60% stem similarity or shared suffix).

## Impact

**Inbound refs to changed files:**
- `extensions/types.ts` — imported by every backend and core module (blast radius: entire extension)
- `extensions/backends/registry.ts` — consumed by `search-hub.ts` at 6+ call sites
- `extensions/dispatch.ts` — consumed by `search-hub.ts` and `integration.test.ts`

**Auth-boundary crossings:**
- `extensions/backends/openai-codex.ts:100` — `authStorage.getApiKey("openai-codex")` — new Pi-managed auth pattern (first backend to use it)
- `extensions/search-hub.ts:388` — `resolveBackendKey("jina", config)` — existing config/env auth

## Precedents

No relevant precedents found in git history.

## Recommendation

**Blockers (3):**
1. Add validation/normalization for `combineMode` config value (I1)
2. Fix `search-status` display to accurately reflect openai-codex auth state (I2)
3. Add `timeoutSignal` wrapper to openai-codex stream call (I3)

**Non-blocking:**
- Add end-to-end test for targeted combine branching (Q2)
- Handle missing snippet gracefully in normalizeSearchResult (Q7)
- Add unit tests for URL normalization helpers (Q8-Q10)
- Consider skipCache option for runTargetedCombine (I4, low priority)

## Code References

- `extensions/types.ts:40` — `combineMode?: "all" | "targeted"`
- `extensions/search-hub.ts:128` — `const combineMode = config.combineMode ?? "all"`
- `extensions/search-hub.ts:160` — `if (combineMode === "targeted") {`
- `extensions/search-hub.ts:835` — status display for enabled backends
- `extensions/credentials.ts:112-127` — `getKeySource` returns `{ configured: false, source: "" }` for openai-codex
- `extensions/backends/openai-codex.ts:71` — raw `signal` passed without `timeoutSignal`
- `extensions/utils.ts:55-58` — `timeoutSignal` definition
- `extensions/backends/openai-codex.ts:179` — `if (!snippet) return null`
- `extensions/backends/registry.ts:327` — cache stores empty results
- `extensions/dispatch.ts:60-97` — `runTargetedCombine` loop
