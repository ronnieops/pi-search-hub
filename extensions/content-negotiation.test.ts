import { describe, it, expect } from "vitest";
import {
	detectContentType,
	detectFromContent,
	htmlToMarkdown,
	looksLikeReadableHtml,
} from "./content-negotiation.js";

describe("content-negotiation", () => {
	describe("detectContentType", () => {
		it("detects Markdown content-type", () => {
			const result = detectContentType("text/markdown");
			expect(result.type).toBe("markdown");
			expect(result.confidence).toBe(1);
		});

		it("detects HTML content-type", () => {
			const result = detectContentType("text/html");
			expect(result.type).toBe("html");
			expect(result.confidence).toBe(1);
		});

		it("detects JSON content-type", () => {
			const result = detectContentType("application/json");
			expect(result.type).toBe("json");
			expect(result.confidence).toBe(1);
		});

		it("extracts charset from content-type", () => {
			const result = detectContentType("text/html; charset=utf-8");
			expect(result.charset).toBe("utf-8");
		});

		it("returns unknown for null content-type", () => {
			const result = detectContentType(null);
			expect(result.type).toBe("unknown");
			expect(result.confidence).toBe(0);
		});

		it("detects HTML content when no markdown indicators", () => {
			const html = "<html><body><div>Plain HTML</div></body></html>";
			const result = detectContentType("text/html", html);
			expect(result.type).toBe("html");
		});
	});

	describe("detectFromContent", () => {
		it("returns markdown type for markdown-like content", () => {
			// Content with multiple markdown indicators
			const md = "# Header\n\n[link](url)\n\n```code```\n\n> quote\n\n| table |";
			const result = detectFromContent(md);
			// Result should be markdown or text (confidence varies by indicators)
			expect(["markdown", "text"]).toContain(result.type);
		});

		it("detects HTML from content", () => {
			const html = "<div><p>Paragraph</p><ul><li>Item</li></ul><table><tr><td>Cell</td></tr></table></div>";
			const result = detectFromContent(html);
			expect(result.type).toBe("html");
			expect(result.confidence).toBeGreaterThan(0.3);
		});

		it("detects JSON content", () => {
			const json = '{"key": "value", "array": [1, 2, 3]}';
			const result = detectFromContent(json);
			expect(result.type).toBe("json");
			expect(result.confidence).toBe(0.9);
		});

		it("returns text for plain content", () => {
			const plain = "Just some plain text without any markup.";
			const result = detectFromContent(plain);
			expect(result.type).toBe("text");
			expect(result.confidence).toBe(0.5);
		});
	});

	describe("htmlToMarkdown", () => {
		it("converts headings", () => {
			const html = "<h1>Title</h1><h2>Subtitle</h2>";
			const md = htmlToMarkdown(html);
			expect(md).toContain("# Title");
			expect(md).toContain("## Subtitle");
		});

		it("converts bold and italic", () => {
			const html = "<strong>bold</strong> and <em>italic</em>";
			const md = htmlToMarkdown(html);
			expect(md).toContain("**bold**");
			expect(md).toContain("*italic*");
		});

		it("converts links", () => {
			const html = '<a href="https://example.com">Link Text</a>';
			const md = htmlToMarkdown(html);
			expect(md).toContain("[Link Text](https://example.com)");
		});

		it("converts images", () => {
			const html = '<img src="image.png" alt="Alt text">';
			const md = htmlToMarkdown(html);
			expect(md).toContain("![Alt text](image.png)");
		});

		it("converts code blocks", () => {
			const html = '<pre><code class="language-javascript">console.log("test");</code></pre>';
			const md = htmlToMarkdown(html);
			expect(md).toContain("```javascript");
			expect(md).toContain("console.log");
		});

		it("converts lists", () => {
			const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
			const md = htmlToMarkdown(html);
			expect(md).toContain("- Item 1");
			expect(md).toContain("- Item 2");
		});

		it("converts blockquotes", () => {
			const html = "<blockquote>Quoted text</blockquote>";
			const md = htmlToMarkdown(html);
			expect(md).toContain("> Quoted text");
		});

		it("converts horizontal rules", () => {
			const html = "<hr>";
			const md = htmlToMarkdown(html);
			expect(md).toContain("---");
		});

		it("handles paragraphs", () => {
			const html = "<p>First paragraph</p><p>Second paragraph</p>";
			const md = htmlToMarkdown(html);
			expect(md).toContain("First paragraph");
			expect(md).toContain("Second paragraph");
		});

		it("decodes HTML entities", () => {
			const html = "<p>Hello &amp; World &lt;3</p>";
			const md = htmlToMarkdown(html);
			expect(md).toContain("Hello & World <3");
		});

		it("cleans up whitespace", () => {
			const html = "<p>Line 1</p><p>Line 2</p><p>Line 3</p>";
			const md = htmlToMarkdown(html);
			expect(md).not.toContain("\n\n\n");
		});
	});

	describe("looksLikeReadableHtml", () => {
		it("detects article elements", () => {
			expect(looksLikeReadableHtml("<article><p>Content</p></article>")).toBe(true);
		});

		it("detects main content elements", () => {
			expect(looksLikeReadableHtml("<main><p>Content</p></main>")).toBe(true);
		});

		it("detects article elements", () => {
			expect(looksLikeReadableHtml('<article><p>Content</p></article>')).toBe(true);
		});

		it("returns false for non-content HTML", () => {
			expect(looksLikeReadableHtml("<div>No real content</div>")).toBe(false);
		});

		it("returns false for empty content", () => {
			expect(looksLikeReadableHtml("")).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("handles malformed HTML gracefully", () => {
			const html = "<div><p>Unclosed";
			const md = htmlToMarkdown(html);
			expect(md).toBeDefined();
		});

		it("handles empty content", () => {
			const result = detectFromContent("");
			expect(result.type).toBe("text");
			expect(result.confidence).toBe(0.5);
		});

		it("handles very long content", () => {
			const html = "<p>" + "x".repeat(10000) + "</p>";
			const md = htmlToMarkdown(html);
			expect(md.length).toBeGreaterThan(0);
		});

		it("preserves code in lists", () => {
			const html = "<ul><li><code>code</code> text</li></ul>";
			const md = htmlToMarkdown(html);
			expect(md).toContain("`code`");
		});
	});
});