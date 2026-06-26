# Autoresearch: Find bugs in pi-search-hub v2.7.0

## Objective
Systematically find all bugs, TypeScript errors, runtime issues, and code quality problems in the pi-search-hub extension. The extension provides 18 search backends + web_read content extraction for pi coding agent.

## Metrics
- **Primary**: ts_errors (count, lower is better) — TypeScript compilation errors from `npx tsc --noEmit`
- **Secondary**: test_failures (count), require_in_esm (count), unused_imports (count), any_types (count)

## How to Run
`./.auto/measure.sh` — outputs `METRIC name=number` lines.

## Files in Scope
- `extensions/` — All extension modules (search-hub.ts, config.ts, credentials.ts, utils.ts, dispatch.ts, scoring.ts, formatters.ts, cache-system.ts, spillover.ts, tool-persistence.ts, gfm-support.ts, content-negotiation.ts, sibling-probe.ts, tls-fingerprint.ts)
- `extensions/backends/` — All 18 backend implementations
- `backends/` — parsers.ts (response parsers)
- `tests/` — Integration tests
- `types/` — Type declarations

## Off Limits
- `node_modules/`
- `.git/`
- `docs/`
- `handoffs/`
- `.rpiv/`
- `.ralph/`

## Constraints
- No new dependencies
- No breaking API changes
- Must maintain backward compatibility
- All existing tests must still pass

## What's Been Tried
- Initial `npx tsc --noEmit` shows ~30 TypeScript errors across 5 files
- All 281 vitest tests pass
- Key issues found so far:
  1. `require()` calls in ESM context in utils.ts, spillover.ts, cache-system.ts
  2. TypeScript errors in config.ts (implicit any on backends index)
  3. TypeScript errors in tls-fingerprint.ts (type mismatches)
  4. TypeScript errors in content-negotiation.ts (implicit any params)
  5. TypeScript errors in duckduckgo.test.ts (mock type issues)
