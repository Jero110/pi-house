// The digest engine of the keeper: turns a batch of pending runs into digests, a new workflow memory and proposals.
// Pure in the sense that matters: it takes the store and an injected `complete(prompt) => Promise<string>`, so no
// model, extension or network is needed to run it. The keeper extension wires the real model in.
// Spec: docs/specs/workflow-memory.md, "The keeper (T6)"; choices: ADR-001 (D1, D8).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Transcript } from "agent-transcripts";
import type { Catalog } from "./catalog.ts";
import {
	type IndexEntry,
	LIMITS,
	type MemoryStore,
	type Proposal,
	type ProposalKind,
	parseFrontmatter,
	proposalFingerprint,
	type RunPackage,
} from "./memory.ts";

/** One nested model call: a prompt in, text out. */
export type Complete = (prompt: string) => Promise<string>;

/** Runs per digest batch; more stay pending and the summary says how many. */
export const BATCH_SIZE = 10;
/** "Unused" means: not loaded or named in this many processed runs. */
export const UNUSED_RUNS = 10;
/** Archived raw copies and unused entries wait this long. */
export const STALE_DAYS = 90;
const DAY_MS = 86_400_000;
/** Skills the memory itself depends on are never proposed for removal for being unused in flagged runs. */
const KEPT_SKILLS = new Set(["keeper", "executor", "planner"]);
const PROPOSAL_KINDS: readonly ProposalKind[] = [
	"memory-rule",
	"edit-skill",
	"remove-skill",
	"remove-idea",
	"delete-raw",
];
const MESSAGE_CHARS = 400;

/** Cuts text to `max` chars, saying so. */
export function cap(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 20))}\n[cut: ${text.length - max + 20} chars]`;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) =>
	flat(text).length <= max ? flat(text) : `${flat(text).slice(0, max - 1)}…`;

/**
 * A transcript as lines built by code: each message's text cut to 400 chars, tool names and failures, skills.
 * Problem: a long run is megabytes of tool output and a model call over all of it would cost a fortune and not fit.
 * Example: a 2 MB transcript of 4,000 messages against a 60,000-char input. Solution: one line per message, and when
 * the lines are still over the budget, the start and the end are kept and the middle is counted, not shown.
 */
export function condenseTranscript(t: Transcript, budget: number): string {
	const lines = t.messages.map((m) => {
		const tools = m.tools.length
			? ` [tools: ${m.tools.map((x) => (x.ok === false ? `${x.name} FAILED` : x.name)).join(", ")}]`
			: "";
		const skills = m.skills.length ? ` [skills: ${m.skills.join(", ")}]` : "";
		const who = m.role === "user" ? (m.origin === "agent" ? "agent" : "user") : "assistant";
		return `#${m.index} ${who}: ${clip(m.text, MESSAGE_CHARS)}${tools}${skills}`;
	});
	const all = lines.join("\n");
	if (all.length <= budget) return all;
	const half = Math.floor(budget / 2) - 60;
	let head = 0;
	let headLen = 0;
	while (head < lines.length && headLen + lines[head].length + 1 <= half) headLen += lines[head++].length + 1;
	let tail = lines.length;
	let tailLen = 0;
	while (tail > head && tailLen + lines[tail - 1].length + 1 <= half) tailLen += lines[--tail].length + 1;
	return [...lines.slice(0, head), `[... ${tail - head} messages left out ...]`, ...lines.slice(tail)].join("\n");
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

const runDir = (store: MemoryStore, runId: string) => join(store.dir, "runs", runId);

/**
 * The prompt that digests one run: the one full read of it. The report plus a condensed view of every agent's
 * transcript, the whole thing under LIMITS.digestInput.
 */
export function digestPrompt(store: MemoryStore, runId: string): string {
	const dir = runDir(store, runId);
	const pkg = readJson<RunPackage>(join(dir, "run.json"));
	const intro = [
		"You are the keeper of a developer's workflow memory. Digest ONE captured workflow run.",
		`Write the digest in Markdown, at most ${LIMITS.digest - 200} characters: a first line "summary: <one line, at most 160 chars>",`,
		"then what ran, what worked, what did not, and the evidence (agent name and message #). Plain text, no preamble.",
		"",
		`# Run ${runId}${pkg ? `: ${pkg.title}` : ""}`,
		pkg?.reason ? `Why the user saved it: ${pkg.reason}` : "",
	]
		.filter(Boolean)
		.join("\n");
	const reportFile = join(dir, "report.md");
	const report = existsSync(reportFile) ? cap(readFileSync(reportFile, "utf8"), 15_000) : "(no report)";
	const head = `${intro}\n\n## Report (computed)\n\n${report}\n`;
	const agents = pkg?.agents ?? [];
	let room = LIMITS.digestInput - head.length - 200;
	const parts: string[] = [];
	for (const [i, a] of agents.entries()) {
		if (!a.transcript) {
			parts.push(`## Agent ${a.name} (${a.role}): ${a.missing ?? "no transcript"}`);
			continue;
		}
		const t = readJson<Transcript>(join(dir, a.transcript));
		if (!t) continue;
		const share = Math.max(500, Math.floor(room / Math.max(1, agents.length - i)));
		const body = condenseTranscript(t, share - 120);
		const part = `## Agent ${a.name} (${a.role}, ${a.harness})\n${body}`;
		parts.push(part);
		room -= part.length;
	}
	return cap(`${head}\n${parts.join("\n\n")}\n`, LIMITS.digestInput);
}

interface ProposalLine {
	id: string;
	status: string;
	title: string;
}

/** Open and rejected proposals as titles only: enough to avoid asking for the same thing twice. */
function proposalTitles(store: MemoryStore): ProposalLine[] {
	return store
		.readIndex()
		.filter((e) => e.kind === "proposal" && (e.status === "open" || e.status === "rejected"))
		.map((e) => ({ id: e.id, status: e.status, title: e.title }))
		.slice(-40);
}

/**
 * The prompt of the consolidation call: the batch's digests, the current workflow memory, which skills were used, and
 * the titles of the proposals already open or rejected. Never a transcript.
 */
export function consolidationPrompt(store: MemoryStore, runIds: string[]): string {
	const digests = runIds.map((id) => `### ${id}\n${store.readDigest(id) ?? "(no digest)"}`).join("\n\n");
	const use = Object.entries(store.skillUse(UNUSED_RUNS))
		.map(([n, c]) => `${n}: ${c}`)
		.join(", ");
	const titles = proposalTitles(store)
		.map((p) => `- ${p.status}: ${clip(p.title, 120)}`)
		.join("\n");
	return cap(
		[
			"You are the keeper of a developer's workflow memory. Consolidate this batch of run digests.",
			"Answer with ONE fenced ```json block of this shape and nothing else:",
			'{"memory": "<the new workflow-memory.md, at most 8000 chars: how the user works, what works, what does not>",',
			' "summary": "<the batch summary for the user, a few lines>",',
			' "proposals": [{"kind": "memory-rule|edit-skill|remove-skill|remove-idea", "target": "...", "change": "...", "evidence": "..."}]}',
			"A memory-rule proposal: target is the exact existing line to change or drop, or (new) to add a line; change is",
			"the new line, or (drop). Propose only what the digests support. Do not repeat the proposals listed below.",
			"",
			"## Current workflow memory",
			store.readWorkflowMemory() || "(empty)",
			"",
			`## Skills loaded or named in the last ${UNUSED_RUNS} processed runs (runs per skill)`,
			use || "(none yet)",
			"",
			"## Proposals already open or rejected",
			titles || "(none)",
			"",
			"## Digests of this batch",
			digests,
		].join("\n"),
		LIMITS.consolidationInput,
	);
}

export interface Consolidation {
	memory: string;
	summary: string;
	proposals: Array<Pick<Proposal, "kind" | "target" | "change" | "evidence">>;
}

/** Reads the fenced JSON block (or bare JSON) of the consolidation answer; throws when it is not usable. */
export function parseConsolidation(text: string): Consolidation {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
	const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		throw new Error("The consolidation answer has no JSON block");
	}
	const o = v as { memory?: unknown; summary?: unknown; proposals?: unknown };
	if (typeof o.memory !== "string" || typeof o.summary !== "string")
		throw new Error("The consolidation answer needs memory and summary");
	const proposals = (Array.isArray(o.proposals) ? o.proposals : []).flatMap((p) => {
		const x = p as Record<string, unknown>;
		const kind = x.kind as ProposalKind;
		if (!PROPOSAL_KINDS.includes(kind) || typeof x.target !== "string" || typeof x.change !== "string") return [];
		return [{ kind, target: x.target, change: x.change, evidence: typeof x.evidence === "string" ? x.evidence : "" }];
	});
	return { memory: o.memory, summary: o.summary, proposals };
}

export interface DigestResult {
	batchId: string;
	runIds: string[];
	/** Runs left pending because the batch is capped. */
	remaining: number;
	summary: string;
	/** Proposals created by this digest (model and mechanical), not those blocked as duplicates or rejected before. */
	proposals: Array<{ id: string; kind: ProposalKind; title: string }>;
	blocked: number;
	archived: string[];
}

export interface DigestDeps {
	store: MemoryStore;
	complete: Complete;
	catalog: Catalog;
	now?: () => Date;
}

/** Where a run's raw transcripts go once digested. */
const rawArchive = (store: MemoryStore, runId: string) => join(store.dir, "archive", "raw", runId);

/**
 * Moves a digested run's transcripts out of runs/. Problem: archive/runs/<id> is where archiving the run entry
 * itself puts it, and renaming a folder onto a non-empty one fails; example: a run unused for 90 days after its
 * digest. Solution: the transcripts go to archive/raw/<id>, so the two never meet.
 */
function archiveRaw(store: MemoryStore, runId: string): void {
	const from = join(runDir(store, runId), "transcripts");
	if (!existsSync(from)) return;
	const to = join(rawArchive(store, runId), "transcripts");
	rmSync(to, { recursive: true, force: true });
	mkdirSync(dirname(to), { recursive: true });
	renameSync(from, to);
}

type NewProposal = { id: string; kind: ProposalKind; title: string };

/**
 * Proposals the store would accept again. Problem: the store blocks open, approved and rejected fingerprints, but an
 * applied one is none of those; example: the user approved "- prefers small commits", it was applied, and the next
 * consolidation proposes the line it just added. Solution: an applied fingerprint blocks too.
 */
function addProposals(store: MemoryStore, list: Proposal[], into: NewProposal[]): number {
	let blocked = 0;
	const applied = new Set(
		store
			.readIndex()
			.filter((e) => e.kind === "proposal" && e.status === "applied" && e.fingerprint)
			.map((e) => e.fingerprint),
	);
	for (const p of list) {
		if (applied.has(proposalFingerprint(p))) {
			blocked++;
			continue;
		}
		const r = store.propose(p);
		if (r.result === "created") into.push({ id: r.id, kind: p.kind, title: p.title ?? `${p.kind}: ${p.target}` });
		else blocked++;
	}
	return blocked;
}

/** Processed runs, newest first. */
function processedRuns(store: MemoryStore): IndexEntry[] {
	return store
		.readIndex()
		.filter((e) => e.kind === "run" && e.status === "processed")
		.sort((a, b) => (b.processedAt ?? b.createdAt).localeCompare(a.processedAt ?? a.createdAt));
}

/**
 * Proposals made by code from facts, not by a model: `remove-skill` for catalog skills no recent run used,
 * `remove-idea` for ideas nobody touched in that time, `delete-raw` for raw copies archived over 90 days ago.
 * Problem: "unused" decided by a model drifts. Example: a skill nobody loaded in 12 runs stays forever because the
 * digests never mention it. Solution: count it in run.json, and only once 10 runs are processed.
 */
export function mechanicalProposals(store: MemoryStore, catalog: Catalog, now: Date): Proposal[] {
	const out: Proposal[] = [];
	const processed = processedRuns(store);
	if (processed.length >= UNUSED_RUNS) {
		const use = store.skillUse(UNUSED_RUNS);
		for (const s of catalog.skills) {
			if ((s.group !== "build" && s.group !== "extras") || KEPT_SKILLS.has(s.name) || use[s.name]) continue;
			out.push({
				kind: "remove-skill",
				target: s.name,
				change: `Remove the skill ${s.name} from skills/${s.group}/ and the catalog.`,
				evidence: `Not loaded or named by any of the last ${UNUSED_RUNS} processed runs.`,
				title: `remove-skill: ${s.name}`,
			});
		}
		const since = processed[UNUSED_RUNS - 1].processedAt ?? processed[UNUSED_RUNS - 1].createdAt;
		for (const e of store.readIndex()) {
			if (e.kind !== "idea" || e.status === "archived" || e.lastUsedAt >= since) continue;
			out.push({
				kind: "remove-idea",
				target: e.id,
				change: `Archive the idea ${e.title}.`,
				evidence: `Not used since ${e.lastUsedAt}, before the last ${UNUSED_RUNS} processed runs.`,
				title: `remove-idea: ${e.title}`,
			});
		}
	}
	// Archived runs count too: archiving the package after 90 days of no use leaves the raw copies behind.
	const digested = store.readIndex().filter((e) => e.kind === "run" && e.processedAt !== undefined);
	for (const e of digested) {
		const id = e.id.slice("run:".length);
		const at = Date.parse(e.processedAt ?? e.createdAt);
		if (existsSync(rawArchive(store, id)) && now.getTime() - at > STALE_DAYS * DAY_MS)
			out.push({
				kind: "delete-raw",
				target: id,
				change: `Delete the raw transcript copies of run ${id}.`,
				evidence: `Archived on ${new Date(at).toISOString().slice(0, 10)}, over ${STALE_DAYS} days ago; the digest stays.`,
				title: `delete-raw: ${e.title}`,
			});
	}
	return out;
}

/** The pruning rules: archive what is unused for 90 days (never delete), then the code-made proposals. */
export function prune(deps: Pick<DigestDeps, "store" | "catalog" | "now">): {
	archived: string[];
	proposed: NewProposal[];
	blocked: number;
} {
	const now = deps.now?.() ?? new Date();
	const archived = deps.store.archiveStale({ days: STALE_DAYS });
	const proposed: NewProposal[] = [];
	const blocked = addProposals(deps.store, mechanicalProposals(deps.store, deps.catalog, now), proposed);
	return { archived, proposed, blocked };
}

/**
 * Digests the pending batch: one model call per run (its one full read), one consolidation call, then everything
 * is written; only after every write the batch is marked processed and the raw copies archived.
 * Problem: a model call failing half way must not lose or double-read runs. Example: run 2 of 3 fails. Solution: the
 * batch stays claimed; digests already written are kept, so the next call resumes and the finished runs are not read
 * again. Returns undefined when nothing is pending.
 */
export async function digestPending(deps: DigestDeps): Promise<DigestResult | undefined> {
	const { store, complete } = deps;
	const resumed = store.claimedBatches()[0];
	const batch =
		resumed ??
		store.claimBatch(
			store
				.pending()
				.slice(0, BATCH_SIZE)
				.map((e) => e.id.slice("run:".length)),
		);
	if (!batch) return undefined;
	const inBatch = new Set(batch.runIds);
	const remaining = store.pending().filter((e) => !inBatch.has(e.id.slice("run:".length))).length;

	for (const runId of batch.runIds) {
		if (store.readDigest(runId) !== null) continue;
		const text = (await complete(digestPrompt(store, runId))).trim();
		if (!text) throw new Error(`The model returned an empty digest for run ${runId}`);
		store.writeDigest(runId, cap(text, LIMITS.digest));
	}

	const consolidation = parseConsolidation(await complete(consolidationPrompt(store, batch.runIds)));
	store.writeWorkflowMemory(consolidation.memory);
	const created: NewProposal[] = [];
	let blocked = addProposals(
		store,
		consolidation.proposals.map((p) => ({
			...p,
			title: `${p.kind}: ${clip(p.target === "(new)" ? p.change : p.target, 80)}`,
		})),
		created,
	);

	// Every write above worked: the batch can be closed for good.
	store.markProcessed(batch.runIds, batch.id);
	for (const runId of batch.runIds) archiveRaw(store, runId);
	const pruned = prune(deps);
	created.push(...pruned.proposed);
	blocked += pruned.blocked;
	const more = remaining
		? `\n\n${remaining} more run${remaining === 1 ? " is" : "s are"} pending; summarize again for the next batch.`
		: "";
	const summary = `${consolidation.summary.trim()}${more}`;
	store.finishBatch(batch.id, summary);
	store.touch(batch.runIds.flatMap((id) => [`run:${id}`, `digest:${id}`]));
	return {
		batchId: batch.id,
		runIds: batch.runIds,
		remaining,
		summary,
		proposals: created,
		blocked,
		archived: pruned.archived,
	};
}

export interface ProposalRecord {
	id: string;
	kind: ProposalKind;
	target: string;
	change: string;
	status: string;
	title: string;
	path: string;
}

/** Reads a proposal back from its Markdown file. */
export function readProposal(store: MemoryStore, id: string): ProposalRecord | undefined {
	const bare = id.startsWith("proposal:") ? id.slice("proposal:".length) : id;
	const entry = store.readIndex().find((e) => e.id === `proposal:${bare}`);
	if (!entry) return undefined;
	const file = join(store.dir, entry.path);
	if (!existsSync(file)) return undefined;
	const { fields, body } = parseFrontmatter(readFileSync(file, "utf8"));
	const change = /## Change\n\n([\s\S]*?)\n\n## Evidence/.exec(body)?.[1] ?? body;
	return {
		id: bare,
		kind: fields.kind as ProposalKind,
		target: fields.target ?? "",
		change,
		status: entry.status,
		title: entry.title,
		path: file,
	};
}

/** Open proposals, oldest first. */
export function openProposals(store: MemoryStore): IndexEntry[] {
	return store
		.readIndex()
		.filter((e) => e.kind === "proposal" && e.status === "open")
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A `memory-rule` applied to the workflow memory text: add a line, change one, or drop one. */
export function applyMemoryRule(memory: string, target: string, change: string): string {
	const lines = memory.split("\n");
	if (target === "(new)") return `${memory.replace(/\s+$/, "")}${memory.trim() ? "\n" : ""}${change.trim()}\n`;
	const i = lines.findIndex((l) => l.trim() === target.trim());
	if (i < 0) throw new Error(`The memory has no line "${clip(target, 60)}"; reject this proposal or propose it again`);
	if (change.trim() === "(drop)") lines.splice(i, 1);
	else lines[i] = change.trim();
	return lines.join("\n");
}

export type ApplyResult =
	| { applied: true; note: string }
	/** The keeper's model must make the change (a skill file); code marks it applied afterwards. */
	| { applied: false; instruction: string };

/**
 * Applies an approved proposal. Code does memory rules, idea removal and raw deletion; skill changes are left to
 * the model, which gets the instruction. Deleting is the one irreversible step, so it exists only here, behind an
 * approved `delete-raw`, and touches nothing but that run's archived transcripts.
 */
export function applyProposal(store: MemoryStore, p: ProposalRecord): ApplyResult {
	if (p.status !== "approved") throw new Error(`Proposal ${p.id} is ${p.status}, not approved`);
	switch (p.kind) {
		case "memory-rule":
			store.writeWorkflowMemory(applyMemoryRule(store.readWorkflowMemory(), p.target, p.change));
			store.markApplied(p.id);
			return { applied: true, note: "workflow-memory.md updated" };
		case "remove-idea":
			store.archive(p.target);
			store.markApplied(p.id);
			return { applied: true, note: `${p.target} archived` };
		case "delete-raw":
			rmSync(rawArchive(store, p.target), { recursive: true, force: true });
			store.markApplied(p.id);
			return { applied: true, note: `raw copies of run ${p.target} deleted` };
		case "edit-skill":
		case "remove-skill":
			return {
				applied: false,
				instruction: [
					`The user approved proposal ${p.id} (${p.kind}) for ${p.target}:`,
					p.change,
					p.kind === "remove-skill"
						? "Remove the skill's folder and its entry in skills/catalog.json, then run npm run skills in the pihouse repository."
						: "Make the change in that skill's SKILL.md. If the catalog changes, run npm run skills in the pihouse repository.",
					"Edit nothing else.",
				].join("\n"),
			};
	}
}
