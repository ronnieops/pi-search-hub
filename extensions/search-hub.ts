/**
 * Extension — Unified web search (19 backends) + content extraction (web_read)
 *
 * Backends (choose any, all disabled by default):
 *   duckduckgo    — ✅ Free, no key, via Python ddgs lib. Rate-limited.
 *   jina          — ✅ Free tier (API key optional for higher rate limits), full markdown via s.jina.ai
 *   marginalia    — ✅ Anti-SEO, "public" key optional. 354ms avg
 *   serper        — ✅ Google via serper.dev, 2500 free/mo. 667ms
 *   brave         — ✅ Brave Search, 2000 free/mo. 460ms
 *   tavily        — ✅ AI search, 1000 free/mo. 356ms BEST QUALITY
 *   exa           — ✅ AI-native, 1000 free/mo. 137ms FASTEST
 *   firecrawl     — ✅ Search+crawl, keyless 1000 credits/mo (optional key). 644ms
 *   langsearch    — ✅ Free tier, no CC. 1816ms
 *   websearchapi  — ✅ Google-powered, 2000 free credits. 1323ms
 *   perplexity    — ✅ Unlimited free Sonar, citation-based answers
 *   searxng       — ✅ Self-hosted, 70+ aggregators. Needs instance URL
 *
 * Tools: web_search (auto-fallback + RRF combine modes), web_read (URL content)
 * Config: ~/.pi/agent/extensions/search.json + .pi/search.json (project wins)
 * Credentials: env var refs (ALL_CAPS), shell commands (!command), or literal keys
 *
 * Statusline activity: Shows "search" status during search operations
 *
 * Example .pi/search.json:
 *   {
 *     "defaultBackend": "auto",
 *     "backends": {
 *       "duckduckgo": { "enabled": true },
 *       "marginalia": { "enabled": true },
 *       "serper": { "enabled": true, "apiKey": "..." },
 *       "tavily": { "enabled": true, "apiKey": "..." },
 *       "exa": { "enabled": true, "apiKey": "..." },
 *       "firecrawl": { "enabled": true, "apiKey": "..." },
 *       "langsearch": { "enabled": true, "apiKey": "..." },
 *       "websearchapi": { "enabled": true, "apiKey": "..." },
 *       "perplexity": { "enabled": true, "apiKey": "..." },
 *       "searxng": { "enabled": true, "instanceUrl": "http://localhost:8888" }
 *     }
 *   }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import type { BackendConfig, SearchConfig, SearchResult, SearchResultWithBackend } from "./types.js";
import { getAgentDir, timeoutSignal, sanitizeError, clearCooldowns, MISSING_KEY_HELP, validateUrl } from "./utils.js";
import { resolveBackendKey, getKeySource } from "./credentials.js";
import { fetchSofya } from "./backends/sofya.js";
import { fetchFirecrawl } from "./backends/firecrawl.js";
import { fetchExaContents } from "./backends/exa.js";
import { fetchExaMCP } from "./backends/exa-mcp.js";
import { config, refreshConfig, getActiveBackends, recordLatency, latencyMap } from "./config.js";
import { BACKEND_DEFS, runBackend } from "./backends/registry.js";
import { selectBackendsForFallback, reciprocalRankFusion, runTargetedCombine } from "./dispatch.js";
import { formatResults, formatCombinedResults, formatResultsCompact, formatCombinedResultsCompact } from "./formatters.js";

/** Cap on a single web_read response body, in bytes, to bound memory use on heavy pages. */
const READ_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// Tool: web_search
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using one of several backend search engines. " +
			"Supports DuckDuckGo (free, no key), " +
			"Marginalia Search (free, shared public key), Serper, Tavily, Exa, Brave, " +
			"LangSearch, Firecrawl, WebSearchAPI, Perplexity Sonar, and SearXNG (most need API keys). " +
			"The best available backend is used automatically. " +
			"Use combine=true to query all enabled backends in parallel for broader coverage. " +
			"Use for fact-finding, research, documentation lookups, and current events.",
		promptSnippet: "Search the web (supports multiple search backends)",
		promptGuidelines: [
			"Use web_search when you need up-to-date information, facts, or documentation from the web",
			"Auto mode tries enabled backends in order (DuckDuckGo is the free fallback)",
			"Set combine=true to query enabled backends in parallel and merge/deduplicate results",
			"Set combineMode=targeted in search.json to cap combine fan-out while still using multiple backends",
			"Configure additional backends in .pi/search.json for better quality results",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (natural language works best)",
			}),
			numResults: Type.Optional(
				Type.Number({
					description: "Number of results (1-20, default 10)",
					default: 10,
				}),
			),
			backend: Type.Optional(
				StringEnum(["duckduckgo", "jina", "marginalia", "serper", "tavily", "exa", "exa_mcp",
					"openai-codex", "brave", "brave-llm", "langsearch", "firecrawl", "websearchapi", "perplexity",
					"searxng", "linkup", "youcom", "fastcrw", "sofya", "auto"] as const, {
					description:
						"Backend to use. 'auto' picks the best configured backend (default)",
				}),
			),
			combine: Type.Optional(
				Type.Boolean({
					description:
						"When true, queries enabled backends in parallel and merges/deduplicates results. " +
						"Config combineMode controls whether this uses all backends or targeted fan-out. " +
						"Default is false (fallback mode: uses first successful backend only). " +
						"Ignored when a specific backend is requested (backend != 'auto').",
					default: false,
				}),
			),
			compact: Type.Optional(
				Type.Boolean({
					description:
						"When true, returns compact single-line results (title + URL). " +
						"Can also be set as default in search.json config. Default: false (verbose).",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshConfig(ctx.cwd);
			const numResults = Math.max(1, Math.min(params.numResults ?? 10, 20));
			const requestedBackend = params.backend || "auto";
			const combine = params.combine ?? false;
			const compact = params.compact ?? config.compact ?? false;
			const combineMode = (() => {
				const raw = config.combineMode;
				if (raw === "all" || raw === "targeted") return raw;
				if (raw !== undefined) {
					console.warn(`search-hub: unrecognized combineMode "${raw}", falling back to "all"`);
				}
				return "all";
			})();
			// If config has combine:true, force combine mode regardless of LLM choice
			const forceCombine = config.combine === true;
			const effectiveCombine = forceCombine || combine;

			// Helper to update statusline
			const setStatus = (status: string) => {
				ctx.ui.setStatus("search", status);
				onUpdate?.({ content: [{ type: "text", text: `*${status}*` }] });
			};

			if (requestedBackend !== "auto") {
				// Specific backend requested — try it directly
				const backendLabel = BACKEND_DEFS[requestedBackend]?.label || requestedBackend;
				setStatus(`🔍 ${backendLabel}: searching...`);
				try {
					const results = await runBackend(requestedBackend, params.query, numResults, signal);
					setStatus(`🔍 ${backendLabel}: ${results.length} results`);
					return {
						content: [{ type: "text", text: compact ? formatResultsCompact(results) : formatResults(params.query, requestedBackend, results) }],
						details: { backend: requestedBackend, resultCount: results.length },
					};
				} catch (err) {
					setStatus(`❌ ${backendLabel}: failed`);
					throw err;
				}
			}

			// Auto mode
			const activeBackends = getActiveBackends();

			if (effectiveCombine) {
				if (combineMode === "targeted") {
					const orderedBackends = selectBackendsForFallback(
						config.selectionStrategy ?? "sequential",
						activeBackends,
					);
					setStatus(`🔍 targeted combine: up to 3 of ${activeBackends.length} backends...`);
					const {
						results: combined,
						backendStats,
						usableBackendCount,
					} = await runTargetedCombine({
						orderedBackends,
						query: params.query,
						numResults,
						signal,
						runBackend,
					});

					if (usableBackendCount === 0) {
						setStatus(`❌ targeted combine: no usable backends`);
						const errors = Array.from(backendStats.entries()).map(([backend, stats]) => (
							stats.success
								? `${backend}: 0 results`
								: `${backend}: ${stats.error || "failed"}`
						));
						throw new Error(`Targeted combine found no usable backend results: ${errors.join("; ")}`);
					}

					const attemptedCount = backendStats.size;
					const incomplete = usableBackendCount < 3 ? `, exhausted after ${usableBackendCount} usable` : "";
					setStatus(`🔍 targeted combined: ${combined.length} results (${usableBackendCount}/${attemptedCount} usable${incomplete})`);

					return {
						content: [
							{
								type: "text",
								text: compact
									? formatCombinedResultsCompact(combined)
									: formatCombinedResults(params.query, combined, backendStats, BACKEND_DEFS),
							},
						],
						details: {
							backend: "combined-targeted",
							resultCount: combined.length,
							usableBackendCount,
							backendStats: Object.fromEntries(backendStats),
						},
					};
				}

				// Combine mode: query all enabled backends in parallel
				setStatus(`🔍 combine: ${activeBackends.length} backends...`);
				const resultsPerBackend = await Promise.all(
					activeBackends.map(async (backend) => {
						try {
							const results = await runBackend(
								backend,
								params.query,
								Math.ceil(numResults / activeBackends.length),
								signal,
							);
							return {
								backend,
								results: results.map((r) => ({ ...r, backend })) as SearchResultWithBackend[],
								success: true,
							};
						} catch (err) {
							return {
								backend,
								results: [] as SearchResultWithBackend[],
								success: false,
								error: (err as Error).message,
							};
						}
					}),
				);

				// Build backend stats map
				const backendStats = new Map<
					string,
					{ success: boolean; count: number; error?: string }
				>();

				for (const { backend, results, success, error } of resultsPerBackend) {
					backendStats.set(backend, {
						success,
						count: results.length,
						error,
					});
				}

				// Merge and re-rank using Reciprocal Rank Fusion
				const successfulBackends = resultsPerBackend
					.filter(r => r.success && r.results.length > 0)
					.map(r => ({ backend: r.backend, results: r.results }));

				const combined = successfulBackends.length > 0
					? reciprocalRankFusion(successfulBackends, numResults)
					: [];

				const successCount = successfulBackends.length;
				const failCount = activeBackends.length - successCount;
				setStatus(`🔍 combined: ${combined.length} results (${successCount} ok${failCount > 0 ? `, ${failCount} failed` : ""})`);

				return {
					content: [
						{
							type: "text",
							text: compact
								? formatCombinedResultsCompact(combined)
							: formatCombinedResults(params.query, combined, backendStats, BACKEND_DEFS),
						},
					],
					details: {
						backend: "combined",
						resultCount: combined.length,
						backendStats: Object.fromEntries(backendStats),
					},
				};
			} else {
				// Fallback mode: select backends using configured strategy
				const orderedBackends = selectBackendsForFallback(
					config.selectionStrategy ?? "sequential",
					activeBackends,
				);
				const errors: string[] = [];
				for (const backend of orderedBackends) {
					const backendLabel = BACKEND_DEFS[backend]?.label || backend;
					const t0 = Date.now();
					setStatus(`🔍 ${backendLabel}: searching...`);
					try {
						const results = await runBackend(backend, params.query, numResults, signal);
						recordLatency(backend, Date.now() - t0);
						setStatus(`🔍 ${backendLabel}: ${results.length} results`);
						return {
							content: [
								{
									type: "text",
									text: errors.length > 0
										? `${errors.join("; ")}\n\n${compact ? formatResultsCompact(results) : formatResults(params.query, backend, results)}`
										: (compact ? formatResultsCompact(results) : formatResults(params.query, backend, results)),
								},
							],
							details: {
								backend: errors.length > 0 ? `${backend} (fallback)` : backend,
								resultCount: results.length,
								errors: errors.length > 0 ? errors : undefined,
							},
						};
					} catch (err) {
						errors.push(`${backend}: ${(err as Error).message}`);
						setStatus(`❌ ${backendLabel}: failed, trying next...`);
					}
				}

				setStatus(`❌ all backends failed`);
				throw new Error(`All backends failed: ${errors.join("; ")}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// Tool: web_read — Read/extract content from a URL
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "web_read",
		label: "Read Web Page",
		description:
			"Fetch a URL as markdown. Use objective for a concrete question, keywords for long pages, " +
			"rush for speed, smart for better narrowing. Use reader param to switch between " +
			"Jina (default, free) and Sofya (250+ site parsers, needs API key).",
		promptSnippet: "Read content from a web page (supports markdown extraction)",
		promptGuidelines: [
			"Use web_read when you need to read the content of a specific URL",
			"Set objective for a concrete question when only part of the page matters",
			"Add keywords for long pages when you know the relevant terms",
			"Choose rush for speed or smart for higher-quality narrowing",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "HTTP(S) URL or bare domain to fetch",
			}),
			fresh: Type.Optional(
				Type.Boolean({
					description: "Bypass cache when freshness matters",
				}),
			),
			keywords: Type.Optional(
				Type.Array(Type.String(), {
					description: "Keyword to focus extraction on relevant sections",
				}),
			),
			mode: Type.Optional(
				StringEnum(["rush", "smart"] as const, {
					description: "rush = faster mode, smart = better section selection on long/noisy pages",
				}),
			),
			objective: Type.Optional(
				Type.String({
					description:
						"CSS selector for targeted extraction. Use when only part of the page matters. (Jina reader only.)",
				}),
			),
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
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshConfig(ctx.cwd);

			// Helper to update statusline for web_read
			const setStatus = (status: string) => {
				ctx.ui.setStatus("read", status);
				onUpdate?.({ content: [{ type: "text", text: `*${status}*` }] });
			};

			const url = params.url.startsWith("https://") || params.url.startsWith("http://")
				? params.url
				: `https://${params.url}`;

			const reader = params.reader ?? config.reader ?? "jina";
			const readerLabel = reader === "sofya" ? "Sofya" : reader === "firecrawl" ? "Firecrawl" : reader === "exa" ? "Exa" : reader === "exa_mcp" ? "Exa MCP" : "Jina";
			setStatus(`📄 ${readerLabel}: fetching...`);

			// SSRF guard — block private/internal addresses regardless of reader.
			const ssrfError = validateUrl(url);
			if (ssrfError) {
				throw new Error(ssrfError);
			}

			let content: string;
			if (reader === "sofya") {
				// Sofya Fetch: clean markdown via 250+ site-specific parsers.
				const sofyaKey = resolveBackendKey("sofya", config);
				if (!sofyaKey) {
					throw new Error(`Sofya reader selected but no API key configured. ${MISSING_KEY_HELP}`);
				}
				const result = await fetchSofya(url, sofyaKey, signal);
				content = result.content;
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
				if (result.warning) {
					ctx.ui.notify(result.warning, "warn");
				}
				content = result.content;
			} else if (reader === "exa_mcp") {
				// Exa MCP web_fetch: zero-config, no API key needed.
				const result = await fetchExaMCP(url, signal);
				content = result.content;
			} else {
				// Jina Reader: free, supports keywords / mode / objective hints.
				const readerUrl = new URL("https://r.jina.ai/" + url);

				const headers: Record<string, string> = {
					"Accept": "text/plain",
				};

				// Optional Jina API key for higher rate limits (fallback to no-auth)
				const jinaKey = resolveBackendKey("jina", config);
				if (jinaKey) {
					headers["Authorization"] = `Bearer ${jinaKey}`;
				}

				if (params.fresh) {
					headers["x-no-cache"] = "true";
				}
				if (params.keywords && params.keywords.length > 0) {
					headers["x-keywords"] = params.keywords.join(", ");
				}
				if (params.mode) {
					headers["x-respond-with"] = params.mode === "rush" ? "text" : "markdown";
				}
				if (params.objective) {
					headers["x-target-selector"] = params.objective;
				}

				const response = await fetch(readerUrl.toString(), {
					signal: timeoutSignal(signal),
					headers,
				});

				if (!response.ok) {
					const text = await response.text().catch(() => "");
					throw new Error(`Failed to read ${url}: ${sanitizeError(response.status, text)}`);
				}

				// Size guard — refuse oversized payloads before buffering into memory.
				const contentLength = parseInt(response.headers.get("content-length") ?? "", 10);
				if (Number.isFinite(contentLength) && contentLength > READ_MAX_BYTES) {
					throw new Error(`Failed to read ${url}: response too large (${contentLength} bytes, limit ${READ_MAX_BYTES})`);
				}

				content = await response.text();
			}

			setStatus(`📄 ${readerLabel}: ${content.length} chars`);

			const truncated = content.length > 10000
				? content.slice(0, 10000) + `\n\n[... truncated, full length: ${content.length} chars]`
				: content;

			return {
				content: [{ type: "text", text: truncated }],
				details: {
					url,
					reader,
					length: content.length,
					truncated: content.length > 10000,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	pi.registerCommand("search-setup", {
		description: "Configure search backends interactively",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/search-setup requires interactive mode", "error");
				return;
			}

			// Build backend list with rate limits for free backends
			const backendList = Object.entries(BACKEND_DEFS)
				.filter(([_, d]) => d.setupLabel !== null)
				.map(([k, d]) => {
					let label = d.setupLabel!;
					// Add rate limit hints for free backends
					if (k === "duckduckgo") label += " (rate-limited)";
					if (k === "marginalia") label += " (rate-limited)";
					if (k === "jina") label += " (1000/mo free)";
					if (k === "exa_mcp") label += " (rate-limited)";
					if (k === "searxng") label += " (self-hosted)";
				return label;
			});

			const option = await ctx.ui.select("Which backend do you want to configure?", [
				...backendList,
				"⚡ Enable all free backends",
				"⚙️ Global settings",
				"✅ Done — save and exit",
			]);

			const backendKey: Record<string, string> = Object.fromEntries(
				Object.entries(BACKEND_DEFS)
					.filter(([_, d]) => d.setupLabel !== null)
					.map(([k, d]) => {
						let label = d.setupLabel!;
						if (k === "duckduckgo") label += " (rate-limited)";
						if (k === "marginalia") label += " (rate-limited)";
						if (k === "jina") label += " (1000/mo free)";
						if (k === "exa_mcp") label += " (rate-limited)";
						if (k === "searxng") label += " (self-hosted)";
					return [label, k];
				})
			);

			if (!option || option.startsWith("✅ Done")) {
				ctx.ui.notify("Search setup complete.", "info");
				return;
			}

			if (option === "⚙️ Global settings") {
				await configureGlobalSettings(ctx);
				return;
			}

			if (option === "⚡ Enable all free backends") {
				await enableAllFreeBackends(ctx);
				return;
			}

			const backend = backendKey[option!];
			const def = BACKEND_DEFS[backend];
			const label = option;

			// Free backends (needsKey: false) can be enabled without API key
			if (!def.needsKey) {
				// Auto-enable free backends directly
				const configDir = join(getAgentDir(), "extensions");
				const configPath = join(configDir, "search.json");
				mkdirSync(configDir, { recursive: true });

				let existing: SearchConfig = {};
				if (existsSync(configPath)) {
					try {
						existing = JSON.parse(readFileSync(configPath, "utf-8"));
					} catch {
						// ignore
					}
				}

				// Handle backends needing instance URL (e.g. SearXNG)
				let backendConfig: BackendConfig = { enabled: true };
				if (def.needsInstanceUrl) {
					const instanceUrl = await ctx.ui.input("Enter your instance URL (e.g. http://localhost:8888):", {
						placeholder: "http://localhost:8888",
						validate: (v: string) =>
							v.trim().length > 0 ? undefined : "URL cannot be empty",
					});
					if (!instanceUrl) {
						ctx.ui.notify("Setup cancelled.", "info");
						return;
					}
					backendConfig.instanceUrl = instanceUrl.trim();
					// Optionally ask for API key (some instances require auth)
					const optKey = await ctx.ui.input("Optional API key (press Enter to skip):", {
						placeholder: "sk-... (optional)",
				});
					if (optKey && optKey.trim()) {
						backendConfig.apiKey = optKey.trim();
					}
				} else if (def.optionalKey) {
					// Optionally ask for API key if optional
					const optKey = await ctx.ui.input("Optional API key (press Enter to skip):", {
						placeholder: "sk-... (optional)",
					});
					if (optKey && optKey.trim()) {
						backendConfig.apiKey = optKey.trim();
					}
				}

				const updated: SearchConfig = {
					...existing,
					backends: {
						...existing.backends,
						[backend]: backendConfig,
					},
				};

				writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
				ctx.ui.notify(`${label} enabled. Run /reload to activate.`, "success");
				return;
			}

			const key = await ctx.ui.input(`Enter your ${label} API key:`, {
				placeholder: "sk-...",
				validate: (v: string) =>
					v.trim().length > 0 ? undefined : "Key cannot be empty",
			});

			if (!key) {
				ctx.ui.notify("Setup cancelled.", "info");
				return;
			}

			const configDir = join(getAgentDir(), "extensions");
			const configPath = join(configDir, "search.json");

			mkdirSync(configDir, { recursive: true });

			let existing: SearchConfig = {};
			if (existsSync(configPath)) {
				try {
					existing = JSON.parse(readFileSync(configPath, "utf-8"));
				} catch {
					// ignore
				}
			}

			// SearXNG setup needs both instance URL and optional API key
			let backendConfig: BackendConfig = { enabled: true };
			if (backend === "searxng") {
				const url = await ctx.ui.input("Enter your SearXNG instance URL (e.g. http://localhost:8888):", {
					placeholder: "http://localhost:8888",
					validate: (v: string) =>
						v.trim().length > 0 ? undefined : "URL cannot be empty",
				});
				if (!url) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				backendConfig.instanceUrl = url.trim();
				// Optionally ask for API key (some instances require auth)
				const optionalKey = await ctx.ui.input("Optional API key (leave empty if none):", {
					placeholder: "sk-... (optional)",
				});
				if (optionalKey && optionalKey.trim()) {
					backendConfig.apiKey = optionalKey.trim();
				}
			} else {
				backendConfig.apiKey = key?.trim() || "";
			}

			const updated: SearchConfig = {
				...existing,
				backends: {
					...existing.backends,
					[backend]: backendConfig,
				},
			};

			writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });

			ctx.ui.notify(
				`${label} API key saved to ${configPath}. Run /reload to activate.`,
				"success",
			);
		},
	});

	// -------------------------------------------------------------------------
	// Enable all free backends
	// -------------------------------------------------------------------------

	async function enableAllFreeBackends(ctx: ExtensionContext) {
		const configDir = join(getAgentDir(), "extensions");
		const configPath = join(configDir, "search.json");
		mkdirSync(configDir, { recursive: true });

		let existing: SearchConfig = {};
		if (existsSync(configPath)) {
			try {
				existing = JSON.parse(readFileSync(configPath, "utf-8"));
			} catch {
				// ignore
			}
		}

		// List of free backends to enable
		const freeBackends = [
			"duckduckgo",
			"jina",
			"marginalia",
			"exa_mcp",
			"searxng",
		];

		const updated: SearchConfig = {
			...existing,
			backends: {
				...existing.backends,
				...Object.fromEntries(
					freeBackends.map(name => [name, { enabled: true }])
				),
			},
		};

		writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
		ctx.ui.notify(
			`Enabled: DuckDuckGo, Jina, Marginalia, Exa MCP, SearXNG. Run /reload to activate.`,
			"success",
		);
	}

	// -------------------------------------------------------------------------
	// Global settings configuration
	// -------------------------------------------------------------------------

	async function configureGlobalSettings(ctx: ExtensionContext) {
		const configDir = join(getAgentDir(), "extensions");
		const configPath = join(configDir, "search.json");
		mkdirSync(configDir, { recursive: true });

		let existing: SearchConfig = {};
		if (existsSync(configPath)) {
			try {
				existing = JSON.parse(readFileSync(configPath, "utf-8"));
			} catch {
				// ignore
			}
		}

		const settings = [
			["compact", "Compact output", existing.compact ? "On" : "Off"],
			["showStatus", "Show status line", existing.showStatus !== false ? "On" : "Off"],
			["combine", "Combine mode (parallel search)", existing.combine ? "On" : "Off"],
			["combineMode", "Combine strategy", existing.combineMode ?? "all"],
			["cacheTtl", "Cache TTL (ms)", String(existing.cacheTtl ?? 300000)],
			["cacheMax", "Max cached queries", String(existing.cacheMax ?? 100)],
			["reader", "Web reader", existing.reader ?? "jina"],
			["selectionStrategy", "Selection strategy", existing.selectionStrategy ?? "sequential"],
		];

		const labels = settings.map(([key, label, current]) => `${label}: ${current}`);
		labels.push("✅ Done — save and exit");

		const selected = await ctx.ui.select("Configure global settings:", labels);
		if (!selected || selected === "✅ Done — save and exit") {
			ctx.ui.notify("Global settings saved.", "info");
			return;
		}

		// Find which setting was selected
		const idx = labels.indexOf(selected);
		if (idx < 0 || idx >= settings.length) {
			ctx.ui.notify("Setup cancelled.", "info");
			return;
		}

		const [key, label] = settings[idx];
		let value: unknown;

		switch (key) {
			case "compact":
			case "showStatus":
			case "combine": {
				const toggle = await ctx.ui.select(`${label} — current: ${selected.split(": ")[1]}`, ["On", "Off", "Cancel"]);
				if (toggle === "Cancel" || !toggle) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				value = toggle === "On";
				break;
			}
			case "combineMode": {
				const choice = await ctx.ui.select(`${label} — current: ${selected.split(": ")[1]}`, ["all", "targeted", "Cancel"]);
				if (choice === "Cancel" || !choice) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				value = choice;
				break;
			}
			case "cacheTtl":
			case "cacheMax": {
				const input = await ctx.ui.input(`${label} — current: ${selected.split(": ")[1]}`, {
					placeholder: selected.split(": ")[1],
					validate: (v) => /\d+/.test(v) ? undefined : "Must be a number",
				});
				if (!input) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				value = parseInt(input, 10);
				break;
			}
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
			case "selectionStrategy": {
				const choice = await ctx.ui.select(`${label} — current: ${selected.split(": ")[1]}`, [
					"sequential", "random", "round-robin", "best-latency", "Cancel",
				]);
				if (choice === "Cancel" || !choice) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				value = choice;
				break;
			}
			default:
				ctx.ui.notify("Unknown setting.", "error");
				return;
		}

		const updated: SearchConfig = { ...existing, [key]: value };
		writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
		ctx.ui.notify(`${label} set. Run /reload to apply.`, "success");

		// Allow configuring another setting
		await configureGlobalSettings(ctx);
	}

	pi.registerCommand("search-status", {
		description: "Show which search backends are configured and active",
		handler: async (_args, ctx) => {
			refreshConfig(ctx.cwd);

			const backendLabels: Record<string, string> = Object.fromEntries(
				Object.entries(BACKEND_DEFS).map(([k, v]) => [k, `${v.label}${k === "duckduckgo" ? " (free, no key)" : ""}`])
			);

			// Collect table rows first to compute aligned column widths
			type Row = [string, string, string];
			const rows: Row[] = [];

			for (const [name, label] of Object.entries(backendLabels)) {
				const { configured, source } = getKeySource(name, config);
				const bc = config.backends?.[name as keyof typeof config.backends];
				const samples = latencyMap.get(name) ?? [];
				const avgLatency = samples.length > 0
					? `${Math.round(samples.reduce((sum, s) => sum + s.ms, 0) / samples.length)}ms`
					: "\u2014";

				if (name === "duckduckgo") {
					rows.push([label, "\u2713 enabled, key: \u2014 (free)", avgLatency]);
				} else if (name === "marginalia" && bc?.enabled) {
					rows.push([label, "\u2713 enabled, key: optional (public)", avgLatency]);
				} else if (name === "searxng" && bc?.enabled) {
					const urlInfo = bc.instanceUrl ? `url: ${bc.instanceUrl}` : "no URL set";
					rows.push([label, `\u2713 enabled, ${urlInfo}${configured ? `, key: \u2713 (${source})` : ", key: \u2014"}`, avgLatency]);
				} else if (bc?.enabled) {
					const keyStatus = configured
						? `\u2713${source ? ` (${source})` : ""}`
						: "\u2014 (Pi auth)";
					rows.push([label, `\u2713 enabled, key: ${keyStatus}`, avgLatency]);
				} else {
					rows.push([label, `\u2014 disabled${configured ? `, key: \u2713 (${source})` : ""}`, avgLatency]);
				}
			}

			// Compute column widths from headers + data
			const col1Header = "Backend";
			const col2Header = "Status";
			const col3Header = "Avg Latency";
			const w1 = rows.reduce((max, [c]) => Math.max(max, c.length), col1Header.length);
			const w2 = rows.reduce((max, [, s]) => Math.max(max, s.length), col2Header.length);
			const w3 = rows.reduce((max, [, , s]) => Math.max(max, s.length), col3Header.length);

			const pad = (s: string, w: number) => s + " ".repeat(w - s.length);

			const tableLines = [
				`| ${pad(col1Header, w1)} | ${pad(col2Header, w2)} | ${pad(col3Header, w3)} |`,
				`| ${"-".repeat(w1)} | ${"-".repeat(w2)} | ${"-".repeat(w3)} |`,
				...rows.map(([c1, c2, c3]) => `| ${pad(c1, w1)} | ${pad(c2, w2)} | ${pad(c3, w3)} |`),
			];

			const activeBackends = getActiveBackends();
			const resolvedDefault = activeBackends[0] || "none";
			const lines: string[] = [
				"## Search Backend Status",
				`Configured default: ${config.defaultBackend || "none"}`,
				`Resolved default: ${resolvedDefault}`,
				`Combine mode: ${config.combine ? (config.combineMode || "all") : "off"}`,
				`Strategy: ${config.selectionStrategy || "sequential"}`,
				`Active: ${activeBackends.join(", ") || "none"}`,
				"",
				...tableLines,
			];

			if (activeBackends.length === 1 && activeBackends[0] === "duckduckgo") {
				lines.push("");
				lines.push("Only DuckDuckGo is active (no API key needed).");
				lines.push("Add a search backend with /search-setup to get more results.");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});


	// -----------------------------------------------------------------------
	// Session start
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		clearCooldowns();
		refreshConfig(ctx.cwd);
		if (config.showStatus !== false) {
			const status = getActiveBackends().join(", ");
			ctx.ui.setStatus("search", `search: ${status}`);
		}
	});
}
