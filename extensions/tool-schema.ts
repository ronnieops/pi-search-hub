/**
 * web_search tool schema, kept in sync with the active backend set.
 *
 * The backend enum and the backend list in the description advertise only the
 * backends enabled in search.json (plus "auto"), so the model cannot select an
 * unconfigured backend from the schema. Tool objects in provider payloads come
 * in three shapes: { name, description, input_schema } (Anthropic),
 * { type: "function", name, description, parameters } (OpenAI Responses), and
 * { type: "function", function: { name, description, parameters } } (OpenAI Chat).
 */

export const WEB_SEARCH_TOOL_NAME = "web_search";
const AUTO_BACKEND = "auto";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Backends the model may select: the active set, plus "auto". */
export function webSearchBackendEnum(activeBackends: string[]): string[] {
	return [...activeBackends, AUTO_BACKEND];
}

/** Tool description naming the backends actually available. */
export function webSearchDescription(activeBackends: string[]): string {
	return (
		"Search the web using one of several backend search engines. " +
		`Configured backends: ${activeBackends.join(", ")}. ` +
		"The best available backend is used automatically. " +
		"Use combine=true to query all configured backends in parallel for broader coverage. " +
		"Use for fact-finding, research, documentation lookups, and current events."
	);
}

/**
 * Rewrite a provider-payload tool entry in place so the web_search schema
 * matches the active set. Other tools and malformed entries are left alone.
 */
export function rewriteWebSearchTool(tool: unknown, activeBackends: string[]): void {
	if (!isRecord(tool)) return;
	const holder = isRecord(tool.function) ? tool.function : tool;
	if (holder.name !== WEB_SEARCH_TOOL_NAME) return;
	holder.description = webSearchDescription(activeBackends);
	const schema = isRecord(holder.input_schema)
		? holder.input_schema
		: isRecord(holder.parameters)
			? holder.parameters
			: undefined;
	if (!schema || !isRecord(schema.properties)) return;
	const backend = schema.properties.backend;
	if (!isRecord(backend)) return;
	if (Array.isArray(backend.enum)) {
		backend.enum = webSearchBackendEnum(activeBackends);
	}
}
