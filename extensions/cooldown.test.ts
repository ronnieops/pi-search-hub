import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCooldowns, waitForCooldown } from "./utils.js";

describe("per-backend cooldown", () => {
	afterEach(() => {
		clearCooldowns();
		vi.useRealTimers();
	});

	it("serializes parallel reservations using the configured interval", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);

		const starts: number[] = [];
		const reserve = async () => {
			await waitForCooldown("perplexity", 1_500);
			starts.push(Date.now());
		};

		const requests = [reserve(), reserve(), reserve()];
		await vi.runAllTimersAsync();
		await Promise.all(requests);

		expect(starts).toEqual([10_000, 11_500, 13_000]);
	});

	it("maintains independent queues for different backends", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(20_000);

		const starts: Array<[string, number]> = [];
		const reserve = async (backend: string) => {
			await waitForCooldown(backend, 1_500);
			starts.push([backend, Date.now()]);
		};

		await Promise.all([reserve("perplexity"), reserve("tavily")]);

		expect(starts).toEqual([
			["perplexity", 20_000],
			["tavily", 20_000],
		]);
	});

	it("allows throttling to be disabled with a zero interval", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(30_000);

		const starts: number[] = [];
		await Promise.all(Array.from({ length: 3 }, async () => {
			await waitForCooldown("perplexity", 0);
			starts.push(Date.now());
		}));

		expect(starts).toEqual([30_000, 30_000, 30_000]);
	});
});
