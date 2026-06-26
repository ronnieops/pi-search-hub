/**
 * Unit tests for Exa Contents API fetch function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchExaContents } from "../extensions/backends/exa.js";

describe("fetchExaContents", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("sends x-api-key header", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "Test", url: "https://example.com", text: "Hello" }],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		await fetchExaContents("https://example.com", "exa-key");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("exa-key");
	});

	it("posts to the Exa contents endpoint", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "T", url: "https://example.com", text: "c" }],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		await fetchExaContents("https://example.com", "key");

		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.exa.ai/contents");
	});

	it("sends correct request body", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "T", url: "https://example.com", text: "c" }],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		await fetchExaContents("https://example.com", "key");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ urls: ["https://example.com"], text: true });
	});

	it("returns content on success", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "Example", url: "https://example.com", text: "Page content here" }],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		const result = await fetchExaContents("https://example.com", "key");
		expect(result).toEqual({
			title: "Example",
			url: "https://example.com",
			content: "Page content here",
			warning: undefined,
		});
	});

	it("throws on HTTP error", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => '{"error":"Invalid API key"}',
		} as Response);

		const err = await fetchExaContents("https://example.com", "bad-key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/Exa contents/);
	});

	it("throws when per-URL status is error", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "", url: "https://example.com", text: "" }],
				statuses: [{ id: "https://example.com", status: "error", error: { tag: "CRAWL_NOT_FOUND" } }],
			}),
		} as Response);

		const err = await fetchExaContents("https://example.com", "key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/CRAWL_NOT_FOUND/);
	});

	it("throws when no results returned", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		} as Response);

		const err = await fetchExaContents("https://example.com", "key").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/no results/);
	});
});
