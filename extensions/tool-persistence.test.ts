import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	loadToolSelection,
	saveToolSelection,
	enableBackend,
	disableBackend,
	toggleBackend,
	getPersistedConfig,
	mergeWithConfig,
	formatToolSelection,
} from "./tool-persistence.js";
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock getAgentDir for tests
const mockAgentDir = join(tmpdir(), "pi-search-hub-test-tools");

vi.mock("./utils.js", () => ({
	getAgentDir: () => join(mockAgentDir, "agent"),
}));

describe("tool-persistence", () => {
	beforeEach(() => {
		// Ensure test directory exists
		const dir = join(mockAgentDir, "agent", "extensions");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	});

	afterEach(() => {
		// Clean up test files
		const persistFile = join(mockAgentDir, "agent", "extensions", "tool-persistence.json");
		if (existsSync(persistFile)) {
			unlinkSync(persistFile);
		}
	});

	describe("loadToolSelection", () => {
		it("returns default backends when no file exists", () => {
			const backends = loadToolSelection();
			expect(backends).toEqual(["duckduckgo"]);
		});

		it("loads persisted backends", () => {
			saveToolSelection(["tavily", "exa", "brave"]);
			const backends = loadToolSelection();
			expect(backends).toEqual(["tavily", "exa", "brave"]);
		});

		it("handles invalid JSON gracefully", () => {
			const path = join(mockAgentDir, "agent", "extensions", "tool-persistence.json");
			writeFileSync(path, "not valid json", { mode: 0o600 });
			const backends = loadToolSelection();
			expect(backends).toEqual(["duckduckgo"]);
		});
	});

	describe("saveToolSelection", () => {
		it("saves backends to file", () => {
			saveToolSelection(["jina", "marginalia"]);
			const backends = loadToolSelection();
			expect(backends).toEqual(["jina", "marginalia"]);
		});

		it("overwrites previous selection", () => {
			saveToolSelection(["brave"]);
			saveToolSelection(["firecrawl"]);
			const backends = loadToolSelection();
			expect(backends).toEqual(["firecrawl"]);
		});
	});

	describe("enableBackend", () => {
		it("adds backend to selection", () => {
			saveToolSelection(["duckduckgo"]);
			const updated = enableBackend("tavily");
			expect(updated).toContain("tavily");
			expect(updated).toContain("duckduckgo");
		});

		it("does not duplicate existing backend", () => {
			saveToolSelection(["tavily"]);
			const updated = enableBackend("tavily");
			expect(updated.filter(b => b === "tavily").length).toBe(1);
		});
	});

	describe("disableBackend", () => {
		it("removes backend from selection", () => {
			saveToolSelection(["tavily", "exa"]);
			const updated = disableBackend("tavily");
			expect(updated).not.toContain("tavily");
			expect(updated).toContain("exa");
		});

		it("keeps at least duckduckgo when last backend disabled", () => {
			saveToolSelection(["tavily"]);
			const updated = disableBackend("tavily");
			expect(updated).toEqual(["duckduckgo"]);
		});
	});

	describe("toggleBackend", () => {
		it("enables disabled backend", () => {
			saveToolSelection(["duckduckgo"]);
			const updated = toggleBackend("tavily");
			expect(updated).toContain("tavily");
		});

		it("disables enabled backend", () => {
			saveToolSelection(["duckduckgo", "tavily"]);
			const updated = toggleBackend("tavily");
			expect(updated).not.toContain("tavily");
		});
	});

	describe("getPersistedConfig", () => {
		it("returns config object with enabled backends", () => {
			saveToolSelection(["tavily", "exa"]);
			const config = getPersistedConfig();
			expect(config).toEqual({
				tavily: { enabled: true },
				exa: { enabled: true },
			});
		});
	});

	describe("mergeWithConfig", () => {
		it("adds persisted backends not in config", () => {
			saveToolSelection(["tavily", "brave"]);
			const config = { tavily: { enabled: true } };
			const merged = mergeWithConfig(config);
			expect(merged.tavily?.enabled).toBe(true);
			expect(merged.brave?.enabled).toBe(true);
		});

		it("preserves explicitly disabled backends", () => {
			saveToolSelection(["tavily", "brave"]);
			const config = { tavily: { enabled: true }, brave: { enabled: false } };
			const merged = mergeWithConfig(config);
			expect(merged.tavily?.enabled).toBe(true);
			expect(merged.brave).toBeUndefined();
		});

		it("preserves backends only in config", () => {
			saveToolSelection(["tavily"]);
			const config = { tavily: { enabled: true }, firecrawl: { enabled: true } };
			const merged = mergeWithConfig(config);
			expect(Object.keys(merged)).toContain("tavily");
			expect(Object.keys(merged)).toContain("firecrawl");
		});
	});

	describe("formatToolSelection", () => {
		it("formats selection for display", () => {
			saveToolSelection(["tavily", "exa"]);
			const formatted = formatToolSelection();
			expect(formatted).toContain("tavily");
			expect(formatted).toContain("exa");
			expect(formatted).toContain("Last updated:");
		});
	});
});