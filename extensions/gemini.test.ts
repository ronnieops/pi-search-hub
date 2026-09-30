import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamGoogleMock, streamCliMock, getModelMock, getApiKeyMock } = vi.hoisted(() => ({
	streamGoogleMock: vi.fn(), streamCliMock: vi.fn(), getModelMock: vi.fn(), getApiKeyMock: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: { create: () => ({ getApiKey: getApiKeyMock }) },
	readStoredCredential: () => undefined,
}));
vi.mock("@earendil-works/pi-ai", () => ({
	getModel: getModelMock, streamGoogle: streamGoogleMock, streamGoogleGeminiCli: streamCliMock,
}));

import { searchGemini, injectGeminiSearchPayload, injectGeminiSubmitPayload } from "./backends/gemini.js";
import { SUBMIT_SEARCH_RESULTS_TOOL } from "./shared-llm-results.js";

const structured = {
	stopReason: "toolUse", content: [{
		type: "toolCall", name: "submit_search_results",
		arguments: { results: [{ title: "Source", url: "https://example.com/source", snippet: "Source-grounded summary" }] },
	}],
};
const googleModel = { id: "gemini-2.5-flash", api: "google-generative-ai", provider: "google" };
const cliModel = { ...googleModel, api: "google-gemini-cli", provider: "google-antigravity" };

beforeEach(() => {
	vi.clearAllMocks();
	getApiKeyMock.mockResolvedValue("test-api-key");
	getModelMock.mockImplementation((provider: string) => provider === "google" ? googleModel : undefined);
	streamGoogleMock.mockReturnValue({ result: async () => structured });
	streamCliMock.mockReturnValue({ result: async () => structured });
});

describe("Gemini provider resolution", () => {
	it("uses the host registry for Antigravity with request-time auth, not raw credentials", async () => {
		const hostStream = vi.fn().mockReturnValue({ result: async () => structured });
		const ctx = { modelRegistry: { find: vi.fn(() => cliModel), stream: hostStream } };
		const { results } = await searchGemini("test query", 3, undefined, undefined, ctx);
		expect(results[0].url).toBe("https://example.com/source");
		expect(ctx.modelRegistry.find).toHaveBeenCalledWith("google-antigravity", "gemini-2.5-flash");
		expect(getModelMock).not.toHaveBeenCalled();
		expect(getApiKeyMock).not.toHaveBeenCalled();
		expect(hostStream.mock.calls[0][2].apiKey).toBeUndefined();
	});

	it("selects the public Google API on classic hosts, without a Zen fallback", async () => {
		await searchGemini("test", 3);
		expect(streamGoogleMock).toHaveBeenCalledOnce();
		expect(streamCliMock).not.toHaveBeenCalled();
		expect(getModelMock.mock.calls.map(c => c[0])).toEqual(["google-antigravity", "google-gemini-cli", "google"]);
	});

	it("matches the CLI stream to the resolved model API on classic hosts", async () => {
		getModelMock.mockReturnValue(cliModel);
		await searchGemini("test", 3);
		expect(streamCliMock).toHaveBeenCalledOnce();
		expect(streamGoogleMock).not.toHaveBeenCalled();
	});

	it("honors explicit provider and model settings", async () => {
		await searchGemini("test", 3, undefined, { provider: "google", model: "gemini-2.5-pro" });
		expect(getModelMock).toHaveBeenCalledExactlyOnceWith("google", "gemini-2.5-pro");
	});

	it("does not route a non-Google host model into the Google wire format", async () => {
		const ctx = { modelRegistry: { find: () => ({ api: "openai-responses" }), stream: streamGoogleMock } };
		await expect(searchGemini("test", 3, undefined, { provider: "other" }, ctx)).rejects.toThrow("requires a Google API model");
		expect(streamGoogleMock).not.toHaveBeenCalled();
	});

	it("reports unresolved models with the providers tried", async () => {
		getModelMock.mockReturnValue(undefined);
		await expect(searchGemini("test", 3)).rejects.toThrow("Gemini model not found (tried google-antigravity/gemini-2.5-flash, google-gemini-cli/gemini-2.5-flash, google/gemini-2.5-flash)");
	});

	it("fails clearly when a classic host cannot resolve credentials", async () => {
		getApiKeyMock.mockResolvedValue(undefined);
		await expect(searchGemini("test", 3)).rejects.toThrow("Gemini credentials unavailable");
		expect(streamGoogleMock).not.toHaveBeenCalled();
	});

	it("grounds first, then ends the conversion history on a user turn with functions only", async () => {
		streamGoogleMock
			.mockReturnValueOnce({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Evidence from https://example.com/source" }] }) })
			.mockReturnValueOnce({ result: async () => structured });
		const { results } = await searchGemini("test", 3);
		expect(results).toHaveLength(1);
		const [, firstContext, firstOptions] = streamGoogleMock.mock.calls[0];
		const [, secondContext, secondOptions] = streamGoogleMock.mock.calls[1];
		expect(firstContext.tools).toEqual([]);
		expect(firstContext.messages[0].toolsAdded).toEqual([]);
		expect(firstContext.systemPrompt).toContain("full http/https URL");
		expect(secondContext.messages.at(-1).role).toBe("user");
		expect(secondContext.messages[0].toolsAdded).toEqual([SUBMIT_SEARCH_RESULTS_TOOL]);
		expect(secondContext.systemPrompt).toContain("450-500 character");
		expect(firstOptions.onPayload).toBe(injectGeminiSearchPayload);
		expect(secondOptions.onPayload).toBe(injectGeminiSubmitPayload);
	});
});

describe("Gemini payloads", () => {
	it("replaces functions with search-only tools for Cloud Code Assist", () => {
		const body: any = injectGeminiSearchPayload({ project: "p", request: { contents: [], tools: [{ functionDeclarations: [] }], toolConfig: { functionCallingConfig: { mode: "ANY" } } } });
		expect(body.request.tools).toEqual([{ google_search: {} }]);
		expect(body.request.contents).toEqual([]);
		expect(body.request.toolConfig).toBeUndefined();
		expect(body.config).toBeUndefined();
	});

	it("uses the public SDK spelling and retains generation/abort options", () => {
		const body: any = injectGeminiSearchPayload({ config: { tools: [{ functionDeclarations: [] }], toolConfig: {}, maxOutputTokens: 1000 } });
		expect(body.config.tools).toEqual([{ googleSearch: {} }]);
		expect(body.config.maxOutputTokens).toBe(1000);
		expect(body.config.toolConfig).toBeUndefined();
		expect(injectGeminiSearchPayload(body)).toEqual(body);
	});

	it("uses plain parameters for CLI submit and keeps schema parity with the shared tool", () => {
		const body: any = injectGeminiSubmitPayload({ project: "p", request: { contents: [], tools: [{ google_search: {} }] } });
		const decl = body.request.tools[0].functionDeclarations[0];
		expect(decl.name).toBe(SUBMIT_SEARCH_RESULTS_TOOL.name);
		expect(decl.parameters.required).toEqual(SUBMIT_SEARCH_RESULTS_TOOL.parameters.required);
		expect(decl.parameters.properties.results.items.required).toEqual(SUBMIT_SEARCH_RESULTS_TOOL.parameters.properties.results.items.required);
		expect(decl.parametersJsonSchema).toBeUndefined();
		expect(body.project).toBe("p");
	});

	it("keeps public SDK transcript function declarations on submit", () => {
		const body = { config: { tools: [{ functionDeclarations: [{ name: "submit_search_results" }] }] } };
		expect(injectGeminiSubmitPayload(body)).toEqual(body);
	});
});
