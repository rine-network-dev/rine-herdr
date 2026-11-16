// plural.ts — a count with its noun, so "1 step" and "2 steps" read right everywhere.
export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
