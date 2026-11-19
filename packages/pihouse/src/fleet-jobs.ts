// Durable chat state belongs to the host, outside the working tree writable by an agent.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { devNull, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ArtifactSummary, createArtifactStore } from "./fleet-artifacts.ts";
import { createFleetFactory } from "./fleet-factory.ts";
import {
	type FleetPlanner,
	FleetPlannerAddressError,
	fleetPlannerAddress,
	selectFleetPlanner,
} from "./fleet-planner.ts";
import { createFleetRecall, isFleetMemoryCommand } from "./fleet-recall.ts";

type ExecutionEvent = { type: "queued" | "started" | "finished" | "failed" | "interrupted"; text: string; at: number };
export type FleetAgent = "pi" | "codex" | "claude";
type Status = "queued" | "running" | "completed" | "failed" | "interrupted";
type Message = {
	role: "user" | "assistant" | "system";
	text: string;
	at?: number;
	actor?: string;
	kind?: "error" | "plan" | "memory";
	privateContext?: boolean;
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
	sourceHost?: string;
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

function allowedProjects(config: Record<string, string>, state: string, memoryRepo: string) {
	const home = homedir();
	const protectedPaths = [
		state,
		memoryRepo,
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

function context(messages: Message[], facts: string) {
	const parts: string[] = [];
	let remaining = 48 * 1024;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		// Memory searches can contain snippets from unrelated chats. Only confirmed facts selected below travel to workers.
		if (m.kind === "memory" || (m.role === "user" && messages[i + 1]?.kind === "memory")) continue;
		const data = Buffer.from(m.text);
		remaining -= m.role.length + 4;
		if (remaining <= 0) break;
		const text = data.subarray(Math.max(0, data.length - remaining)).toString("utf8");
		parts.unshift(`${m.kind === "plan" ? "untrusted planner suggestion" : m.role}\n${text}`);
		remaining -= data.length;
		if (remaining <= 0) break;
	}
	return `Continue this project conversation. Answer the latest user message. Earlier messages may be shortened.\n\n${parts.join("\n\n")}${facts}`;
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
		origin?: string;
		memoryRepo?: string;
		planner?: FleetPlanner;
		planners?: FleetPlanner[];
	},
	sandboxPath = sandbox,
	plannerPath = fileURLToPath(new URL("./fleet-planner.ts", import.meta.url)),
) {
	const timeout = options.turnTimeoutMs ?? 2 * 60 * 60_000;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 24 * 60 * 60_000)
		throw new Error("Turn timeout must be between 1 ms and 24 hours.");
	const state = canonicalPath(resolve(options.stateDir));
	if (existsSync(join(state, "RESTORE-INCOMPLETE"))) throw new Error("Fleet restore is incomplete.");
	const memoryRepo = canonicalPath(resolve(options.memoryRepo ?? join(state, "memory.git")));
	const projects = allowedProjects(options.projects, state, memoryRepo);
	const checkouts = join(state, "checkouts");
	mkdirSync(checkouts, { mode: 0o700, recursive: true });
	const dbPath = join(state, "jobs.sqlite");
	const db = new DatabaseSync(dbPath);
	let closed = false;
	let active: ChildProcess | undefined;
	let scheduled = false;
	let recall: ReturnType<typeof createFleetRecall> | undefined;
	function memory() {
		recall ??= createFleetRecall(memoryRepo, { list, get }, options.origin);
		return recall;
	}
	let assessCase: ((job: FleetJob) => void) | undefined;
	let artifacts: ReturnType<typeof createArtifactStore>;
	const planners = options.planners ?? (options.planner ? [options.planner] : []);
	function selectedPlanner(id: string, text: string) {
		try {
			return selectFleetPlanner(id, planners, text);
		} catch (error) {
			if (error instanceof FleetPlannerAddressError) throw new FleetJobError(400, error.message);
			throw error;
		}
	}
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
		if (!db.prepare("SELECT name FROM pragma_table_info('jobs') WHERE name='sourceHost'").get())
			db.exec("ALTER TABLE jobs ADD COLUMN sourceHost TEXT");
		if (!db.prepare("SELECT name FROM pragma_table_info('jobs') WHERE name='events'").get())
			db.exec("ALTER TABLE jobs ADD COLUMN events TEXT NOT NULL DEFAULT '[]'");
		db.exec(
			"CREATE TABLE IF NOT EXISTS external_turns(receipt TEXT PRIMARY KEY, chat TEXT NOT NULL REFERENCES jobs(id))",
		);
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
			sourceHost: typeof row.sourceHost === "string" ? row.sourceHost : undefined,
			messages: JSON.parse(String(row.messages)) as Message[],
			events: JSON.parse(String(row.events)) as ExecutionEvent[],
			artifacts: artifacts.list(id),
		};
	}
	function save(job: FleetJob) {
		job.updatedAt = Math.max(Date.now(), job.updatedAt + 1);
		db.prepare("UPDATE jobs SET updatedAt=?,status=?,messages=?,events=? WHERE id=?").run(
			job.updatedAt,
			job.status,
			JSON.stringify(job.messages),
			JSON.stringify(job.events ?? []),
			job.id,
		);
		assessCase?.(job);
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
		// Immediate memory answers never open a checkout. Clone on the first agent turn,
		// including after a chat that previously contained only owner memory commands.
		const prior = job.messages.slice(0, -1);
		if (
			!existsSync(checkout) &&
			prior.every((m, index) => (index % 2 === 0 ? m.role === "user" : m.kind === "memory"))
		) {
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
		const latest = job.messages.findLast((m) => m.role === "user");
		let matched: string | undefined;
		try {
			if (latest && existsSync(memoryRepo)) matched = memory().context(job.project, latest.text);
		} catch {
			process.stderr.write("Fleet project memory is unavailable for this turn.\n");
		}
		const privateContext = Boolean(matched) || job.messages.some((m) => m.privateContext);
		const facts = matched ? `\n\n${Buffer.from(matched).subarray(0, 8192).toString("utf8")}` : "";
		const planner = selectedPlanner(job.id, latest?.text ?? "");
		let plannerReceipt = "";
		if (planner) {
			const actor = `${planner.label} · Planner`;
			event(job, "started", `${actor} · Preparing a plan.`);
			save(job);
			try {
				const advice = await run(
					process.execPath,
					[plannerPath, JSON.stringify(planner)],
					checkout,
					`Fleet execution: this planning turn was sent by ${options.host ?? "the primary Mac"} to ${planner.label}.\n${context(job.messages, facts)}`,
					timeout,
				);
				if (closed) throw new TaskError("Fleet host closed.");
				if (!advice.trim()) throw new TaskError("Planner returned no plan.");
				job.messages.push({
					role: "assistant",
					kind: "plan",
					privateContext,
					actor,
					text: Buffer.from(advice).subarray(0, 8192).toString("utf8"),
					at: Date.now(),
				});
				plannerReceipt = ` The coordinator received a completed planning response from ${planner.label} for this turn.`;
				event(job, "finished", `${actor} · Plan ready.`);
			} catch (error) {
				if (closed || error instanceof DeadlineError || error instanceof UnconfirmedExit) throw error;
				if (fleetPlannerAddress(latest?.text ?? ""))
					throw new TaskError(`${actor} is unavailable. The primary worker did not run.`);
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
			`Fleet execution: this answer runs on ${primary(job)}.${plannerReceipt}\n` +
			context(job.messages, facts) +
			"\n\nPlace files requested for delivery directly under artifacts/ with simple filenames. Only new or changed files there will be attached to this chat.";
		const answer = await run(process.execPath, [sandboxPath, job.agent], checkout, prompt, remaining);
		if (!answer) throw new TaskError("Sandbox runner returned no assistant response.");
		return { checkout, before, answer, privateContext };
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
						job.messages.push({
							role: "assistant",
							actor: primary(job),
							text: result.answer,
							privateContext: result.privateContext,
							at: Date.now(),
						});
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
					try {
						job.artifacts = artifacts.list(job.id);
						memory().capture(job);
					} catch {
						process.stderr.write("Fleet could not archive the completed chat. Memory source backfill can retry.\n");
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
	function list(): FleetJobSummary[] {
		return db
			.prepare("SELECT id,project,agent,status,updatedAt,title FROM jobs ORDER BY updatedAt DESC,rowid DESC")
			.all() as unknown as FleetJobSummary[];
	}
	function prepareTurn(job: FleetJob, text: string) {
		const answer = isFleetMemoryCommand(text) ? memory().reply(job.project, job.id, text) : undefined;
		if (answer !== undefined) {
			const actor = `${options.host ?? "Local Mac"} · Memory`;
			job.status = "completed";
			job.messages.push({ role: "assistant", actor, kind: "memory", text: answer, at: Date.now() });
			event(job, "finished", `${actor} · Answered locally.`);
			return;
		}
		selectedPlanner(job.id, text);
		admit();
		job.status = "queued";
		event(job, "queued", `${primary(job)} · Turn queued.`);
		queue();
	}

	function transaction<T>(fn: () => T): T {
		if (db.isTransaction) return fn();
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	const jobs = {
		copyForRecovery(destination: string) {
			db.prepare("VACUUM INTO ?").run(destination);
		},
		list,
		memorySource(project: string) {
			if (!projects.has(project)) throw new FleetJobError(404, "Unknown project.");
			return memory().source(project);
		},
		memoryFacts(project: string) {
			if (!projects.has(project)) throw new FleetJobError(404, "Unknown project.");
			return memory().facts(project);
		},
		memoryRelations(project: string) {
			if (!projects.has(project)) throw new FleetJobError(404, "Unknown project.");
			return memory().relations(project);
		},
		memoryProfile(project: string) {
			if (!projects.has(project)) throw new FleetJobError(404, "Unknown project.");
			return memory().profile(project);
		},
		get,
		artifact: artifacts.get,
		create(project: string, agent: FleetAgent, input: string): FleetJob {
			return transaction(() => {
				if (!projects.has(project)) throw new FleetJobError(404, "Unknown project.");
				if (!["pi", "claude", "codex"].includes(agent)) throw new FleetJobError(400, "Unknown agent.");
				const message = userMessage(input);
				const row = db.prepare("SELECT count(*) AS count FROM jobs").get();
				if (Number(row?.count) >= 256) throw new FleetJobError(503, "Host chat capacity reached.");
				const job: FleetJob = {
					id: randomUUID(),
					sourceHost: options.host,
					project,
					agent,
					title: message.text.replace(/\s+/g, " ").slice(0, 100),
					status: "queued",
					updatedAt: Date.now(),
					messages: [message],
					events: [],
					artifacts: [],
				};
				prepareTurn(job, message.text);
				db.prepare(
					"INSERT INTO jobs(id,project,agent,title,status,updatedAt,messages,events,sourceHost) VALUES (?,?,?,?,?,?,?,?,?)",
				).run(
					job.id,
					project,
					agent,
					job.title,
					job.status,
					job.updatedAt,
					JSON.stringify(job.messages),
					JSON.stringify(job.events ?? []),
					job.sourceHost ?? null,
				);
				return job;
			});
		},
		reply(id: string, input: string): FleetJob {
			return transaction(() => {
				const job = get(id);
				if (!job) throw new FleetJobError(404, "Unknown chat.");
				if (!projects.has(job.project)) throw new FleetJobError(404, "Unknown project.");
				if (job.status === "interrupted") throw new FleetJobError(409, "Interrupted chat is closed to further writes.");
				if (job.status === "queued" || job.status === "running") throw new FleetJobError(409, "Chat is busy.");
				if (job.messages.filter((m) => m.role === "user").length >= maxTurns)
					throw new FleetJobError(409, "Chat turn limit reached.");
				const message = userMessage(input);
				job.messages.push(message);
				prepareTurn(job, message.text);
				save(job);
				return job;
			});
		},
		submitExternalTurn(receipt: string, project: string, agent: FleetAgent, input: string, chat?: string): FleetJob {
			if (isFleetMemoryCommand(input)) throw new FleetJobError(400, "Manage project memory in the private web chat.");
			// A Slack delivery can be retried after the job committed but before its thread
			// binding committed. Keep the submission receipt in the SAME transaction as the turn.
			return transaction(() => {
				const prior = db.prepare("SELECT chat FROM external_turns WHERE receipt=?").get(receipt);
				const job = prior
					? get(String(prior.chat))
					: chat
						? jobs.reply(chat, input)
						: jobs.create(project, agent, input);
				if (!job) throw new Error("Missing job for persisted submission.");
				if (!prior) db.prepare("INSERT INTO external_turns(receipt,chat) VALUES(?,?)").run(receipt, job.id);
				return job;
			});
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				cancelFleetProcessTree(active);
				interruptPending();
				if (recall && "close" in recall && typeof recall.close === "function") recall.close();
			} finally {
				db.close();
			}
		},
	};
	const { assess, ...factory } = createFleetFactory(db, {
		project: (p) => projects.has(p),
		get,
		submit: (receipt, p, agent, input) => jobs.submitExternalTurn(receipt, p, agent, input),
	});
	assessCase = assess;
	return { ...jobs, factory };
}
