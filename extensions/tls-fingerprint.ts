/**
 * TLS fingerprinting module for Cloudflare bypass.
 * 
 * Uses wreq-js for browser-grade TLS fingerprints.
 * Falls back to standard fetch when not needed.
 * 
 * Browser profiles:
 *   - chrome_145 (default, most compatible)
 *   - chrome_142
 *   - firefox_147
 *   - safari_26
 *   - edge_145
 *   - okhttp (Android)
 */

import { timeoutSignal, sanitizeError } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BrowserProfile = 
	| "chrome_145" | "chrome_142" | "chrome_130"
	| "firefox_147" | "firefox_128"
	| "safari_26" | "safari_17"
	| "edge_145" | "edge_130"
	| "okhttp";

export type OS = "windows" | "macos" | "linux" | "android";

export interface TLSFetchOptions extends RequestInit {
	/** Browser profile to use (default: chrome_145) */
	browser?: BrowserProfile;
	/** Operating system (default: windows) */
	os?: OS;
	/** Proxy URL (e.g., http://proxy:8080) */
	proxy?: string;
	/** Timeout in ms (default: 30000) */
	timeout?: number;
}

export interface TLSFetchResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// Bot detection patterns
// ---------------------------------------------------------------------------

const BOT_CHECK_PATTERNS = [
	/cloudflare/i,
	/challenges\.cloudflare\.com/i,
	/arkose labs/i,
	/perimeterx/i,
	/datadome/i,
	/bot detection/i,
	/access denied/i,
	/please verify you are human/i,
	/please enable cookies/i,
];

const BLOCKED_STATUS_CODES = [403, 429, 503];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let wreqAvailable = false;
let wreqModule: typeof import("wreq-js") | null = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Check if wreq-js is available and initialize.
 */
async function initWreq(): Promise<boolean> {
	if (wreqAvailable && wreqModule) return true;
	
	try {
		wreqModule = await import("wreq-js");
		wreqAvailable = true;
		return true;
	} catch {
		wreqAvailable = false;
		return false;
	}
}

/**
 * Check if response indicates bot detection.
 */
function isBotBlocked(response: Response | { status: number; headers?: Record<string, string> }): boolean {
	// Check status code
	if ("status" in response && BLOCKED_STATUS_CODES.includes(response.status)) {
		return true;
	}
	
	// Check headers for bot detection clues
	const headers = "headers" in response ? response.headers : {};
	const cfRay = headers["cf-ray"] || headers["CF-Ray"];
	const cfCaptcha = headers["cf-captcha-ray"] || headers["CF-Captcha-Ray"];
	
	if (cfRay || cfCaptcha) return true;
	
	return false;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Check if a URL or response indicates bot protection.
 */
export function isProtectedUrl(url: string): boolean {
	const protectedPatterns = [
		/cloudflare/i,
		/arkose/i,
		/perimeterx/i,
		/datadome/i,
	];
	return protectedPatterns.some(pattern => pattern.test(url));
}

/**
 * Check if content looks like a bot challenge page.
 */
export function isChallengePage(content: string): boolean {
	return BOT_CHECK_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * Fetch with TLS fingerprinting fallback.
 * 
 * First tries standard fetch, falls back to wreq-js if bot detection detected.
 */
export async function tlsFetch(
	url: string,
	options?: TLSFetchOptions,
): Promise<TLSFetchResponse> {
	const signal = timeoutSignal(undefined, options?.timeout);
	
	// Try standard fetch first
	try {
		const response = await fetch(url, {
			...options,
			signal,
			headers: {
				...options?.headers,
				// Common headers that help bypass basic checks
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Encoding": "gzip, deflate, br",
			},
		});
		
		if (!isBotBlocked(response)) {
			return wrapResponse(response);
		}
		
		// Bot detected, fall through to wreq
	} catch {
		// Standard fetch failed, fall through to wreq
	}
	
	// Use wreq-js for fingerprint bypass
	const wreqAvailable = await initWreq();
	if (!wreqAvailable) {
		throw new Error(
			"Bot detection detected and wreq-js not available. " +
			"Install with: npm install wreq-js"
		);
	}
	
	const { fetch: wreqFetch } = wreqModule!;
	const browser = options?.browser ?? "chrome_145";
	const os = options?.os ?? "windows";
	
	const wreqResponse = await wreqFetch(url, {
		...options,
		browser,
		os,
		proxy: options?.proxy,
	} as Record<string, unknown>);
	
	return wreqResponse as TLSFetchResponse;
}

/**
 * Create a session with TLS fingerprinting.
 * Sessions maintain cookies and context across requests.
 */
export async function createTLSSession(
	options?: {
		browser?: BrowserProfile;
		os?: OS;
		proxy?: string;
	},
): Promise<TLSFetchSession | null> {
	const wreqAvailable = await initWreq();
	if (!wreqAvailable) {
		return null;
	}
	
	const { createSession } = wreqModule!;
	const session = await createSession({
		browser: options?.browser ?? "chrome_145",
		os: options?.os ?? "windows",
		proxy: options?.proxy,
	} as Record<string, unknown>);
	
	return {
		session,
		fetch: async (url: string, options?: TLSFetchOptions) => {
			const response = await session.fetch(url, options as Record<string, unknown>);
			return response as TLSFetchResponse;
		},
		close: async () => {
			await session.close();
		},
	};
}

/**
 * Wrapper for standard fetch response.
 */
async function wrapResponse(response: Response): Promise<TLSFetchResponse> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	
	return {
		status: response.status,
		statusText: response.statusText,
		headers,
		text: () => response.text(),
		json: <T>() => response.json() as Promise<T>,
		arrayBuffer: () => response.arrayBuffer(),
	};
}

// ---------------------------------------------------------------------------
// Session interface
// ---------------------------------------------------------------------------

export interface TLSFetchSession {
	session: unknown;
	fetch(url: string, options?: TLSFetchOptions): Promise<TLSFetchResponse>;
	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Browser profile helpers
// ---------------------------------------------------------------------------

/**
 * Get default browser profile for a given use case.
 */
export function getDefaultProfile(): BrowserProfile {
	return "chrome_145";
}

/**
 * Get profile for anti-Cloudflare sites.
 */
export function getCloudflareProfile(): BrowserProfile {
	return "chrome_145"; // Chrome works best with Cloudflare
}

/**
 * Get profile for anti-bot sites (DataDome, PerimeterX).
 */
export function getAntiBotProfile(): BrowserProfile {
	return "chrome_142"; // Older Chrome sometimes works better
}

/**
 * List available browser profiles.
 */
export function listProfiles(): { name: string; description: string }[] {
	return [
		{ name: "chrome_145", description: "Chrome 145 (latest, default)" },
		{ name: "chrome_142", description: "Chrome 142 (stable)" },
		{ name: "chrome_130", description: "Chrome 130 (older)" },
		{ name: "firefox_147", description: "Firefox 147" },
		{ name: "firefox_128", description: "Firefox 128 (ESR)" },
		{ name: "safari_26", description: "Safari 26 (macOS)" },
		{ name: "safari_17", description: "Safari 17 (macOS)" },
		{ name: "edge_145", description: "Edge 145" },
		{ name: "edge_130", description: "Edge 130" },
		{ name: "okhttp", description: "OkHttp (Android)" },
	];
}

/**
 * Check if wreq-js is available.
 */
export function isWreqAvailable(): boolean {
	return wreqAvailable;
}

/**
 * Get installation instructions.
 */
export function getInstallInstructions(): string {
	return "npm install wreq-js";
}