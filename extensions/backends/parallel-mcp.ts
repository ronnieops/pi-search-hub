import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import packageJson from "../../package.json" with { type: "json" };

import type { SearchResult } from "../types.js";
import { timeoutSignal } from "../utils.js";

const PARALLEL_MCP_ENDPOINT = new URL("https://search.parallel.ai/mcp");
let searchSessionId = randomUUID();

export function startParallelMCPSession(): void {
	searchSessionId = randomUUID();
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const RESPONSE_SIZE_ERROR = "Parallel Search MCP response exceeded the 1 MiB limit.";
const PARALLEL_CLIENT_NAME = "pi-search-hub";
const PARALLEL_CLIENT_VERSION = packageJson.version;
const PARALLEL_USER_AGENT = `${PARALLEL_CLIENT_NAME}/${PARALLEL_CLIENT_VERSION}`;

type SearchRecord = Record<string, unknown>;
type ParallelToolResult = {
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

function isRecord(value: unknown): value is SearchRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectOversizedResponse(response: Response): void {
	const contentLength = response.headers.get("content-length");
	if (contentLength === null) return;
	const declaredLength = Number(contentLength);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		void response.body?.cancel().catch(() => undefined);
		throw new Error(RESPONSE_SIZE_ERROR);
	}
}

function limitResponseBytes(response: Response): Response {
	rejectOversizedResponse(response);
	if (!response.body) return response;

	let receivedBytes = 0;
	const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			receivedBytes += chunk.byteLength;
			if (receivedBytes > MAX_RESPONSE_BYTES) {
				controller.error(new Error(RESPONSE_SIZE_ERROR));
				return;
			}
			controller.enqueue(chunk);
		},
	}));
	return new Response(body, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}

async function readBoundedResponseBytes(response: Response): Promise<ArrayBuffer | undefined> {
	rejectOversizedResponse(response);
	const reader = response.body?.getReader();
	if (!reader) return undefined;

	const chunks: Uint8Array[] = [];
	let receivedBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > MAX_RESPONSE_BYTES) {
				void reader.cancel().catch(() => undefined);
				throw new Error(RESPONSE_SIZE_ERROR);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const buffer = new ArrayBuffer(receivedBytes);
	const bytes = new Uint8Array(buffer);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return buffer;
}

function getRequestId(init?: RequestInit): string | number | undefined {
	if (typeof init?.body !== "string") return undefined;
	try {
		const request = JSON.parse(init.body) as unknown;
		if (isRecord(request) && (typeof request.id === "string" || typeof request.id === "number")) {
			return request.id;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function correlateNullIdErrors(value: unknown, requestId: string | number): boolean {
	const messages = Array.isArray(value) ? value : [value];
	let correlated = false;
	for (const message of messages) {
		if (isRecord(message) && message.jsonrpc === "2.0" && message.id === null && isRecord(message.error)) {
			message.id = requestId;
			correlated = true;
		}
	}
	return correlated;
}

function createBufferedResponse(response: Response, body: BodyInit): Response {
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	return new Response(body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}

function getTextContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(item => item.type === "text")
		.map(item => item.text ?? "")
		.join("\n");
}

function parseToolResult(value: unknown): ParallelToolResult {
	if (!isRecord(value) || !Array.isArray(value.content)) {
		throw new Error("Parallel Search MCP returned an invalid tool response.");
	}

	const content = value.content.flatMap(item => {
		if (!isRecord(item) || typeof item.type !== "string") return [];
		return [{ type: item.type, ...(typeof item.text === "string" ? { text: item.text } : {}) }];
	});
	return {
		content,
		...(isRecord(value.structuredContent) ? { structuredContent: value.structuredContent } : {}),
		...(value.isError === true ? { isError: true } : {}),
	};
}

function getRawResults(result: {
	structuredContent?: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
}): unknown[] {
	const structuredResults = result.structuredContent?.results;
	if (Array.isArray(structuredResults)) return structuredResults;

	const text = getTextContent(result.content);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Parallel Search MCP returned an invalid search response.");
	}

	if (Array.isArray(parsed)) return parsed;
	if (isRecord(parsed) && Array.isArray(parsed.results)) return parsed.results;
	throw new Error("Parallel Search MCP returned an invalid search response.");
}

function normalizeResults(result: {
	structuredContent?: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
}, numResults: number): SearchResult[] {
	const rawResults = getRawResults(result);
	const normalizedResults = rawResults.flatMap(value => {
		if (!isRecord(value) || typeof value.url !== "string") return [];

		let url: URL;
		try {
			url = new URL(value.url);
		} catch {
			return [];
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return [];

		const excerpts = Array.isArray(value.excerpts)
			? value.excerpts.filter((excerpt): excerpt is string => typeof excerpt === "string")
			: [];
		const snippet = typeof value.snippet === "string" && value.snippet.trim()
			? value.snippet
			: typeof value.description === "string" && value.description.trim()
				? value.description
				: excerpts.join("\n");
		return [{
			title: typeof value.title === "string" && value.title.trim() ? value.title : value.url,
			url: value.url,
			...(snippet ? { snippet } : {}),
		}];
	});
	if (rawResults.length > 0 && normalizedResults.length === 0) {
		throw new Error("Parallel Search MCP returned an invalid search response.");
	}
	return normalizedResults.slice(0, Math.max(1, Math.min(Math.floor(numResults), 20)));
}

export async function searchParallelMCP(
	query: string,
	numResults: number,
	signal?: AbortSignal,
	apiKey?: string,
): Promise<{ results: SearchResult[] }> {
	const resolvedApiKey = apiKey?.trim();
	if (apiKey !== undefined && !resolvedApiKey) {
		throw new Error("Parallel Search MCP API key must not be empty.");
	}

	const requestSignal = timeoutSignal(signal, REQUEST_TIMEOUT_MS);
	const client = new Client({ name: PARALLEL_CLIENT_NAME, version: PARALLEL_CLIENT_VERSION });
	const transport = new StreamableHTTPClientTransport(PARALLEL_MCP_ENDPOINT, {
		requestInit: {
			// Identify the project for aggregate free-MCP measurement; keep this project-wide, never per-user or per-installation.
			headers: {
				"User-Agent": PARALLEL_USER_AGENT,
				...(resolvedApiKey ? { Authorization: "Bearer " + resolvedApiKey } : {}),
			},
			redirect: "error",
			signal: requestSignal,
		},
		fetch: async (input, init) => {
			const response = await globalThis.fetch(input, { ...init, redirect: "error" });
			const requestId = getRequestId(init);
			const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
			if (!response.ok || requestId === undefined || contentType !== "application/json") {
				return limitResponseBytes(response);
			}

			const responseBytes = await readBoundedResponseBytes(response);
			if (!responseBytes) return response;
			let responseBody: unknown;
			try {
				responseBody = JSON.parse(new TextDecoder().decode(responseBytes)) as unknown;
			} catch {
				return createBufferedResponse(response, responseBytes);
			}
			const hasNullIdError = correlateNullIdErrors(responseBody, requestId);
			return createBufferedResponse(response, hasNullIdError ? JSON.stringify(responseBody) : responseBytes);
		},
	});

	try {
		await client.connect(transport, { signal: requestSignal });
		const result = parseToolResult(await client.callTool({
			name: "web_search",
			arguments: {
				objective: query,
				search_queries: [query],
				session_id: searchSessionId,
			},
		}, undefined, { signal: requestSignal }));

		if (result.isError) {
			throw new Error(getTextContent(result.content) || "Parallel Search MCP returned an error.");
		}

		return { results: normalizeResults(result, numResults) };
	} catch (error) {
		if (signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : "Unknown error";
		throw new Error(`Parallel Search MCP failed: ${message}`, { cause: error });
	} finally {
		await client.close().catch(() => undefined);
	}
}
