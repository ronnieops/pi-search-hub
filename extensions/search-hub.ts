/**
 * Extension — Unified web search (18 backends) + content extraction (web_read)
 *
 * Backends (choose any, all disabled by default):
 *   duckduckgo    — ✅ Free, no key, via Python ddgs lib. Rate-limited.
 *   jina          — ✅ Free tier (API key optional for higher rate limits), full markdown via s.jina.ai
 *   marginalia    — ✅ Anti-SEO, "public" key optional. 354ms avg
 *   serper        — ✅ Google via serper.dev, 2500 free/mo. 667ms
 *   brave         — ✅ Brave Search, 2000 free/mo. 460ms
 *   tavily        — ✅ AI search, 1000 free/mo. 356ms BEST QUALITY
 *   exa           — ✅ AI-native, 1000 free/mo. 137ms FASTEST
 *   firecrawl     — ✅ Search+crawl, 500 free credits. 644ms
 *   langsearch    — ✅ Free tier, no CC. 1816ms
 *   websearchapi  — ✅ Google-powered, 2000 free credits. 1323ms
 *   perplexity    — ✅ Unlimited free Sonar, citation-based answers
 *   searxng       — ✅ Self-hosted, 70+ aggregators. Needs instance URL
 *
 * Tools: web_search (auto-fallback + RRF combine mode), web_read (URL content)
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
import { getAgentDir, timeoutSignal, sanitizeError, clearCooldowns, MISSING_KEY_HELP } from "./utils.js";
import { resolveBackendKey, getKeySource } from "./credentials.js";
import { fetchSofya } from "./backends/sofya.js";
import { config, refreshConfig, getActiveBackends, recordLatency, latencyMap } from "./config.js";
import { BACKEND_DEFS, runBackend } from "./backends/registry.js";
import { selectBackendsForFallback, reciprocalRankFusion } from "./dispatch.js";
import { formatResults, formatCombinedResults, formatResultsCompact, formatCombinedResultsCompact } from "./formatters.js";

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
			"Set combine=true to query ALL backends in parallel and merge/deduplicate results",
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
					"brave", "brave-llm", "langsearch", "firecrawl", "websearchapi", "perplexity",
					"searxng", "linkup", "youcom", "fastcrw", "sofya", "auto"] as const, {
					description:
						"Backend to use. 'auto' picks the best configured backend (default)",
				}),
			),
			combine: Type.Optional(
				Type.Boolean({
					description:
						"When true, queries ALL enabled backends in parallel and merges/deduplicates results. " +
						"Default is false (fallback mode: uses first successful backend only). " +
						"Ignored when a specific backend is requested (backend != 'auto').",
					default: false,
				}),
			),
			compact: Type.Optional(
				Type.Boolean({
					description:
						"When true, returns compact single-line results (title + URL). " +
						"Default is false (verbose markdown with snippets).",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			refreshConfig(ctx.cwd);
			const numResults = Math.max(1, Math.min(params.numResults ?? 10, 20));
			const requestedBackend = params.backend || "auto";
			const combine = params.combine ?? false;
			const compact = params.compact ?? false;
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
				StringEnum(["jina", "sofya"] as const, {
					description:
						"Reader backend: 'jina' (default, free, supports keywords/mode/objective) or " +
						"'sofya' (250+ site-specific parsers, needs API key). Overrides the configured default.",
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
			const readerLabel = reader === "sofya" ? "Sofya" : "Jina";
			setStatus(`📄 ${readerLabel}: fetching...`);

			let content: string;
			if (reader === "sofya") {
				// Sofya Fetch: clean markdown via 250+ site-specific parsers.
				const sofyaKey = resolveBackendKey("sofya", config);
				if (!sofyaKey) {
					throw new Error(`Sofya reader selected but no API key configured. ${MISSING_KEY_HELP}`);
				}
				const result = await fetchSofya(url, sofyaKey, signal);
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

			const backends = Object.values(BACKEND_DEFS)
				.filter(d => d.setupLabel !== null)
				.map(d => d.setupLabel!);

			const backendKey: Record<string, string> = Object.fromEntries(
				Object.entries(BACKEND_DEFS)
					.filter(([_, d]) => d.setupLabel !== null)
					.map(([k, d]) => [d.setupLabel!, k])
			);

			const option = await ctx.ui.select("Which backend do you want to configure?", [
				...backends,
				"✅ Done — save and exit",
			]);

			if (!option || option.startsWith("✅ Done")) {
				ctx.ui.notify("Search setup complete.", "info");
				return;
			}

			const backend = backendKey[option];
			const def = BACKEND_DEFS[backend];
			const label = option;

			// Free backends (needsKey: false) can be enabled without API key
			if (!def.needsKey) {
				const enable = await ctx.ui.select(
					`${label} is free and needs no API key. Enable it?`,
					["Yes, enable it", "Cancel"],
				);
				if (enable !== "Yes, enable it") {
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
					rows.push([label, `\u2713 enabled, key: \u2713${source ? ` (${source})` : ""}`, avgLatency]);
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
