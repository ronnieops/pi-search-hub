import { describe, it, expect } from "vitest";
import {
	generateSiblingUrls,
	looksLikeMarkdown,
} from "./sibling-probe.js";

describe("sibling-probe", () => {
	describe("generateSiblingUrls", () => {
		it("returns empty for Markdown URLs", () => {
			const variants = generateSiblingUrls("https://example.com/README.md");
			expect(variants).toHaveLength(0);
		});

		it("returns empty for invalid URLs", () => {
			const variants = generateSiblingUrls("not-a-url");
			expect(variants).toHaveLength(0);
		});

		it("generates .md variant for path without extension", () => {
			const variants = generateSiblingUrls("https://example.com/docs/intro");
			expect(variants).toContain("https://example.com/docs/intro.md");
		});

		it("generates README.md in same directory", () => {
			const variants = generateSiblingUrls("https://example.com/docs/guide");
			expect(variants).toContain("https://example.com/docs/README.md");
		});

		it("generates raw GitHub URL from blob", () => {
			const url = "https://github.com/user/repo/blob/main/src/index.ts";
			const variants = generateSiblingUrls(url);
			expect(variants).toContain("https://raw.githubusercontent.com/user/repo/main/src/index.ts");
		});

		it("generates README.md from GitHub tree", () => {
			const url = "https://github.com/user/repo/tree/main/docs";
			const variants = generateSiblingUrls(url);
			expect(variants.some(v => v.includes("README.md"))).toBe(true);
		});

		it("limits to MAX_PROBES variants", () => {
			const variants = generateSiblingUrls("https://example.com/a/b/c");
			expect(variants.length).toBeLessThanOrEqual(5);
		});

		it("does not duplicate paths", () => {
			const url = "https://example.com/docs/index.md";
			const variants = generateSiblingUrls(url);
			expect(variants.filter(v => v === "https://example.com/docs/index.md.md")).toHaveLength(0);
		});
	});

	describe("looksLikeMarkdown", () => {
		it("detects Markdown headings", () => {
			expect(looksLikeMarkdown("# Hello World")).toBe(true);
			expect(looksLikeMarkdown("## Section")).toBe(true);
			expect(looksLikeMarkdown("### Subsection")).toBe(true);
		});

		it("detects Markdown links", () => {
			expect(looksLikeMarkdown("[link](https://example.com)")).toBe(true);
		});

		it("detects code blocks", () => {
			expect(looksLikeMarkdown("```javascript\nconsole.log('test');\n```")).toBe(true);
			expect(looksLikeMarkdown("`inline code`")).toBe(true);
		});

		it("detects list items", () => {
			expect(looksLikeMarkdown("- item 1\n- item 2")).toBe(true);
			expect(looksLikeMarkdown("* bullet\n* bullet")).toBe(true);
			expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
		});

		it("detects images", () => {
			expect(looksLikeMarkdown("![alt](image.png)")).toBe(true);
		});

		it("detects blockquotes", () => {
			expect(looksLikeMarkdown("> quoted text")).toBe(true);
		});

		it("detects tables", () => {
			expect(looksLikeMarkdown("| col1 | col2 |\n|------|------|\n| val  | val  |")).toBe(true);
		});

		it("detects horizontal rules", () => {
			expect(looksLikeMarkdown("---")).toBe(true);
		});

		it("rejects plain HTML", () => {
			expect(looksLikeMarkdown("<html><body>content</body></html>")).toBe(false);
		});

		it("rejects plain text", () => {
			expect(looksLikeMarkdown("Just some plain text without any markdown formatting.")).toBe(false);
		});

		it("rejects empty content", () => {
			expect(looksLikeMarkdown("")).toBe(false);
		});

		it("rejects short non-markdown content", () => {
			expect(looksLikeMarkdown("Hello")).toBe(false);
		});
	});
});