/**
 * Ambient type declarations for @earendil-works/pi-coding-agent (optional peer dep).
 */

declare module "@earendil-works/pi-coding-agent" {
	export interface UISelectOption {
		label: string;
		description?: string;
	}

	export interface UIInputOptions {
		placeholder?: string;
		validate?: (value: string) => string | undefined;
	}

	export interface UI {
		notify(message: string, type?: "info" | "warn" | "error" | "success"): void;
		setStatus(key: string, status: string): void;
		select<T extends string>(label: string, options: T[]): Promise<T | undefined>;
		select<T extends UISelectOption>(label: string, options: T[]): Promise<T | undefined>;
		input(label: string, options?: UIInputOptions): Promise<string | undefined>;
	}

	export interface ModelRegistry {
		find(provider: string, modelId: string): import("@earendil-works/pi-ai").Model | undefined;
		hasConfiguredAuth(model: import("@earendil-works/pi-ai").Model): boolean;
		complete<TApi extends import("@earendil-works/pi-ai").Api>(
			model: import("@earendil-works/pi-ai").Model<TApi>,
			context: import("@earendil-works/pi-ai").Context,
			options?: import("@earendil-works/pi-ai").ModelsApiStreamOptions<TApi>,
		): Promise<import("@earendil-works/pi-ai").AssistantMessage>;
	}

	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		ui: UI;
		modelRegistry: ModelRegistry;
	}

	export interface ToolParameter {
		name: string;
		label: string;
		description: string;
		promptSnippet: string;
		promptGuidelines?: string[];
		parameters: unknown;
		execute: (
			toolCallId: string,
			params: any,
			signal: AbortSignal,
			onUpdate: (update: { content: Array<{ type: string; text: string }> }) => void,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
	}

	export interface Command {
		description: string;
		handler: (args: string[], ctx: ExtensionContext) => Promise<void>;
	}

	export interface ExtensionAPI {
		registerTool(config: ToolParameter): void;
		registerCommand(name: string, config: Command): void;
		on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void): void;
	}
}
