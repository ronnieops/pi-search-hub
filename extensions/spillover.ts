/**
 * Large-page spillover utilities for pi-search-hub.
 *
 * When content exceeds threshold, saves to temp file and returns a reference.
 * Prevents memory issues with very large responses.
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Content length threshold for spillover (16KB). */
export const SPILLOVER_THRESHOLD_CHARS = 16_384; // 16KB

/** Directory for spillover files. */
function getSpilloverDir(): string {
	const { tmpdir } = require("node:os") as typeof import("node:os");
	return join(tmpdir(), "pi-search-hub-spillover");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpilloverResult {
	/** Full content or empty if spilled to file */
	content: string;
	/** True if content was too large and was saved to a temp file */
	spilled: boolean;
	/** Path to temp file if spilled, null otherwise */
	spillPath?: string;
	/** Original content length */
	originalLength: number;
	/** Truncated preview if spilled */
	preview?: string;
}

export interface SpilloverManifest {
	version: 1;
	createdAt: string;
	files: SpilloverFileEntry[];
}

export interface SpilloverFileEntry {
	id: string;
	path: string;
	url?: string;
	backend?: string;
	size: number;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Process content that may be too large to return inline.
 * If content exceeds threshold, saves to temp file and returns reference.
 *
 * @param content The full content
 * @param options Optional configuration
 * @returns SpilloverResult with content (truncated) or file reference
 */
export function spillover(
	content: string,
	options?: {
		/** Threshold in chars (default: 16KB) */
		threshold?: number;
		/** Preview length when truncated (default: 500) */
		previewLength?: number;
		/** Metadata for the spill file */
		url?: string;
		backend?: string;
	},
): SpilloverResult {
	const threshold = options?.threshold ?? SPILLOVER_THRESHOLD_CHARS;
	const previewLength = options?.previewLength ?? 500;

	const originalLength = content.length;

	// If under threshold, return as-is
	if (originalLength <= threshold) {
		return {
			content,
			spilled: false,
			originalLength,
		};
	}

	// Content too large — save to temp file
	const id = randomUUID().slice(0, 8);
	const dir = getSpilloverDir();

	// Ensure directory exists
	try {
		const { mkdirSync } = require("node:fs") as typeof import("node:fs");
		mkdirSync(dir, { recursive: true });
	} catch {
		// Directory creation failed, return truncated content anyway
		return {
			content: content.slice(0, threshold),
			spilled: false,
			originalLength,
			preview: content.slice(0, previewLength),
		};
	}

	const fileName = `spill-${id}.txt`;
	const filePath = join(dir, fileName);

	try {
		writeFileSync(filePath, content, "utf-8");
	} catch {
		// Write failed, return truncated content
		return {
			content: content.slice(0, threshold),
			spilled: false,
			originalLength,
			preview: content.slice(0, previewLength),
		};
	}

	return {
		content: "", // Empty, content is in file
		spilled: true,
		spillPath: filePath,
		originalLength,
		preview: content.slice(0, previewLength),
	};
}

/**
 * Read content from a spillover file.
 *
 * @param spillPath Path to the spillover file
 * @returns The content, or null if file doesn't exist
 */
export function readSpillover(spillPath: string): string | null {
	try {
		if (!existsSync(spillPath)) return null;
		return readFileSync(spillPath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Delete a spillover file.
 *
 * @param spillPath Path to the spillover file
 * @returns True if deleted, false otherwise
 */
export function deleteSpillover(spillPath: string): boolean {
	try {
		if (existsSync(spillPath)) {
			unlinkSync(spillPath);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Clean up old spillover files (older than maxAgeMs).
 * Call periodically to prevent temp file accumulation.
 *
 * @param maxAgeMs Maximum age in ms (default: 1 hour)
 * @returns Number of files deleted
 */
export function cleanupSpillover(maxAgeMs: number = 60 * 60 * 1000): number {
	const dir = getSpilloverDir();
	let deleted = 0;

	try {
		const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
		const { existsSync } = require("node:fs") as typeof import("node:fs");

		if (!existsSync(dir)) return 0;

		const now = Date.now();
		for (const file of readdirSync(dir)) {
			if (!file.startsWith("spill-") || !file.endsWith(".txt")) continue;

			const filePath = join(dir, file);
			try {
				const stat = statSync(filePath);
				if (now - stat.mtimeMs > maxAgeMs) {
					unlinkSync(filePath);
					deleted++;
				}
			} catch {
				// Skip files we can't stat
			}
		}
	} catch {
		// Directory access failed
	}

	return deleted;
}

/**
 * Create a manifest for multiple spillover files.
 * Useful when returning results that reference multiple spill files.
 *
 * @param entries Array of spillover file entries
 * @returns Manifest JSON string
 */
export function createSpilloverManifest(entries: SpilloverFileEntry[]): string {
	const manifest: SpilloverManifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		files: entries,
	};
	return JSON.stringify(manifest, null, 2);
}

/**
 * Format a spillover notice for display.
 *
 * @param result The spillover result
 * @param url Optional URL associated with the content
 * @returns Formatted notice string
 */
export function formatSpilloverNotice(result: SpilloverResult, url?: string): string {
	if (!result.spilled) return "";

	const lines = [
		"",
		"**⚠️ Content truncated** — full response saved to temp file.",
		`Original size: ${formatBytes(result.originalLength)}`,
	];

	if (result.spillPath) {
		lines.push(`Temp file: ${result.spillPath}`);
	}

	if (result.preview) {
		lines.push("");
		lines.push("**Preview:**");
		lines.push(result.preview.slice(0, 500) + (result.preview.length > 500 ? "..." : ""));
	}

	if (url) {
		lines.push("");
		lines.push(`Source: ${url}`);
	}

	lines.push("");
	lines.push("Use `readSpillover(path)` to retrieve full content.");

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}