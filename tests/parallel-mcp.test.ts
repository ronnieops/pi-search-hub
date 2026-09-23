import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchDuckDuckGo } from "../extensions/backends/duckduckgo.js";
import { BACKEND_DEFS, runBackend } from "../extensions/backends/registry.js";
import { searchParallelMCP } from "../extensions/backends/parallel-mcp.js";
import { config, refreshConfig } from "../extensions/config.js";
import { clearCooldowns } from "../extensions/utils.js";
import searchHub from "../extensions/search-hub.js";

vi.mock("../extensions/backends/duckduckgo.js", () => ({
	searchDuckDuckGo: vi.fn(),
}));

vi.mock("../extensions/backends/openai-codex.js", () => ({
	searchOpenAICodex: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async () => {
	const { Type } = await import("typebox");
	return {
		StringEnum: (values: string[]) => Type.Union(values.map(value => Type.Literal(value))),
	};
});

type WebSearchTool = {
	execute: (...args: any[]) => Promise<{
		content: Array<{ type: string; text?: string }>;
		details: { backend: string; resultCount: number };
	}>;
};

function createProject(searchConfig: Record<string, unknown>) {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-search-hub-parallel-"));
	const homeDir = join(tempRoot, "home");
	const projectDir = join(tempRoot, "project");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "search.json"), JSON.stringify(searchConfig));
	vi.stubEnv("HOME", homeDir);
	vi.stubEnv("USERPROFILE", homeDir);
	return { tempRoot, projectDir };
}

function registerSearchHub(projectDir: string) {
	refreshConfig(projectDir, true);
	const registeredTools = new Map<string, unknown>();
	const registeredCommands = new Map<string, unknown>();
	const eventHandlers = new Map<string, (...args: any[]) => unknown>();
	const context = { cwd: projectDir, ui: { setStatus: vi.fn() } };
	searchHub({
		registerTool: (tool: { name: string }) => registeredTools.set(tool.name, tool),
		registerCommand: (name: string, command: unknown) => {
			registeredCommands.set(name, command);
		},
		on: (event: string, handler: (...args: any[]) => unknown) => eventHandlers.set(event, handler),
	} as never);
	const sessionStartHandler = eventHandlers.get("session_start");
	if (!sessionStartHandler) throw new Error("Search hub did not register session_start.");
	return {
		webSearchTool: registeredTools.get("web_search") as WebSearchTool,
		registeredCommands,
		context,
		startSession: async () => {
			await sessionStartHandler({}, context);
		},
	};
}

describe("Parallel Search MCP backend", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let toolResult: Record<string, unknown>;
	let jsonRpcError: { code: number; message: string } | undefined;
	let jsonRpcErrorId: "request" | "null";
	let oversizedResponse: "declared" | "streamed" | undefined;
	let serverStatus: number;
	let holdToolCall: boolean;
	let requestPayloads: Record<string, unknown>[];
	let requestUrls: string[];
	let requestMethods: string[];
	let requestHeaders: Headers[];
	let requestRedirectModes: (RequestRedirect | undefined)[];

	beforeEach(() => {
		toolResult = {
			content: [{ type: "text", text: "Search completed." }],
			structuredContent: {
				results: [
					{ title: "First", url: "https://example.com/1", excerpts: ["First excerpt", "Second excerpt"] },
					{ title: "Second", url: "https://example.com/2", excerpts: ["Another excerpt"] },
				],
			},
		};
		jsonRpcError = undefined;
		jsonRpcErrorId = "request";
		oversizedResponse = undefined;
		serverStatus = 200;
		holdToolCall = false;
		requestPayloads = [];
		requestUrls = [];
		requestMethods = [];
		requestHeaders = [];
		requestRedirectModes = [];
		vi.stubEnv("SEARCH_PARALLEL_MCP_API_KEY", "");
		vi.stubEnv("PI_SEARCH_PARALLEL_REVIEW_KEY", "");
		vi.stubEnv("PI_SEARCH_PARALLEL_MISSING_KEY", "");
		vi.mocked(searchDuckDuckGo).mockReset().mockResolvedValue({
			results: [{ title: "DuckDuckGo", url: "https://example.com/duckduckgo", snippet: "Incumbent result" }],
		});
		clearCooldowns();
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const method = init?.method ?? request?.method;
			requestMethods.push(method ?? "unknown");
			requestUrls.push(request?.url ?? String(input));
			requestHeaders.push(new Headers(request ? request.headers : init?.headers));
			requestRedirectModes.push(init?.redirect ?? request?.redirect);
			const signal = init?.signal ?? request?.signal;
			if (signal?.aborted) throw signal.reason ?? new Error("Request aborted.");
			if (method === "DELETE") return new Response(null, { status: 200 });
			const body = typeof init?.body === "string" ? init.body : request ? await request.text() : "{}";
			const requestPayload = JSON.parse(body) as Record<string, unknown>;
			requestPayloads.push(requestPayload);
			if (serverStatus !== 200) return new Response("Upstream request failed", { status: serverStatus });
			if (requestPayload.method === "initialize") {
				const params = requestPayload.params as Record<string, unknown>;
				return Response.json({
					jsonrpc: "2.0",
					id: requestPayload.id,
					result: {
						protocolVersion: params.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "Parallel Search MCP", version: "1.0.0" },
					},
				}, { headers: { "Mcp-Session-Id": "test-session" } });
			}
			if (requestPayload.method === "notifications/initialized" || requestPayload.method === "notifications/cancelled") {
				return new Response(null, { status: 202 });
			}
			if (requestPayload.method === "tools/call") {
				if (holdToolCall) {
					return new Promise<Response>((_, reject) => {
						if (!signal) {
							reject(new Error("Request signal was not provided."));
							return;
						}
						signal.addEventListener("abort", () => reject(signal.reason ?? new Error("Request aborted.")), { once: true });
					});
				}
				if (oversizedResponse === "declared") {
					return new Response("{}", {
						headers: { "content-length": String(1024 * 1024 + 1), "content-type": "application/json" },
					});
				}
				if (oversizedResponse === "streamed") {
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(1024 * 1024 + 1));
							controller.close();
						},
					});
					return new Response(body, { headers: { "content-type": "application/json" } });
				}
				if (jsonRpcError) {
					return Response.json({
						jsonrpc: "2.0",
						id: jsonRpcErrorId === "null" ? null : requestPayload.id,
						error: jsonRpcError,
					});
				}
				return Response.json({ jsonrpc: "2.0", id: requestPayload.id, result: toolResult });
			}
			throw new Error(`Unexpected MCP request: ${String(requestPayload.method)} ${String(input)}`);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		config.backends = {};
		config.defaultBackend = "duckduckgo";
		clearCooldowns();
	});

	it("enables Parallel through /search-setup and reports the written effective configuration", async () => {
		const { tempRoot, projectDir } = createProject({});
		try {
			const globalConfigDir = join(tempRoot, "home", ".pi", "agent", "extensions");
			mkdirSync(globalConfigDir, { recursive: true });
			const globalConfigPath = join(globalConfigDir, "search.json");
			writeFileSync(globalConfigPath, JSON.stringify({
				defaultBackend: "duckduckgo",
				selectionStrategy: "random",
				backends: {
					serper: { enabled: false, apiKey: "SERPER_API_KEY" },
					parallel_mcp: { enabled: false, apiKey: "PARALLEL_API_KEY", timeout: 12000 },
				},
			}));

			const { registeredCommands } = registerSearchHub(projectDir);
			const setupCommand = registeredCommands.get("search-setup") as {
				handler: (args: string, ctx: unknown) => Promise<void>;
			};
			const select = vi.fn().mockResolvedValue("⚡ Enable all free backends");
			const notify = vi.fn();
			await setupCommand.handler("", { hasUI: true, ui: { select, notify } });

			expect(select).toHaveBeenCalledWith(
				"Which backend do you want to configure?",
				expect.arrayContaining(["⚡ Enable all free backends"]),
			);
			const writtenConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
			expect(writtenConfig).toMatchObject({
				defaultBackend: "duckduckgo",
				selectionStrategy: "random",
				backends: {
					serper: { enabled: false, apiKey: "SERPER_API_KEY" },
					duckduckgo: { enabled: true },
					jina: { enabled: true },
					marginalia: { enabled: true },
					exa_mcp: { enabled: true },
					parallel_mcp: { enabled: true, apiKey: "PARALLEL_API_KEY", timeout: 12000 },
					searxng: { enabled: true },
				},
			});

			const activeBackends = refreshConfig(projectDir, true);
			expect(config.defaultBackend).toBe("duckduckgo");
			expect(activeBackends).toEqual(expect.arrayContaining([
				"duckduckgo",
				"jina",
				"marginalia",
				"exa_mcp",
				"parallel_mcp",
				"searxng",
			]));
			expect(notify).toHaveBeenCalledWith(
				"Enabled: DuckDuckGo, Jina, Marginalia, Exa MCP, Parallel Search MCP, SearXNG. Run /reload to activate.",
				"success",
			);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("uses anonymous MCP, sends attribution, rejects redirects, and maps useful results", async () => {
		const result = await searchParallelMCP("pi search extension", 1);
		const callIndex = requestPayloads.findIndex(request => request.method === "tools/call");
		const call = requestPayloads[callIndex];
		const params = call?.params as Record<string, unknown>;
		const args = params?.arguments as Record<string, unknown>;

		expect(BACKEND_DEFS.parallel_mcp.needsKey).toBe(false);
		expect(BACKEND_DEFS.parallel_mcp.optionalKey).toBe(true);
		expect(BACKEND_DEFS.parallel_mcp.setupLabel).toContain("optional API key");
		expect(result.results).toEqual([
			{ title: "First", url: "https://example.com/1", snippet: "First excerpt\nSecond excerpt" },
		]);
		expect(params?.name).toBe("web_search");
		expect(args).toMatchObject({ objective: "pi search extension", search_queries: ["pi search extension"] });
		expect(args).not.toHaveProperty("model_name");
		expect(requestUrls[0]).toBe("https://search.parallel.ai/mcp");
		expect(callIndex).toBeGreaterThanOrEqual(0);
		expect(requestHeaders.every(headers => headers.get("user-agent") === "pi-search-hub/2.8.0")).toBe(true);
		expect(requestHeaders.every(headers => !headers.has("authorization"))).toBe(true);
		expect(requestRedirectModes.length).toBeGreaterThan(0);
		expect(requestMethods).toContain("GET");
		expect(requestRedirectModes.every(mode => mode === "error")).toBe(true);
	});

	it("parses JSON text results when structured content is absent", async () => {
		toolResult = {
			content: [{
				type: "text",
				text: JSON.stringify({ results: [{ title: "Text result", url: "https://example.com/text", snippet: "From text" }] }),
			}],
		};

		const result = await searchParallelMCP("text result", 10);

		expect(result.results).toEqual([
			{ title: "Text result", url: "https://example.com/text", snippet: "From text" },
		]);
	});

	it("treats a valid empty result as success and rejects malformed results", async () => {
		toolResult = {
			content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
			structuredContent: { results: [] },
		};
		expect(await searchParallelMCP("empty result", 10)).toEqual({ results: [] });

		toolResult = {
			content: [{ type: "text", text: "Search completed." }],
			structuredContent: { results: [
				{ title: "Unsupported", url: "file:///not-a-web-result" },
				{ title: "Valid", url: "https://example.com/valid", excerpts: ["Valid excerpt"] },
			] },
		};
		expect(await searchParallelMCP("partial malformed result", 10)).toEqual({
			results: [{ title: "Valid", url: "https://example.com/valid", snippet: "Valid excerpt" }],
		});

		toolResult = {
			content: [{ type: "text", text: "Search completed." }],
			structuredContent: { results: [{ title: "Unsupported", url: "file:///not-a-web-result" }] },
		};
		await expect(searchParallelMCP("malformed result", 10)).rejects.toThrow("invalid search response");

		toolResult = { content: [{ type: "text", text: "not a JSON search result" }] };
		await expect(searchParallelMCP("malformed payload", 10)).rejects.toThrow("invalid search response");
	});

	it("surfaces MCP tool and JSON-RPC errors", async () => {
		toolResult = { isError: true, content: [{ type: "text", text: "Search is rate limited." }] };
		await expect(searchParallelMCP("rate limit", 10)).rejects.toThrow("Search is rate limited.");

		jsonRpcError = { code: -32000, message: "Search quota exceeded." };
		await expect(searchParallelMCP("quota error", 10)).rejects.toThrow("Search quota exceeded.");
	});

	it("surfaces null-ID JSON-RPC service errors promptly", async () => {
		jsonRpcError = { code: -32000, message: "Search quota exceeded." };
		jsonRpcErrorId = "null";
		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(new Error("Timed out waiting for service error.")), 1_000);
		try {
			await expect(searchParallelMCP("null-id quota error", 10, abortController.signal))
				.rejects.toThrow("Search quota exceeded.");
		} finally {
			clearTimeout(timeout);
		}
	});

	it("rejects declared and streamed MCP responses over the byte limit", async () => {
		oversizedResponse = "declared";
		await expect(searchParallelMCP("declared oversized response", 10)).rejects.toThrow("1 MiB limit");

		oversizedResponse = "streamed";
		await expect(searchParallelMCP("streamed oversized response", 10)).rejects.toThrow("1 MiB limit");
	});

	it("resolves a configured optional credential through the host credential path", async () => {
		const previousBackends = config.backends;
		const previousDefault = config.defaultBackend;
		config.backends = { parallel_mcp: { enabled: true, apiKey: "PI_SEARCH_PARALLEL_REVIEW_KEY" } };
		config.defaultBackend = "parallel_mcp";
		vi.stubEnv("PI_SEARCH_PARALLEL_REVIEW_KEY", "unit-test-placeholder");
		try {
			await runBackend("parallel_mcp", "configured credential", 1, undefined, { skipCache: true });
			expect(requestHeaders.some(headers => headers.get("authorization") === "Bearer unit-test-placeholder")).toBe(true);
			expect(requestHeaders.every(headers => headers.get("user-agent") === "pi-search-hub/2.8.0")).toBe(true);
		} finally {
			config.backends = previousBackends;
			config.defaultBackend = previousDefault;
			clearCooldowns();
		}
	});

	it("auto-enables and resolves the standard optional credential environment variable", async () => {
		const { tempRoot, projectDir } = createProject({});
		vi.stubEnv("SEARCH_PARALLEL_MCP_API_KEY", "unit-test-placeholder");
		try {
			const activeBackends = refreshConfig(projectDir, true);
			expect(activeBackends).toContain("parallel_mcp");
			await runBackend("parallel_mcp", "fallback credential", 1, undefined, { skipCache: true });
			expect(requestHeaders.some(headers => headers.get("authorization") === "Bearer unit-test-placeholder")).toBe(true);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
			clearCooldowns();
		}
	});

	it("refuses anonymous access when a configured credential cannot be resolved", async () => {
		const previousBackends = config.backends;
		const previousDefault = config.defaultBackend;
		config.backends = { parallel_mcp: { enabled: true, apiKey: "PI_SEARCH_PARALLEL_MISSING_KEY" } };
		config.defaultBackend = "parallel_mcp";
		try {
			await expect(runBackend("parallel_mcp", "missing credential", 1, undefined, { skipCache: true }))
				.rejects.toThrow("refusing an anonymous request");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			config.backends = previousBackends;
			config.defaultBackend = previousDefault;
			clearCooldowns();
		}
	});

	it("does not downgrade a rejected explicit credential to anonymous access", async () => {
		const previousBackends = config.backends;
		const previousDefault = config.defaultBackend;
		config.backends = { parallel_mcp: { enabled: true, apiKey: "PI_SEARCH_PARALLEL_REVIEW_KEY" } };
		config.defaultBackend = "parallel_mcp";
		vi.stubEnv("PI_SEARCH_PARALLEL_REVIEW_KEY", "unit-test-placeholder");
		serverStatus = 401;
		try {
			await expect(runBackend("parallel_mcp", "rejected credential", 1, undefined, { skipCache: true }))
				.rejects.toBeInstanceOf(Error);
			expect(requestPayloads.filter(request => request.method === "initialize")).toHaveLength(1);
			expect(requestHeaders.every(headers => headers.get("authorization") === "Bearer unit-test-placeholder")).toBe(true);
		} finally {
			config.backends = previousBackends;
			config.defaultBackend = previousDefault;
			clearCooldowns();
		}
	});

	it("propagates caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("request cancelled by test"));
		await expect(searchParallelMCP("cancel request", 10, controller.signal)).rejects.toThrow("request cancelled by test");
	});

	it("cancels an in-flight Parallel MCP search", async () => {
		holdToolCall = true;
		const controller = new AbortController();
		const resultPromise = searchParallelMCP("cancel in-flight search", 10, controller.signal);
		const cancellationAssertion = expect(resultPromise).rejects.toThrow("request cancelled during search");
		try {
			await vi.waitFor(() => {
				expect(requestPayloads.some(request => request.method === "tools/call")).toBe(true);
			}, { timeout: 1_000 });
			controller.abort(new Error("request cancelled during search"));
			await cancellationAssertion;
		} finally {
			controller.abort();
		}
	});

	it("preserves DuckDuckGo by default and returns Parallel results through web_search when selected", async () => {
		const { tempRoot, projectDir } = createProject({
			backends: {
				parallel_mcp: { enabled: true },
				duckduckgo: { enabled: true },
			},
		});
		const { webSearchTool, context, startSession } = registerSearchHub(projectDir);
		try {
			await startSession();
			expect(config.defaultBackend).toBe("duckduckgo");
			const incumbentResult = await webSearchTool.execute("default-search", {
				query: "baseline incumbent backend",
				numResults: 1,
			}, undefined, undefined, context);
			expect(incumbentResult.details.backend).toBe("duckduckgo");
			expect(requestPayloads.filter(request => request.method === "tools/call")).toHaveLength(0);

			const explicitResult = await webSearchTool.execute("explicit-parallel", {
				query: "explicit Parallel backend",
				numResults: 1,
				backend: "parallel_mcp",
			}, undefined, undefined, context);
			expect(explicitResult.details).toMatchObject({ backend: "parallel_mcp", resultCount: 1 });
			expect(explicitResult.content[0]?.text).toContain("https://example.com/1");
			expect(explicitResult.content[0]?.text).toContain("First excerpt");

			writeFileSync(join(projectDir, ".pi", "search.json"), JSON.stringify({
				defaultBackend: "parallel_mcp",
				backends: {
					parallel_mcp: { enabled: true },
					duckduckgo: { enabled: true },
				},
			}));
			expect(refreshConfig(projectDir, true)[0]).toBe("parallel_mcp");
			const savedDefaultResult = await webSearchTool.execute("saved-parallel", {
				query: "saved Parallel default",
				numResults: 1,
			}, undefined, undefined, context);
			expect(savedDefaultResult.details.backend).toBe("parallel_mcp");

			await startSession();
			const nextSessionResult = await webSearchTool.execute("next-session", {
				query: "new Parallel conversation",
				numResults: 1,
				backend: "parallel_mcp",
			}, undefined, undefined, context);
			expect(nextSessionResult.details.backend).toBe("parallel_mcp");

			const searchCalls = requestPayloads.filter(request => request.method === "tools/call");
			const sessionIds = searchCalls.map(request => {
				const params = request.params as Record<string, unknown>;
				const args = params.arguments as Record<string, unknown>;
				expect(args).not.toHaveProperty("model_name");
				return args.session_id;
			});
			expect(sessionIds).toHaveLength(3);
			expect(sessionIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
			expect(sessionIds[1]).toBe(sessionIds[0]);
			expect(sessionIds[2]).not.toBe(sessionIds[0]);
			expect(requestUrls[0]).toBe("https://search.parallel.ai/mcp");
			expect(requestHeaders.every(headers => headers.get("user-agent") === "pi-search-hub/2.8.0")).toBe(true);
			expect(requestHeaders.every(headers => !headers.has("authorization"))).toBe(true);
			expect(requestRedirectModes.every(mode => mode === "error")).toBe(true);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("falls back to Parallel after the incumbent backend fails", async () => {
		const { tempRoot, projectDir } = createProject({
			backends: {
				duckduckgo: { enabled: true },
				parallel_mcp: { enabled: true },
			},
		});
		vi.mocked(searchDuckDuckGo).mockRejectedValueOnce(new Error("DuckDuckGo unavailable"));
		const { webSearchTool, context, startSession } = registerSearchHub(projectDir);
		try {
			await startSession();
			const result = await webSearchTool.execute("fallback-search", {
				query: "fallback to Parallel",
				numResults: 1,
			}, undefined, undefined, context);
			expect(result.details.backend).toBe("parallel_mcp (fallback)");
			expect(result.content[0]?.text).toContain("https://example.com/1");
			expect(result.content[0]?.text).toContain("First excerpt");
			expect(requestPayloads.filter(request => request.method === "tools/call")).toHaveLength(1);
			expect(requestHeaders.every(headers => headers.get("user-agent") === "pi-search-hub/2.8.0")).toBe(true);
			expect(requestHeaders.every(headers => !headers.has("authorization"))).toBe(true);
			expect(requestRedirectModes.every(mode => mode === "error")).toBe(true);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
