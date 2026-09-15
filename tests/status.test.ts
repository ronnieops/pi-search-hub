import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	config: { defaultBackend: "duckduckgo", backends: {}, showStatus: true as boolean | undefined },
	refreshConfig: vi.fn(),
	runBackend: vi.fn(),
	fetchWithFallback: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async () => {
	const { Type } = await import("typebox");
	return {
		StringEnum: (values: readonly string[], options?: Record<string, unknown>) => Type.Union(values.map(value => Type.Literal(value)), options),
		Type,
	};
});

vi.mock("../extensions/config.js", () => ({
	config: state.config,
	refreshConfig: state.refreshConfig,
	getActiveBackends: () => ["duckduckgo"],
	recordLatency: vi.fn(),
	latencyMap: new Map(),
}));
vi.mock("../extensions/backends/registry.js", () => ({
	BACKEND_DEFS: { duckduckgo: { label: "DuckDuckGo" } },
	runBackend: state.runBackend,
}));
vi.mock("../extensions/readers/dispatch.js", () => ({
	fetchWithFallback: state.fetchWithFallback,
	fetchWithReader: vi.fn(),
	readerLabel: (reader: string) => reader,
	DEFAULT_READER_FALLBACK: ["jina"],
}));
vi.mock("../extensions/utils.js", () => ({
	getAgentDir: () => "/tmp",
	clearCooldowns: vi.fn(),
	validateUrl: () => undefined,
}));
vi.mock("../extensions/credentials.js", () => ({ getKeySource: vi.fn() }));
vi.mock("../extensions/dispatch.js", () => ({
	selectBackendsForFallback: () => ["duckduckgo"],
	reciprocalRankFusion: vi.fn(),
	runTargetedCombine: vi.fn(),
}));
vi.mock("../extensions/formatters.js", () => ({
	formatResults: () => "results",
	formatCombinedResults: vi.fn(),
	formatResultsCompact: () => "results",
	formatCombinedResultsCompact: vi.fn(),
}));

import registerSearchHub from "../extensions/search-hub.js";

type RegisteredTool = { name: string; execute: (...args: any[]) => Promise<unknown> };

function harness() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (...args: any[]) => Promise<void>>();
	const setStatus = vi.fn();
	const onUpdate = vi.fn();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		on: (event: string, handler: (...args: any[]) => Promise<void>) => handlers.set(event, handler),
	};
	registerSearchHub(pi as any);
	const ctx = { cwd: "/tmp", ui: { setStatus, notify: vi.fn() }, modelRegistry: {} };
	return { tools, handlers, ctx, setStatus, onUpdate };
}

describe("showStatus", () => {
	beforeEach(() => {
		state.config.showStatus = true;
		state.refreshConfig.mockClear();
		state.runBackend.mockReset().mockResolvedValue([{ title: "Result", url: "https://example.com" }]);
		state.fetchWithFallback.mockReset().mockResolvedValue({ reader: "jina", content: "page" });
	});

	it("suppresses search and read footer progress while preserving tool updates when false", async () => {
		state.config.showStatus = false;
		const { tools, ctx, setStatus, onUpdate } = harness();

		await tools.get("web_search")!.execute("id", { query: "query", backend: "duckduckgo" }, undefined, onUpdate, ctx);
		await tools.get("web_read")!.execute("id", { url: "https://example.com" }, undefined, onUpdate, ctx);

		expect(setStatus).toHaveBeenCalledTimes(4);
		expect(setStatus).toHaveBeenCalledWith("search", undefined);
		expect(setStatus).toHaveBeenCalledWith("read", undefined);
		expect(setStatus).not.toHaveBeenCalledWith("search", expect.any(String));
		expect(setStatus).not.toHaveBeenCalledWith("read", expect.any(String));
		expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: "text", text: "*🔍 DuckDuckGo: searching...*" }] });
		expect(onUpdate).toHaveBeenCalledWith({ content: [{ type: "text", text: "*📄 jina: fetching...*" }] });
	});

	it("clears stale search and read footer entries at session start when false", async () => {
		state.config.showStatus = false;
		const { handlers, ctx, setStatus } = harness();

		await handlers.get("session_start")!({}, ctx);

		expect(setStatus).toHaveBeenCalledTimes(2);
		expect(setStatus).toHaveBeenCalledWith("search", undefined);
		expect(setStatus).toHaveBeenCalledWith("read", undefined);
	});

	it.each([true, undefined])("preserves search, read, and startup footer statuses when showStatus is %s", async (showStatus) => {
		state.config.showStatus = showStatus;
		const { tools, handlers, ctx, setStatus, onUpdate } = harness();

		await handlers.get("session_start")!({}, ctx);
		await tools.get("web_search")!.execute("id", { query: "query", backend: "duckduckgo" }, undefined, onUpdate, ctx);
		await tools.get("web_read")!.execute("id", { url: "https://example.com" }, undefined, onUpdate, ctx);

		expect(setStatus).toHaveBeenCalledWith("search", "search: duckduckgo");
		expect(setStatus).toHaveBeenCalledWith("search", "🔍 DuckDuckGo: searching...");
		expect(setStatus).toHaveBeenCalledWith("search", "🔍 DuckDuckGo: 1 results");
		expect(setStatus).toHaveBeenCalledWith("read", "📄 jina: fetching...");
		expect(setStatus).toHaveBeenCalledWith("read", "📄 jina: 4 chars");
		expect(setStatus).not.toHaveBeenCalledWith("search", undefined);
		expect(setStatus).not.toHaveBeenCalledWith("read", undefined);
	});
});
