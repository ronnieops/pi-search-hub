/**
 * Unit tests for Perplexity backend HTTP layer.
 *
 * Covers the request headers sent to the Perplexity Sonar API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchPerplexity } from "../extensions/backends/perplexity.js";

describe("searchPerplexity", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("sends Authorization and X-Pplx-Integration headers to api.perplexity.ai", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ choices: [{ message: { content: "" } }], citations: [] }),
		} as Response);

		await searchPerplexity("rust async", 5, "pplx-test-key");

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(url).toBe("https://api.perplexity.ai/chat/completions");
		expect(headers["Authorization"]).toBe("Bearer pplx-test-key");
		expect(headers["X-Pplx-Integration"]).toBe("pi-search-hub");
		expect(Object.keys(headers).filter((k) => k.toLowerCase() === "x-pplx-integration")).toHaveLength(1);
	});
});
