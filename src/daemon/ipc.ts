// ipc.ts — the daemon's local socket: NDJSON, one request per line, zod-checked in both directions.
// Trust is same-user, like herdr's own socket: a 0600 socket inside the 0700 state dir.
import { chmodSync, rmSync } from "node:fs";
import net from "node:net";
import { createInterface } from "node:readline";
import { z } from "zod";
import { type IpcMethod, type IpcReply, type IpcRequest, IpcRequestSchema } from "../types.js";
import { IpcReplyWire, IpcResults } from "./ipc-schemas.js";

/** What every surface says when nothing listens on the socket; the command sits on its own line so it never wraps. */
export const DAEMON_DOWN = "The rine daemon is not running. Start herdr with the plugin linked, or run:\n  rine-herdr daemon start --detach";

/** The errno codes of a socket nobody is listening on: no file, or a file left by a daemon that died. */
const DAEMON_ABSENT: ReadonlySet<string> = new Set(["ENOENT", "ECONNREFUSED"]);

export type IpcHandler = (request: IpcRequest) => Promise<unknown>;

export interface IpcServer {
	close(): Promise<void>;
}

async function answer(line: string, handler: IpcHandler, log: (line: string) => void): Promise<IpcReply> {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return { id: -1, ok: false, error: "request is not json" };
	}
	const id = z.object({ id: z.number().int() }).safeParse(raw);
	const request = IpcRequestSchema.safeParse(raw);
	if (!request.success) return { id: id.success ? id.data.id : -1, ok: false, error: "invalid request" };
	try {
		const result = IpcResults[request.data.method].safeParse(await handler(request.data));
		if (result.success) return { id: request.data.id, ok: true, result: result.data };
		log(`${request.data.method}: handler returned a malformed result`);
		return { id: request.data.id, ok: false, error: "internal error" };
	} catch (err) {
		return { id: request.data.id, ok: false, error: (err as Error).message };
	}
}

export function startIpcServer(socketPath: string, handler: IpcHandler, log: (line: string) => void): Promise<IpcServer> {
	rmSync(socketPath, { force: true });
	const connections = new Set<net.Socket>();
	const server = net.createServer((conn) => {
		connections.add(conn);
		conn.on("close", () => connections.delete(conn));
		conn.on("error", () => conn.destroy());
		const lines = createInterface({ input: conn });
		lines.on("error", () => conn.destroy());
		lines.on("line", (line) => {
			void answer(line, handler, log).then((reply) => conn.write(`${JSON.stringify(reply)}\n`));
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			chmodSync(socketPath, 0o600);
			resolve({
				close: () =>
					new Promise<void>((done) => {
						for (const conn of connections) conn.destroy();
						server.close(() => {
							rmSync(socketPath, { force: true });
							done();
						});
					}),
			});
		});
	});
}

let nextId = 1;

export function ipcCall<M extends IpcMethod, S extends z.ZodType>(
	socketPath: string,
	method: M,
	params: Extract<IpcRequest, { method: M }>["params"],
	resultSchema: S,
	timeoutMs = 5_000,
): Promise<z.infer<S>> {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const conn = net.createConnection(socketPath);
		const fail = (message: string): void => {
			conn.destroy();
			reject(new Error(message));
		};
		conn.setTimeout(timeoutMs, () => fail(`daemon did not answer ${method} in ${timeoutMs} ms`));
		conn.once("error", (err: NodeJS.ErrnoException) => fail(DAEMON_ABSENT.has(err.code ?? "") ? DAEMON_DOWN : `daemon unreachable: ${err.message}`));
		conn.once("connect", () => conn.write(`${JSON.stringify({ id, method, params })}\n`));
		const lines = createInterface({ input: conn });
		lines.on("error", () => {}); // the connection's own error handler reports it
		lines.once("line", (line) => {
			conn.destroy();
			let reply: z.infer<typeof IpcReplyWire>;
			try {
				reply = IpcReplyWire.parse(JSON.parse(line));
			} catch {
				return reject(new Error("daemon sent a malformed reply"));
			}
			if (!reply.ok) return reject(new Error(reply.error));
			const result = resultSchema.safeParse(reply.result);
			if (result.success) resolve(result.data);
			else reject(new Error(`daemon sent a malformed ${method} result`));
		});
	});
}
