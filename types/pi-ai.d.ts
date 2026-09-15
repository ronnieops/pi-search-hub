/**
 * Ambient type declarations for @earendil-works/pi-ai (optional peer dep).
 */

declare module "@earendil-works/pi-ai" {
	export type Api = string;

	export interface Model<TApi extends Api = Api> {
		id: string;
		provider: string;
		api: TApi;
		[key: string]: unknown;
	}

	export interface Context {
		systemPrompt: string;
		messages: unknown[];
		tools?: unknown[];
	}

	export interface AssistantMessage {
		stopReason: string;
		errorMessage?: string;
		content: Array<{
			type: string;
			name?: string;
			arguments?: unknown;
		}>;
	}

	export interface ModelsApiStreamOptions<TApi extends Api = Api> {
		signal?: AbortSignal;
		transport?: "sse" | "websocket" | "websocket-cached" | "auto";
		reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		textVerbosity?: "low" | "medium" | "high";
		onPayload?: (payload: unknown, model: Model<TApi>) => unknown | undefined | Promise<unknown | undefined>;
	}

	/**
	 * Create a StringEnum type for use with TypeBox schemas.
	 * @param values - Tuple of allowed string values
	 * @param options - Optional description
	 */
	export function StringEnum<T extends readonly string[]>(
		values: T,
		options?: { description?: string },
	): import("typebox").TStringEnum<T[number]>;
}
