/**
 * Tests for duckduckgo.ts — Python subprocess backend.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { searchDuckDuckGo } from "./duckduckgo.js";
import { HTTP_TIMEOUT_MS } from "../utils.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

/**
 * Build a mock proc. Call trigger() to fire close event (with data events first).
 * Tests must call trigger() after starting searchDuckDuckGo.
 */
function makeMockProc(stdout: string, stderr: string, exitCode: number) {
	const stdoutMock = { on: vi.fn(), removeAllListeners: vi.fn() };
	const stderrMock = { on: vi.fn(), removeAllListeners: vi.fn() };
	const proc = {
		stdout: stdoutMock,
		stderr: stderrMock,
		on: vi.fn(),
		kill: vi.fn(),
	} as unknown as ReturnType<typeof spawn>;

	// Captured at trigger-time (after searchDuckDuckGo registers handlers)
	let closeHandlers: Array<(code: number) => void> = [];
	let stdoutCalls: Array<[string, (d: Buffer) => void]> = [];
	let stderrCalls: Array<[string, (d: Buffer) => void]> = [];

	(proc.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (...args: unknown[]) => void) => {
		if (evt === "close") closeHandlers.push(cb as (code: number) => void);
	});
	(stdoutMock.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (d: Buffer) => void) => {
		if (evt === "data") stdoutCalls.push([evt, cb]);
	});
	(stderrMock.on as ReturnType<typeof vi.fn>).mockImplementation((evt: string, cb: (d: Buffer) => void) => {
		if (evt === "data") stderrCalls.push([evt, cb]);
	});

	const trigger = () => {
		for (const [, cb] of stdoutCalls) cb(Buffer.from(stdout));
		for (const [, cb] of stderrCalls) cb(Buffer.from(stderr));
		closeHandlers.forEach((h) => h(exitCode));
	};

	return { proc, trigger };
}

describe("searchDuckDuckGo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("resolves with results on successful ddgs call", async () => {
		const jsonResults = JSON.stringify({
			results: [
				{ title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1" },
				{ title: "Result 2", url: "https://example.com/2", snippet: "Snippet 2" },
			],
		});
		const { proc, trigger } = makeMockProc(jsonResults, "", 0);
		mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

		const resultPromise = searchDuckDuckGo("test query", 5);
		trigger();
		const result = await resultPromise;
		expect(result.results).toHaveLength(2);
		expect(result.results[0].title).toBe("Result 1");
		expect(result.results[0].url).toBe("https://example.com/1");
		expect(result.results[1].snippet).toBe("Snippet 2");
	});

	it("rejects with sanitized error on Python not found (spawn error)", async () => {
		const errProc = {
			stdout: { on: vi.fn(), removeAllListeners: vi.fn() },
			stderr: { on: vi.fn(), removeAllListeners: vi.fn() },
			on: vi.fn((evt: string, cb: (...args: unknown[]) => void) => {
				if (evt === "error") cb(new Error("ENOENT: python3 not found"));
			}),
			kill: vi.fn(),
		} as unknown as ReturnType<typeof spawn>;
		mockSpawn.mockReturnValue(errProc);

		await expect(searchDuckDuckGo("test", 5)).rejects.toThrow("spawn error");
	});

	it("rejects with ddgs install hint when stderr contains 'ddgs'", async () => {
		// Python script detects "ddgs" in ImportError and prints install hint
		const { proc, trigger } = makeMockProc("", "pip3 install ddgs\n", 1);
		mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

		const promise = searchDuckDuckGo("test", 5);
		trigger();
		await expect(promise).rejects.toThrow("pip3 install ddgs");
	});

	it("rejects with DuckDuckGo failed on other stderr messages", async () => {
		const { proc, trigger } = makeMockProc("", "Some python error\n", 1);
		mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

		const promise = searchDuckDuckGo("test", 5);
		trigger();
		await expect(promise).rejects.toThrow("DuckDuckGo failed");
	});

	it("rejects on non-zero exit code with diagnostic info", async () => {
		const { proc, trigger } = makeMockProc("", "python crashed\n", 1);
		mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

		const promise = searchDuckDuckGo("test", 5);
		trigger();
		await expect(promise).rejects.toThrow("DuckDuckGo failed (exit 1)");
	});

	it("rejects with invalid JSON on malformed stdout", async () => {
		const { proc, trigger } = makeMockProc("not json{", "", 0);
		mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

		const promise = searchDuckDuckGo("test", 5);
		trigger();
		await expect(promise).rejects.toThrow("invalid JSON");
	});

	it("rejects with timeout after HTTP_TIMEOUT_MS", async () => {
		const hungProc = {
			stdout: { on: vi.fn(), removeAllListeners: vi.fn() },
			stderr: { on: vi.fn(), removeAllListeners: vi.fn() },
			on: vi.fn(),
			kill: vi.fn(),
		} as unknown as ReturnType<typeof spawn>;
		mockSpawn.mockReturnValue(hungProc);

		vi.useFakeTimers();
		const promise = searchDuckDuckGo("test", 5);
		vi.advanceTimersByTime(HTTP_TIMEOUT_MS + 1_000);
		await expect(promise).rejects.toThrow("timed out");
		vi.useRealTimers();
	});

	it("rejects with aborted message when signal fires", async () => {
		const ac = new AbortController();
		const { proc, trigger } = makeMockProc("", "", 0);
		mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

		const promise = searchDuckDuckGo("test", 5, ac.signal);
		// Don't trigger close — signal abort should reject first
		ac.abort();
		await expect(promise).rejects.toThrow("aborted");
	});

	it("injects timelimit kwarg when option set", async () => {
		const { proc, trigger } = makeMockProc(JSON.stringify({ results: [] }), "", 0);
		mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

		const promise = searchDuckDuckGo("query", 3, undefined, { timelimit: "w" });
		trigger();
		await promise;

		expect(mockSpawn).toHaveBeenCalledOnce;
		const script = (mockSpawn.mock.calls[0]![1] as string[])[1];
		expect(script).toContain('kwargs["timelimit"] = "w"');
	});

	it("passes backend, region, and safesearch options", async () => {
		const { proc, trigger } = makeMockProc(JSON.stringify({ results: [] }), "", 0);
		mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

		const promise = searchDuckDuckGo("query", 3, undefined, {
			backend: "bing",
			region: "uk-en",
			safesearch: "off",
		});
		trigger();
		await promise;

		const script = (mockSpawn.mock.calls[0]![1] as string[])[1];
		expect(script).toContain('"backend": "bing"');
		expect(script).toContain('"region": "uk-en"');
		expect(script).toContain('"safesearch": "off"');
	});

	it("uses 'python' on win32, 'python3' otherwise", async () => {
		const origPlatform = process.platform;

		const { proc: p1, trigger: t1 } = makeMockProc(JSON.stringify({ results: [] }), "", 0);
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		mockSpawn.mockReturnValue(p1 as ReturnType<typeof spawn>);
		const promise1 = searchDuckDuckGo("test", 5);
		t1();  // capture handlers AFTER search registers them
		await promise1;
		expect(mockSpawn.mock.calls[0]![0]).toBe("python");

		const { proc: p2, trigger: t2 } = makeMockProc(JSON.stringify({ results: [] }), "", 0);
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		mockSpawn.mockReturnValue(p2 as ReturnType<typeof spawn>);
		const promise2 = searchDuckDuckGo("test", 5);
		t2();  // capture handlers AFTER second search registers them
		await promise2;
		expect(mockSpawn.mock.calls[1]![0]).toBe("python3");

		Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
	});
});
