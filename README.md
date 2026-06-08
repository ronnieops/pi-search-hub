# pi-search-hub

Unified web search + content extraction extension for [pi](https://pi.dev) with **17 backend providers** (all working). One `web_search` tool, one `web_read` tool (pluggable reader: Jina or Sofya), auto-fallback, RRF-ranked combine mode, and credential resolution via env/shell/literal.

## Installation

```bash
pi install npm:pi-search-hub
```

> **Note for DuckDuckGo backend:** Requires the `ddgs` Python package. Install with:
>
> - Linux/macOS: `pip3 install ddgs`
> - Windows: `pip install ddgs`

## Usage

### Web Search

After installing, just ask naturally:

```text
Search for recent AI agent frameworks.
```

```text
What's the latest news on Llama 4?
```

Or use the tools directly — the agent picks the best configured backend automatically:

- `web_search` — search the web with auto-fallback or parallel combine mode
- `web_read` — fetch any URL as clean markdown

### Combine Mode

Set `combine=true` to query **ALL enabled backends in parallel** with Reciprocal Rank Fusion (RRF) ranking:

```text
Search for "Rust vs Go performance benchmarks" with combine=true to get results from all backends
```

**Combine mode benefits:**

- Broader coverage across multiple search indexes
- Results ranked by RRF — position-based scoring across all backends
- Each result shows which backend found it
- URL deduplication with content-aware merge (prefers richest result)
- Useful for comprehensive research or when you want diverse sources

**Tradeoff:** Uses more API quota per query (all backends are called), but you get more comprehensive results.

### Read Web Pages

Fetch any URL as clean markdown — great for extracting article content, docs, or reference pages.
**Note: `web_read` uses [Jina Reader](https://r.jina.ai/) by default. Set `reader` to choose the engine.**

```text
Read https://docs.example.com/api-reference
```

The `web_read` tool supports:

- **reader**: `jina` (default, free, no key) or `sofya` ([Sofya](https://sofya.co) Fetch, 250+ site-specific parsers, needs an API key). Set a project-wide default with `"reader"` in `search.json`, or override per call.
- **objective**: CSS selector to target specific content (e.g. "div.article-body") _(Jina reader only)_
- **keywords**: relevant terms to highlight on long pages _(Jina reader only)_
- **mode**: `rush` for speed (return innerText) or `smart` (markdown extraction) _(Jina reader only)_
- **fresh**: bypass cache when freshness matters

## Supported Backends

| #   | Backend               | Free Tier                     | API Key? | How to get key                                                    |
| --- | --------------------- | ----------------------------- | :------: | ----------------------------------------------------------------- |
| 1   | **DuckDuckGo**        | Unlimited (rate-limited)      |  **No**  | `pip install ddgs` (Linux/macOS: `pip3`)                          |
| 2   | **Jina AI**           | Search: key req. web_read: free (no key) |   Yes   | [jina.ai](https://jina.ai)   |
| 3   | **Marginalia Search** | Unlimited (rate-limited)      | **No**†  | [marginalia.nu](https://www.marginalia.nu/marginalia-search/api/) |
| 4   | **Tavily**            | 1,000 calls/month             |   Yes    | [tavily.com](https://tavily.com)                                  |
| 5   | **Serper** (Google)   | 2,500 free queries (one-time) |   Yes    | [serper.dev](https://serper.dev)                                  |
| 6   | **Brave**             | 2,000 queries/month           |   Yes    | [brave.com/search/api](https://brave.com/search/api)              |
| 7   | **Firecrawl**         | 500 free credits              |   Yes    | [firecrawl.dev](https://www.firecrawl.dev)                        |
| 8   | **Exa**               | 1,000 free queries/month      |   Yes    | [exa.ai](https://dashboard.exa.ai/api-keys)                       |
| 9   | **LangSearch**        | Genuinely free, no CC         |   Yes    | [langsearch.com](https://langsearch.com)                          |
| 10  | **WebSearchAPI.ai**   | 2,000 free credits            |   Yes    | [websearchapi.ai](https://www.websearchapi.ai)                    |
| 11  | **Perplexity Sonar**  | Paid (usage-based)            |   Yes    | [perplexity.ai](https://docs.perplexity.ai)                       |
| 12  | **SearXNG**           | Self-hosted, unlimited        |  **No**  | [docs.searxng.org](https://docs.searxng.org)                      |
| 13  | **Brave LLM**         | Shares Brave key & quota      |   Yes    | [brave.com/search/api](https://brave.com/search/api)              |
| 14  | **Linkup**            | $20 free credit (EU/GDPR)     |   Yes    | [linkup.so](https://www.linkup.so)                                |
| 15  | **You.com**           | $100 free credits             |   Yes    | [you.com](https://api.you.com)                                    |
| 16  | **fastCRW**           | 500 free/month, self-hostable |   Yes    | [fastcrw.com](https://www.fastcrw.com)                            |
| 17  | **Sofya**             | 1,000 credits on GitHub signup |  Yes    | [sofya.co](https://sofya.co)                                      |

> † Marginalia Search uses `public` as a shared API key — no registration required, but subject to a shared rate limit.
>
> **Jina AI:** Search (`s.jina.ai`) requires a free API key from [jina.ai](https://jina.ai). Content extraction via `web_read` uses Jina Reader (`r.jina.ai`) which is **free and needs no API key**.
>
> **Perplexity Sonar** supports multiple model variants. Set `model` in your Perplexity backend config to choose: `sonar` (default, fast), `sonar-pro` (higher quality), `sonar-deep-research` (multi-step reasoning), or `sonar-reasoning` (DeepSeek R1-based).
>
> **SearXNG** is a self-hosted metasearch engine. Run your own instance (or use a public one), no API key required. Configure the instance URL in `.pi/search.json`.
>
> **Firecrawl** uses `api.firecrawl.dev/v2/search` with a `data.web[]` response shape. The v1 endpoint is deprecated.
>
> **Exa** (March 2026) includes content for the first 10 results per request at no extra cost. Content extraction is enabled by default.
>
> **Sofya** ([sofya.co](https://sofya.co)) gives **1,000 free credits when you sign up with GitHub**, and powers both a `web_search` backend and the `web_read` reader from one key. Search uses `POST /v1/search` (`basic` depth returns full extracted page content, ~3 credits; `snippets` returns SERP snippets, 1 credit, set via `searchDepth`). The `web_read` Sofya reader uses `POST /v1/fetch` (1 credit/URL) with 250+ site-specific parsers. Configure depth/topic per backend in `.pi/search.json`.

## Configuration

Configure backends globally (all projects) or per-project:

**Global:** `~/.pi/agent/extensions/search.json`
**Project:** `.pi/search.json` (project takes precedence)

```json
{
  "defaultBackend": "auto",
  "reader": "jina",
  "backends": {
    "duckduckgo": { "enabled": true },
    "jina": { "enabled": true, "apiKey": "JINA_API_KEY" },
    "sofya": { "enabled": true, "apiKey": "SOFYA_API_KEY", "searchDepth": "basic" },
    "marginalia": { "enabled": true },
    "serper": { "enabled": true, "apiKey": "SERPER_API_KEY" },
    "tavily": { "enabled": true, "apiKey": "TAVILY_API_KEY" },
    "brave": { "enabled": true, "apiKey": "BRAVE_API_KEY" },
    "exa": { "enabled": true, "apiKey": "EXA_API_KEY" },
    "firecrawl": { "enabled": true, "apiKey": "FIRECRAWL_API_KEY" },
    "langsearch": { "enabled": true, "apiKey": "LANGSEARCH_API_KEY" },
    "websearchapi": { "enabled": true, "apiKey": "WEBSEARCHAPI_API_KEY" },
    "perplexity": {
      "enabled": true,
      "apiKey": "PERPLEXITY_API_KEY",
      "model": "sonar"
    },
    "searxng": { "enabled": true, "instanceUrl": "http://localhost:8888" }
  }
}
```

### Credential Resolution

The `apiKey` field supports four formats (following pi-web-providers convention):

| `apiKey` value            | Resolved from                           | Example                            |
| ------------------------- | --------------------------------------- | ---------------------------------- |
| `"SERPER_API_KEY"`        | `process.env.SERPER_API_KEY`            | ALL_CAPS → env var                 |
| `"!pass show api/serper"` | stdout of shell command (cached)        | `!` prefix → exec                  |
| `"sk-abc123..."`          | Used as-is                              | Literal key (backwards compatible) |
| _(unset)_                 | `SEARCH_<BACKEND>_API_KEY` env fallback | Auto-enables backend               |

**Env var references:** Any ALL_CAPS string is treated as an environment variable name (not a literal). If the referenced env var is unset, a warning is printed (your literal key is not silently discarded).

**Shell commands:** Commands prefixed with `!` are executed via `execSync` with a 5s timeout. Results are cached and invalidated when config is reloaded (editing the config file clears the cache).

**Convenience env vars:** Backends are auto-enabled when these env vars are set (even with no config entry):

```bash
export SEARCH_SERPER_API_KEY="sk-..."
export SEARCH_TAVILY_API_KEY="sk-..."
export SEARCH_EXA_API_KEY="sk-..."
# ...
```

```json
{
  "backends": {
    "serper": { "enabled": true, "apiKey": "SERPER_API_KEY" }
  }
}
```

**To rotate a shell-command key:** Update the secret in your password manager, then trigger a config reload (edit the config file, or wait 10s for automatic refresh).

Or use the interactive setup:

```
/search-setup
```

## Commands

| Command          | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `/search-setup`  | Interactive prompt to configure API keys and instance URLs        |
| `/search-status` | Show which backends are active, which have keys, and their status |

> **Tip:** After running `/search-setup` or editing your config, run `/reload` to activate changes without restarting pi.

## How auto mode works

### Fallback Mode (default, `combine=false`)

1. Tries each enabled backend in order from your config
2. If a backend fails (rate limit, auth error, etc.), moves to the next one
3. Jina AI search requires a free API key from [jina.ai](https://jina.ai) (get one at jina.ai/reader). DuckDuckGo requires no API key. Both serve as safety nets
4. Returns results from the first backend that succeeds
5. If all backends fail, reports the collected errors

### Combine Mode (`combine=true`)

1. Queries **ALL** enabled backends in parallel
2. Each backend receives `numResults / numBackends` as a target
3. Results are merged using **Reciprocal Rank Fusion** (RRF) — position-based scoring that works across incompatible ranking systems
4. Each result shows its source backend (e.g., `*Source: Tavily*`)
5. URL dedup prefers the result with the richest content (content > snippet)
6. Backend statistics are displayed (which succeeded, result counts, errors)

### RRF Scoring

RRF assigns each result a score of `Σ(1 / (60 + rank_i))` across all backends that returned it. Results are ranked by score, then by number of backends that found them. This means a result ranked #1 by one backend and #5 by another beats a result ranked #4 by two backends.

## Security

- API keys are stored in local config files only (`~/.pi/agent/extensions/search.json` or `.pi/search.json`), never sent to any third party besides the chosen backend
- **Env vars and shell commands** are supported for credential resolution — the config file is trusted (you own it), but never commit plain API keys to version control
- DuckDuckGo queries use spawned Python subprocess (abortable via signal)
- All HTTP backends have a 30-second timeout; shell commands for credentials have a 5-second timeout
- Error messages are sanitized — API response bodies are truncated and key-like patterns are redacted
- The `.pi/` directory is in `.gitignore` — **never commit API keys to version control**

## Testing

```bash
# Run unit tests for backend parsers
npx vitest run backends/parsers.test.ts

# Quick test Jina AI (with your free API key)
curl -s -H "Authorization: Bearer $JINA_API_KEY" "https://s.jina.ai/?q=test&format=json" | jq .

# Quick test via curl with your configured key
curl -X POST "https://api.exa.ai/search" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $KEY" \
  -d '{"query": "test", "numResults": 3, "contents": {"text": true}}'

# Quick test Perplexity Sonar (use "sonar-pro" or "sonar-deep-research" for model)
curl -X POST "https://api.perplexity.ai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"model": "sonar", "messages": [{"role": "user", "content": "test"}], "search_context_size": "low"}'

# Quick test Firecrawl (v2 endpoint — code still uses v1)
curl -X POST "https://api.firecrawl.dev/v2/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"query": "test", "limit": 3}'

# Quick test SearXNG (replace URL with your instance)
curl "http://localhost:8888/search?q=test&format=json&count=3"
```

## Adding a new backend

Backends are registered via the `BACKEND_DEFS` registry in `extensions/search-hub.ts`. Define a `search` function and add one entry to the registry:

```typescript
const BACKEND_DEFS: Record<string, BackendRunner> = {
  // ... existing entries
  mybackend: {
    needsKey: true,
    needsKeyFromConfig: false,
    needsInstanceUrl: false,
    label: "My Backend",
    setupLabel: "My Backend (free tier description)",
    search: async (query, numResults, { key, signal }) => {
      const result = await searchMyBackend(query, numResults, key!, signal);
      return { results: result.results };
    },
  },
};
```

The registry handles dispatching, key resolution, formatting labels, and setup menu — no other edits needed.

## License

MIT

---

<p align="true">Proudly created with <a href="https://pi.dev">pi</a></p>
