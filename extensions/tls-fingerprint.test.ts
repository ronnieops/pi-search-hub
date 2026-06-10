import { describe, it, expect } from "vitest";
import {
	isProtectedUrl,
	isChallengePage,
	getDefaultProfile,
	getCloudflareProfile,
	listProfiles,
} from "./tls-fingerprint.js";

describe("tls-fingerprint", () => {
	describe("isProtectedUrl", () => {
		it("detects Cloudflare URLs", () => {
			expect(isProtectedUrl("https://challenges.cloudflare.com/")).toBe(true);
			expect(isProtectedUrl("https://example.com/cloudflare")).toBe(true);
		});

		it("detects other bot protection URLs", () => {
			expect(isProtectedUrl("https://example.com/arkose")).toBe(true);
			expect(isProtectedUrl("https://example.com/perimeterx")).toBe(true);
		});

		it("returns false for normal URLs", () => {
			expect(isProtectedUrl("https://google.com")).toBe(false);
			expect(isProtectedUrl("https://github.com/user/repo")).toBe(false);
		});
	});

	describe("isChallengePage", () => {
		it("detects Cloudflare challenge", () => {
			expect(isChallengePage("Cloudflare Ray ID: abc123")).toBe(true);
			expect(isChallengePage("Please complete a Cloudflare security check")).toBe(true);
		});

		it("detects Arkose challenge", () => {
			expect(isChallengePage("Arkose Labs verification")).toBe(true);
		});

		it("detects general bot check", () => {
			expect(isChallengePage("Access Denied")).toBe(true);
			expect(isChallengePage("Please verify you are human")).toBe(true);
		});

		it("returns false for normal content", () => {
			expect(isChallengePage("Hello, this is a normal page")).toBe(false);
			expect(isChallengePage("{\"result\": \"ok\"}")).toBe(false);
		});
	});

	describe("getDefaultProfile", () => {
		it("returns chrome_145", () => {
			expect(getDefaultProfile()).toBe("chrome_145");
		});
	});

	describe("getCloudflareProfile", () => {
		it("returns chrome profile", () => {
			const profile = getCloudflareProfile();
			expect(profile).toBe("chrome_145");
		});
	});

	describe("listProfiles", () => {
		it("returns all available profiles", () => {
			const profiles = listProfiles();
			expect(profiles.length).toBeGreaterThan(5);
			expect(profiles.map(p => p.name)).toContain("chrome_145");
			expect(profiles.map(p => p.name)).toContain("firefox_147");
			expect(profiles.map(p => p.name)).toContain("safari_26");
		});

		it("has descriptions for all profiles", () => {
			const profiles = listProfiles();
			for (const profile of profiles) {
				expect(profile.description).toBeTruthy();
			}
		});
	});
});