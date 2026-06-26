/**
 * Global type aliases used across the extension without explicit imports.
 */

interface ExtensionContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warn" | "error" | "success"): void;
		setStatus(key: string, status: string): void;
		select<T extends string>(label: string, options: T[]): Promise<T | undefined>;
		input(label: string, options?: { placeholder?: string; validate?: (value: string) => string | undefined }): Promise<string | undefined>;
	};
}
