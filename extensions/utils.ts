/**
 * Shared utilities for pi-search-hub extension.
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HTTP_TIMEOUT_MS = 30_000;
export const COOLDOWN_MS = 2_000;
export const COMMAND_TIMEOUT_MS = 5_000;

export const MISSING_KEY_HELP =
	"Set the API key via env var (SEARCH_<BACKEND>_API_KEY), " +
	"config reference (\"apiKey\": \"SOME_ENV_VAR\"), " +
	"shell command (\"apiKey\": \"!pass show api/backend\"), " +
	"or a literal key in ~/.pi/agent/extensions/search.json. " +
	"DuckDuckGo needs no key. Marginalia uses a shared public key (optional)."

// ---------------------------------------------------------------------------
// Agent directory
// ---------------------------------------------------------------------------

export function getAgentDir(): string {
	return join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "agent");
}

// ---------------------------------------------------------------------------
// Per-backend cooldown
// ---------------------------------------------------------------------------

const backendCooldowns = new Map<string, number>();

export function waitForCooldown(backend: string): Promise<void> {
	const until = backendCooldowns.get(backend);
	if (!until) return Promise.resolve();
	const delay = until - Date.now();
	if (delay <= 0) return Promise.resolve();
	return new Promise(r => setTimeout(r, delay));
}

export function markCooldown(backend: string) {
	backendCooldowns.set(backend, Date.now() + COOLDOWN_MS);
}

export function clearCooldowns() {
	backendCooldowns.clear();
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/** Combine an optional caller signal with a timeout (default or custom). */
export function timeoutSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
	const effectiveTimeout = timeoutMs ?? HTTP_TIMEOUT_MS;
	if (!signal) return AbortSignal.timeout(effectiveTimeout);
	return AbortSignal.any([signal, AbortSignal.timeout(effectiveTimeout)]);
}

// ---------------------------------------------------------------------------
// Search result cache (LRU with TTL)
// ---------------------------------------------------------------------------

export interface CacheEntry<T> {
	value: T;
	timestamp: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CACHE_MAX = 100;

export class SearchCache<T> {
	private cache = new Map<string, CacheEntry<T>>();
	private readonly ttlMs: number;
	private readonly maxSize: number;

	constructor(ttlMs = DEFAULT_CACHE_TTL_MS, maxSize = DEFAULT_CACHE_MAX) {
		this.ttlMs = ttlMs;
		this.maxSize = maxSize;
	}

	get(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (Date.now() - entry.timestamp > this.ttlMs) {
			this.cache.delete(key);
			return undefined;
		}
		// LRU: move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.value;
	}

	set(key: string, value: T): void {
		// Evict oldest if at capacity
		if (this.cache.size >= this.maxSize) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.set(key, { value, timestamp: Date.now() });
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}
}

// Global search result cache instance
export const searchCache = new SearchCache<Array<{ title: string; url: string; snippet?: string; content?: string }>>();

// ---------------------------------------------------------------------------
// Exa usage tracking (monthly quota)
// ---------------------------------------------------------------------------

const EXA_MONTHLY_LIMIT = 1000;
const EXA_WARNING_THRESHOLD = 800; // warn at 80%

interface ExaUsageRecord {
	count: number;
	resetAt: string; // ISO date string for month start
}

function getUsageFilePath(): string {
	return join(getAgentDir(), "exa-usage.json");
}

function getCurrentMonthStart(): string {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

function readUsage(): ExaUsageRecord {
	try {
		const data = readFileSync(getUsageFilePath(), "utf-8");
		return JSON.parse(data) as ExaUsageRecord;
	} catch {
		return { count: 0, resetAt: getCurrentMonthStart() };
	}
}

function writeUsage(record: ExaUsageRecord): void {
	try {
		const dir = getAgentDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(getUsageFilePath(), JSON.stringify(record, null, 2));
	} catch {
		// ignore write failures
	}
}

/** Check Exa usage and return warning message if approaching quota, or null. */
export function checkExaUsage(): string | null {
	const usage = readUsage();
	// Reset if new month
	const currentMonth = getCurrentMonthStart();
	if (usage.resetAt !== currentMonth) {
		return null; // will be reset on next increment
	}
	if (usage.count >= EXA_WARNING_THRESHOLD) {
		const remaining = EXA_MONTHLY_LIMIT - usage.count;
		if (remaining <= 0) {
			return `⚠️ Exa quota exhausted (${usage.count}/${EXA_MONTHLY_LIMIT}). Upgrade at https://exa.ai/pricing`;
		}
		return `⚠️ Exa quota low (${remaining} remaining of ${EXA_MONTHLY_LIMIT}/month)`;
	}
	return null;
}

/** Increment Exa usage count. Call after each successful request. */
export function incrementExaUsage(): string | null {
	const usage = readUsage();
	const currentMonth = getCurrentMonthStart();
	// Reset if new month
	if (usage.resetAt !== currentMonth) {
		usage.count = 0;
		usage.resetAt = currentMonth;
	}
	usage.count++;
	writeUsage(usage);
	// Return warning if needed
	if (usage.count >= EXA_WARNING_THRESHOLD) {
		const remaining = EXA_MONTHLY_LIMIT - usage.count;
		if (remaining <= 0) {
			return `⚠️ Exa quota exhausted. Upgrade at https://exa.ai/pricing`;
		}
		if (usage.count === EXA_WARNING_THRESHOLD) {
			return `⚠️ Exa quota at ${EXA_WARNING_THRESHOLD}/${EXA_MONTHLY_LIMIT}. ${remaining} requests remaining this month.`;
		}
	}
	return null;
}

/** Build a cache key from query + backend + numResults. */
export function cacheKey(query: string, backend: string, numResults: number): string {
	return `${backend}:${numResults}:${query}`;
}

// ---------------------------------------------------------------------------
// SSRF guard — block private/internal addresses
// ---------------------------------------------------------------------------

/** Check if a hostname/IP is a private/internal address. */
export function isPrivateHost(host: string): boolean {
	const lower = host.toLowerCase();

	// Block obvious localhost variants
	if (lower === "localhost" || lower === "localhost.localdomain") return true;
	if (lower === "127.0.0.1" || lower === "::1" || lower === "0.0.0.0") return true;

	// Block private IP ranges (RFC1918 + RFC3927 + RFC4291)
	try {
		// Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
		let ip = host;
		if (ip.startsWith("::ffff:")) {
			ip = ip.slice(7);
		}

		// Parse as IPv4
		if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
			const parts = ip.split(".").map(Number);
			const octet = (n: number) => (n >= 0 && n <= 255 ? n : -1);

			// 127.0.0.0/8 — loopback
			if (parts[0] === 127) return true;

			// 10.0.0.0/8 — private
			if (parts[0] === 10) return true;

			// 172.16.0.0/12 — private
			if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

			// 192.168.0.0/16 — private
			if (parts[0] === 192 && parts[1] === 168) return true;

			// 169.254.0.0/16 — link-local
			if (parts[0] === 169 && parts[1] === 254) return true;

			// 0.0.0.0 — unspecified
			if (parts.every(p => p === 0)) return true;
		}

		// IPv6 parsing (basic)
		if (ip.includes(":")) {
			// ::1 — loopback
			if (ip === "::1") return true;
			// fe80:: — link-local
			if (ip.toLowerCase().startsWith("fe80:")) return true;
			// fc00:: and fd00:: — unique local
			if (ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd")) return true;
		}
	} catch {
		// Invalid IP format — continue with hostname check
	}

	// Block internal hostnames
	const blocked = [
		"metadata.google.internal.",
		"metadata.internal.",
		"169.254.169.254", // AWS/GCP/Azure metadata
		"metadata.azure.com",
		"instance metadata",
	];
	for (const blockedHost of blocked) {
		if (lower.includes(blockedHost)) return true;
	}

	return false;
}

/**
 * Validate a URL for SSRF vulnerabilities.
 * Returns null if safe, or an error message if blocked.
 */
export function validateUrl(url: string): string | null {
	try {
		const parsed = new URL(url);

		// Only allow http/https
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return `SSRF blocked: only http/https allowed, got ${parsed.protocol}`;
		}

		// Check hostname
		if (isPrivateHost(parsed.hostname)) {
			return `SSRF blocked: private host ${parsed.hostname}`;
		}

		// Check for credentials in URL (could be used to access internal services)
		if (parsed.username || parsed.password) {
			return `SSRF blocked: credentials in URL not allowed`;
		}

		// Check port (block some privileged ports as a safeguard)
		const port = parsed.port ? parseInt(parsed.port, 10) : 0;
		// Block ports 1-1023 (privileged) except common web ports
		if (port > 0 && port < 1024 && ![80, 443, 8080, 8443].includes(port)) {
			return `SSRF blocked: privileged port ${port} not allowed`;
		}

		return null;
	} catch {
		return `SSRF blocked: invalid URL ${url}`;
	}
}

/**
 * Validate a URL and throw if unsafe.
 * Use this before making fetch requests.
 */
export function assertSafeUrl(url: string): void {
	const error = validateUrl(url);
	if (error) throw new Error(error);
}

/** Sanitize API error text — truncate and strip potential secrets. */
export function sanitizeError(status: number, text: string): string {
	const safe = text
		// Redact "Bearer <token>" and "Token <value>" patterns
		.replace(/(bearer|token)\s+[\w.\/-]{8,}/gi, "$1 [redacted]")
		// Redact key=value or "key": "value" pairs for known secret keys
		.replace(/(api[-_]?key|bearer|token|authorization|secret|password)["']?\s*[:=]\s*["']?[\w.\/-]{8,}/gi, "[redacted]")
		// Redact JSON key-value pairs where the value looks like a key
		.replace(/"(?:api[-_]?key|apiKey|token|secret|password|bearer)"\s*:\s*"[^"']{8,}"/gi, '"[redacted]"')
		// Redact x-api-key / Authorization header values in raw text
		.replace(/(x-api-key|authorization)\s*:\s*[\w.\/-]{8,}/gi, "$1: [redacted]")
		.slice(0, 300);
	return `API error (${status}): ${safe}`;
}
