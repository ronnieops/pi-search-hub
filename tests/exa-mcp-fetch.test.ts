/**
 * Unit tests for Exa MCP web_fetch function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchExaMCP } from "../extensions/backends/exa-mcp.js";

describe("fetchExaMCP", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("sends valid JSON-RPC 2.0 request with web_fetch_exa tool", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: JSON.stringify([{ title: "Test", url: "https://example.com", content: "Hello" }]) }],
				},
			}),
		} as Response);

		await fetchExaMCP("https://example.com");

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.jsonrpc).toBe("2.0");
		expect(body.method).toBe("tools/call");
		expect(body.params.arguments.name).toBe("web_fetch_exa");
		expect(body.params.arguments.arguments.url).toBe("https://example.com");
	});

	it("posts to the Exa MCP endpoint", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: JSON.stringify([{ title: "T", url: "https://example.com", content: "c" }]) }],
				},
			}),
		} as Response);

		await fetchExaMCP("https://example.com");

		const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://mcp.exa.ai/mcp");
	});

	it("returns content on success", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: JSON.stringify([{ title: "Example", url: "https://example.com", content: "Page content" }]) }],
				},
			}),
		} as Response);

		const result = await fetchExaMCP("https://example.com");
		expect(result).toEqual({ title: "Example", url: "https://example.com", content: "Page content" });
	});

	it("throws on HTTP error", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 429,
			text: async () => "Rate limited",
		} as Response);

		const err = await fetchExaMCP("https://example.com").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/Exa MCP/);
	});

	it("throws on MCP error response", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32601, message: "Method not found" },
			}),
		} as Response);

		const err = await fetchExaMCP("https://example.com").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/Method not found/);
	});

	it("throws when no content returned", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [] },
			}),
		} as Response);

		const err = await fetchExaMCP("https://example.com").catch(e => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/no content/);
	});
});
