import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

interface Payload {
	fingerprint: string;
	invocation?: string;
	attempts: number;
	lease?: { token: string; until: number };
	artifactPath?: string;
	cleanup?: { invocation?: string; attempts: number; lease?: { token: string; until: number } };
}

export interface JobClaim {
	id: string;
	token: string;
}

export function isQuiescent(snapshot: {
	states: string[];
	deliveries: number | null;
	handoff: boolean | null;
	livenessKnown: boolean;
}): boolean {
	return (
		snapshot.livenessKnown &&
		snapshot.states.length > 0 &&
		snapshot.states.every((state) => state === "idle" || state === "stopped") &&
		snapshot.deliveries === 0 &&
		snapshot.handoff === false
	);
}

export function enqueueJob(db: DatabaseSync, id: string, revision: string | null, fingerprint: string): void {
	db.prepare("INSERT OR IGNORE INTO jobs(id, revision_id, state, payload) VALUES (?, ?, 'pending', ?)").run(
		id,
		revision,
		JSON.stringify({ fingerprint, attempts: 0 } satisfies Payload),
	);
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = work();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function claimJob(
	db: DatabaseSync,
	id: string,
	invocation: string,
	now: number,
	leaseMs: number,
	maxAttempts = 2,
): JobClaim | null {
	if (
		!invocation ||
		!Number.isFinite(now) ||
		!Number.isFinite(leaseMs) ||
		leaseMs <= 0 ||
		!Number.isInteger(maxAttempts) ||
		maxAttempts < 1
	)
		throw new Error("Invalid claim parameters");
	return transaction(db, () => {
		const row = db.prepare("SELECT state, payload FROM jobs WHERE id = ?").get(id);
		if (!row || typeof row.payload !== "string" || !["pending", "running", "failed"].includes(String(row.state)))
			return null;
		const payload = JSON.parse(row.payload) as Payload;
		if (payload.lease && payload.lease.until > now) return null;
		if (payload.invocation !== invocation) {
			payload.invocation = invocation;
			payload.attempts = 0;
		}
		if (payload.attempts >= maxAttempts) return null;
		const token = randomUUID();
		payload.lease = { token, until: now + leaseMs };
		db.prepare("UPDATE jobs SET state = 'running', payload = ? WHERE id = ?").run(JSON.stringify(payload), id);
		return { id, token };
	});
}

export function finishJob(
	db: DatabaseSync,
	claim: JobClaim,
	outcome: "success" | "failure" | "cancelled",
	fingerprint: string,
	now: number,
	artifactPath?: string,
): boolean {
	return transaction(db, () => {
		const row = db.prepare("SELECT state, payload FROM jobs WHERE id = ?").get(claim.id);
		if (row?.state !== "running" || typeof row.payload !== "string") return false;
		const payload = JSON.parse(row.payload) as Payload;
		if (!payload.lease || payload.lease.token !== claim.token || payload.lease.until <= now) return false;
		delete payload.lease;
		if (outcome !== "cancelled") payload.attempts++;
		if (outcome === "success" && fingerprint === payload.fingerprint && artifactPath)
			payload.artifactPath = artifactPath;
		const state =
			outcome === "cancelled"
				? "pending"
				: outcome === "failure"
					? "failed"
					: fingerprint === payload.fingerprint
						? "generated"
						: "deferred";
		db.prepare("UPDATE jobs SET state = ?, payload = ? WHERE id = ?").run(state, JSON.stringify(payload), claim.id);
		return true;
	});
}

export interface DispatchInput {
	id: string;
	revision: string;
	evidencePath: string;
	fingerprint: string;
}
export type DispatchResult =
	| { id: string; status: "failed" | "cancelled" | "deferred" | "lost" }
	| { id: string; status: "generated"; path: string };
export interface DispatchOptions {
	invocation: string;
	now: () => number;
	leaseMs: number;
	maxJobs: number;
	maxAttempts?: number;
	adapter: (request: {
		id: string;
		revision: string;
		evidencePath: string;
	}) => Promise<{ status: "success"; artifactPath: string; fingerprint: string } | { status: "failure" | "cancelled" }>;
}

function boundedPath(path: string): boolean {
	return path.startsWith("/") && path.length <= 1024 && !path.includes("\0");
}

export async function dispatchJobs(
	db: DatabaseSync,
	jobs: DispatchInput[],
	options: DispatchOptions,
): Promise<DispatchResult[]> {
	if (!Number.isInteger(options.maxJobs) || options.maxJobs < 1 || options.maxJobs > 100)
		throw new Error("Invalid dispatch bound");
	const results: DispatchResult[] = [];
	for (const job of jobs.slice(0, options.maxJobs)) {
		const row = db.prepare("SELECT revision_id, payload FROM jobs WHERE id = ?").get(job.id);
		if (
			!row ||
			row.revision_id !== job.revision ||
			typeof row.payload !== "string" ||
			!job.id ||
			job.id.length > 128 ||
			!job.revision ||
			job.revision.length > 128 ||
			!boundedPath(job.evidencePath)
		)
			continue;
		const payload = JSON.parse(row.payload) as Payload;
		if (payload.fingerprint !== job.fingerprint) continue;
		const claim = claimJob(db, job.id, options.invocation, options.now(), options.leaseMs, options.maxAttempts);
		if (!claim) continue;
		let response: Awaited<ReturnType<DispatchOptions["adapter"]>>;
		try {
			response = await options.adapter({ id: job.id, revision: job.revision, evidencePath: job.evidencePath });
		} catch {
			response = { status: "failure" };
		}
		if (response.status === "success" && !boundedPath(response.artifactPath)) response = { status: "failure" };
		const outcome =
			response.status === "success" ? "success" : response.status === "cancelled" ? "cancelled" : "failure";
		const fingerprint = response.status === "success" ? response.fingerprint : job.fingerprint;
		const path = response.status === "success" ? response.artifactPath : undefined;
		if (!finishJob(db, claim, outcome, fingerprint, options.now(), path)) results.push({ id: job.id, status: "lost" });
		else if (outcome === "success" && fingerprint !== job.fingerprint) results.push({ id: job.id, status: "deferred" });
		else if (outcome === "success" && path) results.push({ id: job.id, status: "generated", path });
		else results.push({ id: job.id, status: outcome === "cancelled" ? "cancelled" : "failed" });
	}
	return results;
}

// Generation alone is not deletion authority. For example, an adapter can return a path without a
// validated receipt. Integration must provide a verified, idempotent cleanup adapter; this port deletes nothing.
export async function dispatchCleanup(
	db: DatabaseSync,
	id: string,
	options: {
		invocation: string;
		now: () => number;
		leaseMs: number;
		maxAttempts?: number;
		adapter: (request: { id: string; artifactPath: string }) => Promise<"success" | "failure" | "cancelled">;
	},
): Promise<{ id: string; status: "cleaned" | "cleanup-failed" | "cancelled" | "unavailable" | "lost" }> {
	const maxAttempts = options.maxAttempts ?? 2;
	const now = options.now();
	if (
		!options.invocation ||
		!Number.isFinite(now) ||
		!Number.isFinite(options.leaseMs) ||
		options.leaseMs <= 0 ||
		!Number.isInteger(maxAttempts) ||
		maxAttempts < 1
	)
		throw new Error("Invalid cleanup claim parameters");
	const claim = transaction(db, () => {
		const row = db.prepare("SELECT state, payload FROM jobs WHERE id = ?").get(id);
		if (
			!row ||
			typeof row.payload !== "string" ||
			!["generated", "cleanup-failed", "cleanup-running"].includes(String(row.state))
		)
			return null;
		const payload = JSON.parse(row.payload) as Payload;
		if (!payload.artifactPath || !boundedPath(payload.artifactPath)) return null;
		const cleanup = payload.cleanup ?? { attempts: 0 };
		if (cleanup.lease && cleanup.lease.until > now) return null;
		if (cleanup.invocation !== options.invocation) {
			cleanup.invocation = options.invocation;
			cleanup.attempts = 0;
		}
		if (cleanup.attempts >= maxAttempts) return null;
		const token = randomUUID();
		cleanup.lease = { token, until: now + options.leaseMs };
		payload.cleanup = cleanup;
		db.prepare("UPDATE jobs SET state = 'cleanup-running', payload = ? WHERE id = ?").run(JSON.stringify(payload), id);
		return { token, artifactPath: payload.artifactPath };
	});
	if (!claim) return { id, status: "unavailable" };
	let outcome: "success" | "failure" | "cancelled";
	try {
		outcome = await options.adapter({ id, artifactPath: claim.artifactPath });
	} catch {
		outcome = "failure";
	}
	return transaction(db, () => {
		const row = db.prepare("SELECT state, payload FROM jobs WHERE id = ?").get(id);
		if (row?.state !== "cleanup-running" || typeof row.payload !== "string") return { id, status: "lost" };
		const payload = JSON.parse(row.payload) as Payload;
		const cleanup = payload.cleanup;
		if (!cleanup?.lease || cleanup.lease.token !== claim.token || cleanup.lease.until <= options.now())
			return { id, status: "lost" };
		delete cleanup.lease;
		if (outcome !== "cancelled") cleanup.attempts++;
		const state = outcome === "success" ? "cleaned" : outcome === "cancelled" ? "generated" : "cleanup-failed";
		db.prepare("UPDATE jobs SET state = ?, payload = ? WHERE id = ?").run(state, JSON.stringify(payload), id);
		return { id, status: outcome === "cancelled" ? "cancelled" : outcome === "success" ? "cleaned" : "cleanup-failed" };
	});
}
