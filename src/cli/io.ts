// io.ts — what a command prints and asks through, so commands are testable without a terminal.
import { createInterface } from "node:readline/promises";

export interface CliIo {
	out(line: string): void;
	err(line: string): void;
	/** Ask a yes/no question; false when nobody can answer. */
	confirm(question: string): Promise<boolean>;
}

export const stdIo: CliIo = {
	out: (line) => console.log(line),
	err: (line) => console.error(line),
	async confirm(question) {
		if (!process.stdin.isTTY) return false;
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
		} finally {
			rl.close();
		}
	},
};
