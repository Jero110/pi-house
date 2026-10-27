// /workflow report, save, ask and the proposals: pihouse looking at its own workflow.
//
// report: rebuilds the last run from disk (agent-link journal + transcripts) and writes a code-only report of what ran,
//   with which skills, tokens and time by role, harness, agent and message. No model turn.
// save: flags the current session's run and captures it into the workflow memory now. Planner and executor sessions
//   are flagged and captured by default (see workflow/capture.ts).
// ask: gives the model the architecture, the skills catalog and what is installed here, then the question.
// proposals, approve, reject: the proposal store (see proposalCommand). No model turn.
// `/workflow review` (model-written recommendations) was removed; the report is what remains, and it is computed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionRecord } from "agent-link-core";
import { agentLinkHome, hubPaths, readJournal } from "agent-link-core";
import { pihousePaths, REPO_ROOT, SKILLS_DIR } from "../paths.ts";
import { readConfig } from "../setup.ts";
import { buildAskContext } from "../workflow/ask-context.ts";
import {
	addFlag,
	capTitle,
	captureRun,
	captureRunOutcome,
	isFlagged,
	localRecord,
	ownRoot,
	projectOf,
	readFlags,
} from "../workflow/capture.ts";
import {
	digestCommand,
	type LearningDeps,
	type LearningOutcome,
	selfLearningCommand,
} from "../workflow/learning-commands.ts";
import { LIMITS, type MemoryStore, openMemory } from "../workflow/memory.ts";
import { ACTIVE_MARKER } from "../workflow/migration.ts";
import { createProposalTarget } from "../workflow/proposal-target.ts";
import {
	applyProposal,
	approveProposal,
	getProposal,
	listProposals,
	type Proposal,
	recoverApplying,
	rejectProposal,
	resolveProposalId,
	type ScopedTarget,
	shortVersion,
} from "../workflow/proposals.ts";
import { renderReport } from "../workflow/report.ts";
import { buildRun, pickRoot, type WorkflowRun } from "../workflow/run.ts";
import { fetchSource, type SourceResult } from "../workflow/sources.ts";
import { openOperationalStore } from "../workflow/storage.ts";
import { sessionTitle } from "./brand.ts";

export const MESSAGE_TYPE = "pihouse-workflow";

/**
 * The public `/workflow` commands. The usage line and the completions both read this table, so they cannot list
 * different commands. Problem: each listed the commands by hand, and the review command stayed in one after it was
 * removed from the other. Solution: one table; the handler's dispatch below handles the same words.
 */
export const WORKFLOW_COMMANDS = [
	{ usage: "report [--last]", completions: ["report", "report --last"] },
	{ usage: "save [reason]", completions: ["save "] },
	{ usage: "digest (separate model agent; model quota)", completions: ["digest"] },
	{ usage: "self-learning (digest, scan and review agents; model quota)", completions: ["self-learning"] },
	{ usage: "ask <question>", completions: ["ask "] },
	{ usage: "proposals", completions: ["proposals"] },
	{ usage: "approve <id> [version]", completions: ["approve "] },
	{ usage: "reject <id> [reason]", completions: ["reject "] },
] as const;

export const USAGE = `usage: ${WORKFLOW_COMMANDS.map((c) => `/workflow ${c.usage}`).join(" | ")}`;

/**
 * Removed invocations say what replaces them and start nothing: no alias, no model turn.
 * Problem: a removed command that stays silent looks like it ran; one that falls through to a model reads the old words
 * as a new request. Example: `/keeper summarize` must not start a digest that no longer exists. Solution: a concise
 * warning that names the replacement.
 */
const REVIEW_REMOVED =
	"/workflow review was removed. Use /workflow report [--last] for what a run did. Use /workflow self-learning to learn from runs.";
const KEEPER_RETIRED =
	"The keeper was retired. Use /workflow proposals, /workflow approve <id> and /workflow reject <id> [reason]; /workflow report shows what a run did.";

export const ARCHITECTURE = `## How pihouse works

- pihouse is pi (unmodified) with three extensions: the header, ask_user_question (questions in a picker) and /workflow.
- agent-link lets any agent launch, message and stop other agents (claude, codex, opencode, pihouse, pi), each in its own
  pane with its native UI. A hub daemon routes messages; results reach the parent by themselves.
- The hub journals every agent to ~/.agent-link/sessions/<id>.json (parent, task, pane, session id, transcript path), so
  sessions can be found and read after the hub or the agent stops.
- The cmux MCP (cmux only) lists agent sessions and reads their transcripts, arranges surfaces, panes and workspaces,
  and drives cmux's browser.
- The workflow: the planner skill (pre-build) takes the user from an idea to a validated plan in docs/plans/<slug>.md,
  asking only through ask_user_question; the user picks the build skills; grilling stress-tests the idea. On approval the
  planner launches an executor (a pihouse agent in its own pane) that runs the plan end to end with no questions to the user,
  dispatching tasks to workers on the harness and model the plan names. Post-build and Extras skills are manual.
- /workflow report reads a run back from the journal and transcripts: tokens, time per message, skills per agent.`;

/**
 * The newest report in `dir`, by when it was written.
 * Problem: it picked the last file name in order, which only worked while the date led the name. Solution: the file's
 * own time, so a name is free to start with what the review is about.
 */
export function latestReport(dir: string): string | undefined {
	try {
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => a.at - b.at || a.f.localeCompare(b.f));
		const last = files.at(-1);
		return last ? join(dir, last.f) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The name of a review report: what it is (workflow-review), which plan, and when, in the user's own time (2026-10-24-0415).
 * Problem: it was "20261024T041500-<plan>.md", the date run together and in UTC, which read as noise.
 */
export function reviewFileName(slug: string, when: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const date = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
	return `workflow-review-${slug}-${date}-${p(when.getHours())}${p(when.getMinutes())}.md`;
}

export interface AskDeps {
	/** Default: the memory dir under pihouse's home. */
	memoryDir?: string;
	/** Default: the real fetchSource (YouTube, web, media files). */
	fetchSource?: (input: string) => Promise<SourceResult>;
	/** The folder the question is asked from, for the project tag of saved sources. Default: process.cwd(). */
	cwd?: string;
}

const MAX_SOURCES = 3;
const SOURCE_CHARS = 4_000;
/**
 * The links and media files named in a question, at most three.
 * Problem: "see https://youtu.be/x, then compare." would hand fetchSource a link ending in a comma. Solution: trim
 * trailing punctuation and closing brackets.
 */
export function sourcesIn(question: string): string[] {
	const found =
		question.match(
			/https?:\/\/[^\s<>"']+|(?:~|\.{0,2})\/[^\s<>"']+\.(?:mp4|mkv|mov|webm|avi|m4v|mp3|m4a|wav|flac|ogg|opus|aac)\b/gi,
		) ?? [];
	const clean = found.map((f) => f.replace(/[.,;:!?)\]}]+$/, ""));
	return [...new Set(clean)].slice(0, MAX_SOURCES);
}

/**
 * Saves what each source gave and says what to do with it.
 * Problem: a link in the question was left to the model to open, so the same video was read twice and never kept.
 * Example: "what do you think of https://youtu.be/abc?" must leave consulted/<id>.md and .txt behind. Solution: code
 * fetches and saves the text through the store; the model only writes the summary, the ideas and the question back.
 */
async function sourcesSection(
	store: MemoryStore,
	inputs: string[],
	deps: AskDeps,
	fetcher: (input: string) => Promise<SourceResult>,
): Promise<string> {
	const where = projectOf(deps.cwd ?? process.cwd());
	const parts: string[] = [];
	const saved: string[] = [];
	for (const input of inputs) {
		const got = await fetcher(input);
		if (!got.ok) {
			parts.push(`## Source not read: ${input}\n\n${got.message}\nFallback: ${FALLBACK_AGENT}`);
			continue;
		}
		const id = `src-${createHash("sha256").update(input).digest("hex").slice(0, 10)}`;
		const title = got.meta.title ?? input;
		store.writeConsulted({ id, title, source: input, ...where }, got.text, "");
		saved.push(id);
		parts.push(
			[
				`## Source: ${title}`,
				"",
				`- Entry: ${join(store.dir, "consulted", `${id}.md`)} (text: ${join(store.dir, "consulted", `${id}.txt`)})`,
				`- From: ${input} (${got.meta.kind}, ${got.meta.method})`,
				"",
				got.text.slice(0, SOURCE_CHARS),
				got.text.length > SOURCE_CHARS ? "\n[... the rest is in the text file above]" : "",
			].join("\n"),
		);
	}
	const todo = saved.length
		? [
				"",
				"For each source above:",
				"1. Write a summary of at most 1,500 chars under `## Summary` in its entry file (edit only that section).",
				"2. Relate it to the user's past runs, using the digests and the memory above; name the runs.",
				`3. For each idea worth keeping, write ${join(store.dir, "ideas", "<source id>-<short-name>.md")} starting with`,
				"   `---`, then lines `id: <source id>-<short-name>`, `title: <title>`, `project: <project>`, `projectSlug: <slug>`,",
				"   `createdAt: <ISO time>`, then `---`, then the idea in a few lines.",
				"4. Ask the user what they need from it to go on (use ask_user_question).",
			].join("\n")
		: "";
	return `# Sources in the question\n\n${parts.join("\n\n")}\n${todo}\n`;
}

const FALLBACK_AGENT =
	"offer to launch a cheap agent with agent-link spawn (an opencode or haiku worker) to read it and report the text back.";

/**
 * The context /workflow ask gives the model: how pihouse works, this machine, the catalog, the workflow memory, the
 * index and the digests that match the question; never a transcript. Async because a link in the question is fetched.
 */
export async function askContext(
	question: string,
	env: NodeJS.ProcessEnv = process.env,
	deps: AskDeps = {},
): Promise<string> {
	const paths = pihousePaths(env);
	const config = readConfig(paths);
	const store = openMemory(deps.memoryDir ?? paths.memory);
	store.adoptIdeas();
	const sources = sourcesIn(question);
	const sourcesText = sources.length ? await sourcesSection(store, sources, deps, deps.fetchSource ?? fetchSource) : "";
	return [
		buildAskContext({
			memoryDir: store.dir,
			project: projectOf(deps.cwd ?? process.cwd()).projectSlug,
			question,
			repoRoot: REPO_ROOT,
			skillsDir: SKILLS_DIR,
			config: { backend: config?.backend, mcpServers: ["agent-link", ...(config?.backend === "cmux" ? ["cmux"] : [])] },
		}),
		sourcesText,
	]
		.filter(Boolean)
		.join("\n\n")
		.slice(0, LIMITS.ask);
}

/**
 * The name a session gets when it starts the planner or runs the executor: `workflow-planner · <title>`.
 * Problem: the brand extension names a session from its first input and only when it has no name, so a name set here
 * would lose the readable title, and `/skill:planner` alone gives it nothing to read. Example: "/skill:planner build a
 * todo app" must show as "workflow-planner · build a todo app", not "workflow-planner" or "/skill:planner build…".
 * Solution: the prefix says the role, the title is the plan's slug, else the request after the command.
 */
export function workflowSessionName(text: string): { name: string; by: "planner" | "executor" } | undefined {
	const by = /^\/skill:planner\b|skills\/pre-build\/planner\b/i.test(text.trim())
		? "planner"
		: /^\/skill:executor\b|skills\/build\/executor\b|\bexecutor skill\b/i.test(text)
			? "executor"
			: undefined;
	if (!by) return undefined;
	const plan = /docs\/plans\/([\w.-]+?)\.md\b/.exec(text)?.[1];
	const title = plan ?? sessionTitle(text) ?? "session";
	return { name: `${WORKFLOW_PREFIX}${by} · ${title}`, by };
}

const WORKFLOW_PREFIX = "workflow-";

/** The run of the session asking: its tree in the journal, else the session alone (no hub). */
function ownRun(ctx: ExtensionContext): { records: SessionRecord[]; root: SessionRecord } {
	const records = readJournal(hubPaths(agentLinkHome()).sessions);
	const sessionId = ctx.sessionManager.getSessionId();
	const root =
		ownRoot(records, { sessionId, agent: process.env.AGENT_LINK_AGENT }) ??
		localRecord(sessionId, ctx.cwd, ctx.sessionManager.getSessionFile());
	return { records: records.some((r) => r.id === root.id) ? records : [...records, root], root };
}

/**
 * The package revision before this capture, if one is retained.
 * Problem: captureRunOutcome says `written` both for a first capture and a reopened revision. Example: a run resumes
 * after cleanup and gets a new delta, but the command says only "Saved". Solution: compare the stored revision around
 * the capture; the capture library still owns all capture semantics.
 */
function savedRevision(store: MemoryStore, runId: string): number | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(join(store.dir, "runs", runId, "run.json"), "utf8"));
		if (typeof value !== "object" || value === null || !Number.isSafeInteger(Reflect.get(value, "revision")))
			return undefined;
		return Number(Reflect.get(value, "revision"));
	} catch {
		return undefined;
	}
}

/**
 * The user's save result, without claiming a write for a discarded, deferred or legacy processed run.
 */
export function saveOutcomeText(
	runId: string,
	result: ReturnType<typeof captureRunOutcome>,
	priorRevision?: number,
	revision?: number,
	pending = 0,
): CommandResult {
	if (result.status === "written")
		return priorRevision !== undefined && revision !== undefined && revision > priorRevision
			? {
					level: "info",
					text: `Reopened run ${runId} as revision ${revision}; the new evidence is in the workflow memory (${pending} pending).`,
				}
			: { level: "info", text: `Captured run ${runId} in the workflow memory (${pending} pending).` };
	if (result.status === "processed")
		return { level: "info", text: `Run ${runId} is legacy processed; it was not recaptured. The flag is kept.` };
	if (result.status === "discarded")
		return { level: "info", text: `Run ${runId} was discarded: it was already cleaned and has no new evidence.` };
	if (result.status === "deferred")
		return { level: "warning", text: `Run ${runId} was deferred: ${result.reason}. The flag is kept.` };
	return { level: "warning", text: `Run ${runId} capture returned ${result.status}; no new capture was written.` };
}

function save(pi: ExtensionAPI, reason: string, ctx: ExtensionCommandContext): void {
	const store = openMemory(pihousePaths().memory);
	const { records, root } = ownRun(ctx);
	addFlag(store.dir, root.id, { reason: reason || undefined, by: "save" });
	const name = pi.getSessionName();
	if (!name?.startsWith(WORKFLOW_PREFIX))
		pi.setSessionName(`workflow-saved · ${name ?? (capTitle(reason, 48) || "chat")}`);
	const priorRevision = savedRevision(store, root.id);
	const result = captureRunOutcome(records, root, store, { by: "save", reason: reason || undefined });
	const outcome = saveOutcomeText(root.id, result, priorRevision, savedRevision(store, root.id), store.pendingCount());
	ctx.ui.notify(outcome.text, outcome.level);
}

function report(args: string[], ctx: ExtensionCommandContext): void {
	const records = readJournal(hubPaths(agentLinkHome()).sessions);
	const root = args.includes("--last")
		? pickRoot(records, {})
		: pickRoot(records, { sessionId: ctx.sessionManager.getSessionId(), agent: process.env.AGENT_LINK_AGENT });
	const run = root
		? buildRun(records, root)
		: buildRun([], localRecord(ctx.sessionManager.getSessionId(), ctx.cwd, ctx.sessionManager.getSessionFile()));
	const paths = pihousePaths();
	mkdirSync(paths.reports, { recursive: true });
	const file = join(paths.reports, reviewFileName(slugOf(run), new Date()));
	writeFileSync(file, `${renderReport(run)}\n`);
	ctx.ui.notify(`Workflow report: ${file}`, "info");
}

export type ProposalCommand = "proposals" | "approve" | "reject";

export interface ProposalDeps {
	/** The workflow memory folder; its memory.sqlite holds the proposals once the store is active. */
	memory: string;
	/** The checkout whose skills/ folder a skill proposal edits. */
	repoRoot: string;
}

export interface CommandResult {
	level: "info" | "warning";
	text: string;
}

const PROPOSAL_LIST_LIMIT = 50;
const NO_REASON = "No reason given";
const NOT_ACTIVE =
	"The proposal store is not active yet, so nothing changed. These commands never migrate the workflow memory.";
const PROPOSAL_USAGE: Record<Exclude<ProposalCommand, "proposals">, string> = {
	approve: "usage: /workflow approve <id> [version]",
	reject: "usage: /workflow reject <id> [reason]",
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the apply step checked beyond the target's own reads: a skill is checked for frontmatter and catalog, no model. */
const validationOf = (proposal: Proposal): string =>
	proposal.target.startsWith("skill:")
		? "frontmatter and catalog checks (no model or network)"
		: "the target's own checks";

/**
 * The target a proposal applies to. A target that cannot be built (a legacy hypothesis names "(new)") becomes one whose
 * reads fail with the reason, so the library records it as failed.
 * Problem: createProposalTarget throws for "(new)" before the library can record why the proposal cannot apply.
 * Example: `approve` on a legacy hypothesis must end as "failed: Legacy hypothesis ...", not as a crash.
 * Solution: the reason travels inside the target and the library stores it, as it does for every other failure.
 */
function targetFor(proposal: Proposal, deps: ProposalDeps): ScopedTarget {
	try {
		return createProposalTarget({
			repoRoot: deps.repoRoot,
			storeRoot: deps.memory,
			target: proposal.target,
			proposalId: proposal.id,
		});
	} catch (error) {
		const reason = messageOf(error);
		return {
			read: async () => {
				throw new Error(reason);
			},
			compareAndSwap: async () => false,
			validate: async () => false,
			failureReason: () => reason,
		};
	}
}

/** The result of an apply, said only when the state is applied and its receipt is recorded. */
function outcome(db: DatabaseSync, proposal: Proposal): CommandResult {
	if (proposal.state !== "applied")
		return {
			level: "warning",
			text: `Not applied: ${proposal.id} is ${proposal.state}${proposal.reason ? `: ${proposal.reason}` : ""}.`,
		};
	const receipt = db
		.prepare("SELECT 1 AS hit FROM receipts WHERE proposal_id = ? AND kind = 'application'")
		.get(proposal.id);
	if (!receipt)
		return {
			level: "warning",
			text: `${proposal.id} is marked applied but has no receipt; inspect it before retrying.`,
		};
	return {
		level: "info",
		text: `Applied ${proposal.id} to ${proposal.target}. Receipt recorded; checked: ${validationOf(proposal)}.`,
	};
}

/** A version prefix as typed: hex only, so a stray word is usage rather than a prefix that matches nothing. */
const VERSION_PREFIX = /^[0-9a-f]{1,64}$/i;

/** What changed since creation, in terms a person can check: the evidence count and how often it was revised. */
function revisedSummary(proposal: Proposal): string {
	const runs = new Set(proposal.evidence).size;
	const revisions = proposal.history?.length ?? 0;
	return `${runs} supporting run${runs === 1 ? "" : "s"}, revised ${revisions} time${revisions === 1 ? "" : "s"}`;
}

/**
 * Approves the displayed proposal, then applies it. An approved proposal is applied without a second approval; an
 * interrupted one (applying) is recovered to failed, so it is never applied twice.
 * Problem: approve read the proposal and pinned whatever version it found, so a run merged after `proposals` listed it
 * was approved unseen. Example: listed with 1 run; a second run merges in; `approve <id>` approves the 2-run version.
 * Solution: `approve <id> <version>` approves only the version the user saw. Without a version, only a proposal that was
 * never revised is approved, and the reply names the version; a revised one refuses and names the version to pass.
 */
async function approve(
	db: DatabaseSync,
	proposal: Proposal,
	deps: ProposalDeps,
	shown: string | undefined,
): Promise<CommandResult> {
	const target = targetFor(proposal, deps);
	if (proposal.state === "applying") return outcome(db, await recoverApplying(db, proposal.id, target));
	if (proposal.state !== "open" && proposal.state !== "approved")
		return {
			level: "warning",
			text: `${proposal.id} is ${proposal.state}; only open or approved proposals can be approved.`,
		};
	const current = shortVersion(proposal.version);
	if (shown !== undefined && !VERSION_PREFIX.test(shown)) return { level: "warning", text: PROPOSAL_USAGE.approve };
	if (shown !== undefined && !proposal.version.startsWith(shown.toLowerCase()))
		return {
			level: "warning",
			text: `${proposal.id} is now version ${current}, not ${shown}. Nothing was approved. It has ${revisedSummary(proposal)} since creation; review it, then run /workflow approve ${proposal.id} ${current}.`,
		};
	if (shown === undefined && proposal.state === "open" && proposal.history?.length)
		return {
			level: "warning",
			text: `${proposal.id} has changed since it was created (version ${current}, ${revisedSummary(proposal)}). Nothing was approved. Review it, then run /workflow approve ${proposal.id} ${current}.`,
		};
	const approvedNow = proposal.state === "open";
	if (approvedNow) approveProposal(db, proposal.id, proposal.version);
	const result = outcome(db, await applyProposal(db, proposal.id, target));
	return approvedNow ? { ...result, text: `${result.text} Approved version ${current}.` } : result;
}

/** The bounded list: one line per proposal, with the same fields for every state. */
function listText(db: DatabaseSync): string {
	const rows = listProposals(db, { limit: PROPOSAL_LIST_LIMIT });
	if (rows.length === 0) return "No proposals yet.";
	const lines = rows.map((row) => {
		const legacy = getProposal(db, row.id).before === "" ? " (legacy hypothesis: no verified before-state)" : "";
		const runs = `${row.supportingRuns} run${row.supportingRuns === 1 ? "" : "s"}`;
		return `${row.id.slice(0, 8)}  ${row.kind ?? "-"}  ${row.scope ?? "-"}  ${row.target}  ${row.state}${legacy}  version ${row.version}  ${runs}  next: ${row.nextAction}`;
	});
	if (rows.length === PROPOSAL_LIST_LIMIT) lines.push(`The first ${PROPOSAL_LIST_LIMIT} proposals are shown.`);
	return ["Proposals: id, kind, scope, target, state, version, supporting runs, next action", ...lines].join("\n");
}

/**
 * `/workflow proposals | approve <id> | reject <id> [reason]`: the proposal library over the activated store. No model
 * turn; it returns what to show and the handler notifies it.
 * Problem: a proposal printed as applied before its receipt exists would tell the user a change landed that did not.
 * Example: a crash after the file write but before the receipt insert. Solution: "Applied" is printed only when the
 * state is applied and its receipt row exists; anything else says "Not applied" with the stored reason.
 */
export async function proposalCommand(
	command: ProposalCommand,
	args: string[],
	deps: ProposalDeps,
): Promise<CommandResult> {
	const dbPath = join(deps.memory, "memory.sqlite");
	if (!existsSync(join(deps.memory, ACTIVE_MARKER)) || !existsSync(dbPath))
		return { level: "warning", text: NOT_ACTIVE };
	const store = openOperationalStore(dbPath, { fts: false, legacy: true });
	try {
		if (command === "proposals") return { level: "info", text: listText(store.db) };
		const [prefix = "", ...rest] = args;
		if (!prefix) return { level: "warning", text: PROPOSAL_USAGE[command] };
		if (command === "approve" && rest.length > 1) return { level: "warning", text: PROPOSAL_USAGE.approve };
		const found = resolveProposalId(store.db, prefix);
		if (found.status === "none")
			return { level: "warning", text: `No proposal matches "${prefix}". /workflow proposals lists them.` };
		if (found.status === "ambiguous")
			return { level: "warning", text: `"${prefix}" matches ${found.matches.join(", ")}. Use a longer prefix.` };
		if (command === "reject") {
			const rejected = rejectProposal(store.db, found.proposal.id, rest.join(" ").trim() || NO_REASON);
			return { level: "info", text: `Rejected ${rejected.id}: ${rejected.reason}.` };
		}
		return await approve(store.db, found.proposal, deps, rest[0]);
	} catch (error) {
		return { level: "warning", text: messageOf(error) };
	} finally {
		store.close();
	}
}

/**
 * Whether a model id resolves in pi's registry with configured auth. The learning children are only started when it does.
 * Problem: the registry knows models that have no key, and a child started for one stalls in its pane. Example: a
 * provider that was never signed in. Solution: the same check the status bar's model uses, before anything starts.
 */
function modelAvailable(ctx: ExtensionCommandContext, model: string): boolean {
	const slash = model.indexOf("/");
	if (slash <= 0) return false;
	const found = ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1));
	return found !== undefined && ctx.modelRegistry.hasConfiguredAuth(found);
}

/** `/workflow digest` and `/workflow self-learning`: the learning runtime with the session's hub, pane backend and models. */
async function learning(
	ctx: ExtensionCommandContext,
	name: string,
	run: (deps: LearningDeps) => Promise<LearningOutcome>,
): Promise<void> {
	const paths = pihousePaths();
	const deps: LearningDeps = {
		memory: paths.memory,
		journalDir: hubPaths(agentLinkHome()).sessions,
		env: process.env,
		cwd: ctx.cwd,
		backend: readConfig(paths)?.backend,
		modelAvailable: (model) => modelAvailable(ctx, model),
		progress: (text) => ctx.ui.notify(text, "info"),
	};
	try {
		const result = await run(deps);
		ctx.ui.notify(result.text, result.level);
	} catch (error) {
		ctx.ui.notify(`/workflow ${name}: ${messageOf(error)}`, "warning");
	}
}

async function runProposalCommand(
	command: ProposalCommand,
	args: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		const result = await proposalCommand(command, args, { memory: pihousePaths().memory, repoRoot: REPO_ROOT });
		ctx.ui.notify(result.text, result.level);
	} catch (error) {
		ctx.ui.notify(`/workflow ${command}: ${messageOf(error)}`, "warning");
	}
}

const slugOf = (run: WorkflowRun) =>
	(run.plan?.split("/").pop()?.replace(/\.md$/, "") ?? run.root.name).replace(/[^\w-]+/g, "-");

export default function workflow(pi: ExtensionAPI): void {
	// Planner and executor sessions are flagged by name and captured by default (spec: Flags). The flag is written at
	// the first input, when the run is surely in the journal; the capture follows each answer while the run is pending.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		const named = workflowSessionName(event.text);
		if (!named) return;
		try {
			if (!pi.getSessionName()?.startsWith(WORKFLOW_PREFIX)) pi.setSessionName(named.name);
			addFlag(pihousePaths().memory, ownRun(ctx).root.id, { by: named.by });
		} catch {
			// Flagging must never block the user's prompt.
		}
	});
	pi.on("agent_end", (_event, ctx) => {
		try {
			const store = openMemory(pihousePaths().memory);
			const { records, root } = ownRun(ctx);
			const flag = isFlagged(records, root, readFlags(store.dir));
			if (flag) captureRun(records, root, store, flag);
		} catch {
			// A failed capture is retried by the sweep.
		}
	});
	pi.registerCommand("workflow", {
		description:
			"report [--last]: what the last run did · save [reason] · digest (launches a separate model agent; costs model quota) · self-learning (launches digest, scan and review agents; costs model quota) · ask <question> · proposals · approve <id> [version] · reject <id> [reason]",
		getArgumentCompletions: (prefix) =>
			WORKFLOW_COMMANDS.flatMap((c) => [...c.completions])
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c })),
		handler: async (raw, ctx) => {
			const [sub, ...rest] = raw.trim().split(/\s+/);
			if (sub === "report") return report(rest, ctx);
			if (sub === "review") return ctx.ui.notify(REVIEW_REMOVED, "warning");
			if (sub === "save") return save(pi, rest.join(" ").trim(), ctx);
			if (sub === "proposals" || sub === "approve" || sub === "reject") return runProposalCommand(sub, rest, ctx);
			if (sub === "digest") return learning(ctx, sub, digestCommand);
			if (sub === "self-learning") return learning(ctx, sub, selfLearningCommand);
			if (sub === "ask" && rest.join(" ").trim()) {
				pi.sendMessage(
					{ customType: MESSAGE_TYPE, content: await askContext(rest.join(" ").trim()), display: false },
					{ triggerTurn: true },
				);
				return;
			}
			ctx.ui.notify(USAGE, "warning");
		},
	});
	// The keeper's command is gone with its extension; this stub only says so, so `/keeper` cannot reach a model.
	pi.registerCommand("keeper", {
		description: "retired: /workflow proposals, approve and reject",
		handler: async (_raw, ctx) => ctx.ui.notify(KEEPER_RETIRED, "warning"),
	});
}
