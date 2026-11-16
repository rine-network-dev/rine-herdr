// fake-port.ts — an in-memory HerdrPort: scripted CLI results and sockets the test drives by hand.
import type { HerdrPort, HerdrResult, HerdrSocket } from "../../src/herdr/port.js";

export const ok = (result: unknown = {}): HerdrResult => ({ code: 0, stdout: JSON.stringify({ id: "t", result }), stderr: "" });
export const fail = (code: string, message = code): HerdrResult => ({
	code: 1,
	stdout: "",
	stderr: JSON.stringify({ id: "t", error: { code, message } }),
});

export class FakeSocket implements HerdrSocket {
	sent: string[] = [];
	closed = false;
	private lines: Array<(line: string) => void> = [];
	private closes: Array<() => void> = [];
	send(line: string): void {
		this.sent.push(line);
	}
	onLine(handler: (line: string) => void): void {
		this.lines.push(handler);
	}
	onClose(handler: () => void): void {
		this.closes.push(handler);
	}
	close(): void {
		this.dropped();
	}
	/** Pushes one line from herdr. */
	emit(line: string | object): void {
		for (const handler of this.lines) handler(typeof line === "string" ? line : JSON.stringify(line));
	}
	/** herdr (or the network) ends the connection. */
	dropped(): void {
		if (this.closed) return;
		this.closed = true;
		for (const handler of this.closes) handler();
	}
	requests(): Array<{ id: string; method: string; params: Record<string, unknown> }> {
		return this.sent.map((line) => JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> });
	}
}

export type CliHandler = (args: readonly string[]) => HerdrResult | Promise<HerdrResult>;

export class FakePort implements HerdrPort {
	calls: string[][] = [];
	sockets: FakeSocket[] = [];
	reachable = true;
	constructor(public handler: CliHandler = () => ok()) {}
	async run(args: readonly string[]): Promise<HerdrResult> {
		this.calls.push([...args]);
		return this.handler(args);
	}
	async connect(): Promise<HerdrSocket> {
		if (!this.reachable) throw new Error("herdr socket unreachable");
		const socket = new FakeSocket();
		this.sockets.push(socket);
		return socket;
	}
	/** The CLI calls whose first two words match, e.g. `prompts("agent", "prompt")`. */
	calling(first: string, second: string): string[][] {
		return this.calls.filter((c) => c[0] === first && c[1] === second);
	}
	socketsSubscribedTo(type: string): FakeSocket[] {
		return this.sockets.filter((s) => s.sent.some((l) => l.includes(`"type":"${type}"`)));
	}
}
