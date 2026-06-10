/**
 * GFM (GitHub Flavored Markdown) support for Markdown extraction.
 * 
 * Supports:
 * - Tables (GFM table extension)
 * - Task lists (checkboxes)
 * - Strikethrough
 * - Autolinks
 * - Fenced code blocks with language
 * - Line breaks (hard line breaks)
 */

import { timeoutSignal } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GFMOptions {
	/** Enable table support (default: true) */
	tables?: boolean;
	/** Enable task lists (default: true) */
	tasklists?: boolean;
	/** Enable strikethrough (default: true) */
	strikethrough?: boolean;
	/** Enable autolinks (default: true) */
	autolinks?: boolean;
	/** Enable fenced code blocks (default: true) */
	fencedCode?: boolean;
	/** Enable hard line breaks (default: true) */
	hardBreaks?: boolean;
}

export interface ParsedMarkdown {
	html: string;
	original: string;
	stats: {
		tables: number;
		tasklists: number;
		codeBlocks: number;
		links: number;
		headings: number;
	};
}

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: Required<GFMOptions> = {
	tables: true,
	tasklists: true,
	strikethrough: true,
	autolinks: true,
	fencedCode: true,
	hardBreaks: true,
};

// ---------------------------------------------------------------------------
// Regex patterns for GFM elements
// ---------------------------------------------------------------------------

const PATTERNS = {
	// Tables: | Header | Header | or |---|---|---|
	tableRow: /^\|(.+?)\|[\r\n]*$/,
	
	// Task lists: - [ ] todo or - [x] done
	taskList: /^(\s*[-*+])\s+\[([ xX])\]\s*(.*)$/,
	
	// Strikethrough: ~~text~~
	strikethrough: /~~([^~]+)~~/g,
	
	// Autolinks: <https://example.com> or <mailto@example.com>
	autolink: /<((?:https?|ftp|mailto):[^>]+)>/g,
	
	// Fenced code blocks: ```language or ```
	fencedCodeStart: /^```(\w*)\s*$/,
	fencedCodeEnd: /^```\s*$/,
	
	// Headings
	heading: /^#{1,6}\s+(.+)$/,
	
	// Links
	link: /\[([^\]]+)\]\(([^)]+)\)/g,
	
	// Hard line breaks (2+ spaces at end or backslash)
	hardBreak: /(\S)(  +\n|\n|\\)$/gm,
};

/**
 * Check if a line looks like a table delimiter row.
 */
function isTableDelimiter(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
	const content = trimmed.slice(1, -1);
	const cells = content.split("|");
	return cells.every(cell => /^[:\s\-]+$/.test(cell.trim()));
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Parse Markdown with GFM support.
 */
export function parseGFM(markdown: string, options?: GFMOptions): ParsedMarkdown {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	
	let html = markdown;
	const stats = {
		tables: 0,
		tasklists: numberOfMatches(markdown, /^\s*[-*+]\s+\[([ xX])\]\s/gm),
		codeBlocks: numberOfMatches(html, /```[\s\S]*?```/g),
		links: numberOfMatches(html, PATTERNS.link),
		headings: numberOfMatches(html, /^#{1,6}\s+/gm),
	};
	
	// Process in order (most specific first)
	
	// 1. Fenced code blocks (protect from other processing)
	const codeBlocks: string[] = [];
	html = extractCodeBlocks(html, codeBlocks);
	
	// 2. Tables - count complete tables (header + delimiter + at least one body row)
	if (opts.tables) {
		const tableLines = markdown.split("\n").filter(l => 
			l.trim().startsWith("|") && l.trim().endsWith("|")
		);
		// Count tables: each table has header + delimiter + body rows
		// We count tables by looking for delimiter rows
		stats.tables = numberOfMatches(markdown, /\|[ :-]+\|[ :-]*\|/g);
		html = processTables(html);
	}
	
	// 3. Task lists
	if (opts.tasklists) {
		html = processTaskLists(html);
	}
	
	// 4. Strikethrough
	if (opts.strikethrough) {
		html = processStrikethrough(html);
	}
	
	// 5. Autolinks
	if (opts.autolinks) {
		html = processAutolinks(html);
	}
	
	// 6. Hard line breaks
	if (opts.hardBreaks) {
		html = processHardBreaks(html);
	}
	
	// 7. Restore code blocks
	html = restoreCodeBlocks(html, codeBlocks);
	
	// 8. Convert remaining Markdown to HTML
	html = markdownToBasicHtml(html);
	
	return {
		html,
		original: markdown,
		stats,
	};
}

/**
 * Convert Markdown to basic HTML (headings, lists, links, etc.).
 */
export function markdownToBasicHtml(markdown: string): string {
	let html = markdown;
	
	// Headings
	html = html.replace(/^#{6}\s+(.+)$/gm, (_, text) => `<h6>${text}</h6>`);
	html = html.replace(/^#{5}\s+(.+)$/gm, (_, text) => `<h5>${text}</h5>`);
	html = html.replace(/^#{4}\s+(.+)$/gm, (_, text) => `<h4>${text}</h4>`);
	html = html.replace(/^#{3}\s+(.+)$/gm, (_, text) => `<h3>${text}</h3>`);
	html = html.replace(/^#{2}\s+(.+)$/gm, (_, text) => `<h2>${text}</h2>`);
	html = html.replace(/^#\s+(.+)$/gm, (_, text) => `<h1>${text}</h1>`);
	
	// Bold and italic
	html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
	html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
	html = html.replace(/___(.+?)___/g, "<strong><em>$1</em></strong>");
	html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
	html = html.replace(/_(.+?)_/g, "<em>$1</em>");
	
	// Blockquotes
	html = html.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");
	
	// Horizontal rules
	html = html.replace(/^(-{3,}|\*{3,}|_{3,})\s*$/gm, "<hr>");
	
	// Unordered lists
	html = html.replace(/^[\s]*[-*+]\s+(.+)$/gm, "<li>$1</li>");
	
	// Ordered lists
	html = html.replace(/^[\s]*\d+\.\s+(.+)$/gm, "<li>$1</li>");
	
	// Wrap consecutive <li> elements in <ul>
	html = wrapListItems(html);
	
	// Links (skip already converted)
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
	
	// Images
	html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
	
	// Inline code
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	
	return html;
}

/**
 * Process GFM tables.
 */
function processTables(markdown: string): string {
	const lines = markdown.split("\n");
	const result: string[] = [];
	let i = 0;
	
	while (i < lines.length) {
		const line = lines[i];
		
		// Check if this is a table row
		if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
			// Check if next line is delimiter row
			if (i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
				// Found a table!
				const tableData: string[][] = [];
				
				// Parse header row
				tableData.push(parseTableCells(line));
				
				// Skip delimiter row
				i += 2;
				
				// Parse body rows until table ends
				while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
					// Skip delimiter rows
					if (!isTableDelimiter(lines[i])) {
						tableData.push(parseTableCells(lines[i]));
					}
					i++;
				}
				
				// Build HTML table
				const tableHtml = buildTableHtml(tableData);
				result.push(tableHtml);
			} else {
				result.push(line);
				i++;
			}
		} else {
			result.push(line);
			i++;
		}
	}
	
	return result.join("\n");
}

/**
 * Parse table cells from a row.
 */
function parseTableCells(row: string): string[] {
	return row.split("|")
		.map(cell => cell.trim())
		.filter(cell => cell.length > 0 || cell === " ");
}

/**
 * Build HTML table from parsed data.
 */
function buildTableHtml(data: string[][]): string {
	if (data.length === 0) return "";
	
	const headerRow = data[0];
	const bodyRows = data.slice(1);
	
	const headers = headerRow.map(cell => `<th>${cell}</th>`).join("");
	const rows = bodyRows.map(row => {
		const cells = row.map(cell => `<td>${cell}</td>`).join("");
		return `<tr>${cells}</tr>`;
	}).join("");
	
	return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Process GFM task lists.
 */
function processTaskLists(markdown: string): string {
	// Handle task lists: - [ ] or - [x] or - [X]
	const lines = markdown.split("\n");
	const result: string[] = [];
	
	for (const line of lines) {
		const match = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)$/);
		if (match) {
			const checked = match[3].toLowerCase() === "x";
			const text = match[4] || "";
			const indent = match[1];
			const checkedAttr = checked ? ' checked="checked"' : "";
			result.push(`${indent}<input type="checkbox"${checkedAttr} disabled> ${text}`);
		} else {
			result.push(line);
		}
	}
	
	return result.join("\n");
}

/**
 * Process strikethrough.
 */
function processStrikethrough(markdown: string): string {
	return markdown.replace(PATTERNS.strikethrough, (_, text) => `<del>${text}</del>`);
}

/**
 * Process autolinks.
 */
function processAutolinks(markdown: string): string {
	return markdown.replace(PATTERNS.autolink, (_, url) => {
		const display = url.replace(/^(https?|ftp):\/\//, "");
		return `<a href="${url}">${display}</a>`;
	});
}

/**
 * Process hard line breaks.
 */
function processHardBreaks(markdown: string): string {
	// Two+ spaces at end of line
	markdown = markdown.replace(/  +\n/g, "<br>\n");
	// Backslash at end of line
	markdown = markdown.replace(/\\\n/g, "<br>\n");
	return markdown;
}

/**
 * Extract fenced code blocks for protection.
 */
function extractCodeBlocks(markdown: string, blocks: string[]): string {
	return markdown.replace(/```[\s\S]*?```/g, (match) => {
		blocks.push(match);
		return `<<<CODE_BLOCK_${blocks.length - 1}>>>`;
	});
}

/**
 * Restore extracted code blocks.
 */
function restoreCodeBlocks(html: string, blocks: string[]): string {
	let result = html;
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const language = block.match(/^```(\w*)/)?.[1] || "";
		const code = block.replace(/^```\w*\n?/, "").replace(/```\s*$/, "");
		
		result = result.replace(
			`<<<CODE_BLOCK_${i}>>>`,
			`<pre><code class="language-${language}">${escapeHtml(code)}</code></pre>`
		);
	}
	return result;
}

/**
 * Wrap consecutive <li> elements in <ul> or <ol>.
 */
function wrapListItems(html: string): string {
	// This is a simplified version - a full implementation would need
	// to track whether each list is ordered or unordered
	return html
		.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Count matches of a pattern in a string.
 */
function numberOfMatches(str: string, pattern: RegExp): number {
	const matches = str.match(pattern);
	return matches ? matches.length : 0;
}

/**
 * Convert Markdown table to another format (CSV, JSON, etc.).
 */
export function tableToCSV(markdown: string): string {
	const lines = markdown.split("\n").filter(line => 
		line.trim().startsWith("|") && line.trim().endsWith("|") &&
		!isTableDelimiter(line)
	);
	
	if (lines.length === 0) return "";
	
	const rows = lines.map(line => {
		const cells = parseTableCells(line);
		return cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(",");
	});
	
	return rows.join("\n");
}

/**
 * Convert Markdown table to JSON array of objects.
 */
export function tableToJSON(markdown: string): string {
	const lines = markdown.split("\n").filter(line => 
		line.trim().startsWith("|") && line.trim().endsWith("|") &&
		!isTableDelimiter(line)
	);
	
	if (lines.length < 2) return "[]";
	
	const headers = parseTableCells(lines[0]);
	const rows = lines.slice(1).map(line => {
		const cells = parseTableCells(line);
		const obj: Record<string, string> = {};
		headers.forEach((header, i) => {
			obj[header] = cells[i] || "";
		});
		return obj;
	});
	
	return JSON.stringify(rows, null, 2);
}

/**
 * Check if content looks like a Markdown table.
 */
export function looksLikeTable(markdown: string): boolean {
	const lines = markdown.split("\n").filter(line => line.trim());
	return lines.some(line => 
		line.trim().startsWith("|") && line.trim().endsWith("|") && 
		lines.some(l => isTableDelimiter(l))
	);
}