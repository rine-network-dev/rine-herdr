// cli.ts — typed wrappers over the herdr CLI. Output is JSON on stdout (errors may land on stderr);
// every reply is zod-checked, and the one refusal delivery depends on, agent_blocked, is a value.
import { z } from "zod";
import { AgentStatus } from "../types.js";
import type { HerdrPort, HerdrResult } from "./port.js";

const TOKEN_SOURCE = "custom:rine";
const TOKEN_NAME = "rine";
const TOKEN_MAX = 80;
const TOAST_TITLE_MAX = 80;
const TOAST_BODY_MAX = 240;
const BLOCKED_CODE = "agent_blocked";

export const HerdrSound = { None: "none", Done: "done", Request: "request" } as const;
export type HerdrSound = (typeof HerdrSound)[keyof typeof HerdrSound];

export class HerdrCliError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`herdr: ${code}: ${message}`);
	}
}

export interface HerdrFailure {
	code: string;
	message: string;
}

const Envelope = z.object({
	result: z.unknown().optional(),
	error: z.object({ code: z.string(), message: z.string() }).optional(),
});

type Outcome = { ok: true; result: unknown } | { ok: false; error: HerdrFailure };

function readEnvelope(text: string): z.infer<typeof Envelope> | null {
	try {
		const parsed = Envelope.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** `quietOk`: the command prints nothing on success (`report-metadata`), so exit 0 with no output is ok. */
function outcomeOf(res: HerdrResult, quietOk = false): Outcome {
	if (quietOk && res.code === 0 && !res.stdout.trim() && !res.stderr.trim()) return { ok: true, result: undefined };
	const env = readEnvelope(res.stdout) ?? readEnvelope(res.stderr);
	if (env?.error) return { ok: false, error: env.error };
	if (res.code === 0 && env) return { ok: true, result: env.result };
	const detail = (res.stderr || res.stdout).trim().slice(0, 200);
	return { ok: false, error: { code: "cli_failed", message: detail || `exit ${res.code}` } };
}

async function call(port: HerdrPort, args: readonly string[], quietOk = false): Promise<unknown> {
	const out = outcomeOf(await port.run(args), quietOk);
	if (!out.ok) throw new HerdrCliError(out.error.code, out.error.message);
	return out.result;
}

/** Clips by code point, so a multi-byte character is never cut in half. */
function clip(text: string, max: number): string {
	const points = Array.from(text);
	return points.length <= max ? text : points.slice(0, max).join("");
}

export interface AgentInfo {
	paneId: string;
	workspaceId: string;
	/** The herdr name given with `agent rename`; null when the pane has none. */
	name: string | null;
	/** The detected or self-reported agent kind. */
	kind: string | null;
	cwd: string | null;
	status: AgentStatus;
}

export const AgentInfoSchema = z
	.object({
		pane_id: z.string(),
		workspace_id: z.string(),
		name: z.string().nullish(),
		agent: z.string().nullish(),
		cwd: z.string().nullish(),
		agent_status: z.enum(AgentStatus).catch(AgentStatus.Unknown),
	})
	.transform(
		(a): AgentInfo => ({
			paneId: a.pane_id,
			workspaceId: a.workspace_id,
			name: a.name ?? null,
			kind: a.agent ?? null,
			cwd: a.cwd ?? null,
			status: a.agent_status,
		}),
	);

const AgentResult = z.object({ agent: AgentInfoSchema });
const AgentListResult = z.object({ agents: z.array(AgentInfoSchema) });
const WorkspaceResult = z.object({
	workspace: z.object({
		workspace_id: z.string(),
		worktree: z.object({ repo_root: z.string().nullish() }).nullish(),
	}),
});

export type PromptResult = { blocked: true } | { blocked: false; error: HerdrFailure | null };

/** Types `text` into the agent. A blocked agent is refused by herdr before any input is sent. */
export async function promptAgent(port: HerdrPort, target: string, text: string): Promise<PromptResult> {
	const out = outcomeOf(await port.run(["agent", "prompt", target, text]));
	if (out.ok) return { blocked: false, error: null };
	if (out.error.code === BLOCKED_CODE) return { blocked: true };
	return { blocked: false, error: out.error };
}

export async function reportToken(port: HerdrPort, paneId: string, value: string): Promise<void> {
	await call(port, [
		"pane",
		"report-metadata",
		paneId,
		"--source",
		TOKEN_SOURCE,
		"--token",
		`${TOKEN_NAME}=${clip(value, TOKEN_MAX)}`,
	], true);
}

export async function clearToken(port: HerdrPort, paneId: string): Promise<void> {
	await call(port, ["pane", "report-metadata", paneId, "--source", TOKEN_SOURCE, "--clear-token", TOKEN_NAME], true);
}

export async function reportWorkspaceToken(port: HerdrPort, workspaceId: string, value: string): Promise<void> {
	await call(port, [
		"workspace",
		"report-metadata",
		workspaceId,
		"--source",
		TOKEN_SOURCE,
		"--token",
		`${TOKEN_NAME}=${clip(value, TOKEN_MAX)}`,
	], true);
}

export interface Toast {
	title: string;
	body?: string;
	sound?: HerdrSound;
}

export async function notify(port: HerdrPort, toast: Toast): Promise<void> {
	const args = ["notification", "show", clip(toast.title, TOAST_TITLE_MAX)];
	if (toast.body !== undefined) args.push("--body", clip(toast.body, TOAST_BODY_MAX));
	if (toast.sound !== undefined) args.push("--sound", toast.sound);
	await call(port, args);
}

export async function agentGet(port: HerdrPort, target: string): Promise<AgentInfo> {
	return AgentResult.parse(await call(port, ["agent", "get", target])).agent;
}

export async function agentList(port: HerdrPort): Promise<AgentInfo[]> {
	return AgentListResult.parse(await call(port, ["agent", "list"])).agents;
}

export async function agentRename(port: HerdrPort, target: string, name: string): Promise<AgentInfo> {
	return AgentResult.parse(await call(port, ["agent", "rename", target, name])).agent;
}

export interface WorkspaceInfo {
	workspaceId: string;
	/** `worktree.repo_root` when the workspace is a herdr worktree. */
	repoRoot: string | null;
}

export async function workspaceGet(port: HerdrPort, workspaceId: string): Promise<WorkspaceInfo> {
	const { workspace } = WorkspaceResult.parse(await call(port, ["workspace", "get", workspaceId]));
	return { workspaceId: workspace.workspace_id, repoRoot: workspace.worktree?.repo_root ?? null };
}

export interface OpenPaneOptions {
	plugin: string;
	entrypoint: string;
	cwd?: string;
	env?: Readonly<Record<string, string>>;
}

export async function openPane(port: HerdrPort, opts: OpenPaneOptions): Promise<void> {
	const args = ["plugin", "pane", "open", "--plugin", opts.plugin, "--entrypoint", opts.entrypoint];
	if (opts.cwd !== undefined) args.push("--cwd", opts.cwd);
	for (const [key, value] of Object.entries(opts.env ?? {})) args.push("--env", `${key}=${value}`);
	await call(port, args);
}
