// Durable chat state belongs to the host, outside the working tree writable by an agent.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { devNull, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ArtifactSummary, createArtifactStore } from "./fleet-artifacts.ts";

import type { FleetPlanner } from "./fleet-planner.ts";

type ExecutionEvent = { type: "queued" | "started" | "finished" | "failed" | "interrupted"; text: string; at: number };
export type FleetAgent = "pi" | "codex" | "claude";
type Status = "queued" | "running" | "completed" | "failed" | "interrupted";
type Message = {
	role: "user" | "assistant" | "system";
	text: string;
	at?: number;
	actor?: string;
	kind?: "error" | "plan";
};
export type FleetJobSummary = {
	id: string;
	project: string;
	agent: FleetAgent;
	status: Status;
	updatedAt: number;
	title: string;
};
export type FleetJob = FleetJobSummary & {
	messages: Message[];
	events?: ExecutionEvent[];
	artifacts?: ArtifactSummary[];
};
export class FleetJobError extends Error {
	readonly statusCode: 400 | 404 | 409 | 429 | 503;
	constructor(statusCode: FleetJobError["statusCode"], message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}
const sandbox = fileURLToPath(new URL("./fleet-sandbox.ts", import.meta.url));
const maxOutput = 128 * 1024;
const maxTurns = 80;

function canonicalPath(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	return join(canonicalPath(dirname(path)), basename(path));
}

function overlaps(a: string, b: string) {
	return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

function gitEnv() {
	return {
		PATH: process.env.PATH,
		HOME: homedir(),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: devNull,
		GIT_TERMINAL_PROMPT: "0",
		GIT_ALLOW_PROTOCOL: "file",
		GIT_LFS_SKIP_SMUDGE: "1",
	};
}

function allowedProjects(config: Record<string, string>, state: string) {
	const home = homedir();
	const protectedPaths = [
		state,
		...[".pihouse", ".codex", ".claude", ".pi", ".config", ".ssh", ".gnupg", ".aws", ".local/share", "Library"].map(
			(p) => canonicalPath(join(home, p)),
		),
	];
	for (const override of [
		process.env.PIHOUSE_HOME,
		process.env.CODEX_HOME,
		process.env.CLAUDE_CONFIG_DIR,
		process.env.PI_CODING_AGENT_DIR,
	]) {
		if (override) protectedPaths.push(canonicalPath(resolve(override)));
	}
	const allowed = new Map<string, string>();
	function assertAllowed(path: string) {
		if (protectedPaths.some((reserved) => overlaps(path, reserved)))
			throw new Error("Project overlaps private owner or fleet state.");
	}
	for (const [name, path] of Object.entries(config)) {
		if (!path || !isAbsolute(path)) throw new Error("A configured project must be an absolute Git working-tree root.");
		const source = realpathSync(path);
		assertAllowed(source);
		const info = execFileSync(
			"git",
			["-C", source, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
			{ env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: 5000, encoding: "utf8", maxBuffer: 32768 },
		)
			.trimEnd()
			.split("\n");
		if (info.length !== 3 || realpathSync(info[0]) !== source)
			throw new Error("A configured project must be a Git working-tree root.");
		for (const dir of info.slice(1)) {
			const metadata = realpathSync(dir);
			assertAllowed(metadata);
			if (existsSync(join(metadata, "objects/info/alternates")))
				throw new Error("Project uses an external Git object store.");
		}
		allowed.set(name, source);
	}
	return allowed;
}

function userMessage(input: string): Message {
	if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > 16 * 1024)
		throw new FleetJobError(400, "Message must contain 1 to 16384 bytes.");
	return { role: "user", text: input.trim(), at: Date.now() };
}

function context(messages: Message[]) {
	const parts: string[] = [];
	let remaining = 48 * 1024;
	for (const m of messages.toReversed()) {
		const data = Buffer.from(m.text);
		remaining -= m.role.length + 4;
		if (remaining <= 0) break;
		const text = data.subarray(Math.max(0, data.length - remaining)).toString("utf8");
		parts.unshift(`${m.kind === "plan" ? "untrusted planner suggestion" : m.role}\n${text}`);
		remaining -= data.length;
		if (remaining <= 0) break;
	}
	return `Continue this project conversation. Answer the latest user message. Earlier messages may be shortened.\n\n${parts.join("\n\n")}`;
}

function stopTree(child?: ChildProcess): boolean {
	if (!child?.pid) return true;
	try {
		if (process.platform === "win32") return child.kill("SIGKILL");
		process.kill(-child.pid, "SIGKILL");
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		// Some environments restrict group signals. Stop the direct child and recheck
		// the group on exit before permitting another turn in this checkout.
		child.kill("SIGKILL");
		return false;
	}
}

// A tool can start a child in a new process group. Capture the live ancestry
// before signaling the runner, while those children can still be attributed.
export function cancelFleetProcessTree(child?: ChildProcess) {
	if (!child?.pid) return;
	if (process.platform !== "win32") {
		try {
			const tree = execFileSync("/bin/ps", ["-ax", "-o", "pid=,ppid="], {
				encoding: "utf8",
				timeout: 2000,
				maxBuffer: 2 ** 20,
			});
			const children = new Map<number, number[]>();
			for (const line of tree.trim().split("\n")) {
				const [pid, parent] = line.trim().split(/\s+/).map(Number);
				const entries = children.get(parent) ?? [];
				entries.push(pid);
				children.set(parent, entries);
			}
			const descendants = [child.pid];
			for (const pid of descendants) descendants.push(...(children.get(pid) ?? []));
			for (const pid of descendants.slice(1).reverse()) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* A descendant can already have exited. */
				}
			}
		} catch {
			/* Group termination remains available when process inspection is restricted. */
		}
	}
	stopTree(child);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

class TaskError extends Error {}
class UnconfirmedExit extends TaskError {}
class DeadlineError extends TaskError {}

export function createFleetJobs(
	options: {
		stateDir: string;
		projects: Record<string, string>;
		turnTimeoutMs?: number;
		host?: string;
		planner?: FleetPlanner;
	},
	sandboxPath = sandbox,
	plannerPath = fileURLToPath(new URL("./fleet-planner.ts", import.meta.url)),
) {
	const timeout = options.turnTimeoutMs ?? 2 * 60 * 60_000;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 24 * 60 * 60_000)
		throw new Error("Turn timeout must be between 1 ms and 24 hours.");
	const state = canonicalPath(resolve(options.stateDir));
	const projects = allowedProjects(options.projects, state);
	const checkouts = join(state, "checkouts");
	mkdirSync(checkouts, { mode: 0o700, recursive: true });
	const dbPath = join(state, "jobs.sqlite");
	const db = new DatabaseSync(dbPath);
	let closed = false;
	let active: ChildProcess | undefined;
	let scheduled = false;
	let artifacts: ReturnType<typeof createArtifactStore>;
	const primary = (job: FleetJob) => `${options.host ?? "Local Mac"} · ${job.agent}`;
	function event(job: FleetJob, type: ExecutionEvent["type"], text: string) {
		job.events ??= [];
		job.events.push({ type, text, at: Date.now() });
	}
	try {
		chmodSync(dbPath, 0o600);
		// A second listener could otherwise accept a reply while the first writes its checkout.
		// SQLite keeps this exclusive lock across commits and releases it on process death.
		db.exec(
			"PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL, updatedAt INTEGER NOT NULL, title TEXT NOT NULL, messages TEXT NOT NULL); COMMIT;",
		);
		if (!db.prepare("SELECT name FROM pragma_table_info('jobs') WHERE name='events'").get())
			db.exec("ALTER TABLE jobs ADD COLUMN events TEXT NOT NULL DEFAULT '[]'");
		artifacts = createArtifactStore(db);
		interruptPending();
	} catch (error) {
		db.close();
		throw error;
	}

	function get(id: string): FleetJob | undefined {
		const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
		if (!row) return undefined;
		return {
			...(row as unknown as FleetJobSummary),
			messages: JSON.parse(String(row.messages)) as Message[],
			events: JSON.parse(String(row.events)) as ExecutionEvent[],
			artifacts: artifacts.list(id),
		};
	}
	function save(job: FleetJob) {
		job.updatedAt = Date.now();
		db.prepare("UPDATE jobs SET updatedAt=?,status=?,messages=?,events=? WHERE id=?").run(
			job.updatedAt,
			job.status,
			JSON.stringify(job.messages),
			JSON.stringify(job.events ?? []),
			job.id,
		);
	}
	function interruptPending() {
		const pending = db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").all();
		for (const { id } of pending) {
			const job = get(String(id));
			if (!job) continue;
			job.status = "interrupted";
			event(job, "interrupted", `${primary(job)} · Host stopped before confirming completion.`);
			job.messages.push({
				role: "system",
				at: Date.now(),
				kind: "error",
				text: "Host stopped before confirming completion. This checkout is closed to further writes. Start a new chat to run another turn.",
			});
			save(job);
		}
	}
	function run(command: string, args: string[], cwd: string, prompt?: string, deadlineMs = timeout): Promise<string> {
		if (closed) throw new TaskError("Fleet host closed.");
		const isRunner = prompt !== undefined;
		const child = spawn(command, args, {
			cwd,
			env: isRunner ? { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR } : gitEnv(),
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		active = child;
		return new Promise((accept, reject) => {
			const output: Buffer[] = [];
			const diagnostic: Buffer[] = [];
			let bytes = 0;
			let failure = "";
			function abort(reason: string) {
				if (failure) return;
				failure = reason;
				cancelFleetProcessTree(child);
			}
			const timer = setTimeout(() => abort("Task timed out."), isRunner ? deadlineMs : 60_000);
			function capture(list: Buffer[], chunk: Buffer) {
				bytes += chunk.byteLength;
				if (bytes > maxOutput) abort("Task exceeded its output limit.");
				else list.push(chunk);
			}
			child.stdout.on("data", (chunk: Buffer) => capture(output, chunk));
			child.stderr.on("data", (chunk: Buffer) => capture(diagnostic, chunk));
			child.stdin.on("error", () => {
				/* A child may exit before reading its input. Its exit status is authoritative. */
			});
			child.on("error", () => {
				failure = "Task executable could not start.";
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				const stopped = stopTree(child);
				if (active === child) active = undefined;
				if (!stopped)
					return reject(
						new UnconfirmedExit("Host could not confirm the task stopped. This checkout is closed to further writes."),
					);
				if (failure) return reject(failure === "Task timed out." ? new DeadlineError(failure) : new TaskError(failure));
				if (code !== 0) {
					const line = Buffer.concat(diagnostic).toString("utf8").trim();
					const detail =
						isRunner && line.startsWith("Fleet sandbox: ") && !line.includes("\n")
							? line.slice("Fleet sandbox: ".length, 1024)
							: "";
					return reject(
						new TaskError(detail || (isRunner ? "Sandbox runner failed." : "Could not prepare the project checkout.")),
					);
				}
				accept(Buffer.concat(output).toString("utf8").trim());
			});
			child.stdin.end(prompt);
		});
	}

	async function execute(job: FleetJob) {
		const checkout = join(checkouts, job.id);
		const source = projects.get(job.project);
		if (!source) throw new TaskError("Project is no longer enabled.");
		if (job.messages.length === 1) {
			const staging = join(checkouts, `.${job.id}-init`);
			try {
				await run(
					"git",
					[
						"-c",
						`core.hooksPath=${devNull}`,
						"clone",
						"--no-local",
						"--no-hardlinks",
						"--depth=1",
						"--single-branch",
						"--no-tags",
						"--no-recurse-submodules",
						"--template=",
						"--",
						pathToFileURL(source).href,
						staging,
					],
					checkouts,
				);
				await run("git", ["remote", "remove", "origin"], staging);
				if (closed) throw new TaskError("Fleet host closed.");
				renameSync(staging, checkout);
			} finally {
				rmSync(staging, { recursive: true, force: true });
			}
		}
		if (!existsSync(checkout) || realpathSync(checkout) !== checkout)
			throw new TaskError("Task checkout is unavailable.");
		const before = artifacts.baseline(checkout);
		const deadline = Date.now() + timeout;
		const planner = options.planner;
		if (planner) {
			const actor = `${planner.label} · Planner`;
			event(job, "started", `${actor} · Preparing a plan.`);
			save(job);
			try {
				const advice = await run(
					process.execPath,
					[plannerPath, JSON.stringify(planner)],
					checkout,
					context(job.messages),
					timeout,
				);
				if (closed) throw new TaskError("Fleet host closed.");
				if (!advice.trim()) throw new TaskError("Planner returned no plan.");
				job.messages.push({
					role: "assistant",
					kind: "plan",
					actor,
					text: Buffer.from(advice).subarray(0, 8192).toString("utf8"),
					at: Date.now(),
				});
				event(job, "finished", `${actor} · Plan ready.`);
			} catch (error) {
				if (closed || error instanceof DeadlineError || error instanceof UnconfirmedExit) throw error;
				event(job, "failed", `${actor} · Planner unavailable. Continuing on ${options.host ?? "the primary Mac"}.`);
			}
			save(job);
		}
		if (closed) throw new TaskError("Fleet host closed.");
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new DeadlineError("Task timed out.");
		event(job, "started", `${primary(job)} · Working in the task checkout.`);
		save(job);
		const prompt =
			context(job.messages) +
			"\n\nPlace files requested for delivery directly under artifacts/ with simple filenames. Only new or changed files there will be attached to this chat.";
		const answer = await run(process.execPath, [sandboxPath, job.agent], checkout, prompt, remaining);
		if (!answer) throw new TaskError("Sandbox runner returned no assistant response.");
		return { checkout, before, answer };
	}
	async function pump() {
		try {
			while (!closed) {
				const row = db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY updatedAt,rowid LIMIT 1").get();
				if (!row) break;
				const job = get(String(row.id));
				if (!job) break;
				job.status = "running";
				save(job);
				try {
					const result = await execute(job);
					if (closed) break;
					db.exec("BEGIN IMMEDIATE");
					try {
						const captured = artifacts.capture(job.id, result.checkout, result.before);
						job.messages.push({ role: "assistant", actor: primary(job), text: result.answer, at: Date.now() });
						job.status = "completed";
						event(
							job,
							"finished",
							`${primary(job)} · Turn finished.${captured ? "" : " Artifact capture unavailable or over its limit."}`,
						);
						save(job);
						db.exec("COMMIT");
					} catch (error) {
						db.exec("ROLLBACK");
						throw error;
					}
				} catch (error) {
					if (closed) break;
					job.status = error instanceof UnconfirmedExit ? "interrupted" : "failed";
					event(
						job,
						job.status,
						`${primary(job)} · ${job.status === "interrupted" ? "Turn interrupted." : "Turn failed."}`,
					);
					job.messages.push({
						role: "system",
						at: Date.now(),
						kind: "error",
						text: error instanceof TaskError ? error.message : "Host could not access the task checkout.",
					});
					save(job);
				}
			}
		} finally {
			scheduled = false;
		}
	}
	function queue() {
		if (scheduled) return;
		scheduled = true;
		setImmediate(() => void pump());
	}
	function admit() {
		const row = db.prepare("SELECT count(*) AS count FROM jobs WHERE status IN ('queued','running')").get();
		if (Number(row?.count) >= 16) throw new FleetJobError(429, "Task queue is full.");
	}
	return {
		list(): FleetJobSummary[] {
			return db
				.prepare("SELECT id,project,agent,status,updatedAt,title FROM jobs ORDER BY updatedAt DESC,rowid DESC")
				.all() as unknown as FleetJobSummary[];
		},
		get,
		artifact: artifacts.get,
		create(project: string, agent: FleetAgent, input: string): FleetJob {
			if (!projects.has(project)) throw new FleetJobError(404, "Unknown project.");
			if (!["pi", "claude", "codex"].includes(agent)) throw new FleetJobError(400, "Unknown agent.");
			const message = userMessage(input);
			admit();
			const row = db.prepare("SELECT count(*) AS count FROM jobs").get();
			if (Number(row?.count) >= 256) throw new FleetJobError(503, "Host chat capacity reached.");
			const job: FleetJob = {
				id: randomUUID(),
				project,
				agent,
				title: message.text.replace(/\s+/g, " ").slice(0, 100),
				status: "queued",
				updatedAt: Date.now(),
				messages: [message],
				events: [],
				artifacts: [],
			};
			event(job, "queued", `${primary(job)} · Turn queued.`);
			db.prepare(
				"INSERT INTO jobs(id,project,agent,title,status,updatedAt,messages,events) VALUES (?,?,?,?,?,?,?,?)",
			).run(
				job.id,
				project,
				agent,
				job.title,
				job.status,
				job.updatedAt,
				JSON.stringify(job.messages),
				JSON.stringify(job.events ?? []),
			);
			queue();
			return job;
		},
		reply(id: string, input: string): FleetJob {
			const job = get(id);
			if (!job) throw new FleetJobError(404, "Unknown chat.");
			if (!projects.has(job.project)) throw new FleetJobError(404, "Unknown project.");
			if (job.status === "interrupted") throw new FleetJobError(409, "Interrupted chat is closed to further writes.");
			if (job.status === "queued" || job.status === "running") throw new FleetJobError(409, "Chat is busy.");
			if (job.messages.filter((m) => m.role === "user").length >= maxTurns)
				throw new FleetJobError(409, "Chat turn limit reached.");
			const message = userMessage(input);
			admit();
			job.messages.push(message);
			job.status = "queued";
			event(job, "queued", `${primary(job)} · Turn queued.`);
			save(job);
			queue();
			return job;
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				cancelFleetProcessTree(active);
				interruptPending();
			} finally {
				db.close();
			}
		},
	};
}
