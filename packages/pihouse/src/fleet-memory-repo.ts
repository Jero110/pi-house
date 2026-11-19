import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { FleetJob } from "./fleet-jobs.ts";
import type { FleetMemorySource } from "./fleet-memory.ts";

const identity = {
	GIT_AUTHOR_NAME: "pi-house",
	GIT_AUTHOR_EMAIL: "memory@pi-house.local",
	GIT_COMMITTER_NAME: "pi-house",
	GIT_COMMITTER_EMAIL: "memory@pi-house.local",
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function git(args: string[], input?: string) {
	return execFileSync("git", args, {
		encoding: "utf8",
		maxBuffer: 12 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
		input,
		env: {
			PATH: process.env.PATH,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			...identity,
		},
	}).trimEnd();
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
	const cached = new Map<string, { ref: string; job: FleetJob }>();
	function capture(job: FleetJob) {
		// Only terminal chat revisions are evidence. Runtime tokens, checkout files and attachment bytes stay outside Git.
		if (job.status === "running" || job.status === "queued") return;
		const ref = `${projectRef("threads", job.project)}/${digest(job.id)}`;
		const prev = readRef(ref);
		const prior = cached.get(ref);
		const existing = prior?.ref === prev ? prior?.job : prev ? read<FleetJob>(ref, "thread.json") : undefined;
		if (existing && existing.updatedAt >= job.updatedAt) return;
		commit(ref, "thread.json", job, "Capture project thread evidence", prev);
		cached.delete(ref);
	}
	function source(project: string): FleetMemorySource {
		const prefix = `${projectRef("threads", project)}/`;
		const readRows = () =>
			run(["for-each-ref", "--format=%(objectname) %(refname)", prefix]).split("\n").filter(Boolean);
		const rows = new Map<string, FleetJob>();
		for (const line of readRows()) {
			const [head, ref] = line.split(" ");
			const known = cached.get(ref);
			const job: FleetJob = known?.ref === head ? known.job : JSON.parse(run(["show", `${head}:thread.json`]));
			if (job.project !== project) continue;
			cached.set(ref, { ref: head, job });
			rows.set(job.id, job);
		}
		for (const summary of live.list()) {
			if (summary.project !== project) continue;
			const existing = rows.get(summary.id);
			if (existing && existing.updatedAt >= summary.updatedAt) continue;
			const job = live.get(summary.id);
			if (!job || job.project !== project) continue;
			capture(job);
			rows.set(job.id, job);
		}
		return { list: () => Array.from(rows.values()), get: (id) => rows.get(id) };
	}
	return {
		capture,
		source,
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
