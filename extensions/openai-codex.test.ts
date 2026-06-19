import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	AuthStorage: {
		create: () => ({
			getApiKey: async () => "test-api-key",
		}),
	},
}));

vi.mock("@earendil-works/pi-ai", () => ({
	getModel: () => ({ id: "gpt-5.4-mini" }),
	streamOpenAICodexResponses: () => ({
		result: async () => ({ stopReason: "error", errorMessage: "not used in helper tests", content: [] }),
	}),
}));

vi.mock("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: (value?: unknown) => value ?? {},
		Optional: (value: unknown) => value,
		Array: (value: unknown, options?: unknown) => ({ value, options }),
	},
}));

describe("openai-codex helpers", () => {
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

	it("normalizeSubmitSearchResults drops invalid URLs, dedupes, and falls back snippet to content", async () => {
		const { normalizeSubmitSearchResults } = await import("./backends/openai-codex.ts");

		const results = normalizeSubmitSearchResults(
			{
				results: [
					{ title: "", url: "example.com", content: "Primary source summary" },
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
				content: undefined,
			},
		]);
	});

	it("normalizeSubmitSearchResults returns empty for malformed tool arguments", async () => {
		const { normalizeSubmitSearchResults } = await import("./backends/openai-codex.ts");

		expect(normalizeSubmitSearchResults({}, 5)).toEqual([]);
		expect(normalizeSubmitSearchResults({ results: "not-an-array" }, 5)).toEqual([]);
	});
});
