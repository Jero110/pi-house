// Workflow revisions, test inputs and publication decisions are host-owned records.
// Expected answers stay in this database and never enter the evaluation prompt.
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type FleetAgent, type FleetJob, FleetJobError } from "./fleet-jobs.ts";

type Example = { input: string; expected: string };
type Definition = { name: string; instructions: string; agent: FleetAgent; cases: Example[] };
type Revision = Definition & { revision: number; createdAt: number };
type CaseResult = Example & { chatId: string; status: "queued" | "running" | "passed" | "failed"; actual?: string };
type Evaluation = {
	id: string;
	revision: number;
	status: "running" | "passed" | "failed";
	createdAt: number;
	cases: CaseResult[];
};
type Summary = { id: string; project: string; name: string; head: number; published: number | null };
type Detail = Summary & {
	revisions: Revision[];
	evaluations: Evaluation[];
	runs: { revision: number; chatId: string; createdAt: number }[];
	publications: { revision: number; createdAt: number }[];
};
type Ports = {
	project: (project: string) => boolean;
	get: (id: string) => FleetJob | undefined;
	submit: (receipt: string, project: string, agent: FleetAgent, input: string) => FleetJob;
};
function reject(code: FleetJobError["statusCode"], message: string): never {
	throw new FleetJobError(code, message);
}
function bounded(value: unknown, limit: number, label: string) {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit)
		reject(400, `Invalid workflow ${label}.`);
	return value;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) reject(400, "Invalid workflow definition.");
	return value as Record<string, unknown>;
}
function definition(input: unknown): Definition {
	const d = object(input);
	const name = bounded(d.name, 100, "name").trim(),
		instructions = bounded(d.instructions, 6000, "instructions");
	if (d.agent !== "pi" && d.agent !== "codex" && d.agent !== "claude") reject(400, "Unknown workflow agent.");
	if (!Array.isArray(d.cases) || d.cases.length < 1 || d.cases.length > 8)
		reject(400, "Supply between one and eight evaluation cases.");
	return {
		name,
		instructions,
		agent: d.agent,
		cases: d.cases.map((v) => {
			const e = object(v);
			return { input: bounded(e.input, 3000, "case input"), expected: bounded(e.expected, 1000, "expected literal") };
		}),
	};
}
function key(value: unknown) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(value))
		reject(400, "Supply a stable workflow request ID.");
	return value;
}
function rev(value: number) {
	if (!Number.isSafeInteger(value) || value < 1) reject(400, "Invalid workflow revision.");
	return value;
}
function task(def: Definition, input: string) {
	return `Execute the following workflow instructions in your isolated project checkout.\n\nWorkflow: ${def.name}\n\nInstructions:\n${def.instructions}\n\nInput:\n${input}`;
}

export function createFleetFactory(db: DatabaseSync, ports: Ports) {
	db.exec(`CREATE TABLE IF NOT EXISTS factory_workflows(id TEXT PRIMARY KEY,project TEXT NOT NULL,name TEXT NOT NULL,head INTEGER NOT NULL,published INTEGER);
	CREATE TABLE IF NOT EXISTS factory_revisions(flow TEXT NOT NULL,revision INTEGER NOT NULL,definition TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(flow,revision));
	CREATE TABLE IF NOT EXISTS factory_evaluations(id TEXT PRIMARY KEY,flow TEXT NOT NULL,revision INTEGER NOT NULL,request TEXT NOT NULL,at INTEGER NOT NULL,UNIQUE(flow,request));
	CREATE TABLE IF NOT EXISTS factory_cases(evaluation TEXT NOT NULL,seq INTEGER NOT NULL,chat TEXT NOT NULL UNIQUE,expected TEXT NOT NULL,status TEXT NOT NULL,actual TEXT,PRIMARY KEY(evaluation,seq));
	CREATE TABLE IF NOT EXISTS factory_publications(flow TEXT NOT NULL,revision INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(flow,revision));
	CREATE TABLE IF NOT EXISTS factory_runs(flow TEXT NOT NULL,revision INTEGER NOT NULL,request TEXT NOT NULL,input_hash TEXT NOT NULL,chat TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(flow,request));`);
	function tx<T>(fn: () => T): T {
		db.exec("BEGIN IMMEDIATE");
		try {
			const val = fn();
			db.exec("COMMIT");
			return val;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	function project(name: string) {
		if (!ports.project(name)) reject(404, "Unknown project.");
	}
	function summary(p: string, id: string): Summary | undefined {
		project(p);
		return db
			.prepare("SELECT id,project,name,head,published FROM factory_workflows WHERE id=? AND project=?")
			.get(id, p) as unknown as Summary | undefined;
	}
	function requireFlow(p: string, id: string) {
		return summary(p, id) ?? reject(404, "Unknown workflow.");
	}
	function revision(id: string, n: number): Revision {
		const row = db.prepare("SELECT definition,at FROM factory_revisions WHERE flow=? AND revision=?").get(id, rev(n));
		if (!row) reject(404, "Unknown workflow revision.");
		return { ...(JSON.parse(String(row.definition)) as Definition), revision: n, createdAt: Number(row.at) };
	}
	function assess(job: FleetJob) {
		const c = db.prepare("SELECT expected,status FROM factory_cases WHERE chat=?").get(job.id);
		if (!c || c.status === "passed" || c.status === "failed") return;
		// An operator may later continue the chat. Score the first turn exactly once.
		const end = job.messages.findIndex((m, i) => i > 0 && m.role === "user");
		const first = job.messages.slice(1, end < 0 ? undefined : end);
		const answer = first.find((m) => m.role === "assistant" && m.kind !== "plan" && m.kind !== "memory");
		const error = first.find((m) => m.role === "system");
		const terminal = !!answer || !!error || end >= 0 || !["queued", "running"].includes(job.status);
		const status = terminal ? (answer?.text.includes(String(c.expected)) ? "passed" : "failed") : job.status;
		const actual = terminal ? (answer?.text ?? error?.text ?? "No completed worker answer.").slice(0, 800) : null;
		db.prepare("UPDATE factory_cases SET status=?,actual=? WHERE chat=?").run(status, actual, job.id);
	}
	function cases(id: string, input: Example[]): CaseResult[] {
		for (const row of db
			.prepare("SELECT chat FROM factory_cases WHERE evaluation=? AND status IN ('queued','running')")
			.all(id)) {
			const job = ports.get(String(row.chat));
			if (job) assess(job);
		}
		return db
			.prepare("SELECT seq,chat,status,actual FROM factory_cases WHERE evaluation=? ORDER BY seq")
			.all(id)
			.map((row) => ({
				...input[Number(row.seq)],
				chatId: String(row.chat),
				status: row.status as CaseResult["status"],
				...(row.actual === null ? {} : { actual: String(row.actual) }),
			}));
	}
	function get(p: string, id: string): Detail | undefined {
		const main = summary(p, id);
		if (!main) return;
		const revisions = db
			.prepare("SELECT revision,definition,at FROM factory_revisions WHERE flow=? ORDER BY revision DESC")
			.all(id)
			.map((row) => ({
				...(JSON.parse(String(row.definition)) as Definition),
				revision: Number(row.revision),
				createdAt: Number(row.at),
			}));
		const definitions = new Map(revisions.map((v) => [v.revision, v]));
		const evaluations: Evaluation[] = db
			.prepare("SELECT id,revision,at FROM factory_evaluations WHERE flow=? ORDER BY rowid DESC")
			.all(id)
			.map((row) => {
				const r = Number(row.revision);
				const results = cases(String(row.id), definitions.get(r)?.cases ?? []);
				const pending = results.some((c) => c.status === "queued" || c.status === "running");
				return {
					id: String(row.id),
					revision: r,
					status: pending
						? "running"
						: results.length && results.every((c) => c.status === "passed")
							? "passed"
							: "failed",
					createdAt: Number(row.at),
					cases: results,
				};
			});
		const runs = db
			.prepare("SELECT revision,chat AS chatId,at AS createdAt FROM factory_runs WHERE flow=? ORDER BY rowid DESC")
			.all(id) as unknown as Detail["runs"];
		const publications = db
			.prepare("SELECT revision,at AS createdAt FROM factory_publications WHERE flow=? ORDER BY rowid DESC")
			.all(id) as unknown as Detail["publications"];
		return { ...main, revisions, evaluations, runs, publications };
	}
	const detail = (p: string, id: string) => get(p, id) ?? reject(404, "Unknown workflow.");
	return {
		assess,
		list(p: string): Summary[] {
			project(p);
			return db
				.prepare("SELECT id,project,name,head,published FROM factory_workflows WHERE project=? ORDER BY rowid DESC")
				.all(p) as unknown as Summary[];
		},
		get,
		save(p: string, id: string | null, input: unknown): Detail {
			project(p);
			const d = definition(input),
				value = object(input);
			return tx(() => {
				let n = 1;
				const target = id ?? randomUUID();
				if (id !== null) {
					const flow = requireFlow(p, id);
					if (flow.head !== value.baseRevision) reject(409, "The draft revision changed. Reload before editing.");
					n = flow.head + 1;
					if (n > 100) reject(409, "Workflow revision limit reached.");
					db.prepare("UPDATE factory_workflows SET name=?,head=? WHERE id=?").run(d.name, n, id);
				} else {
					if (Number(db.prepare("SELECT count(*) AS n FROM factory_workflows").get()?.n) >= 64)
						reject(409, "Workflow capacity reached.");
					db.prepare("INSERT INTO factory_workflows(id,project,name,head) VALUES(?,?,?,?)").run(target, p, d.name, n);
				}
				db.prepare("INSERT INTO factory_revisions VALUES(?,?,?,?)").run(target, n, JSON.stringify(d), Date.now());
				return detail(p, target);
			});
		},
		evaluate(p: string, id: string, n: number, request: string): Detail {
			key(request);
			rev(n);
			return tx(() => {
				const flow = requireFlow(p, id);
				const prior = db
					.prepare("SELECT revision FROM factory_evaluations WHERE flow=? AND request=?")
					.get(id, request);
				if (prior) {
					if (prior.revision !== n) reject(409, "Evaluation request ID belongs to a different revision.");
					return detail(p, id);
				}
				if (flow.head !== n) reject(409, "Evaluate the current draft revision.");
				const d = revision(id, n),
					eid = randomUUID();
				db.prepare("INSERT INTO factory_evaluations VALUES(?,?,?,?,?)").run(eid, id, n, request, Date.now());
				for (const [i, c] of d.cases.entries()) {
					const job = ports.submit(`factory:evaluate:${eid}:${i}`, p, d.agent, task(d, c.input));
					db.prepare("INSERT INTO factory_cases(evaluation,seq,chat,expected,status) VALUES(?,?,?,?,?)").run(
						eid,
						i,
						job.id,
						c.expected,
						"queued",
					);
				}
				return detail(p, id);
			});
		},
		publish(p: string, id: string, n: number): Detail {
			rev(n);
			return tx(() => {
				const flow = detail(p, id);
				if (flow.head !== n) reject(409, "Publish the current draft revision.");
				if (flow.evaluations.find((e) => e.revision === n)?.status !== "passed")
					reject(409, "The latest evaluation of this exact revision must pass every case.");
				if (flow.published === n) return flow;
				db.prepare("UPDATE factory_workflows SET published=? WHERE id=?").run(n, id);
				db.prepare("INSERT INTO factory_publications VALUES(?,?,?)").run(id, n, Date.now());
				return detail(p, id);
			});
		},
		run(p: string, id: string, n: number, input: string, request: string): { chatId: string; revision: number } {
			key(request);
			rev(n);
			bounded(input, 6000, "run input");
			const digest = createHash("sha256").update(input).digest("hex");
			return tx(() => {
				const flow = requireFlow(p, id);
				const prior = db
					.prepare("SELECT revision,chat,input_hash FROM factory_runs WHERE flow=? AND request=?")
					.get(id, request);
				if (prior) {
					if (prior.revision !== n || prior.input_hash !== digest)
						reject(409, "Run request ID already belongs to different input or revision.");
					return { chatId: String(prior.chat), revision: n };
				}
				if (flow.published !== n) reject(409, "This revision is not currently published.");
				const d = revision(id, n);
				const job = ports.submit(`factory:run:${id}:${request}`, p, d.agent, task(d, input));
				db.prepare("INSERT INTO factory_runs VALUES(?,?,?,?,?,?)").run(id, n, request, digest, job.id, Date.now());
				return { chatId: job.id, revision: n };
			});
		},
	};
}
