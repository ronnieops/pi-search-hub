import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFactoryMock, getApiKeyMock, storedCredentialMock } = vi.hoisted(() => ({
	authFactoryMock: vi.fn(), getApiKeyMock: vi.fn(), storedCredentialMock: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: { create: authFactoryMock }, readStoredCredential: storedCredentialMock,
}));

import {
	resolveHostModel, resolveProviderApiKey, runLlmSearch, type LlmSearchRun,
} from "./shared-llm-results.js";
import { searchOpenAICodex } from "./backends/openai-codex.js";
import { searchAnthropic } from "./backends/anthropic.js";
import { searchGemini } from "./backends/gemini.js";

const prose = { stopReason: "stop", content: [{ type: "text", text: "Evidence from https://example.com/source" }] };
const submitted = { stopReason: "toolUse", content: [{
	type: "toolCall", name: "submit_search_results",
	arguments: { results: [{ title: "Source", url: "https://example.com/source", snippet: "Grounded evidence" }] },
}] };

beforeEach(() => {
	vi.clearAllMocks();
	authFactoryMock.mockReturnValue(undefined);
	storedCredentialMock.mockReturnValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function runWith(streamFn: LlmSearchRun["streamFn"], overrides: Partial<LlmSearchRun> = {}) {
	return runLlmSearch({
		label: "Test", streamFn, model: {}, query: "test", numResults: 3,
		injectSearch: payload => payload, notSubmittedError: "missing submit",
		emptyResultsError: "invalid results", cancelledError: "Test search cancelled", ...overrides,
	});
}

describe("Pi authentication and model runtime", () => {
	it("binds host streams to the owning registry", () => {
		const registry = { find: () => ({ id: "model" }), stream() { expect(this).toBe(registry); return { result: async () => submitted }; } };
		const ref = resolveHostModel({ modelRegistry: registry }, "provider", "model")!;
		expect(ref.model.id).toBe("model");
		ref.stream();
	});

	it("can use classic host auth resolvers that refresh credentials", async () => {
		getApiKeyMock.mockResolvedValue("fresh-test-key");
		authFactoryMock.mockReturnValue({ getApiKey: getApiKeyMock });
		expect(await resolveProviderApiKey("anthropic")).toBe("fresh-test-key");
		expect(getApiKeyMock).toHaveBeenCalledWith("anthropic", { includeFallback: false });
	});

	it("accepts stored API keys when no classic resolver exists", async () => {
		storedCredentialMock.mockReturnValue({ type: "api_key", key: "test-key" });
		expect(await resolveProviderApiKey("google")).toBe("test-key");
	});

	it("never freezes raw OAuth access tokens into a direct stream", async () => {
		storedCredentialMock.mockReturnValue({ type: "oauth", access: "expired-test-access", refresh: "test-refresh", expires: 0 });
		expect(await resolveProviderApiKey("anthropic")).toBeUndefined();
	});
});

describe("shared LLM search runner", () => {
	it("accepts a structured first turn without another model call", async () => {
		const stream = vi.fn(() => ({ result: async () => submitted }));
		expect((await runWith(stream)).results).toHaveLength(1);
		expect(stream).toHaveBeenCalledOnce();
	});

	it("declares transcript tools and keeps conversion turns free of search injection", async () => {
		const stream = vi.fn()
			.mockReturnValueOnce({ result: async () => prose })
			.mockReturnValueOnce({ result: async () => submitted });
		const injectSearch = vi.fn(payload => payload);
		await runWith(stream, { injectSearch });
		const [, firstContext, firstOptions] = stream.mock.calls[0];
		const [, secondContext, secondOptions] = stream.mock.calls[1];
		expect(firstContext.messages[0].role).toBe("system");
		expect(firstContext.messages[0].toolsAdded[0].name).toBe("submit_search_results");
		expect(secondContext.messages.at(-1).role).toBe("assistant");
		expect(secondContext.tools).toEqual(firstContext.tools);
		expect(firstOptions.onPayload).toBe(injectSearch);
		expect(secondOptions.onPayload).toBeUndefined();
		expect(secondOptions.signal).toBe(firstOptions.signal);
	});

	it("does not start a stream when the caller is already cancelled", async () => {
		const stream = vi.fn();
		await expect(runWith(stream, { signal: AbortSignal.abort() })).rejects.toThrow("Test search cancelled");
		expect(stream).not.toHaveBeenCalled();
	});

	it("does not launch conversion after cancellation during the grounding turn", async () => {
		const controller = new AbortController();
		const stream = vi.fn(() => ({ result: async () => { controller.abort(); return prose; } }));
		await expect(runWith(stream, { signal: controller.signal })).rejects.toThrow("Test search cancelled");
		expect(stream).toHaveBeenCalledOnce();
	});

	it("normalizes rejected aborts instead of returning provider-specific exceptions", async () => {
		const controller = new AbortController();
		const stream = vi.fn(() => ({ result: async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); } }));
		await expect(runWith(stream, { signal: controller.signal })).rejects.toThrow("Test search cancelled");
	});

	it("uses one total deadline across both turns, with a distinct timeout error", async () => {
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), ms);
			return controller.signal;
		});
		const stream = vi.fn()
			.mockReturnValueOnce({ result: async () => { vi.advanceTimersByTime(80); return prose; } })
			.mockReturnValueOnce({ result: async () => { vi.advanceTimersByTime(30); return submitted; } });
		await expect(runWith(stream, { timeoutMs: 100 })).rejects.toThrow("timed out after 100ms");
		expect(stream.mock.calls[0][2].signal).toBe(stream.mock.calls[1][2].signal);
	});

	it("preserves provider errors and rejects missing source evidence", async () => {
		await expect(runWith(() => ({ result: async () => ({ stopReason: "error", errorMessage: "quota exhausted" }) }))).rejects.toThrow("quota exhausted");
		await expect(runWith(() => ({ result: async () => ({ stopReason: "stop", content: [] }) }))).rejects.toThrow("missing submit");
	});
});

describe("backend caller cancellation and host auth", () => {
	it.each([
		["OpenAI Codex", searchOpenAICodex, "openai-codex-responses"],
		["Anthropic", searchAnthropic, "anthropic-messages"],
		["Gemini", searchGemini, "google-gemini-cli"],
	] as const)("%s forwards cancellation into the host stream without explicit keys", async (label, search, api) => {
		const controller = new AbortController();
		const model = { id: "model", api };
		const stream = vi.fn((_model: any, _context: any, options: any) => ({ result: async () => {
			expect(options.signal.aborted).toBe(false);
			controller.abort();
			expect(options.signal.aborted).toBe(true);
			return prose;
		} }));
		const ctx = { modelRegistry: { find: () => model, stream } };
		await expect(search("test", 3, controller.signal, undefined, ctx)).rejects.toThrow(`${label} search cancelled`);
		expect(stream).toHaveBeenCalledOnce();
		expect(stream.mock.calls[0][2].apiKey).toBeUndefined();
		expect(authFactoryMock).not.toHaveBeenCalled();
	});
});
