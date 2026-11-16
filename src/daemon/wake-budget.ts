// wake-budget.ts — how often a pane may be woken: the cc plugin's own limits (one per 30 s, twelve per hour;
// rine-cc-plugin hooks/lib/lease.ts WAKE_SPACING_MS and WAKES_PER_HOUR), kept equal by a contract test.
export const WAKE_SPACING_MS = 30_000;
export const WAKES_PER_HOUR = 12;
const HOUR_MS = 3_600_000;

export type WakeCheck = { allowed: true } | { allowed: false; nextAllowedAt: number };

export interface WakeBudget {
	check(key: string, now: number): WakeCheck;
	record(key: string, now: number): void;
}

export function createWakeBudget(): WakeBudget {
	const wakes = new Map<string, number[]>();
	const recent = (key: string, now: number): number[] => (wakes.get(key) ?? []).filter((at) => now - at < HOUR_MS);
	return {
		check(key, now) {
			const stamps = recent(key, now);
			const last = stamps.reduce((latest, at) => Math.max(latest, at), 0);
			let next = last === 0 ? now : last + WAKE_SPACING_MS;
			const oldest = stamps[stamps.length - WAKES_PER_HOUR];
			if (oldest !== undefined) next = Math.max(next, oldest + HOUR_MS);
			return next <= now ? { allowed: true } : { allowed: false, nextAllowedAt: next };
		},
		record(key, now) {
			wakes.set(key, [...recent(key, now), now]);
		},
	};
}
