/**
 * Unit tests for Firecrawl backend HTTP layer.
 *
 * Covers Authorization header behavior (with and without a key), error
 * handling, and abort signal. The registry gating (optionalKey/MISSING_KEY_HELP)
 * is exercised via integration tests; these tests focus on searchFirecrawl itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchFirecrawl, fetchFirecrawl } from "../extensions/backends/firecrawl.js";

describe("searchFirecrawl", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("sends Authorization: Bearer <key> when a key is provided", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ data: { web: [] } }),
		} as Response);

		await searchFirecrawl("rust async", 5, "fc-test-key");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer fc-test-key");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ query: "rust async", limit: 5 });
	});

	it("omits Authorization header when no key is provided (keyless mode)", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ data: { web: [] } }),
		} as Response);

		await searchFirecrawl("q", 5);

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers["Authorization"]).toBeUndefined();
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("posts to the Firecrawl v2 search endpoint", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ data: { web: [] } }),
		} as Response);

		await searchFirecrawl("q", 3, "key");

		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.firecrawl.dev/v2/search");
	});

	it("clamps limit to 20 in the request body", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ data: { web: [] } }),
		} as Response);

		await searchFirecrawl("q", 100, "key");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string).limit).toBe(20);
	});

	it("parses v2 web results", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: {
					web: [
						{ title: "Result", url: "https://example.com", description: "desc" },
					],
				},
			}),
		} as Response);

		const { results } = await searchFirecrawl("q", 10, "key");
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({
			title: "Result",
			url: "https://example.com",
			snippet: "desc",
		});
	});

	it("throws a sanitized error on non-ok response", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => "Unauthorized: Bearer supersecrettoken123",
		} as Response);

		const err = await searchFirecrawl("q", 5, "bad-key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/Firecrawl/);
		// The raw Bearer token from upstream must not leak into the thrown message.
		expect(String(err.message)).not.toMatch(/supersecrettoken123/);
	});
});

describe("fetchFirecrawl", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("sends Authorization: Bearer <key> when a key is provided", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				success: true,
				data: { markdown: "# Hello", metadata: { title: "Test", sourceURL: "https://example.com" } },
			}),
		} as Response);

		const result = await fetchFirecrawl("https://example.com", "fc-key");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers["Authorization"]).toBe("Bearer fc-key");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com", formats: ["markdown"] });
		expect(result).toEqual({ title: "Test", url: "https://example.com", content: "# Hello" });
	});

	it("omits Authorization header in keyless mode", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				success: true,
				data: { markdown: "content", metadata: { title: "", sourceURL: "" } },
			}),
		} as Response);

		await fetchFirecrawl("https://example.com");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers["Authorization"]).toBeUndefined();
	});

	it("posts to the Firecrawl v2 scrape endpoint", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				success: true,
				data: { markdown: "", metadata: {} },
			}),
		} as Response);

		await fetchFirecrawl("https://example.com", "key");

		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
	});

	it("throws on non-ok response", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 429,
			text: async () => "Rate limited",
		} as Response);

		const err = await fetchFirecrawl("https://example.com", "key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/Firecrawl scrape/);
	});

	it("throws when data is missing", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ success: true }),
		} as Response);

		const err = await fetchFirecrawl("https://example.com", "key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/no data/);
	});

	it("sanitizes error messages", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => "Unauthorized: Bearer supersecrettoken123",
		} as Response);

		const err = await fetchFirecrawl("https://example.com", "bad-key").catch(e => e);
		expect(String(err.message)).not.toMatch(/supersecrettoken123/);
	});
});
