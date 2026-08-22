import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({}));
vi.mock("@earendil-works/pi-ai", () => ({}));

vi.mock("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		String: (value?: unknown) => value ?? {},
		Optional: (value: unknown) => value,
		Array: (value: unknown, options?: unknown) => ({ value, options }),
	},
}));

describe("openai-codex helpers", () => {
	it("searchOpenAICodex uses Pi model runtime auth and preserves Codex request options", async () => {
		const { searchOpenAICodex } = await import("./backends/openai-codex.ts");
		const model = { id: "gpt-5.4-mini", provider: "openai-codex", api: "openai-codex-responses" };
		const modelRegistry = {
			find: vi.fn(() => model),
			hasConfiguredAuth: vi.fn(() => true),
			complete: vi.fn(async (_model: unknown, _context: any, _options: any) => ({
				stopReason: "toolUse",
				content: [
					{
						type: "toolCall",
						name: "submit_search_results",
						arguments: {
							results: [{ title: "Example", url: "https://example.com", snippet: "Source summary" }],
						},
					},
				],
			})),
		};

		const result = await searchOpenAICodex(
			"test query",
			3,
			modelRegistry as never,
		);

		expect(result.results).toEqual([
			{
				title: "Example",
				url: "https://example.com/",
				snippet: "Source summary",
				content: "Source summary",
			},
		]);
		expect(modelRegistry.find).toHaveBeenCalledWith("openai-codex", "gpt-5.4-mini");

		const [completedModel, context, options] = modelRegistry.complete.mock.calls[0];
		const submitTool = context.tools[0];
		const resultSchema = submitTool.parameters.results.value;

		expect(completedModel).toBe(model);
		expect(options).toMatchObject({
			transport: "sse",
			reasoningEffort: "minimal",
			textVerbosity: "low",
		});
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(options.onPayload).toBeTypeOf("function");
		expect(context.systemPrompt).toContain("450-500 character");
		expect(context.systemPrompt).toContain("normal search-result display");
		expect(context.systemPrompt).not.toContain("For content");
		expect(resultSchema.snippet.description).toContain("450-500 character");
		expect(resultSchema.snippet.description).toContain("Prefer completeness and concrete details over brevity");
		expect("content" in resultSchema).toBe(false);
	});

	it("searchOpenAICodex reports missing Pi-managed Codex auth", async () => {
		const { searchOpenAICodex } = await import("./backends/openai-codex.ts");
		const modelRegistry = {
			find: vi.fn(() => ({
				id: "gpt-5.4-mini",
				provider: "openai-codex",
				api: "openai-codex-responses",
			})),
			hasConfiguredAuth: vi.fn(() => false),
			complete: vi.fn(),
		};

		await expect(searchOpenAICodex("test query", 3, modelRegistry as never)).rejects.toThrow(
			"OpenAI Codex authentication not found. Run /login and select OpenAI Codex.",
		);
		expect(modelRegistry.complete).not.toHaveBeenCalled();
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

	it("normalizeSubmitSearchResults drops invalid URLs, dedupes, and falls back to content when snippet missing", async () => {
		const { normalizeSubmitSearchResults } = await import("./backends/openai-codex.ts");

		const results = normalizeSubmitSearchResults(
			{
				results: [
					{ title: "", url: "example.com", snippet: "Primary source summary", content: "Ignored model content" },
					{ title: "Content only", url: "https://content-only.example/", content: "Falls back to content when no snippet" },
					{ title: "Duplicate", url: "https://example.com/#section", snippet: "duplicate" },
					{ title: "Bad", url: "javascript:alert(1)", snippet: "ignore me" },
					{ title: "Docs", url: "https://docs.digitalocean.com/reference/doctl/", snippet: "CLI docs" },
				],
			},
			3,
		);

		expect(results).toEqual([
			{
				title: "example.com",
				url: "https://example.com/",
				snippet: "Primary source summary",
				content: "Primary source summary",
			},
			{
				title: "Content only",
				url: "https://content-only.example/",
				snippet: "Falls back to content when no snippet",
				content: "Falls back to content when no snippet",
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

	it("normalizeSubmitSearchResults drops results with neither snippet nor content", async () => {
		const { normalizeSubmitSearchResults } = await import("./backends/openai-codex.ts");

		const results = normalizeSubmitSearchResults(
			{
				results: [
					{ title: "No text", url: "https://example.com/no-text" },
					{ title: "Has snippet", url: "https://example.com/has-snippet", snippet: "valid" },
					{ title: "Empty snippet", url: "https://example.com/empty-snippet", snippet: "", content: "" },
				],
			},
			5,
		);

		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/has-snippet");
	});
});

describe("openai-codex URL helpers", () => {
	it("normalizeHttpUrl prepends https for bare domains", async () => {
		const { normalizeHttpUrl } = await import("./backends/openai-codex.ts");

		expect(normalizeHttpUrl("example.com")).toBe("https://example.com/");
		expect(normalizeHttpUrl("docs.example.com/path")).toBe("https://docs.example.com/path");
	});

	it("normalizeHttpUrl rejects non-http protocols", async () => {
		const { normalizeHttpUrl } = await import("./backends/openai-codex.ts");

		expect(normalizeHttpUrl("javascript:alert(1)")).toBeUndefined();
		expect(normalizeHttpUrl("ftp://example.com")).toBeUndefined();
		expect(normalizeHttpUrl("file:///etc/passwd")).toBeUndefined();
	});

	it("normalizeHttpUrl strips hash fragments", async () => {
		const { normalizeHttpUrl } = await import("./backends/openai-codex.ts");

		expect(normalizeHttpUrl("https://example.com/page#section")).toBe("https://example.com/page");
	});

	it("normalizeHttpUrl returns undefined for empty or whitespace input", async () => {
		const { normalizeHttpUrl } = await import("./backends/openai-codex.ts");

		expect(normalizeHttpUrl("")).toBeUndefined();
		expect(normalizeHttpUrl("   ")).toBeUndefined();
	});

	it("normalizeUrlForDedup normalizes trailing slash and case", async () => {
		const { normalizeUrlForDedup } = await import("./backends/openai-codex.ts");

		expect(normalizeUrlForDedup("https://Example.COM/Page/")).toBe("https://example.com/page");
		expect(normalizeUrlForDedup("https://example.com/page")).toBe("https://example.com/page");
	});

	it("normalizeUrlForDedup strips hash fragments", async () => {
		const { normalizeUrlForDedup } = await import("./backends/openai-codex.ts");

		expect(normalizeUrlForDedup("https://example.com/page#section")).toBe("https://example.com/page");
	});

	it("looksLikeDomainOrPath matches domain-like strings", async () => {
		const { looksLikeDomainOrPath } = await import("./backends/openai-codex.ts");

		expect(looksLikeDomainOrPath("example.com")).toBe(true);
		expect(looksLikeDomainOrPath("sub.example.com/path/to/page")).toBe(true);
		expect(looksLikeDomainOrPath("localhost")).toBe(false);
		expect(looksLikeDomainOrPath("justaword")).toBe(false);
	});
});
