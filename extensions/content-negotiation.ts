/**
 * Content negotiation pipeline for Markdown detection and extraction.
 * 
 * Strategy chain:
 * 1. HEAD request to check Content-Type
 * 2. Sniff content (8KB sample) for Markdown patterns
 * 3. Sibling URL probing (try .md, README.md variants)
 * 4. HTML to Markdown conversion
 */

import { timeoutSignal, sanitizeError } from "./utils.js";
import { looksLikeMarkdown } from "./sibling-probe.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentNegotiationOptions {
	/** Maximum content size to analyze (default: 8KB) */
	sniffSize?: number;
	/** Enable sibling URL probing (default: true) */
	enableSiblingProbe?: boolean;
	/** Enable HTML to Markdown conversion (default: true) */
	enableHtmlConversion?: boolean;
	/** Custom fetch function */
	fetchFn?: typeof fetch;
}

export interface ContentType {
	type: "markdown" | "html" | "json" | "text" | "unknown";
	confidence: number; // 0-1
	charset?: string;
}

export interface NegotiationResult {
	url: string;
	content: string;
	contentType: ContentType;
	negotiated: boolean;
	strategy: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SNIFF_SIZE = 8 * 1024; // 8KB
const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const MARKDOWN_CONTENT_TYPES = ["text/markdown", "text/x-markdown", "text/plain"];
const JSON_CONTENT_TYPES = ["application/json", "text/json"];

// HTML patterns that indicate Markdown content
const MARKDOWN_HTML_PATTERNS = [
	/<(h1|h2|h3|h4|h5|h6)[^>]*>/i,           // Headings
	/<(p|div|section|article)[^>]*>/i,        // Block elements
	/<(ul|ol|li)[^>]*>/i,                     // Lists
	/<(table|thead|tbody|tr|th|td)[^>]*>/i,    // Tables
	/<(pre|code)[^>]*>/i,                     // Code blocks
	/<(blockquote)[^>]*>/i,                    // Blockquotes
	/<(a|img)[^>]*>/i,                        // Links/images
];

// Markdown indicators in content
const MARKDOWN_INDICATORS = [
	/^#{1,6}\s+\w/m,                          // Markdown headings
	/\[.+\]\(.+\)/m,                           // Markdown links
	/`{1,3}[^`]+`{1,3}/m,                     // Code blocks
	/^\s*[-*+]\s+\w/m,                         // Unordered lists
	/\|.+\|.+\|/m,                             // Tables
	/^>\s+\w/m,                                // Blockquotes
	/!\[.+\]\(.+\)/m,                          // Images
];

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Determine content type from HTTP response.
 */
export function detectContentType(
	contentType: string | null,
	sniffContent?: string,
): ContentType {
	// No content-type header
	if (!contentType) {
		if (sniffContent) {
			return detectFromContent(sniffContent);
		}
		return { type: "unknown", confidence: 0 };
	}

	const lower = contentType.toLowerCase();

	// Check for Markdown types
	for (const type of MARKDOWN_CONTENT_TYPES) {
		if (lower.includes(type)) {
			return { type: "markdown", confidence: 1.0, charset: extractCharset(lower) };
		}
	}

	// Check for HTML types
	for (const type of HTML_CONTENT_TYPES) {
		if (lower.includes(type)) {
			if (sniffContent) {
				const mdScore = scoreMarkdownIndicators(sniffContent);
				if (mdScore > 0.3) {
					return { type: "markdown", confidence: mdScore, charset: extractCharset(lower) };
				}
			}
			return { type: "html", confidence: 1.0, charset: extractCharset(lower) };
		}
	}

	// Check for JSON
	for (const type of JSON_CONTENT_TYPES) {
		if (lower.includes(type)) {
			return { type: "json", confidence: 1.0, charset: extractCharset(lower) };
		}
	}

	// Check for text
	if (lower.includes("text/")) {
		if (sniffContent && looksLikeMarkdown(sniffContent)) {
			return { type: "markdown", confidence: 0.9, charset: extractCharset(lower) };
		}
		return { type: "text", confidence: 0.8, charset: extractCharset(lower) };
	}

	return { type: "unknown", confidence: 0 };
}

/**
 * Detect content type from raw content.
 */
export function detectFromContent(content: string): ContentType {
	const mdScore = scoreMarkdownIndicators(content);
	
	if (mdScore > 0.5) {
		return { type: "markdown", confidence: mdScore };
	}

	// Check for HTML patterns
	const htmlScore = scoreHtmlPatterns(content);
	if (htmlScore > 0.3) {
		return { type: "html", confidence: htmlScore };
	}

	// Check for JSON
	try {
		JSON.parse(content.slice(0, 1000));
		return { type: "json", confidence: 0.9 };
	} catch {
		// Not JSON
	}

	return { type: "text", confidence: 0.5 };
}

/**
 * Score content for Markdown indicators.
 */
function scoreMarkdownIndicators(content: string): number {
	if (content.length === 0) return 0;

	let score = 0;
	for (const pattern of MARKDOWN_INDICATORS) {
		const matches = content.match(pattern);
		if (matches) {
			score += matches.length * 0.1;
		}
	}

	return Math.min(1, score);
}

/**
 * Score content for HTML patterns.
 */
function scoreHtmlPatterns(content: string): number {
	if (content.length === 0) return 0;

	let score = 0;
	for (const pattern of MARKDOWN_HTML_PATTERNS) {
		const matches = content.match(pattern);
		if (matches) {
			score += matches.length * 0.05;
		}
	}

	return Math.min(1, score);
}

/**
 * Extract charset from Content-Type header.
 */
function extractCharset(contentType: string): string | undefined {
	const match = contentType.match(/charset=([^;]+)/i);
	return match?.[1]?.trim();
}

// ---------------------------------------------------------------------------
// Pipeline functions
// ---------------------------------------------------------------------------

/**
 * Perform content negotiation for a URL.
 * Tries multiple strategies to get Markdown content.
 */
export async function negotiateContent(
	url: string,
	signal?: AbortSignal,
	options: ContentNegotiationOptions = {},
): Promise<NegotiationResult> {
	const fetchFn = options.fetchFn ?? fetch;
	const sniffSize = options.sniffSize ?? DEFAULT_SNIFF_SIZE;
	const enableSiblingProbe = options.enableSiblingProbe ?? true;
	const enableHtmlConversion = options.enableHtmlConversion ?? true;

	// Strategy 1: Direct fetch with content sniffing
	try {
		const response = await fetchFn(url, {
			signal: timeoutSignal(signal),
			headers: {
				"Accept": "text/markdown, text/html, text/plain, application/json, */*",
				"Accept-Encoding": "gzip, deflate, br",
			},
		});

		const contentType = response.headers.get("Content-Type");
		const text = await response.text();

		// Sniff the content
		const sniff = text.slice(0, sniffSize);
		const detected = detectContentType(contentType, sniff);

		// Already Markdown
		if (detected.type === "markdown" || looksLikeMarkdown(sniff)) {
			return {
				url,
				content: text,
				contentType: detected,
				negotiated: false,
				strategy: "direct",
			};
		}

		// HTML with Markdown indicators
		if (detected.type === "html" && enableHtmlConversion) {
			const mdScore = scoreMarkdownIndicators(sniff);
			if (mdScore > 0.3) {
				const markdown = htmlToMarkdown(text);
				if (markdown.length > text.length * 0.5) {
					return {
						url,
						content: markdown,
						contentType: { type: "markdown", confidence: mdScore },
						negotiated: true,
						strategy: "html-to-markdown",
					};
				}
			}
		}

		// Return as-is if not convertible
		return {
			url,
			content: text,
			contentType: detected,
			negotiated: false,
			strategy: "direct",
		};
	} catch {
		// Continue to fallback
	}

	// Strategy 2: Sibling URL probing
	if (enableSiblingProbe) {
		const siblingResult = await trySiblingUrls(url, signal, fetchFn);
		if (siblingResult) {
			return siblingResult;
		}
	}

	throw new Error(`Content negotiation failed for ${url}`);
}

/**
 * Try sibling URLs to find Markdown versions.
 */
async function trySiblingUrls(
	originalUrl: string,
	signal: AbortSignal | undefined,
	fetchFn: typeof fetch,
): Promise<NegotiationResult | null> {
	const variants = generateSiblingVariants(originalUrl);

	for (const url of variants) {
		try {
			const response = await fetchFn(url, {
				signal: timeoutSignal(signal),
				headers: {
					"Accept": "text/markdown, text/plain, */*",
				},
			});

			if (response.ok) {
				const contentType = response.headers.get("Content-Type");
				const text = await response.text();

				if (looksLikeMarkdown(text.slice(0, 500))) {
					return {
						url,
						content: text,
						contentType: { type: "markdown", confidence: 0.95 },
						negotiated: true,
						strategy: "sibling-probe",
					};
				}
			}
		} catch {
			// Continue to next variant
		}
	}

	return null;
}

/**
 * Generate sibling URL variants for a given URL.
 */
function generateSiblingVariants(url: string): string[] {
	const variants: string[] = [];
	try {
		const parsed = new URL(url);
		const pathname = parsed.pathname;

		// Skip if already Markdown
		if (pathname.endsWith(".md") || pathname.endsWith(".markdown")) {
			return variants;
		}

		// Try .md extension
		if (!pathname.includes(".")) {
			variants.push(`${url}.md`);
			variants.push(`${url}.markdown`);
		}

		// Try README.md in parent directory
		const lastSlash = pathname.lastIndexOf("/");
		if (lastSlash > 0) {
			const dir = pathname.slice(0, lastSlash);
			variants.push(`${parsed.origin}${dir}/README.md`);
			variants.push(`${parsed.origin}${dir}/readme.md`);
			variants.push(`${parsed.origin}${dir}/index.md`);
		}

		// GitHub blob → raw
		const ghBlob = pathname.match(/\/blob\/([^/]+)\/(.+)/);
		if (ghBlob) {
			const rawUrl = `https://raw.githubusercontent.com${pathname.replace("/blob/", "/")}`;
			variants.push(rawUrl);
		}

		// GitHub tree → README.md
		const ghTree = pathname.match(/\/tree\/([^/]+)\/(.+)/);
		if (ghTree) {
			const dir = pathname.replace(/\/tree\/[^/]+\//, "");
			variants.push(`${parsed.origin}${dir}/README.md`);
		}

		// /docs prefix
		if (!pathname.startsWith("/docs")) {
			variants.push(`${parsed.origin}/docs${pathname}`);
		}

	} catch {
		// Invalid URL
	}

	return variants.slice(0, 5);
}

// ---------------------------------------------------------------------------
// HTML to Markdown conversion
// ---------------------------------------------------------------------------

/**
 * Convert HTML to Markdown.
 */
export function htmlToMarkdown(html: string): string {
	let md = html;

	// Headings
	md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `# ${stripTags(t)}\n\n`);
	md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `## ${stripTags(t)}\n\n`);
	md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `### ${stripTags(t)}\n\n`);
	md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `#### ${stripTags(t)}\n\n`);
	md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, t) => `##### ${stripTags(t)}\n\n`);
	md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, t) => `###### ${stripTags(t)}\n\n`);

	// Bold and italic
	md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `**${stripTags(t)}**`);
	md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `*${stripTags(t)}*`);

	// Links
	md = md.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => 
		`[${stripTags(text)}](${href})`
	);

	// Images
	md = md.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, 
		(_, src, alt) => `![${alt}](${src})`
	);
	md = md.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, 
		(_, alt, src) => `![${alt}](${src})`
	);
	md = md.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, 
		(_, src) => `![](${src})`
	);

	// Code blocks
	md = md.replace(/<pre[^>]*><code[^>]*class=["']language-(\w+)["'][^>]*>([\s\S]*?)<\/code><\/pre>/gi,
		(_, lang, code) => `\`\`\`${lang}\n${decodeHtmlEntities(code)}\n\`\`\`\n\n`
	);
	md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
		(_, code) => `\`\`\`\n${decodeHtmlEntities(code)}\n\`\`\`\n\n`
	);

	// Inline code
	md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${decodeHtmlEntities(code)}\``);

	// Blockquotes
	md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
		const lines = stripTags(content).split("\n");
		return lines.map(l => `> ${l}`).join("\n") + "\n\n";
	});

	// Lists
	md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
		return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => 
			`- ${stripTags(item)}\n`
		) + "\n";
	});
	md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
		let i = 1;
		return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => 
			`${i++}. ${stripTags(item)}\n`
		) + "\n";
	});

	// Horizontal rules
	md = md.replace(/<hr[^>]*>/gi, "\n---\n\n");

	// Paragraphs
	md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => `${stripTags(content)}\n\n`);

	// Remove remaining HTML tags
	md = md.replace(/<[^>]+>/g, "");
	
	// Decode HTML entities
	md = decodeHtmlEntities(md);

	// Clean up whitespace
	md = md.replace(/\n{3,}/g, "\n\n");
	md = md.trim();

	return md;
}

/**
 * Strip HTML tags from content.
 */
function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, "").trim();
}

/**
 * Decode common HTML entities.
 */
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/")
		.replace(/&nbsp;/g, " ");
}

/**
 * Check if HTML content looks like it should be converted to Markdown.
 */
export function looksLikeReadableHtml(html: string): boolean {
	// Check for article-like structure
	const articlePatterns = [
		/<article/i,
		/<(main|content)[^>]*>/i,
		/<(p|h[1-6])[^>]*>[\s\S]{20,}/i,  // Substantial text content
		/<(div|section)[^>]*class=["'][^"']*(?:content|article|text|post|entry)[^"']*>/i,
	];

	return articlePatterns.some(pattern => pattern.test(html));
}