import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamOpenAICodexResponsesMock } = vi.hoisted(() => ({
	streamOpenAICodexResponsesMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: {
		create: () => ({
			getApiKey: async () => "test-api-key",
		}),
	},
}));

vi.mock("@earendil-works/pi-ai", () => ({
	getModel: () => ({ id: "gpt-5.4-mini" }),
	streamOpenAICodexResponses: streamOpenAICodexResponsesMock,
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
	streamOpenAICodexResponsesMock.mockReset();
	streamOpenAICodexResponsesMock.mockReturnValue({
		result: async () => ({ stopReason: "error", errorMessage: "not used in helper tests", content: [] }),
	});
});

describe("openai-codex helpers", () => {
	it("searchOpenAICodex asks Codex for rich source-grounded snippets", async () => {
		const { searchOpenAICodex } = await import("./backends/openai-codex.ts");

		await expect(searchOpenAICodex("test query", 3)).rejects.toThrow("not used in helper tests");

		const [, context] = streamOpenAICodexResponsesMock.mock.calls[0];
		const submitTool = context.tools[0];
		const resultSchema = submitTool.parameters.results.value;

		expect(context.systemPrompt).toContain("450-500 character");
		expect(context.systemPrompt).toContain("normal search-result display");
		expect(context.systemPrompt).not.toContain("For content");
		expect(resultSchema.snippet.description).toContain("450-500 character");
		expect(resultSchema.snippet.description).toContain("Prefer completeness and concrete details over brevity");
		expect("content" in resultSchema).toBe(false);
	});

	it("injectCodexSearchPayload prepends hosted search and preserves function tools", async () => {
		const { injectCodexSearchPayload } = await import("./backends/openai-codex.ts");

		const payload = injectCodexSearchPayload({
			tools: [
				{ type: "web_search", external_web_access: false },
				{ type: "function", name: "submit_search_results" },
			],
			include: ["reasoning.encrypted_content"],
			parallel_tool_calls: true,
		}) as {
			tools: Array<Record<string, unknown>>;
			include: string[];
			parallel_tool_calls: boolean;
			tool_choice: string;
		};

		expect(payload.tools).toHaveLength(2);
		expect(payload.tools[0]).toMatchObject({
			type: "web_search",
			external_web_access: true,
			search_context_size: "low",
		});
		expect(payload.tools[1]).toMatchObject({ type: "function", name: "submit_search_results" });
		expect(payload.parallel_tool_calls).toBe(false);
		expect(payload.tool_choice).toBe("auto");
		expect(payload.include).toEqual([
			"reasoning.encrypted_content",
			"web_search_call.action.sources",
		]);
	});

	it("normalizeSubmitSearchResults drops invalid URLs, dedupes, and mirrors snippet into content", async () => {
		const { normalizeSubmitSearchResults } = await import("./backends/openai-codex.ts");

		const results = normalizeSubmitSearchResults(
			{
				results: [
					{ title: "", url: "example.com", snippet: "Primary source summary", content: "Ignored model content" },
					{ title: "Content only", url: "https://content-only.example/", content: "Ignored without snippet" },
					{ title: "Duplicate", url: "https://example.com/#section", snippet: "duplicate" },
					{ title: "Bad", url: "javascript:alert(1)", snippet: "ignore me" },
					{ title: "Docs", url: "https://docs.digitalocean.com/reference/doctl/", snippet: "CLI docs" },
				],
			},
			2,
		);

		expect(results).toEqual([
			{
				title: "example.com",
				url: "https://example.com/",
				snippet: "Primary source summary",
				content: "Primary source summary",
			},
			{
				title: "Docs",
				url: "https://docs.digitalocean.com/reference/doctl/",
				snippet: "CLI docs",
				content: "CLI docs",
			},
		]);
	});

	it("normalizeSubmitSearchResults truncates mirrored snippet content to the snippet cap", async () => {
		const { normalizeSubmitSearchResults } = await import("./backends/openai-codex.ts");
		const longSnippet = "x".repeat(1100);

		const [result] = normalizeSubmitSearchResults(
			{ results: [{ title: "Long", url: "https://example.com/long", snippet: longSnippet }] },
			1,
		);

		expect(result.snippet).toHaveLength(1000);
		expect(result.content).toHaveLength(1000);
	});

	it("normalizeSubmitSearchResults returns empty for malformed tool arguments", async () => {
		const { normalizeSubmitSearchResults } = await import("./backends/openai-codex.ts");

		expect(normalizeSubmitSearchResults({}, 5)).toEqual([]);
		expect(normalizeSubmitSearchResults({ results: "not-an-array" }, 5)).toEqual([]);
	});
});
