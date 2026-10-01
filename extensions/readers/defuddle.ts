/**
 * Defuddle reader — keyless, fully local HTML → Markdown extraction.
 *
 * Opt-in second view for web_read (`reader: "defuddle"`). Jina remains the
 * default; Defuddle is for when Jina output looks poor (boilerplate-heavy
 * articles, unfenced code examples). No API key, no network beyond the single
 * page fetch, no JavaScript execution — JS-rendered pages return shell only
 * and should fall back to a rendering reader (Jina).
 *
 * Options below are the validated per-source policy from the six-page
 * offline comparison (Defuddle 0.19.4 + linkedom 0.18.12):
 * - keep reference-link and screen-reader text (Sphinx `reference` links and
 *   Wikipedia `.sfrac` fraction slashes are content, not clutter);
 * - disable HTML standardization on wikipedia.org only (preserves caption
 *   `<i>`/`<sup>` variables; applied narrowly because it breaks fenced-code
 *   recognition on documentation pages).
 */

import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { timeoutSignal, sanitizeError } from "../utils.js";

/** Cap on fetched HTML, in bytes, mirroring the Jina reader path. */
const DEFUDDLE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/** Hosts where HTML standardization is disabled (caption math fidelity). */
function defuddleOptions(url: string): Record<string, unknown> {
	const base = {
		markdown: true,
		// Strictly local: never call third-party extractor APIs when local
		// content is missing — return what the HTML holds or fail.
		useAsync: false,
		// Sphinx `class="reference internal"` cross-reference links and
		// screen-reader fraction slashes are content, not ad clutter.
		removeExactSelectors: false,
		removePartialSelectors: false,
	};
	try {
		if (new URL(url).hostname.endsWith("wikipedia.org")) {
			return { ...base, standardize: false };
		}
	} catch {
		// Invalid URL — caller validates; fall through with base options.
	}
	return base;
}

/**
 * Fetch a URL and extract clean Markdown locally via Defuddle.
 * Throws on transport error or empty extraction so the reader fallback
 * chain can try the next reader (usually Jina).
 */
export async function fetchDefuddle(
	url: string,
	signal?: AbortSignal,
): Promise<{ title: string; url: string; content: string }> {
	const response = await fetch(url, {
		signal: timeoutSignal(signal),
		headers: {
			Accept: "text/html",
			"Accept-Language": "en",
			"User-Agent": "pi-search-hub/reader (local Defuddle extraction)",
		},
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Failed to read ${url}: ${sanitizeError(response.status, text)}`);
	}

	const contentLength = parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(contentLength) && contentLength > DEFUDDLE_MAX_BYTES) {
		throw new Error(`Failed to read ${url}: response too large (${contentLength} bytes, limit ${DEFUDDLE_MAX_BYTES})`);
	}

	const html = await response.text();
	if (signal?.aborted) {
		throw new Error(`Defuddle read cancelled for ${url}`);
	}

	const { document } = parseHTML(html);
	const result = await Defuddle(document, url, defuddleOptions(url));
	const content = result.content ?? "";
	if (content.trim().length === 0) {
		throw new Error(`Defuddle returned no content for ${url}`);
	}

	return { title: result.title || "", url, content };
}
