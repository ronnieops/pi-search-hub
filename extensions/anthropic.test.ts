import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamAnthropicMessagesMock, getModelMock } = vi.hoisted(() => ({
	streamAnthropicMessagesMock: vi.fn(),
	getModelMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: {
		create: () => ({
			getApiKey: async () => "test-api-key",
		}),
	},
}));

vi.mock("@earendil-works/pi-ai", () => ({
	getModel: getModelMock,
	streamAnthropic: streamAnthropicMessagesMock,
}));

vi.mock("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: (value?: unknown) => value ?? {},
		Optional: (value: unknown) => value,
		Array: (value: unknown, options?: unknown) => ({ value, options }),
	},
}));

beforeEach(() => {
	streamAnthropicMessagesMock.mockReset();
	getModelMock.mockReset();
	getModelMock.mockReturnValue({ id: "claude-haiku-4-5" });
	streamAnthropicMessagesMock.mockReturnValue({
		result: async () => ({ stopReason: "error", errorMessage: "not used in helper tests", content: [] }),
	});
});

describe("anthropic helpers", () => {
	it("searchAnthropic asks Claude for rich source-grounded snippets", async () => {
		const { searchAnthropic } = await import("./backends/anthropic.ts");

		await expect(searchAnthropic("test query", 3)).rejects.toThrow("not used in helper tests");

		const [, context] = streamAnthropicMessagesMock.mock.calls[0];
		const submitTool = context.tools[0];
		const resultSchema = submitTool.parameters.results.value;

		expect(getModelMock).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
		expect(context.messages[0]).toMatchObject({
			role: "system",
			toolsAdded: [{ name: "submit_search_results" }],
		});
		expect(context.systemPrompt).toContain("450-500 character");
		expect(context.systemPrompt).toContain("normal search-result display");
		expect(context.systemPrompt).not.toContain("For content");
		expect(resultSchema.snippet.description).toContain("450-500 character");
		expect(resultSchema.snippet.description).toContain("Prefer completeness and concrete details over brevity");
		expect("content" in resultSchema).toBe(false);
	});

	it("searchAnthropic honors backendConfig.model", async () => {
		const { searchAnthropic } = await import("./backends/anthropic.ts");

		await expect(
			searchAnthropic("test query", 3, undefined, { model: "claude-sonnet-4-5" }),
		).rejects.toThrow("not used in helper tests");

		expect(getModelMock).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");
	});

	it("searchAnthropic throws a clear error when the model is unknown", async () => {
		const { searchAnthropic } = await import("./backends/anthropic.ts");
		getModelMock.mockReturnValue(undefined);

		await expect(searchAnthropic("test query", 3)).rejects.toThrow(
			"Anthropic model not found: claude-haiku-4-5",
		);
	});

	it("searchAnthropic converts a prose answer into structured results on retry", async () => {
		const { searchAnthropic } = await import("./backends/anthropic.ts");
		streamAnthropicMessagesMock
			.mockReturnValueOnce({
				result: async () => ({
					stopReason: "stop",
					content: [{ type: "text", text: "Research found https://example.com/voynich is key." }],
				}),
			})
			.mockReturnValueOnce({
				result: async () => ({
					stopReason: "stop",
					content: [
						{
							type: "toolCall",
							name: "submit_search_results",
							arguments: {
								results: [{ title: "Voynich", url: "https://example.com/voynich", snippet: "grounded summary" }],
							},
						},
					],
				}),
			});

		const { results } = await searchAnthropic("test query", 3);

		expect(streamAnthropicMessagesMock).toHaveBeenCalledTimes(2);
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/voynich");
		// Second turn carries the prose evidence and drops search injection.
		const [, secondContext, secondOptions] = streamAnthropicMessagesMock.mock.calls[1];
		expect(secondContext.messages).toHaveLength(3);
		expect(secondContext.messages[0]).toMatchObject({
			role: "system",
			toolsAdded: [{ name: "submit_search_results" }],
		});
		expect(secondContext.messages[2]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: expect.stringContaining("example.com") }],
		});
		expect(secondContext.messages).toHaveLength(3);
		expect(secondOptions.onPayload).toBeUndefined();
	});

	it("injectAnthropicSearchPayload prepends server-side search and preserves function tools", async () => {
		const { injectAnthropicSearchPayload } = await import("./backends/anthropic.ts");

		const payload = injectAnthropicSearchPayload({
			tools: [
				{ type: "web_search_20250305", name: "web_search", max_uses: 1 },
				{ type: "object", name: "submit_search_results" },
			],
		}) as {
			tools: Array<Record<string, unknown>>;
		};

		expect(payload.tools).toHaveLength(2);
		expect(payload.tools[0]).toMatchObject({
			type: "web_search_20250305",
			name: "web_search",
			max_uses: 5,
		});
		expect(payload.tools[1]).toMatchObject({ name: "submit_search_results" });
	});
});
