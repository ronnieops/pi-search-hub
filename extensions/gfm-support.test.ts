import { describe, it, expect } from "vitest";
import {
	parseGFM,
	markdownToBasicHtml,
	tableToCSV,
	tableToJSON,
	looksLikeTable,
} from "./gfm-support.js";

describe("gfm-support", () => {
	describe("parseGFM", () => {
		it("parses basic markdown", () => {
			const result = parseGFM("# Hello\n\nThis is **bold**.");
			expect(result.html).toContain("<h1>Hello</h1>");
			expect(result.html).toContain("<strong>bold</strong>");
		});

		it("parses tables", () => {
			const md = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;
			const result = parseGFM(md);
			expect(result.html).toContain("<table>");
			expect(result.html).toContain("<th>Header 1</th>");
			expect(result.html).toContain("<td>Cell 1</td>");
			expect(result.stats.tables).toBe(1);
		});

		it("parses task lists", () => {
			const md = `- [ ] Todo item
- [x] Done item`;
			const result = parseGFM(md);
			expect(result.html).toContain('<input type="checkbox"');
			expect(result.html).toContain('checked="checked"');
			expect(result.stats.tasklists).toBe(2);
		});

		it("parses strikethrough", () => {
			const result = parseGFM("~~deleted~~");
			expect(result.html).toContain("<del>deleted</del>");
		});

		it("parses autolinks", () => {
			const result = parseGFM("<https://example.com>");
			expect(result.html).toContain('<a href="https://example.com">');
		});

		it("parses fenced code blocks", () => {
			const md = "```javascript\nconsole.log('test');\n```";
			const result = parseGFM(md);
			expect(result.html).toContain("<pre><code");
			expect(result.html).toContain("language-javascript");
			expect(result.stats.codeBlocks).toBe(1);
		});

		it("preserves original content", () => {
			const md = "# Test";
			const result = parseGFM(md);
			expect(result.original).toBe(md);
		});
	});

	describe("markdownToBasicHtml", () => {
		it("converts headings", () => {
			const html = markdownToBasicHtml("# H1\n## H2\n### H3");
			expect(html).toContain("<h1>H1</h1>");
			expect(html).toContain("<h2>H2</h2>");
			expect(html).toContain("<h3>H3</h3>");
		});

		it("converts bold and italic", () => {
			const html = markdownToBasicHtml("**bold** and *italic*");
			expect(html).toContain("<strong>bold</strong>");
			expect(html).toContain("<em>italic</em>");
		});

		it("converts links", () => {
			const html = markdownToBasicHtml("[link](https://example.com)");
			expect(html).toContain('<a href="https://example.com">link</a>');
		});

		it("converts blockquotes", () => {
			const html = markdownToBasicHtml("> quoted text");
			expect(html).toContain("<blockquote>quoted text</blockquote>");
		});

		it("converts horizontal rules", () => {
			const html = markdownToBasicHtml("---");
			expect(html).toContain("<hr>");
		});
	});

	describe("tableToCSV", () => {
		it("converts table to CSV", () => {
			const md = `| Name | Age |
|------|-----|
| Bob  | 30  |`;
			const csv = tableToCSV(md);
			expect(csv).toContain('"Name","Age"');
			expect(csv).toContain('"Bob","30"');
		});

		it("handles empty table", () => {
			const csv = tableToCSV("| |");
			expect(csv).toBe("");
		});
	});

	describe("tableToJSON", () => {
		it("converts table to JSON array", () => {
			const md = `| Name | Age |
|------|-----|
| Bob  | 30  |`;
			const json = tableToJSON(md);
			const parsed = JSON.parse(json);
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed[0]).toEqual({ Name: "Bob", Age: "30" });
		});

		it("returns empty array for invalid table", () => {
			const json = tableToJSON("not a table");
			expect(json).toBe("[]");
		});
	});

	describe("looksLikeTable", () => {
		it("detects markdown tables", () => {
			const md = `| A | B |
|---|---|
| 1 | 2 |`;
			expect(looksLikeTable(md)).toBe(true);
		});

		it("rejects non-table content", () => {
			expect(looksLikeTable("# Header")).toBe(false);
			expect(looksLikeTable("Just text")).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("handles nested code in tables", () => {
			const md = `| Code | Description |
|------|-------------|
| \`const x = 1\` | Example |`;
			const result = parseGFM(md);
			expect(result.html).toContain("<table>");
			expect(result.html).toContain("<code>");
		});

		it("handles empty task list", () => {
			const md = "- [ ] ";
			const result = parseGFM(md);
			expect(result.html).toContain('<input type="checkbox"');
		});

		it("handles complex markdown", () => {
			const md = `# Title

## Table

| A | B |
|---|---|
| 1 | 2 |

## Task List

- [x] Done
- [ ] Todo

\`\`\`js
console.log('test');
\`\`\`

~~strikethrough~~`;
			const result = parseGFM(md);
			expect(result.html).toContain("<h1>");
			expect(result.html).toContain("<table>");
			expect(result.html).toContain('<input type="checkbox"');
			expect(result.html).toContain("<pre><code");
			expect(result.html).toContain("<del>");
		});
	});
});