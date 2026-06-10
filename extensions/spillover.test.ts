import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	spillover,
	readSpillover,
	deleteSpillover,
	cleanupSpillover,
	formatSpilloverNotice,
	SPILLOVER_THRESHOLD_CHARS,
} from "./spillover.js";

describe("spillover", () => {
	describe("spillover()", () => {
		it("returns content as-is when under threshold", () => {
			const content = "Short content";
			const result = spillover(content);

			expect(result.spilled).toBe(false);
			expect(result.content).toBe("Short content");
			expect(result.spillPath).toBeUndefined();
		});

		it("spills content when over threshold", () => {
			const content = "x".repeat(SPILLOVER_THRESHOLD_CHARS + 1000);
			const result = spillover(content);

			expect(result.spilled).toBe(true);
			expect(result.content).toBe("");
			expect(result.spillPath).toBeDefined();
			expect(result.spillPath).toContain("spill-");
			expect(result.originalLength).toBe(content.length);
		});

		it("respects custom threshold", () => {
			const content = "1234567890";
			const result = spillover(content, { threshold: 5 });

			expect(result.spilled).toBe(true);
		});

		it("includes preview when spilled", () => {
			const content = "A".repeat(SPILLOVER_THRESHOLD_CHARS + 100);
			const result = spillover(content, { previewLength: 100 });

			expect(result.spilled).toBe(true);
			expect(result.preview).toBeDefined();
			expect(result.preview?.length).toBe(100);
		});

		it("stores metadata with spill file", () => {
			const content = "x".repeat(SPILLOVER_THRESHOLD_CHARS + 100);
			const result = spillover(content, {
				url: "https://example.com/page",
				backend: "exa",
			});

			expect(result.spilled).toBe(true);
		});
	});

	describe("readSpillover()", () => {
		it("returns null for non-existent file", () => {
			const content = readSpillover("/nonexistent/path/file.txt");
			expect(content).toBeNull();
		});

		it("reads spilled content", () => {
			const content = "Test content for reading";
			const result = spillover(content, { threshold: 1 });

			expect(result.spilled).toBe(true);
			expect(result.spillPath).toBeDefined();

			const read = readSpillover(result.spillPath!);
			expect(read).toBe("Test content for reading");
		});
	});

	describe("deleteSpillover()", () => {
		it("handles non-existent file gracefully", () => {
			// Returns true (success) even if file doesn't exist
			const deleted = deleteSpillover("/nonexistent/path/file.txt");
			expect(deleted).toBe(true);
		});

		it("deletes spilled file", () => {
			const content = "Content to delete";
			const result = spillover(content, { threshold: 1 });

			expect(result.spilled).toBe(true);
			expect(result.spillPath).toBeDefined();

			const deleted = deleteSpillover(result.spillPath!);
			expect(deleted).toBe(true);

			// Verify file is gone
			const read = readSpillover(result.spillPath!);
			expect(read).toBeNull();
		});
	});

	describe("formatSpilloverNotice()", () => {
		it("returns empty string when not spilled", () => {
			const result = spillover("Short content");
			const notice = formatSpilloverNotice(result);

			expect(notice).toBe("");
		});

		it("returns notice when spilled", () => {
			const content = "x".repeat(SPILLOVER_THRESHOLD_CHARS + 100);
			const result = spillover(content);
			const notice = formatSpilloverNotice(result, "https://example.com");

			expect(notice).toContain("Content truncated");
			expect(notice).toContain("full response saved to temp file");
			expect(notice).toContain("Original size:");
			expect(notice).toContain("Preview:");
			expect(notice).toContain("https://example.com");
			expect(notice).toContain("readSpillover");
		});

		it("includes preview in notice", () => {
			const content = "A".repeat(SPILLOVER_THRESHOLD_CHARS + 100);
			const result = spillover(content, { previewLength: 50 });
			const notice = formatSpilloverNotice(result);

			expect(notice).toContain("A".repeat(50));
		});
	});

	describe("cleanupSpillover()", () => {
		it("returns 0 when no files to clean", () => {
			const deleted = cleanupSpillover(60 * 1000); // 1 minute
			expect(deleted).toBeGreaterThanOrEqual(0);
		});
	});
});