import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pi supplies this optional peer at runtime; CI must not depend on local host symlinks.
vi.mock("@earendil-works/pi-ai", async () => {
	const { Type } = await import("typebox");
	return { StringEnum: (values: string[]) => Type.Union(values.map(value => Type.Literal(value))) };
});

const { runBackendMock } = vi.hoisted(() => ({ runBackendMock: vi.fn() }));
vi.mock("./backends/registry.js", () => ({
	BACKEND_DEFS: Object.fromEntries(["openai-codex", "gemini", "anthropic", "duckduckgo"].map(name => [name, { label: name }])),
	runBackend: runBackendMock,
}));

import searchHub from "./search-hub.js";
import { refreshConfig } from "./config.js";
import { FALLBACK_ENV_MAP } from "./credentials.js";

describe("web_search host context plumbing", () => {
	let root: string;
	let tool: any;
	let ctx: any;
	let signal: AbortSignal;

	function configure(overrides: Record<string, unknown> = {}) {
		writeFileSync(join(root, "extensions", "search.json"), JSON.stringify({
			defaultBackend: "auto",
			selectionStrategy: "sequential",
			backends: {
				"openai-codex": { enabled: true },
				gemini: { enabled: true },
				anthropic: { enabled: true },
				duckduckgo: { enabled: true },
			},
			...overrides,
		}));
		refreshConfig(root, true);
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-search-host-"));
		mkdirSync(join(root, "extensions"));
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		for (const name of Object.values(FALLBACK_ENV_MAP)) vi.stubEnv(name, undefined);
		signal = new AbortController().signal;
		ctx = { cwd: root, hasUI: false, modelRegistry: {}, ui: { setStatus: vi.fn() } };
		runBackendMock.mockReset();
		runBackendMock.mockImplementation(async (backend: string) => [{
			title: backend, url: `https://example.com/${backend}`, snippet: "grounded evidence",
		}]);
		searchHub({
			registerTool: (registered: any) => { if (registered.name === "web_search") tool = registered; },
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as any);
		configure();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function expectContextInEveryCall() {
		for (const call of runBackendMock.mock.calls) {
			expect(call[3]).toBe(signal);
			expect(call[4].hostContext).toBe(ctx);
		}
	}

	it("passes context for an explicitly selected backend", async () => {
		const result = await tool.execute("call", { query: "test", backend: "gemini" }, signal, undefined, ctx);
		expect(result.details.backend).toBe("gemini");
		expect(runBackendMock).toHaveBeenCalledOnce();
		expectContextInEveryCall();
	});

	it("keeps context through auto fallback", async () => {
		runBackendMock.mockRejectedValueOnce(new Error("quota exhausted"));
		const result = await tool.execute("call", { query: "test" }, signal, undefined, ctx);
		expect(result.details.backend).toBe("gemini (fallback)");
		expect(runBackendMock.mock.calls.map(c => c[0])).toEqual(["openai-codex", "gemini"]);
		expectContextInEveryCall();
	});

	it("uses config-forced targeted combine and tops up failed LLM searches", async () => {
		configure({ combine: true, combineMode: "targeted" });
		runBackendMock.mockImplementation(async (backend: string) => {
			if (backend === "anthropic") throw new Error("quota exhausted");
			return [{ title: backend, url: `https://example.com/${backend}`, snippet: "evidence" }];
		});
		const result = await tool.execute("call", { query: "test", numResults: 3 }, signal, undefined, ctx);
		expect(result.details.backend).toBe("combined-targeted");
		expect(result.details.usableBackendCount).toBe(3);
		expect(runBackendMock.mock.calls.map(c => c[0])).toEqual(["openai-codex", "gemini", "anthropic", "duckduckgo"]);
		expectContextInEveryCall();
	});

	it("passes context to every backend in combine-all mode", async () => {
		configure({ combineMode: "all" });
		const result = await tool.execute("call", { query: "test", combine: true, numResults: 4 }, signal, undefined, ctx);
		expect(result.details.backend).toBe("combined");
		expect(runBackendMock).toHaveBeenCalledTimes(4);
		expectContextInEveryCall();
	});

	it.each(["fallback", "targeted", "all"])("stops %s dispatch on caller cancellation without topping up", async mode => {
		const controller = new AbortController();
		configure(mode === "fallback" ? {} : { combine: true, combineMode: mode });
		runBackendMock.mockImplementation(async () => {
			controller.abort();
			throw new Error("cancelled probe");
		});
		await expect(tool.execute("call", { query: "cancel" }, controller.signal, undefined, ctx)).rejects.toThrow("cancelled probe");
		if (mode === "fallback") expect(runBackendMock).toHaveBeenCalledOnce();
		if (mode === "targeted") {
			expect(runBackendMock.mock.calls.map(c => c[0])).toEqual(["openai-codex", "gemini", "anthropic"]);
		}
	});
});
