import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	chatId,
	initPackage,
	manifestHash,
	packFiles,
	snapshotLimit,
	timeLeft,
	unpackFiles,
} from "./fleet-backup-files.ts";
import type { createFleetJobs } from "./fleet-jobs.ts";
import { copySlackForRecovery } from "./fleet-slack.ts";

const script = fileURLToPath(import.meta.url);
const budget = 5 * 60_000;
type Config = { stateDir: string; memoryRepo?: string; projects: Record<string, string> };
type Jobs = Pick<ReturnType<typeof createFleetJobs>, "copyForRecovery" | "list" | "memorySource">;
type Artifact = { id: string; chat: string; size: number; sha256: string };
type JobEntry = { id: string; status: string; needsCheckout: boolean };
type Manifest = {
	format: "pih-fleet-snapshot-v1";
	createdAt: number;
	head: string;
	refs: string[];
	interrupted: string[];
	omittedActive: string[];
	checkouts: string[];
	chats: number;
	artifacts: Artifact[];
	slack: boolean;
};
function git(args: string[], deadline: number, cwd?: string) {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		timeout: timeLeft(deadline),
		maxBuffer: 16 * 1024 ** 2,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			PATH: process.env.PATH,
			GIT_TERMINAL_PROMPT: "0",
			GIT_ALLOW_PROTOCOL: "file",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	}).trim();
}
function refs(repo: string, deadline: number) {
	const raw = git(["--git-dir", repo, "for-each-ref", "--format=%(objectname) %(refname)"], deadline);
	return raw ? raw.split("\n").sort() : [];
}
function checkDb(db: DatabaseSync) {
	if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw Error("SQLite integrity check failed.");
}
function dbEvidence(path: string) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		db.exec("PRAGMA trusted_schema=OFF");
		checkDb(db);
		const rows: JobEntry[] = db
			.prepare(
				"SELECT id,status,EXISTS(SELECT 1 FROM json_each(messages) m WHERE json_extract(m.value,'$.role')='assistant' AND coalesce(json_extract(m.value,'$.kind'),'') NOT IN ('plan','memory')) AS needs FROM jobs ORDER BY id",
			)
			.all()
			.map((r) => ({ id: String(r.id), status: String(r.status), needsCheckout: r.needs === 1 }));
		const ids = new Set(rows.map((row) => String(row.id)));
		if (rows.some((row) => !chatId.test(String(row.id)))) throw Error("Invalid chat identity in snapshot.");
		const artifacts: Artifact[] = [];
		for (const row of db.prepare("SELECT id,chat,size,sha256,bytes FROM fleet_artifacts ORDER BY id").iterate()) {
			const bytes = row.bytes as Uint8Array,
				sha256 = createHash("sha256").update(bytes).digest("hex");
			if (!ids.has(String(row.chat)) || row.size !== bytes.length || row.sha256 !== sha256)
				throw Error("Artifact integrity check failed.");
			artifacts.push({ id: String(row.id), chat: String(row.chat), size: bytes.length, sha256 });
		}
		return { rows, ids, artifacts };
	} finally {
		db.close();
	}
}
function checkSlack(path: string, ids: Set<string>) {
	if (!existsSync(path)) return false;
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		db.exec("PRAGMA trusted_schema=OFF");
		checkDb(db);
		for (const row of db.prepare("SELECT chat FROM threads").iterate())
			if (!ids.has(String(row.chat))) throw Error("Slack binding has no chat.");
	} finally {
		db.close();
	}
	return true;
}
function equal(a: unknown, b: unknown) {
	return JSON.stringify(a) === JSON.stringify(b);
}
function checkoutsFor(state: string, rows: JobEntry[]) {
	const root = join(state, "checkouts");
	if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw Error("Unsafe checkout root.");
	return rows
		.filter((r) => {
			if (r.status === "running") return false;
			const present = !!lstatSync(join(root, r.id), { throwIfNoEntry: false });
			if (!present && r.needsCheckout && r.status !== "interrupted")
				throw Error("A previously used checkout is missing; snapshot was not published.");
			return present;
		})
		.map((r) => r.id);
}
export function createFleetSnapshot(config: Config, jobs: Jobs): string {
	const deadline = Date.now() + budget,
		state = realpathSync(config.stateDir);
	const recovery = join(state, "recovery");
	mkdirSync(recovery, { mode: 0o700, recursive: true });
	if (realpathSync(recovery) !== recovery || lstatSync(recovery).mode & 0o077)
		throw Error("Recovery output must be a private directory.");
	const stage = mkdtempSync(join(recovery, ".preparing-")),
		archive = join(stage, "package.sqlite"),
		target = join(recovery, `${randomUUID()}.snapshot`);
	try {
		// The same event loop commits job state, Slack receipts and local memory. While
		// this section runs no new turn can start. A running child may still be writing,
		// so its checkout is expressly omitted and its turn will be quarantined on restore.
		for (const project of Object.keys(config.projects)) jobs.memorySource(project);
		jobs.copyForRecovery(join(stage, "jobs.sqlite"));
		copySlackForRecovery(state, join(stage, "slack.sqlite"));
		const evidence = dbEvidence(join(stage, "jobs.sqlite")),
			repo = config.memoryRepo ?? join(state, "memory.git");
		const heads = refs(repo, deadline);
		const head = git(["--git-dir", repo, "symbolic-ref", "HEAD"], deadline);
		if (!head.startsWith("refs/heads/") || !heads.some((r) => r.endsWith(` ${head}`)))
			throw Error("Invalid memory HEAD.");
		git(["--git-dir", repo, "bundle", "create", join(stage, "memory.bundle"), "--all"], deadline);
		if (!equal(heads, refs(repo, deadline))) throw Error("Memory references changed during capture.");
		const manifest: Manifest = {
			format: "pih-fleet-snapshot-v1",
			createdAt: Date.now(),
			refs: heads,
			head,
			chats: evidence.rows.length,
			artifacts: evidence.artifacts,
			slack: checkSlack(join(stage, "slack.sqlite"), evidence.ids),
			interrupted: evidence.rows
				.filter((r) => r.status === "running" || r.status === "queued")
				.map((r) => String(r.id)),
			omittedActive: evidence.rows.filter((r) => r.status === "running").map((r) => String(r.id)),
			checkouts: checkoutsFor(state, evidence.rows),
		};
		const privateFile = openSync(archive, "wx", 0o600);
		closeSync(privateFile);
		const pack = new DatabaseSync(archive);
		try {
			initPackage(pack);
		} finally {
			pack.close();
		}
		execFileSync(process.execPath, [script, "pack", archive, stage, state, String(deadline)], {
			input: JSON.stringify(manifest.checkouts),
			timeout: timeLeft(deadline),
			stdio: ["pipe", "pipe", "pipe"],
			env: { PATH: process.env.PATH },
		});
		const db = new DatabaseSync(archive);
		try {
			const payload = JSON.stringify(manifest);
			db.prepare("INSERT INTO header VALUES(?,?)").run(payload, manifestHash(db, payload));
			checkDb(db);
		} finally {
			db.close();
		}
		renameSync(archive, target);
		return target;
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

function inspectPackage(path: string, stage: string, deadline: number) {
	const source = lstatSync(path);
	if (!source.isFile() || source.size > snapshotLimit * 1.1 + 128 * 1024 ** 2) throw Error("Invalid snapshot input.");
	const db = new DatabaseSync(path, { readOnly: true });
	let manifest: Manifest;
	let manifestSha256: string;
	try {
		db.exec("PRAGMA trusted_schema=OFF");
		checkDb(db);
		const heads = db.prepare("SELECT payload,digest FROM header LIMIT 2").all();
		if (heads.length !== 1) throw Error("Invalid snapshot header.");
		const payload = String(heads[0].payload);
		manifestSha256 = manifestHash(db, payload);
		if (heads[0].digest !== manifestSha256) throw Error("Snapshot manifest checksum mismatch.");
		manifest = JSON.parse(payload) as Manifest;
		if (manifest.format !== "pih-fleet-snapshot-v1") throw Error("Unsupported snapshot format.");
		unpackFiles(db, stage, deadline);
	} finally {
		db.close();
	}
	const evidence = dbEvidence(join(stage, "jobs.sqlite"));
	const present = readdirSync(join(stage, "checkouts")).sort();
	const interrupted = evidence.rows
		.filter((r) => r.status === "running" || r.status === "queued")
		.map((r) => String(r.id));
	const omitted = evidence.rows.filter((r) => r.status === "running").map((r) => String(r.id));
	if (
		!equal(interrupted, manifest.interrupted) ||
		!equal(omitted, manifest.omittedActive) ||
		present.some((id) => !evidence.ids.has(id) || omitted.includes(id)) ||
		evidence.rows.some(
			(r) => r.needsCheckout && r.status !== "running" && r.status !== "interrupted" && !present.includes(r.id),
		) ||
		!equal(present, manifest.checkouts) ||
		evidence.rows.length !== manifest.chats ||
		!equal(evidence.artifacts, manifest.artifacts) ||
		checkSlack(join(stage, "slack.sqlite"), evidence.ids) !== manifest.slack
	)
		throw Error("Snapshot evidence integrity mismatch.");
	const repo = join(stage, "memory.git"),
		bundle = join(stage, "memory.bundle");
	mkdirSync(repo, { mode: 0o700 });
	git(["init", "--bare", "--template=", "--initial-branch=main", repo], deadline);
	git(["--git-dir", repo, "bundle", "verify", bundle], deadline);
	git(["--git-dir", repo, "fetch", "--no-write-fetch-head", "--no-tags", bundle, "refs/*:refs/*"], deadline);
	if (!manifest.head.startsWith("refs/heads/") || !manifest.refs.some((r) => r.endsWith(` ${manifest.head}`)))
		throw Error("Invalid memory HEAD.");
	git(["--git-dir", repo, "symbolic-ref", "HEAD", manifest.head], deadline);
	git(["--git-dir", repo, "fsck", "--strict", "--no-reflogs"], deadline);
	if (!equal(refs(repo, deadline), manifest.refs)) throw Error("Memory reference integrity mismatch.");
	unlinkSync(bundle);
	return {
		format: manifest.format,
		createdAt: manifest.createdAt,
		manifestSha256,
		chats: manifest.chats,
		artifacts: manifest.artifacts.length,
		gitRefs: manifest.refs,
		checkouts: present.length,
		interrupted,
		omittedActive: omitted,
		slack: manifest.slack,
	};
}
export function verifyFleetSnapshot(path: string) {
	const temp = mkdtempSync(join(tmpdir(), "fleet-verify-"));
	try {
		return inspectPackage(path, temp, Date.now() + budget);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}
export function restoreFleetSnapshot(path: string, destination: string) {
	const target = resolve(destination),
		parent = dirname(target);
	if (realpathSync(parent) !== parent || lstatSync(target, { throwIfNoEntry: false }))
		throw Error("Restore requires a new directory under a canonical parent; destination already exists or is unsafe.");
	const stage = mkdtempSync(join(parent, ".fleet-restore-"));
	try {
		const report = inspectPackage(path, stage, Date.now() + budget);
		mkdirSync(target, { mode: 0o700 }); // Exclusive creation also protects against concurrent restores.
		writeFileSync(join(target, "RESTORE-INCOMPLETE"), "", { mode: 0o600, flag: "wx" });
		for (const name of readdirSync(stage)) renameSync(join(stage, name), join(target, name));
		unlinkSync(join(target, "RESTORE-INCOMPLETE"));
		return report;
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}
const socketName = "backup.sock";
export async function serveFleetBackup(config: Config, jobs: Jobs) {
	const path = join(config.stateDir, socketName);
	if (Buffer.byteLength(path) > 100)
		throw Error("Use a shorter fleet state directory for the private recovery socket.");
	const stale = lstatSync(path, { throwIfNoEntry: false });
	if (stale) {
		if (!stale.isSocket()) throw Error("Backup socket path is occupied.");
		unlinkSync(path);
	}
	const server = createServer((socket) => {
		socket.setTimeout(10000, () => socket.destroy());
		let request = "";
		socket.on("error", () => {});
		socket.on("data", (data) => {
			request += data.toString("utf8");
			if (request.length > 32) return void socket.destroy();
			if (!request.includes("\n")) return;
			socket.removeAllListeners("data");
			socket.setTimeout(0);
			if (request !== "snapshot\n") return void socket.end("ERROR Unsupported recovery request.\n");
			try {
				socket.end(`${createFleetSnapshot(config, jobs)}\n`);
			} catch (error) {
				process.stderr.write(`Fleet snapshot failed: ${error instanceof Error ? error.message : "capture error"}\n`);
				socket.end("ERROR Snapshot failed. Inspect the private service log.\n");
			}
		});
	});
	try {
		await new Promise<void>((yes, no) => {
			server.once("error", no);
			server.listen(path, () => {
				server.off("error", no);
				yes();
			});
		});
		chmodSync(path, 0o600);
	} catch (error) {
		server.close();
		throw error;
	}
	return { close: () => server.close() };
}
export function requestFleetSnapshot(stateDir: string): Promise<string> {
	return new Promise((yes, no) => {
		const socket = createConnection(join(stateDir, socketName));
		let reply = "";
		socket.setTimeout(budget + 15000, () => socket.destroy(Error("Snapshot request timed out.")));
		socket.on("connect", () => socket.write("snapshot\n"));
		socket.on("data", (b) => {
			reply += b;
			if (reply.length > 4096) socket.destroy(Error("Invalid snapshot response."));
		});
		socket.on("error", no);
		socket.on("end", () => {
			const path = reply.trim();
			if (dirname(path) !== join(stateDir, "recovery") || !path.endsWith(".snapshot"))
				no(Error(path || "No snapshot response."));
			else yes(path);
		});
	});
}
if (import.meta.main) {
	try {
		const [action, ...args] = process.argv.slice(2);
		if (action === "pack" && args.length === 4) {
			const db = new DatabaseSync(args[0]);
			try {
				db.exec("BEGIN IMMEDIATE");
				packFiles(db, args[1], args[2], JSON.parse(readFileSync(0, "utf8")), Number(args[3]));
				db.exec("COMMIT");
			} finally {
				db.close();
			}
		} else if (action === "snapshot" && args.length === 1) {
			const config = JSON.parse(readFileSync(args[0], "utf8"));
			process.stdout.write(`${await requestFleetSnapshot(realpathSync(config.stateDir))}\n`);
		} else if (action === "verify" && args.length === 1)
			process.stdout.write(`${JSON.stringify(verifyFleetSnapshot(args[0]))}\n`);
		else if (action === "restore" && args.length === 2)
			process.stdout.write(`${JSON.stringify(restoreFleetSnapshot(args[0], args[1]))}\n`);
		else
			throw Error(
				"Usage: fleet-backup.ts snapshot <host.json> | verify <snapshot> | restore <snapshot> <new-state-dir>",
			);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "Recovery operation failed."}\n`);
		process.exitCode = 1;
	}
}
