import { describe, expect, it } from "vitest";
import { createWakeBudget, WAKE_SPACING_MS, WAKES_PER_HOUR } from "../../src/daemon/wake-budget.js";

describe("wake budget", () => {
	it("check_firstWake_isAllowed", () => {
		expect(createWakeBudget().check("k", 1_000)).toEqual({ allowed: true });
	});

	it("check_withinSpacing_returnsNextAllowedAt", () => {
		const b = createWakeBudget();
		b.record("k", 100_000);
		expect(b.check("k", 100_000 + 10_000)).toEqual({ allowed: false, nextAllowedAt: 100_000 + WAKE_SPACING_MS });
		expect(b.check("k", 100_000 + WAKE_SPACING_MS)).toEqual({ allowed: true });
	});

	it("check_twelveInTheHour_blocksUntilTheOldestAgesOut", () => {
		const b = createWakeBudget();
		const start = 1_000_000;
		for (let i = 0; i < WAKES_PER_HOUR; i++) b.record("k", start + i * 31_000);
		const now = start + WAKES_PER_HOUR * 31_000;
		expect(b.check("k", now)).toEqual({ allowed: false, nextAllowedAt: start + 3_600_000 });
		expect(b.check("k", start + 3_600_000)).toEqual({ allowed: true });
	});

	it("check_keysAreIndependent", () => {
		const b = createWakeBudget();
		b.record("a", 5_000);
		expect(b.check("b", 5_001)).toEqual({ allowed: true });
	});
});
