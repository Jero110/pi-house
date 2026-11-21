import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FleetJob, FleetJobSummary } from "./fleet-jobs.ts";
import {
	FLEET_RETRIEVAL_REVISION,
	type FleetEvidence,
	type FleetMemorySource,
	type FleetPassage,
	fleetPassages,
} from "./fleet-memory.ts";

const identity = {
	GIT_AUTHOR_NAME: "pi-house",
	GIT_AUTHOR_EMAIL: "memory@pi-house.local",
	GIT_COMMITTER_NAME: "pi-house",
	GIT_COMMITTER_EMAIL: "memory@pi-house.local",
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function gitBytes(args: string[], input?: string) {
	return execFileSync("git", args, {
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
		input,
		env: {
			PATH: process.env.PATH,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			...identity,
		},
	});
}
function git(args: string[], input?: string) {
	return gitBytes(args, input).toString("utf8").trimEnd();
}

/** Each project's reference advances by compare-and-swap. A crash before update-ref leaves the previous version intact. */
export function createMemoryRepository(path: string, live: FleetMemorySource) {
	if (!isAbsolute(path)) throw Error("Memory repository requires an absolute path.");
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const st = lstatSync(path);
	if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & 0o077 || realpathSync(path) !== resolve(path))
		throw Error("Memory requires a private, owner-owned canonical directory.");
	if (!existsSync(join(path, "HEAD"))) {
		git(["init", "--bare", "--template=", "--initial-branch=main", path]);
		chmodSync(path, 0o700);
	}
	const run = (args: string[], input?: string) =>
		git(["--git-dir", path, "-c", "core.hooksPath=/dev/null", ...args], input);
	if (run(["rev-parse", "--is-bare-repository"]) !== "true") throw Error("Memory requires a bare Git repository.");
	const projectRef = (kind: string, project: string) =>
		`refs/heads/${kind}/${/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(project) ? project : digest(project)}`;
	function readRef(ref: string) {
		return run(["for-each-ref", "--format=%(objectname)", ref]).split("\n")[0] || undefined;
	}
	function read<T>(ref: string, name: string): T | undefined {
		const head = readRef(ref);
		return head ? JSON.parse(run(["show", `${head}:${name}`])) : undefined;
	}
	function commit(ref: string, name: string, value: unknown, message: string, previous: string | undefined) {
		const blob = run(["hash-object", "-w", "--stdin"], JSON.stringify(value));
		const tree = run(["mktree"], `100644 blob ${blob}\t${name}\n`);
		const head = run(["commit-tree", tree, ...(previous ? ["-p", previous] : []), "-m", message]);
		run(["update-ref", ref, head, previous ?? "0".repeat(head.length)]);
	}
	// A default branch makes a fresh clone navigable. Actual private data is in project and evidence branches.
	if (!readRef("refs/heads/main")) {
		const readme =
			"# Private fleet memory\n\nProject facts, knowledge relations and evaluation trials live on projects/<project>. Each threads/<project>/<id> branch holds one conversation's evidence revisions. Use git branch --all to list them, or git bundle create memory.bundle --all for a portable snapshot. Store bundles privately. Attachments remain in fleet state.\n";
		const blob = run(["hash-object", "-w", "--stdin"], readme);
		const tree = run(["mktree"], `100644 blob ${blob}\tREADME.md\n`);
		const head = run(["commit-tree", tree, "-m", "Describe the private memory repository"]);
		try {
			run(["update-ref", "refs/heads/main", head, "0".repeat(head.length)]);
		} catch (error) {
			if (!readRef("refs/heads/main")) throw error;
		}
	}
	const file = join(path, `${FLEET_RETRIEVAL_REVISION}.sqlite`);
	let db: DatabaseSync | undefined;
	function index() {
		if (db) return db;
		if (existsSync(file) && !lstatSync(file).isFile()) throw Error("Private search index must be a regular file.");
		const open = () => {
			const d = new DatabaseSync(file);
			try {
				d.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
					CREATE TABLE IF NOT EXISTS docs(ref TEXT PRIMARY KEY,project TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,head TEXT NOT NULL,summary TEXT NOT NULL,job TEXT NOT NULL,at INTEGER,hash TEXT,firstRow INTEGER,lastRow INTEGER,UNIQUE(project,id));
					CREATE TABLE IF NOT EXISTS manifests(project TEXT PRIMARY KEY,signature TEXT);
					CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(body,original UNINDEXED,ref UNINDEXED,kind UNINDEXED,label UNINDEXED,artifact UNINDEXED,tokenize="unicode61 remove_diacritics 2 tokenchars '_'");`);
				chmodSync(file, 0o600);
				return d;
			} catch (e) {
				d.close();
				throw e;
			}
		};
		try {
			db = open();
		} catch (e) {
			if (!(e instanceof Error && "errcode" in e && [11, 26].includes(Number(e.errcode)))) throw e;
			// Only quarantine derived SQLite files. A bundle or an untouched bare repository
			// contains every canonical revision needed to reconstruct them.
			const stamp = Date.now();
			for (const suffix of ["", "-wal", "-shm"])
				if (existsSync(file + suffix)) renameSync(file + suffix, `${file}.damaged-${stamp}${suffix}`);
			db = open();
		}
		return db;
	}
	function capture(job: FleetJob) {
		if (job.status === "running" || job.status === "queued") return;
		const ref = `${projectRef("threads", job.project)}/${digest(job.id)}`;
		const prev = readRef(ref);
		const existing: FleetJob | undefined = prev ? JSON.parse(run(["show", `${prev}:thread.json`])) : undefined;
		if (existing && existing.updatedAt >= job.updatedAt) return;
		commit(ref, "thread.json", job, "Capture project thread evidence", prev);
	}
	function sync(project: string, d: DatabaseSync) {
		const prefix = `${projectRef("threads", project)}/`;
		const listing = run(["for-each-ref", "--format=%(objectname) %(refname)", prefix]);
		const signature = digest(listing);
		if (d.prepare("SELECT signature FROM manifests WHERE project=?").get(project)?.signature === signature) return;
		const refs = new Map(
			listing
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [head, ref] = line.split(" ");
					return [ref, head];
				}),
		);
		d.exec("BEGIN IMMEDIATE");
		try {
			const remove = d.prepare("DELETE FROM passages WHERE rowid BETWEEN ? AND ?");
			for (const row of d.prepare("SELECT ref,head,firstRow,lastRow FROM docs WHERE project=?").all(project)) {
				if (refs.get(String(row.ref)) === row.head) {
					refs.delete(String(row.ref));
					continue;
				}
				if (row.firstRow !== null) remove.run(row.firstRow, row.lastRow);
				d.prepare("DELETE FROM docs WHERE ref=?").run(row.ref);
			}
			const insert = d.prepare("INSERT INTO passages(body,original,ref,kind,label,artifact) VALUES(?,?,?,?,?,?)");
			const put = d.prepare("INSERT INTO docs VALUES(?,?,?,?,?,?,?,?,?,?,?)");
			const items = Array.from(refs, ([ref, head]) => ({ ref, head }));
			if (items.length) {
				const sizes = run(
					["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
					`${items.map((r) => `${r.head}:thread.json`).join("\n")}\n`,
				).split("\n");
				const blobs = items.map((row, i) => {
					const [oid, type, n] = sizes[i].split(" ");
					const size = Number(n);
					if (type !== "blob" || !Number.isSafeInteger(size) || size < 0 || size > 12 * 1024 * 1024)
						throw Error("Invalid fleet evidence object.");
					return { ...row, oid, size };
				});
				for (let start = 0; start < blobs.length; ) {
					let end = start,
						total = 0;
					while (
						end < blobs.length &&
						end - start < 512 &&
						(end === start || total + blobs[end].size < 6 * 1024 * 1024)
					) {
						total += blobs[end++].size;
					}
					const batch = blobs.slice(start, end);
					const bytes = gitBytes(
						["--git-dir", path, "-c", "core.hooksPath=/dev/null", "cat-file", "--batch"],
						`${batch.map((r) => r.oid).join("\n")}\n`,
					);
					let offset = 0;
					for (const item of batch) {
						const newline = bytes.indexOf(10, offset);
						if (bytes.toString("ascii", offset, newline) !== `${item.oid} blob ${item.size}`)
							throw Error("Invalid Git batch response.");
						const json = bytes.toString("utf8", newline + 1, newline + 1 + item.size);
						offset = newline + 2 + item.size;
						const job: FleetJob = JSON.parse(json);
						if (job.project !== project || item.ref !== prefix + digest(job.id))
							throw Error("Mismatched fleet evidence identity.");
						const data = fleetPassages(job);
						let first: number | bigint | null = null;
						let last: number | bigint | null = null;
						for (const p of data.passages) {
							const normalized = p.text.normalize("NFD").replace(/\p{M}/gu, "");
							last = insert.run(
								normalized,
								normalized === p.text ? null : p.text,
								item.ref,
								p.kind,
								p.label,
								p.artifactId ?? null,
							).lastInsertRowid;
							first ??= last;
						}
						const summary = {
							id: job.id,
							title: job.title,
							agent: job.agent,
							project,
							status: job.status,
							updatedAt: job.updatedAt,
						};
						put.run(
							item.ref,
							project,
							job.id,
							job.title,
							item.head,
							JSON.stringify(summary),
							json,
							data.updatedAt,
							data.passages.length ? digest(JSON.stringify(data)) : null,
							first,
							last,
						);
					}
					start = end;
				}
			}
			d.prepare("INSERT OR REPLACE INTO manifests VALUES(?,?)").run(project, signature);
			d.exec("COMMIT");
		} catch (e) {
			d.exec("ROLLBACK");
			throw e;
		}
	}
	function source(project: string): FleetMemorySource {
		const d = index();
		sync(project, d);
		const overlay = new Map<string, FleetJob>();
		const lookup = d.prepare("SELECT job FROM docs WHERE project=? AND id=?");
		for (const summary of live.list()) {
			if (summary.project !== project) continue;
			const stored = d.prepare("SELECT summary FROM docs WHERE project=? AND id=?").get(project, summary.id);
			if (stored && JSON.parse(String(stored.summary)).updatedAt >= summary.updatedAt) continue;
			const job = live.get(summary.id);
			if (!job || job.project !== project) continue;
			capture(job);
			overlay.set(job.id, job);
		}
		return {
			list() {
				const rows = d
					.prepare("SELECT summary FROM docs WHERE project=?")
					.all(project)
					.map((r) => JSON.parse(String(r.summary)) as FleetJobSummary);
				return [...rows.filter((row) => !overlay.has(row.id)), ...overlay.values()];
			},
			get(id) {
				const recent = overlay.get(id);
				if (recent) return recent;
				const row = lookup.get(project, id);
				return row ? (JSON.parse(String(row.job)) as FleetJob) : undefined;
			},
			*matchingPassages(scope, terms): Iterable<FleetEvidence> {
				if (scope !== project || !terms.length) return;
				const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
				const statement = d.prepare(
					"SELECT d.id,d.title,d.at,coalesce(p.original,p.body) AS body,p.kind,p.label,p.artifact FROM passages p JOIN docs d ON d.ref=p.ref WHERE passages MATCH ? AND d.project=? ORDER BY p.rowid",
				);
				for (const row of statement.iterate(expression, project)) {
					const id = String(row.id);
					if (overlay.has(id)) continue;
					yield {
						chatId: id,
						title: String(row.title),
						updatedAt: Number(row.at),
						passage: {
							kind: row.kind as FleetPassage["kind"],
							label: String(row.label),
							text: String(row.body),
							...(row.artifact && { artifactId: String(row.artifact) }),
						},
					};
				}
				for (const job of overlay.values()) {
					const data = fleetPassages(job);
					for (const passage of data.passages)
						yield { chatId: job.id, title: job.title, updatedAt: data.updatedAt, passage };
				}
			},
			evidenceDigest(scope) {
				if (scope !== project) return digest("");
				const hashes = new Map<string, string>();
				for (const row of d.prepare("SELECT id,hash FROM docs WHERE project=? AND hash IS NOT NULL").iterate(project))
					hashes.set(String(row.id), String(row.hash));
				for (const job of overlay.values()) {
					const data = fleetPassages(job);
					if (data.passages.length) hashes.set(job.id, digest(JSON.stringify(data)));
					else hashes.delete(job.id);
				}
				return digest(JSON.stringify([...hashes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
			},
		};
	}
	return {
		capture,
		source,
		close() {
			db?.close();
			db = undefined;
		},
		readState<T>(project: string) {
			return read<T>(projectRef("projects", project), "memory.json");
		},
		updateState<T>(project: string, initial: () => T, change: (state: T) => string) {
			const ref = projectRef("projects", project);
			const prev = readRef(ref);
			const state: T = prev ? JSON.parse(run(["show", `${prev}:memory.json`])) : initial();
			const before = JSON.stringify(state);
			const result = change(state);
			if (JSON.stringify(state) !== before) commit(ref, "memory.json", state, "Update scoped project memory", prev);
			return result;
		},
	};
}
