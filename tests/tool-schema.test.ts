/**
 * web_search tool schema follows the active backend set:
 * the backend enum and the description advertise only configured backends,
 * in the registered schema and in rewritten provider payloads.
 */

import { describe, it, expect } from "vitest";
import {
	rewriteWebSearchTool,
	webSearchBackendEnum,
	webSearchDescription,
} from "../extensions/tool-schema.js";

function schemaWithBackendEnum(enumValues: string[]): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			backend: {
				type: "string",
				enum: enumValues,
				description: "Backend to use. 'auto' picks the best configured backend (default)",
			},
		},
	};
}

describe("webSearchBackendEnum", () => {
	it("appends auto after the active set", () => {
		expect(webSearchBackendEnum(["duckduckgo", "searxng"])).toEqual(["duckduckgo", "searxng", "auto"]);
	});

	it("keeps auto when no backend is active", () => {
		expect(webSearchBackendEnum([])).toEqual(["auto"]);
	});
});

describe("webSearchDescription", () => {
	it("names the configured backends", () => {
		expect(webSearchDescription(["duckduckgo", "searxng"])).toContain(
			"Configured backends: duckduckgo, searxng.",
		);
	});
});

describe("rewriteWebSearchTool", () => {
	const enumBefore = ["duckduckgo", "jina", "marginalia", "serper", "tavily", "exa", "exa_mcp",
		"openai-codex", "brave", "brave-llm", "langsearch", "firecrawl", "websearchapi", "perplexity",
		"searxng", "linkup", "youcom", "fastcrw", "sofya", "auto"];
	const active = ["duckduckgo", "searxng"];

	it("rewrites the anthropic shape (input_schema)", () => {
		const tool = {
			name: "web_search",
			description: "old static description",
			input_schema: schemaWithBackendEnum(enumBefore),
		};
		rewriteWebSearchTool(tool, active);
		expect(tool.description).toBe(webSearchDescription(active));
		const schema = tool.input_schema as ReturnType<typeof schemaWithBackendEnum>;
		expect((schema.properties.backend as { enum: string[] }).enum).toEqual(["duckduckgo", "searxng", "auto"]);
	});

	it("rewrites the openai responses shape (parameters)", () => {
		const tool = {
			type: "function",
			name: "web_search",
			description: "old static description",
			parameters: schemaWithBackendEnum(enumBefore),
		};
		rewriteWebSearchTool(tool, active);
		expect(tool.description).toBe(webSearchDescription(active));
		const schema = tool.parameters as ReturnType<typeof schemaWithBackendEnum>;
		expect((schema.properties.backend as { enum: string[] }).enum).toEqual(["duckduckgo", "searxng", "auto"]);
	});

	it("rewrites the openai chat shape (nested function)", () => {
		const tool = {
			type: "function",
			function: {
				name: "web_search",
				description: "old static description",
				parameters: schemaWithBackendEnum(enumBefore),
			},
		};
		rewriteWebSearchTool(tool, active);
		expect(tool.function.description).toBe(webSearchDescription(active));
		const schema = tool.function.parameters as ReturnType<typeof schemaWithBackendEnum>;
		expect((schema.properties.backend as { enum: string[] }).enum).toEqual(["duckduckgo", "searxng", "auto"]);
	});

	it("leaves other tools untouched", () => {
		const tool = {
			name: "web_read",
			description: "read a page",
			input_schema: schemaWithBackendEnum(enumBefore),
		};
		rewriteWebSearchTool(tool, active);
		expect(tool.description).toBe("read a page");
		const schema = tool.input_schema as ReturnType<typeof schemaWithBackendEnum>;
		expect((schema.properties.backend as { enum: string[] }).enum).toEqual(enumBefore);
	});

	it("ignores entries without a backend property", () => {
		const tool = {
			name: "web_search",
			description: "old static description",
			input_schema: { type: "object", properties: { query: { type: "string" } } },
		};
		rewriteWebSearchTool(tool, active);
		expect(tool.description).toBe(webSearchDescription(active));
		expect(tool.input_schema).toEqual({ type: "object", properties: { query: { type: "string" } } });
	});
});
