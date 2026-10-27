// The workflow memory store: the one module through which everything reads and writes <home>/memory.
// Layout and API: docs/specs/workflow-memory.md, "Memory location and layout (T3)"; choices: ADR-001 (D3, D4).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ACTIVE_MARKER } from "./migration.ts";
import { openOperationalStore } from "./storage.ts";

/** Size limits in chars (about chars/4 tokens), in one place; tests hold the engine to them. */
export const LIMITS = {
	keeperBootstrap: 24_000,
	digestInput: 60_000,
	consolidationInput: 60_000,
	ask: 80_000,
	workflowMemory: 8_000,
	digest: 2_000,
	/** An index entry's one-line summary. */
	summary: 200,
} as const;

export type EntryKind = "run" | "digest" | "consulted" | "idea" | "proposal" | "batch";
export type EntryStatus =
	| "pending"
	| "processed"
	| "open"
	| "approved"
	| "rejected"
	| "applied"
	| "active"
	| "archived";
export type ProposalKind = "memory-rule" | "edit-skill" | "remove-skill" | "remove-idea" | "delete-raw";

export interface RunAgentEntry {
	id: string;
	name: string;
	parent: string | null;
	role: "planner" | "executor" | "worker" | "helper" | "root";
	harness: string;
	model: string;
	taskId?: string;
	taskTitle?: string;
	assignedSkills: string[];
	loadedSkills: string[];
	usage: Record<string, unknown>;
	activeMs: number;
	messages: number;
	/** Relative to runs/<id>/, e.g. transcripts/<agentId>.json. */
	transcript: string;
	raw: string | null;
	/** Why there is no transcript, else null. */
	missing: string | null;
}

export interface RunPackage {
	schema: 1;
	id: string;
	project: string;
	projectSlug: string;
	flaggedBy: "planner" | "executor" | "save";
	reason?: string;
	capturedAt: string;
	plan?: string;
	title: string;
	metrics: { newTokens: number; cacheRead: number; activeMs: number; wallMs: number; agents: number; messages: number };
	agents: RunAgentEntry[];
}

export interface IndexEntry {
	id: string;
	kind: EntryKind;
	project: string;
	projectSlug: string;
	title: string;
	summary: string;
	status: EntryStatus;
	/** Relative to the memory dir. */
	path: string;
	createdAt: string;
	lastUsedAt: string;
	supersededBy?: string;
	/** Proposals only. */
	fingerprint?: string;
	/** Runs: the batch that processed them, and when. */
	batchId?: string;
	processedAt?: string;
}

export interface Proposal {
	kind: ProposalKind;
	/** What it changes: a skill name, an entry id, a memory line. */
	target: string;
	change: string;
	evidence: string;
	project?: string;
	projectSlug?: string;
	title?: string;
}

export interface RunTranscript {
	agentId: string;
	/** The normalized transcript (agent-transcripts shape), always. */
	normalized: unknown;
	/** The harness's own file, when it is a file. */
	raw?: string | Uint8Array | null;
}

/** What a source or idea entry is about; `id` names the file. */
export interface NoteMeta {
	id: string;
	title: string;
	project: string;
	projectSlug: string;
	/** consulted: the link or path the user sent. */
	source?: string;
}

export interface BatchRecord {
	schema: 1;
	id: string;
	runIds: string[];
	state: "claimed" | "done";
	claimedAt: string;
	summaryPath?: string;
}

export type ProposeResult =
	| { result: "created"; id: string; fingerprint: string }
	| { result: "duplicate"; id: string; fingerprint: string }
	| { result: "rejected-before"; fingerprint: string };

export interface SliceOptions {
	project?: string;
	kinds?: EntryKind[];
	limit: number;
	maxChars: number;
}

export interface MemoryStore {
	readonly dir: string;
	writeRun(pkg: RunPackage, transcripts: RunTranscript[], report?: string): "written" | "processed";
	pending(): IndexEntry[];
	pendingCount(): number;
	markProcessed(runIds: string[], batchId: string): void;
	writeDigest(runId: string, markdown: string): IndexEntry;
	readDigest(runId: string): string | null;
	claimBatch(runIds: string[]): BatchRecord | null;
	claimedBatches(): BatchRecord[];
	finishBatch(batchId: string, summaryMarkdown: string): BatchRecord;
	writeConsulted(meta: NoteMeta, text: string, summary: string): IndexEntry;
	writeIdea(meta: NoteMeta, body: string, summary?: string): IndexEntry;
	/** Indexes the ideas/*.md files written by hand (by a model) that index.json does not list yet; returns their ids. */
	adoptIdeas(): string[];
	propose(p: Proposal): ProposeResult;
	decide(id: string, decision: "approved" | "rejected", why?: string): IndexEntry;
	markApplied(id: string): IndexEntry;
	readWorkflowMemory(): string;
	writeWorkflowMemory(markdown: string): void;
	readIndex(): IndexEntry[];
	indexSlice(opts: SliceOptions): string;
	touch(ids: string[]): void;
	archive(id: string): IndexEntry | null;
	archiveStale(opts?: { days?: number }): string[];
	deleteArchived(ids: string[]): string[];
	skillUse(lastN: number): Record<string, number>;
}

interface IndexFile {
	schema: 1;
	entries: IndexEntry[];
	/**
	 * Fingerprints of rejected proposals, kept apart from the entries. Problem: archiving a rejected proposal sets its
	 * status to "archived", and "rejected" is lost; example: the user rejects a rule, 90 days pass, the keeper proposes
	 * it again. Solution: the fingerprint list is never touched by archiving.
	 */
	rejected: string[];
}

const DAY_MS = 86_400_000;
/** Ids become folder and file names; this keeps them inside the memory dir. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeId(id: string): string {
	if (!SAFE_ID.test(id)) throw new Error(`Unsafe memory id: ${JSON.stringify(id)}`);
	return id;
}

/** Write `<file>.tmp`, then rename: a crash leaves the old file or the new one, never half of one. */
function atomicWrite(file: string, data: string | Uint8Array): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, file);
}

function writeJson(file: string, value: unknown): void {
	atomicWrite(file, `${JSON.stringify(value, null, "\t")}\n`);
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** `key: value` lines between `---` markers; values are one line (newlines become spaces). */
export function renderFrontmatter(fields: Record<string, string | undefined>, body: string): string {
	const lines = Object.entries(fields)
		.filter((e): e is [string, string] => e[1] !== undefined)
		.map(([k, v]) => `${k}: ${v.replace(/\s*\n\s*/g, " ")}`);
	return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

export function parseFrontmatter(md: string): { fields: Record<string, string>; body: string } {
	const m = /^---\n([\s\S]*?)\n---\n?\n?([\s\S]*)$/.exec(md);
	if (!m) return { fields: {}, body: md };
	const fields: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { fields, body: m[2] };
}

/** Same change in different case or spacing must give the same fingerprint. */
export function proposalFingerprint(p: Pick<Proposal, "kind" | "target" | "change">): string {
	const normalized = p.change.toLowerCase().replace(/\s+/g, " ").trim();
	return createHash("sha256").update(`${p.kind}\n${p.target}\n${normalized}`).digest("hex");
}

export function openMemory(dir: string, opts: { now?: () => Date } = {}): MemoryStore {
	const now = opts.now ?? (() => new Date());
	const stamp = () => now().toISOString();
	const abs = (rel: string) => join(dir, rel);
	const indexFile = abs("index.json");

	/**
	 * Problem: load() then save() on index.json loses one of two concurrent updates; example: two panes add an idea at
	 * once. Solution: after a migration the index lives in memory.sqlite and every store call is one BEGIN IMMEDIATE.
	 * A corrupt or missing database is an error, never an empty memory and never a fallback to the JSON backup.
	 */
	const db = existsSync(abs(ACTIVE_MARKER)) ? openActiveDatabase(abs("memory.sqlite")) : null;
	const load = (): IndexFile => {
		if (db) {
			const rows = db.prepare("SELECT payload FROM index_entries ORDER BY seq").all() as { payload: string }[];
			const rej = db.prepare("SELECT fingerprint FROM rejected_fingerprints ORDER BY rowid").all() as {
				fingerprint: string;
			}[];
			return {
				schema: 1,
				entries: rows.map((r) => JSON.parse(r.payload) as IndexEntry),
				rejected: rej.map((r) => r.fingerprint),
			};
		}
		const f = readJson<Partial<IndexFile>>(indexFile);
		return { schema: 1, entries: f?.entries ?? [], rejected: f?.rejected ?? [] };
	};
	const save = (f: IndexFile) => {
		if (!db) return writeJson(indexFile, f);
		db.exec("DELETE FROM index_entries; DELETE FROM rejected_fingerprints;");
		const ins = db.prepare("INSERT INTO index_entries(id, seq, payload) VALUES (?, ?, ?)");
		f.entries.forEach((e, i) => {
			ins.run(e.id, i, JSON.stringify(e));
		});
		const rej = db.prepare("INSERT OR IGNORE INTO rejected_fingerprints(fingerprint) VALUES (?)");
		for (const fp of f.rejected) rej.run(fp);
	};
	/** Insert or replace by id. */
	const upsert = (entry: IndexEntry): IndexEntry => {
		const f = load();
		const i = f.entries.findIndex((e) => e.id === entry.id);
		if (i >= 0) f.entries[i] = entry;
		else f.entries.push(entry);
		save(f);
		return entry;
	};
	const mutate = (id: string, fn: (e: IndexEntry) => void): IndexEntry => {
		const f = load();
		const entry = f.entries.find((e) => e.id === id);
		if (!entry) throw new Error(`No memory entry ${id}`);
		fn(entry);
		save(f);
		return entry;
	};
	const baseEntry = (
		kind: EntryKind,
		id: string,
		meta: { project: string; projectSlug: string; title: string; summary: string },
		path: string,
		status: EntryStatus,
	): IndexEntry => ({
		id: `${kind}:${id}`,
		kind,
		project: meta.project,
		projectSlug: meta.projectSlug,
		title: oneLine(meta.title, 120),
		summary: oneLine(meta.summary, LIMITS.summary),
		status,
		path,
		createdAt: stamp(),
		lastUsedAt: stamp(),
	});
	const batchFile = (id: string) => abs(`batches/${safeId(id)}.json`);
	const readBatch = (id: string) => readJson<BatchRecord>(batchFile(id));
	const allBatches = (): BatchRecord[] => {
		const folder = abs("batches");
		if (!existsSync(folder)) return [];
		return readdirSync(folder)
			.filter((n) => n.endsWith(".json"))
			.map((n) => readJson<BatchRecord>(join(folder, n)))
			.filter((b): b is BatchRecord => b !== null)
			.sort((a, b) => a.claimedAt.localeCompare(b.claimedAt));
	};
	const proposalId = (id: string) => (id.startsWith("proposal:") ? id.slice("proposal:".length) : id);
	/** Rewrite a proposal's frontmatter next to its index entry. */
	const setProposalFields = (
		id: string,
		status: EntryStatus,
		extra: Record<string, string | undefined> = {},
	): IndexEntry => {
		const entry = mutate(`proposal:${proposalId(id)}`, (e) => {
			e.status = status;
			e.lastUsedAt = stamp();
		});
		const file = abs(entry.path);
		if (existsSync(file)) {
			const { fields, body } = parseFrontmatter(readFileSync(file, "utf8"));
			atomicWrite(file, renderFrontmatter({ ...fields, status, ...extra }, body));
		}
		return entry;
	};

	const store: MemoryStore = {
		dir,

		writeRun(pkg, transcripts, report) {
			const id = safeId(pkg.id);
			const existing = load().entries.find((e) => e.id === `run:${id}`);
			// A processed run was already digested; capturing it again would put it back in the queue.
			if (existing && existing.status !== "pending") return "processed";
			const root = abs(`runs/${id}`);
			rmSync(root, { recursive: true, force: true });
			for (const t of transcripts) {
				const agent = safeId(t.agentId);
				writeJson(join(root, "transcripts", `${agent}.json`), t.normalized);
				if (t.raw != null) atomicWrite(join(root, "transcripts", `${agent}.jsonl`), t.raw);
			}
			if (report !== undefined) atomicWrite(join(root, "report.md"), report);
			writeJson(join(root, "run.json"), pkg);
			const entry = baseEntry(
				"run",
				id,
				{ ...pkg, summary: pkg.reason ?? `${pkg.agents.length} agents, ${pkg.metrics.messages} messages` },
				`runs/${id}/run.json`,
				"pending",
			);
			if (existing) entry.createdAt = existing.createdAt;
			upsert(entry);
			return "written";
		},

		pending() {
			return load()
				.entries.filter((e) => e.kind === "run" && e.status === "pending")
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		},
		pendingCount() {
			return store.pending().length;
		},

		markProcessed(runIds, batchId) {
			const f = load();
			for (const rid of runIds) {
				const e = f.entries.find((x) => x.id === `run:${rid}`);
				if (!e) continue;
				e.status = "processed";
				e.batchId = batchId;
				e.processedAt = stamp();
			}
			save(f);
		},

		writeDigest(runId, markdown) {
			const id = safeId(runId);
			if (markdown.length > LIMITS.digest)
				throw new RangeError(`Digest is ${markdown.length} chars, over ${LIMITS.digest}`);
			atomicWrite(abs(`digests/${id}.md`), markdown);
			const run = load().entries.find((e) => e.id === `run:${id}`);
			const { fields, body } = parseFrontmatter(markdown);
			return upsert(
				baseEntry(
					"digest",
					id,
					{
						project: run?.project ?? "",
						projectSlug: run?.projectSlug ?? "",
						title: run ? `Digest: ${run.title}` : `Digest ${id}`,
						summary: fields.summary ?? body,
					},
					`digests/${id}.md`,
					"active",
				),
			);
		},
		readDigest(runId) {
			const file = abs(`digests/${safeId(runId)}.md`);
			return existsSync(file) ? readFileSync(file, "utf8") : null;
		},

		claimBatch(runIds) {
			const claimed = allBatches().filter((b) => b.state === "claimed");
			const key = (ids: string[]) => [...ids].sort().join("\n");
			// Idempotent: asking again for the same set returns the batch already claimed.
			const same = claimed.find((b) => key(b.runIds) === key(runIds));
			if (same) return same;
			const taken = new Set(claimed.flatMap((b) => b.runIds));
			const open = new Set(store.pending().map((e) => e.id.slice("run:".length)));
			const free = runIds.filter((r) => open.has(r) && !taken.has(r));
			if (free.length === 0) return null;
			const stampId = stamp().replace(/[-:.]/g, "");
			let n = 1;
			while (existsSync(batchFile(`b-${stampId}-${n}`))) n++;
			const batch: BatchRecord = {
				schema: 1,
				id: `b-${stampId}-${n}`,
				runIds: free,
				state: "claimed",
				claimedAt: stamp(),
			};
			writeJson(batchFile(batch.id), batch);
			return batch;
		},
		claimedBatches() {
			return allBatches().filter((b) => b.state === "claimed");
		},
		finishBatch(batchId, summaryMarkdown) {
			const batch = readBatch(batchId);
			if (!batch) throw new Error(`No batch ${batchId}`);
			const summaryPath = `batches/${batch.id}.md`;
			atomicWrite(abs(summaryPath), summaryMarkdown);
			const done: BatchRecord = { ...batch, state: "done", summaryPath };
			writeJson(batchFile(batch.id), done);
			const first = load().entries.find((e) => e.id === `run:${batch.runIds[0]}`);
			upsert(
				baseEntry(
					"batch",
					batch.id,
					{
						project: first?.project ?? "",
						projectSlug: first?.projectSlug ?? "",
						title: `Batch of ${batch.runIds.length} runs`,
						summary: summaryMarkdown,
					},
					summaryPath,
					"active",
				),
			);
			return done;
		},

		writeConsulted(meta, text, summary) {
			const id = safeId(meta.id);
			atomicWrite(abs(`consulted/${id}.txt`), text);
			atomicWrite(
				abs(`consulted/${id}.md`),
				renderFrontmatter(
					{
						id,
						title: meta.title,
						source: meta.source,
						project: meta.project,
						projectSlug: meta.projectSlug,
						createdAt: stamp(),
					},
					`## Summary\n\n${summary}`,
				),
			);
			return upsert(baseEntry("consulted", id, { ...meta, summary }, `consulted/${id}.md`, "active"));
		},
		writeIdea(meta, body, summary) {
			const id = safeId(meta.id);
			atomicWrite(
				abs(`ideas/${id}.md`),
				renderFrontmatter(
					{ id, title: meta.title, project: meta.project, projectSlug: meta.projectSlug, createdAt: stamp() },
					body,
				),
			);
			return upsert(baseEntry("idea", id, { ...meta, summary: summary ?? body }, `ideas/${id}.md`, "active"));
		},

		/**
		 * Problem: /workflow ask has the model write ideas/<id>.md itself, so they never reached index.json and no
		 * slice or prune saw them. Example: ideas/src-ab12-cache.md exists, indexSlice does not list it.
		 * Solution: index every file the index lacks, from its frontmatter; running it twice adds nothing.
		 */
		adoptIdeas() {
			const folder = abs("ideas");
			if (!existsSync(folder)) return [];
			const known = new Set(load().entries.map((e) => e.id));
			const adopted: string[] = [];
			for (const name of readdirSync(folder).filter((n) => n.endsWith(".md"))) {
				const { fields, body } = parseFrontmatter(readFileSync(join(folder, name), "utf8"));
				const id = fields.id ?? name.replace(/\.md$/, "");
				if (!SAFE_ID.test(id) || known.has(`idea:${id}`)) continue;
				const entry = baseEntry(
					"idea",
					id,
					{
						project: fields.project ?? "",
						projectSlug: fields.projectSlug ?? "",
						title: fields.title ?? id,
						summary: body.split("\n").find((l) => l.trim()) ?? "",
					},
					`ideas/${name}`,
					"active",
				);
				if (fields.createdAt) entry.createdAt = fields.createdAt;
				upsert(entry);
				adopted.push(entry.id);
			}
			return adopted;
		},

		propose(p) {
			const fingerprint = proposalFingerprint(p);
			const f = load();
			// A rejection blocks the same proposal forever, even after the entry was archived.
			const wasRejected =
				f.rejected.includes(fingerprint) ||
				f.entries.some((e) => e.kind === "proposal" && e.status === "rejected" && e.fingerprint === fingerprint);
			if (wasRejected) return { result: "rejected-before", fingerprint };
			const open = f.entries.find(
				(e) =>
					e.kind === "proposal" && e.fingerprint === fingerprint && (e.status === "open" || e.status === "approved"),
			);
			if (open) return { result: "duplicate", id: open.id.slice("proposal:".length), fingerprint };
			const id = `${now()
				.toISOString()
				.replace(/[-:.TZ]/g, "")
				.slice(0, 14)}-${fingerprint.slice(0, 8)}`;
			const title = p.title ?? `${p.kind}: ${p.target}`;
			atomicWrite(
				abs(`proposals/${id}.md`),
				renderFrontmatter(
					{
						id,
						kind: p.kind,
						target: p.target,
						status: "open",
						fingerprint,
						project: p.project,
						createdAt: stamp(),
					},
					`## Change\n\n${p.change}\n\n## Evidence\n\n${p.evidence}`,
				),
			);
			const entry = baseEntry(
				"proposal",
				id,
				{ project: p.project ?? "", projectSlug: p.projectSlug ?? "", title, summary: p.change },
				`proposals/${id}.md`,
				"open",
			);
			entry.fingerprint = fingerprint;
			upsert(entry);
			return { result: "created", id, fingerprint };
		},
		decide(id, decision, why) {
			const entry = setProposalFields(id, decision, { decidedAt: stamp(), why });
			if (decision === "rejected" && entry.fingerprint) {
				const f = load();
				if (!f.rejected.includes(entry.fingerprint)) f.rejected.push(entry.fingerprint);
				save(f);
			}
			return entry;
		},
		markApplied(id) {
			return setProposalFields(id, "applied", { appliedAt: stamp() });
		},

		readWorkflowMemory() {
			const file = abs("workflow-memory.md");
			return existsSync(file) ? readFileSync(file, "utf8") : "";
		},
		writeWorkflowMemory(markdown) {
			if (markdown.length > LIMITS.workflowMemory) {
				throw new RangeError(`Workflow memory is ${markdown.length} chars, over ${LIMITS.workflowMemory}`);
			}
			atomicWrite(abs("workflow-memory.md"), markdown);
		},

		readIndex() {
			return load().entries;
		},
		indexSlice({ project, kinds, limit, maxChars }) {
			// Reads index.json only: a model is never shown, and the code never opens, a transcript for this.
			const entries = load()
				.entries.filter((e) => e.status !== "archived")
				.filter((e) => !project || e.project === project || e.projectSlug === project)
				.filter((e) => !kinds || kinds.includes(e.kind))
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				.slice(0, Math.max(0, limit));
			let out = "";
			for (const e of entries) {
				const line = `${e.id} · ${e.kind} · ${e.projectSlug || e.project} · ${e.title} · ${e.summary}`;
				const next = out ? `${out}\n${line}` : line;
				if (next.length > maxChars) {
					if (!out) out = line.slice(0, Math.max(0, maxChars));
					break;
				}
				out = next;
			}
			return out;
		},
		touch(ids) {
			const f = load();
			for (const e of f.entries) if (ids.includes(e.id)) e.lastUsedAt = stamp();
			save(f);
		},

		archive(id) {
			const f = load();
			const entry = f.entries.find((e) => e.id === id);
			if (!entry || entry.status === "archived") return null;
			const rels = entry.kind === "run" ? [dirname(entry.path)] : [entry.path];
			if (entry.kind === "consulted") rels.push(entry.path.replace(/\.md$/, ".txt"));
			for (const rel of rels) {
				if (!existsSync(abs(rel))) continue;
				mkdirSync(dirname(abs(`archive/${rel}`)), { recursive: true });
				renameSync(abs(rel), abs(`archive/${rel}`));
			}
			entry.path = `archive/${entry.path}`;
			entry.status = "archived";
			save(f);
			return entry;
		},
		archiveStale({ days = 90 } = {}) {
			const cutoff = now().getTime() - days * DAY_MS;
			const archived: string[] = [];
			for (const e of load().entries) {
				if (e.status === "archived") continue;
				// Work still waiting for a person or the keeper is not "unused".
				const waiting = e.status === "pending" || e.status === "open" || e.status === "approved";
				const claimed = e.kind === "batch" && readBatch(e.id.slice("batch:".length))?.state === "claimed";
				const lastUse = Date.parse(e.lastUsedAt || e.createdAt);
				const stale = lastUse < cutoff && !waiting && !claimed;
				if (stale || e.supersededBy) {
					if (store.archive(e.id)) archived.push(e.id);
				}
			}
			return archived;
		},
		deleteArchived(ids) {
			const f = load();
			const deleted: string[] = [];
			for (const id of ids) {
				const entry = f.entries.find((e) => e.id === id);
				// Only what was archived can go; the live memory is never deleted.
				if (entry?.status !== "archived") continue;
				const rels = entry.kind === "run" ? [dirname(entry.path)] : [entry.path];
				if (entry.kind === "consulted") rels.push(entry.path.replace(/\.md$/, ".txt"));
				for (const rel of rels) rmSync(abs(rel), { recursive: true, force: true });
				deleted.push(id);
			}
			f.entries = f.entries.filter((e) => !deleted.includes(e.id));
			save(f);
			return deleted;
		},

		skillUse(lastN) {
			const runs = load()
				.entries.filter((e) => e.kind === "run" && e.status === "processed")
				.sort((a, b) => (b.processedAt ?? b.createdAt).localeCompare(a.processedAt ?? a.createdAt))
				.slice(0, lastN);
			const use: Record<string, number> = {};
			for (const e of runs) {
				const file = abs(e.path);
				if (!existsSync(file) || !statSync(file).isFile()) continue;
				const pkg = readJson<RunPackage>(file);
				const names = new Set((pkg?.agents ?? []).flatMap((a) => [...a.assignedSkills, ...a.loadedSkills]));
				for (const n of names) use[n] = (use[n] ?? 0) + 1;
			}
			return use;
		},
	};
	return db ? transactional(store, db) : store;
}

function openActiveDatabase(path: string): DatabaseSync {
	if (!existsSync(path)) {
		throw new Error(`${path} is missing but the store was migrated to it; restore it from migration-backup`);
	}
	try {
		const { db } = openOperationalStore(path, { fts: false, legacy: true });
		const active = db.prepare("SELECT 1 FROM legacy_migrations WHERE state = 'active'").get();
		if (!active) throw new Error("no active migration row");
		return db;
	} catch (error) {
		throw new Error(`${path} is corrupt or not an activated store; it is not treated as empty`, { cause: error });
	}
}

/** Every public call runs inside one write transaction; nested calls (a method using `store.x`) join the outer one. */
function transactional(store: MemoryStore, db: DatabaseSync): MemoryStore {
	let depth = 0;
	const out: Record<string, unknown> = { ...store };
	for (const [name, fn] of Object.entries(store)) {
		if (typeof fn !== "function") continue;
		const wrapped = (...args: unknown[]) => {
			if (depth > 0) return fn(...args);
			db.exec("BEGIN IMMEDIATE");
			depth++;
			try {
				const result = fn(...args);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			} finally {
				depth--;
			}
		};
		out[name] = wrapped;
		(store as unknown as Record<string, unknown>)[name] = wrapped;
	}
	return out as unknown as MemoryStore;
}
