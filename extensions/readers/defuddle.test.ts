/**
 * Unit tests for the Defuddle reader (local, keyless HTML → Markdown).
 *
 * Uses small synthetic HTML fixtures — no network, no third-party content.
 * Fixtures replicate the structures behind the validated regression checks:
 * Sphinx `reference` cross-links, Wikipedia `.sfrac` screen-reader slashes,
 * and caption `<i>`/`<sup>` variables.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchDefuddle } from "./defuddle.js";

const LOREM =
	"Local extraction keeps working without any hosted service or API key. ".repeat(8);

function mockHtmlResponse(html: string, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => null },
		text: async () => (status >= 200 && status < 300 ? html : "error body"),
	} as unknown as Response;
}

function article(title: string, body: string) {
	return (
		`<html><head><title>${title}</title></head>` +
		`<body><main><article><h1>${title}</h1><p>${LOREM}</p>${body}<p>${LOREM}</p></article></main></body></html>`
	);
}

describe("fetchDefuddle", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("returns markdown with the page title from a single fetch", async () => {
		fetchSpy.mockResolvedValueOnce(mockHtmlResponse(article("Hello", "<p>Body text here.</p>")));

		const result = await fetchDefuddle("https://example.com/hello");

		expect(result.title).toBe("Hello");
		expect(result.content).toContain("Body text here");
		// useAsync:false — strictly local, no follow-up network calls.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://example.com/hello");
		expect(init.headers).toMatchObject({ Accept: "text/html" });
	});

	it("preserves Sphinx-style reference cross-links (Python docs regression)", async () => {
		const body =
			`<p>Unlike <a class="reference internal" href="#iter"><code><span>iter()</span></code></a>, ` +
			`<a class="reference internal" href="#aiter"><code><span>aiter()</span></code></a> has no 2-argument variant.</p>`;
		fetchSpy.mockResolvedValueOnce(mockHtmlResponse(article("Built-in Functions", body)));

		const result = await fetchDefuddle("https://docs.python.org/3/library/functions.html");

		expect(result.content).toContain("iter()");
		expect(result.content).toContain("aiter()");
	});

	it("preserves screen-reader fraction slashes (math caption regression)", async () => {
		const body =
			`<figure><figcaption>The roots of the function <i>y</i> = ` +
			`<span class="sfrac"><span class="tion"><span class="num">1</span>` +
			`<span class="sr-only">/</span><span class="den">2</span></span></span> are here.</figcaption></figure>`;
		fetchSpy.mockResolvedValueOnce(
			mockHtmlResponse(article("Fractions", body)),
		);

		const result = await fetchDefuddle("https://example.com/fractions");

		expect(result.content).toMatch(/1\s*\/\s*2/);
	});

	it("disables standardization on wikipedia.org (caption variable regression)", async () => {
		const body =
			`<figure><figcaption>The graph intersects the ` +
			`<span class="texhtml mvar">x</span>-axis at <i>x</i> = 1.</figcaption></figure>`;
		fetchSpy.mockResolvedValueOnce(mockHtmlResponse(article("Formula", body)));

		const result = await fetchDefuddle("https://en.wikipedia.org/wiki/Quadratic_formula");

		// Turndown escapes the hyphen; the point is the variable survived.
		expect(result.content).toContain("x\\-axis");
		expect(result.content).toContain("*x* = 1");
	});

	it("throws on empty extraction so the fallback chain engages", async () => {
		fetchSpy.mockResolvedValueOnce(
			mockHtmlResponse("<html><head><title>Empty</title></head><body></body></html>"),
		);

		await expect(fetchDefuddle("https://example.com/empty")).rejects.toThrow(/no content/);
	});

	it("throws on transport errors", async () => {
		fetchSpy.mockResolvedValueOnce(mockHtmlResponse("", 503));

		await expect(fetchDefuddle("https://example.com/down")).rejects.toThrow(
			/Failed to read https:\/\/example\.com\/down/,
		);
	});

	it("refuses oversized responses before buffering", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: { get: () => String(4 * 1024 * 1024) },
			text: async () => "",
		} as unknown as Response);

		await expect(fetchDefuddle("https://example.com/big")).rejects.toThrow(/too large/);
	});

	it("threads the abort signal into the page fetch", async () => {
		fetchSpy.mockResolvedValueOnce(mockHtmlResponse(article("Hi", "<p>x</p>")));
		const controller = new AbortController();

		await fetchDefuddle("https://example.com/hi", controller.signal);

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(init.signal).toBeDefined();
	});
});
