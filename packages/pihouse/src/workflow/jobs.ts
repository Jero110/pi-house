import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

interface Payload {
	fingerprint: string;
	invocation?: string;
	attempts: number;
	lease?: { token: string; until: number };
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

export function enqueueJob(db: DatabaseSync, id: string, revision: string, fingerprint: string): void {
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
): boolean {
	return transaction(db, () => {
		const row = db.prepare("SELECT state, payload FROM jobs WHERE id = ?").get(claim.id);
		if (row?.state !== "running" || typeof row.payload !== "string") return false;
		const payload = JSON.parse(row.payload) as Payload;
		if (!payload.lease || payload.lease.token !== claim.token || payload.lease.until <= now) return false;
		delete payload.lease;
		if (outcome !== "cancelled") payload.attempts++;
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
