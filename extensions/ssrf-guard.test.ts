import { describe, it, expect } from "vitest";
import { isPrivateHost, validateUrl, assertSafeUrl } from "./utils.js";

describe("SSRF guard", () => {
	describe("isPrivateHost", () => {
		it("blocks localhost", () => {
			expect(isPrivateHost("localhost")).toBe(true);
			expect(isPrivateHost("127.0.0.1")).toBe(true);
			expect(isPrivateHost("127.0.0.2")).toBe(true);
			expect(isPrivateHost("::1")).toBe(true);
			expect(isPrivateHost("0.0.0.0")).toBe(true);
		});

		it("blocks RFC1918 private ranges", () => {
			expect(isPrivateHost("10.0.0.1")).toBe(true);
			expect(isPrivateHost("10.255.255.255")).toBe(true);
			expect(isPrivateHost("172.16.0.1")).toBe(true);
			expect(isPrivateHost("172.31.255.255")).toBe(true);
			expect(isPrivateHost("192.168.0.1")).toBe(true);
			expect(isPrivateHost("192.168.255.255")).toBe(true);
		});

		it("blocks link-local", () => {
			expect(isPrivateHost("169.254.0.1")).toBe(true);
			expect(isPrivateHost("169.254.255.255")).toBe(true);
		});

		it("blocks IPv6 link-local", () => {
			expect(isPrivateHost("fe80::1")).toBe(true);
			expect(isPrivateHost("fe80:ffff:ffff:ffff::")).toBe(true);
		});

		it("blocks internal hostnames", () => {
			expect(isPrivateHost("metadata.google.internal.")).toBe(true);
			expect(isPrivateHost("169.254.169.254")).toBe(true); // AWS metadata
		});

		it("allows public hosts", () => {
			expect(isPrivateHost("google.com")).toBe(false);
			expect(isPrivateHost("8.8.8.8")).toBe(false);
			expect(isPrivateHost("1.1.1.1")).toBe(false);
			expect(isPrivateHost("example.org")).toBe(false);
		});

		it("allows IPv4-mapped IPv6", () => {
			// ::ffff:127.0.0.1 should block
			expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
			// ::ffff:8.8.8.8 should allow
			expect(isPrivateHost("::ffff:8.8.8.8")).toBe(false);
		});
	});

	describe("validateUrl", () => {
		it("blocks non-http/https", () => {
			expect(validateUrl("file:///etc/passwd")).not.toBeNull();
			expect(validateUrl("ftp://example.com")).not.toBeNull();
			expect(validateUrl("dict://localhost:11211")).not.toBeNull();
		});

		it("blocks private hosts", () => {
			expect(validateUrl("http://localhost:8080")).not.toBeNull();
			expect(validateUrl("http://127.0.0.1/admin")).not.toBeNull();
			expect(validateUrl("https://192.168.1.1/router")).not.toBeNull();
			expect(validateUrl("http://10.0.0.1:8080")).not.toBeNull();
		});

		it("blocks credentials in URL", () => {
			expect(validateUrl("http://user:pass@localhost")).not.toBeNull();
			expect(validateUrl("http://admin:secret@192.168.1.1")).not.toBeNull();
		});

		it("blocks privileged ports", () => {
			expect(validateUrl("http://example.com:22")).not.toBeNull(); // SSH
			expect(validateUrl("http://example.com:3306")).toBeNull(); // MySQL > 1024, allowed
		});

		it("allows common web ports", () => {
			expect(validateUrl("http://example.com:80")).toBeNull();
			expect(validateUrl("https://example.com:443")).toBeNull();
			expect(validateUrl("http://example.com:8080")).toBeNull();
			expect(validateUrl("https://example.com:8443")).toBeNull();
		});

		it("allows public URLs", () => {
			expect(validateUrl("https://google.com")).toBeNull();
			expect(validateUrl("https://github.com/user/repo")).toBeNull();
			expect(validateUrl("https://example.com/path?query=value")).toBeNull();
		});

		it("handles invalid URLs", () => {
			expect(validateUrl("not-a-url")).not.toBeNull();
			expect(validateUrl("")).not.toBeNull();
		});
	});

	describe("assertSafeUrl", () => {
		it("throws on unsafe URL", () => {
			expect(() => assertSafeUrl("http://localhost")).toThrow();
			expect(() => assertSafeUrl("http://192.168.1.1")).toThrow();
			expect(() => assertSafeUrl("ftp://bad.com")).toThrow();
		});

		it("does not throw on safe URL", () => {
			expect(() => assertSafeUrl("https://google.com")).not.toThrow();
		});
	});
});
