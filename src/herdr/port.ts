// port.ts — the seam to herdr: its CLI for commands and its NDJSON socket for events. Everything
// above this file talks to HerdrPort, so tests inject a fake and the real one is exercised by the rig.
import { execFile } from "node:child_process";
import net from "node:net";
import type { HerdrEndpoint } from "./env.js";

export interface HerdrResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface HerdrSocket {
	/** Writes one NDJSON line (the newline is added here). */
	send(line: string): void;
	onLine(handler: (line: string) => void): void;
	/** Fires once, for a peer close, an error or our own close(). */
	onClose(handler: () => void): void;
	close(): void;
}

export interface HerdrPort {
	/** Runs the herdr CLI; a non-zero exit is a result, never an exception. */
	run(args: readonly string[]): Promise<HerdrResult>;
	/** One connection. herdr treats a connection that subscribed as push-only, so each subscription gets its own. */
	connect(): Promise<HerdrSocket>;
}

const CLI_TIMEOUT_MS = 15_000;

function wrapSocket(conn: net.Socket): HerdrSocket {
	const lineHandlers: Array<(line: string) => void> = [];
	const closeHandlers: Array<() => void> = [];
	let buffered = "";
	let closed = false;
	conn.setEncoding("utf8");
	conn.on("data", (chunk: string) => {
		buffered += chunk;
		let cut = buffered.indexOf("\n");
		while (cut >= 0) {
			const line = buffered.slice(0, cut);
			buffered = buffered.slice(cut + 1);
			if (line.length > 0) for (const handler of lineHandlers) handler(line);
			cut = buffered.indexOf("\n");
		}
	});
	const finish = (): void => {
		if (closed) return;
		closed = true;
		for (const handler of closeHandlers) handler();
	};
	conn.on("close", finish);
	conn.on("error", () => conn.destroy());
	return {
		send: (line) => void conn.write(`${line}\n`),
		onLine: (handler) => void lineHandlers.push(handler),
		onClose: (handler) => void closeHandlers.push(handler),
		close: () => conn.destroy(),
	};
}

export function realHerdrPort(endpoint: HerdrEndpoint, env: NodeJS.ProcessEnv = process.env): HerdrPort {
	return {
		run: (args) =>
			new Promise((resolve) => {
				execFile(
					endpoint.binPath,
					[...args],
					{ env, timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
					(error, stdout, stderr) => {
						const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
						resolve({ code, stdout, stderr: error !== null && stderr === "" ? error.message : stderr });
					},
				);
			}),
		connect: () =>
			new Promise((resolve, reject) => {
				if (endpoint.socketPath === null) return reject(new Error("HERDR_SOCKET_PATH is not set"));
				const conn = net.createConnection(endpoint.socketPath);
				conn.once("error", reject);
				conn.once("connect", () => {
					conn.off("error", reject);
					resolve(wrapSocket(conn));
				});
			}),
	};
}
