/**
 * Sibling URL probing for README/source files.
 *
 * When fetching a page, also try common alternative URLs:
 * - .md, .markdown extensions
 * - index.md, README.md in parent directories
 * - /docs, /src, /blob variants for GitHub
 */

import { assertSafeUrl } from "./utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Common Markdown file names to try. */
const MARKDOWN_NAMES = ["index.md", "README.md", "readme.md", "CONTRIBUTING.md"];

/** File extensions that often contain source/docs. */
const DOC_EXTENSIONS = [".md", ".markdown", ".rst", ".txt", ".adoc"];

/** Alternative URL patterns to try. */
const URL_PATTERNS = {
	github: {
		blob: /github\.com\/([^/]+\/[^/]+)\/blob\//,
		tree: /github\.com\/([^/]+\/[^/]+)\/tree\//,
	},
	gitlab: {
		blob: /gitlab\.com\/([^/]+\/[^/]+)\/-\/blob\//,
		tree: /gitlab\.com\/([^/]+\/[^/]+)\/-\/tree\//,
	},
	gitweb: /\/git\//,
};

/** Maximum number of sibling probes to attempt. */
const MAX_PROBES = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeResult {
	url: string;
	success: boolean;
	content?: string;
	error?: string;
}

export interface SiblingProbeOptions {
	/** Maximum probes to attempt (default: 5) */
	maxProbes?: number;
	/** Whether to try GitHub raw URLs (default: true) */
	tryGitHubRaw?: boolean;
	/** Whether to try GitLab raw URLs (default: true) */
	tryGitLabRaw?: boolean;
	/** Custom fetch function (default: global fetch) */
	fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Generate sibling URL variants for a given URL.
 */
export function generateSiblingUrls(url: string): string[] {
	const variants: string[] = [];
	try {
		const parsed = new URL(url);
		const pathname = parsed.pathname;

		// Skip if already a Markdown file
		if (pathname.endsWith(".md") || pathname.endsWith(".markdown")) {
			return variants;
		}

		// 1. Try same path with .md extension
		if (!pathname.includes(".")) {
			variants.push(`${url}.md`);
			variants.push(`${url}.markdown`);
		}

		// 2. Try README.md in same directory
		const dirPath = pathname.replace(/\/[^/]*$/, "");
		if (dirPath) {
			for (const mdName of MARKDOWN_NAMES) {
				variants.push(`${parsed.origin}${dirPath}/${mdName}`);
			}
		}

		// 3. GitHub blob → raw URL
		const ghBlobMatch = pathname.match(/\/blob\/([^/]+)\/(.+)/);
		if (ghBlobMatch) {
			const rawUrl = `https://raw.githubusercontent.com${pathname.replace("/blob/", "/")}`;
			variants.push(rawUrl);
		}

		// 4. GitHub tree → README.md in directory
		const ghTreeMatch = pathname.match(/\/tree\/([^/]+)\/(.+)/);
		if (ghTreeMatch) {
			const dir = pathname.replace(/\/tree\/[^/]+\//, "");
			for (const mdName of MARKDOWN_NAMES) {
				variants.push(`${parsed.origin}${dir}/${mdName}`);
			}
		}

		// 5. Try /docs prefix (common for documentation)
		if (!pathname.startsWith("/docs")) {
			variants.push(`${parsed.origin}/docs${pathname}`);
		}

		// 6. Try /src prefix
		if (!pathname.startsWith("/src")) {
			variants.push(`${parsed.origin}/src${pathname}`);
		}

	} catch {
		// Invalid URL, return empty
	}

	return variants.slice(0, MAX_PROBES);
}

/**
 * Try sibling URLs until one succeeds.
 * Returns the first successful content, or null if all fail.
 */
export async function probeSiblingUrls(
	originalUrl: string,
	signal?: AbortSignal,
	options?: SiblingProbeOptions,
): Promise<{ url: string; content: string } | null> {
	const maxProbes = options?.maxProbes ?? MAX_PROBES;
	const fetchFn = options?.fetchFn ?? fetch;
	const variants = generateSiblingUrls(originalUrl).slice(0, maxProbes);

	for (const url of variants) {
		// Skip invalid URLs
		const ssrfError = (() => {
			try {
				assertSafeUrl(url);
				return null;
			} catch {
				return true;
			}
		})();
		if (ssrfError) continue;

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout per probe

			const response = await fetchFn(url, {
				signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
				headers: {
					"Accept": "text/plain, text/markdown, text/html, */*",
				},
			});

			clearTimeout(timeout);

			if (response.ok && response.headers.get("content-type")?.includes("text")) {
				const content = await response.text();
				if (content.length > 100) { // Skip near-empty responses
					return { url, content };
				}
			}
		} catch {
			// Continue to next variant
		}
	}

	return null;
}

/**
 * Check if content looks like Markdown.
 */
export function looksLikeMarkdown(content: string): boolean {
	const indicators = [
		/^#{1,6}\s+\w/m,                    // Markdown headings
		/\[.+\]\(.+\)/m,                    // Markdown links
		/`{1,3}[^`]+`{1,3}/m,              // Code blocks
		/^\s*[-*+]\s+\w/m,                 // List items
		/^\s*\d+\.\s+\w/m,                 // Numbered lists
		/!\[.+\]\(.+\)/m,                  // Images
		/^>\s+\w/m,                        // Blockquotes
		/\|.+\|.+\|/m,                     // Tables
		/^---$/m,                          // Horizontal rules
	];
	return indicators.some(pattern => pattern.test(content));
}

/**
 * Fetch URL with sibling probing fallback.
 * Tries original URL first, then sibling variants.
 */
export async function fetchWithSiblingProbe(
	url: string,
	signal?: AbortSignal,
	options?: SiblingProbeOptions & {
		/** If true, only return content that looks like Markdown */
		markdownOnly?: boolean;
	},
): Promise<{ url: string; content: string; probed: boolean } | null> {
	const fetchFn = options?.fetchFn ?? fetch;
	const markdownOnly = options?.markdownOnly ?? false;

	// Try original URL first
	try {
		const ssrfError = (() => {
			try {
				assertSafeUrl(url);
				return null;
			} catch {
				return true;
			}
		})();
		if (!ssrfError) {
			const response = await fetchFn(url, {
				signal: timeoutSignal(signal),
				headers: {
					"Accept": "text/plain, text/markdown, text/html, */*",
				},
			});

			if (response.ok) {
				const content = await response.text();
				if (!markdownOnly || looksLikeMarkdown(content)) {
					return { url, content, probed: false };
				}
			}
		}
	} catch {
		// Continue to sibling probing
	}

	// Try sibling variants
	const probeResult = await probeSiblingUrls(url, signal, options);
	if (probeResult) {
		if (!markdownOnly || looksLikeMarkdown(probeResult.content)) {
			return { url: probeResult.url, content: probeResult.content, probed: true };
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Helper function (re-export from utils for convenience)
// ---------------------------------------------------------------------------

function timeoutSignal(signal?: AbortSignal): AbortSignal {
	return signal 
		? AbortSignal.any([signal, AbortSignal.timeout(30000)])
		: AbortSignal.timeout(30000);
}