import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ProposalState = "open" | "approved" | "applying" | "applied" | "failed" | "rejected" | "superseded";
export interface Proposal {
	id: string;
	target: string;
	before: string;
	after: string;
	evidence: string[];
	version: string;
	state: ProposalState;
	reason?: string;
	history?: { state: ProposalState; version: string; reason?: string; explanation: string }[];
}

export function hashBytes(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function createProposal(
	db: DatabaseSync,
	input: Pick<Proposal, "id" | "target" | "before" | "after" | "evidence">,
): Proposal {
	if (!input.id || !input.target || input.before === input.after) throw new Error("Invalid or unchanged proposal");
	const evidence = [...new Set(input.evidence)].sort();
	const version = hashBytes(JSON.stringify({ ...input, evidence }));
	const proposal: Proposal = { ...input, evidence, version, state: "open" };
	db.prepare("INSERT INTO proposals(id, state, payload) VALUES (?, ?, ?)").run(
		input.id,
		proposal.state,
		JSON.stringify(proposal),
	);
	return proposal;
}

export function getProposal(db: DatabaseSync, id: string): Proposal {
	const row = db.prepare("SELECT state, payload FROM proposals WHERE id = ?").get(id);
	if (!row || typeof row.payload !== "string") throw new Error("Proposal not found");
	const proposal = JSON.parse(row.payload) as Proposal;
	if (proposal.id !== id || proposal.state !== row.state) throw new Error("Proposal state conflict");
	return proposal;
}

export type ProposalIdResolution =
	| { status: "found"; proposal: Proposal }
	| { status: "none" }
	| { status: "ambiguous"; matches: string[] };

export function listProposals(db: DatabaseSync, options: { states?: ProposalState[]; limit?: number } = {}) {
	const limit = options.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new Error("Proposal list limit must be between 1 and 100");
	const rows = options.states?.length
		? db
				.prepare(
					`SELECT id, state, payload FROM proposals WHERE state IN (${options.states.map(() => "?").join(",")}) ORDER BY id LIMIT ?`,
				)
				.all(...options.states, limit)
		: db.prepare("SELECT id, state, payload FROM proposals ORDER BY id LIMIT ?").all(limit);
	return rows.map((row) => {
		const value = JSON.parse(String(row.payload)) as Proposal & { kind?: string; scope?: string };
		const supportingRuns = new Set(value.evidence).size;
		return {
			id: value.id,
			target: value.target,
			state: String(row.state) as ProposalState,
			...(value.kind ? { kind: value.kind } : {}),
			...(value.scope ? { scope: value.scope } : {}),
			supportingRuns,
			nextAction:
				value.state === "open"
					? "approve or reject"
					: value.state === "approved"
						? "apply"
						: value.state === "applied"
							? "none"
							: value.state === "failed"
								? "inspect and revise"
								: value.state === "rejected"
									? "none"
									: "inspect",
		};
	});
}

export function resolveProposalId(db: DatabaseSync, prefix: string): ProposalIdResolution {
	if (!/^[a-z0-9-]{1,64}$/i.test(prefix)) return { status: "none" };
	const ids = db
		.prepare("SELECT id FROM proposals WHERE substr(id, 1, ?) = ? ORDER BY id LIMIT 2")
		.all(prefix.length, prefix)
		.map((row) => String(row.id));
	if (ids.length === 0) return { status: "none" };
	if (ids.length > 1) return { status: "ambiguous", matches: ids };
	return { status: "found", proposal: getProposal(db, ids[0] ?? "") };
}

export async function recoverApplying(db: DatabaseSync, id: string, target: ScopedTarget): Promise<Proposal> {
	const proposal = getProposal(db, id);
	if (proposal.state !== "applying") throw new Error("Proposal is not applying");
	if (db.prepare("SELECT 1 AS hit FROM receipts WHERE proposal_id = ? AND kind = 'application'").get(id))
		throw new Error("Application receipt exists; recovery requires explicit receipt verification");
	const observed = await target.read();
	const state = observed === proposal.before ? "before" : observed === proposal.after ? "after" : "other";
	return transition(db, proposal, "failed", `Recovered interrupted application; observed target state: ${state}`);
}

function transition(db: DatabaseSync, proposal: Proposal, state: ProposalState, reason?: string): Proposal {
	const next: Proposal = { ...proposal, state, ...(reason === undefined ? {} : { reason }) };
	const result = db
		.prepare("UPDATE proposals SET state = ?, payload = ? WHERE id = ? AND state = ? AND payload = ?")
		.run(state, JSON.stringify(next), proposal.id, proposal.state, JSON.stringify(proposal));
	if (result.changes !== 1) throw new Error("Proposal changed concurrently");
	return next;
}

export function approveProposal(db: DatabaseSync, id: string, version: string): Proposal {
	const proposal = getProposal(db, id);
	if (proposal.state !== "open") throw new Error("Proposal is not open");
	if (proposal.version !== version) throw new Error("Proposal version changed");
	return transition(db, proposal, "approved");
}

export function rejectProposal(db: DatabaseSync, id: string, reason: string): Proposal {
	const proposal = getProposal(db, id);
	if (!["open", "approved"].includes(proposal.state)) throw new Error("Proposal cannot be rejected");
	return transition(db, proposal, "rejected", reason);
}

// A trusted review must identify material new evidence; matching words alone cannot
// establish semantic equivalence or undo a prior human rejection.
export function mergeEvidence(
	db: DatabaseSync,
	id: string,
	evidence: string[],
	decision: { kind: "merge" | "reopen"; explanation: string },
): Proposal {
	const proposal = getProposal(db, id);
	if (!decision.explanation.trim() || decision.explanation.length > 1000 || evidence.length > 100)
		throw new Error("Invalid review decision");
	if (proposal.state !== "open" && proposal.state !== "rejected") throw new Error("Proposal cannot receive evidence");
	if ((proposal.state === "rejected") !== (decision.kind === "reopen"))
		throw new Error("Explicit reopen required for rejection");
	const merged = [...new Set([...proposal.evidence, ...evidence])].sort();
	if (merged.length === proposal.evidence.length) throw new Error("No new evidence");
	const version = hashBytes(
		JSON.stringify({
			id: proposal.id,
			target: proposal.target,
			before: proposal.before,
			after: proposal.after,
			evidence: merged,
			prior: proposal.version,
		}),
	);
	const next: Proposal = {
		...proposal,
		state: "open",
		evidence: merged,
		version,
		history: [
			...(proposal.history ?? []),
			{ state: proposal.state, version: proposal.version, reason: proposal.reason, explanation: decision.explanation },
		],
	};
	const result = db
		.prepare("UPDATE proposals SET state = ?, payload = ? WHERE id = ? AND state = ? AND payload = ?")
		.run(next.state, JSON.stringify(next), id, proposal.state, JSON.stringify(proposal));
	if (result.changes !== 1) throw new Error("Proposal changed concurrently");
	return next;
}

// The caller must provide an atomic, target-scoped compare-and-swap. A read followed
// by an ordinary write can overwrite an edit made between those operations.
export interface ScopedTarget {
	read(): Promise<string>;
	compareAndSwap(expected: string, replacement: string): Promise<boolean>;
	validate(): Promise<boolean>;
}

export async function applyProposal(db: DatabaseSync, id: string, target: ScopedTarget): Promise<Proposal> {
	let proposal = getProposal(db, id);
	if (proposal.state !== "approved") throw new Error("Proposal is not approved");
	if (proposal.before === "")
		return transition(
			db,
			proposal,
			"failed",
			"Legacy hypothesis has no verified before-state; create a concrete proposal before applying",
		);
	proposal = transition(db, proposal, "applying");
	try {
		if ((await target.read()) !== proposal.before) throw new Error("Target changed since approval");
		if (!(await target.compareAndSwap(proposal.before, proposal.after)))
			throw new Error("Target changed during application");
		if ((await target.read()) !== proposal.after) throw new Error("Application effect not observed");
		if (!(await target.validate())) throw new Error("Validation failed");
		if ((await target.read()) !== proposal.after) throw new Error("Target changed during validation");
		db.exec("BEGIN IMMEDIATE");
		try {
			const applied = transition(db, proposal, "applied");
			db.prepare("INSERT INTO receipts(id, proposal_id, kind, payload) VALUES (?, ?, ?, ?)").run(
				id,
				id,
				"application",
				JSON.stringify({
					version: proposal.version,
					target: proposal.target,
					beforeHash: hashBytes(proposal.before),
					afterHash: hashBytes(proposal.after),
					validation: true,
				}),
			);
			db.exec("COMMIT");
			return applied;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} catch (error) {
		return transition(db, proposal, "failed", String(error));
	}
}

export async function rollbackProposal(db: DatabaseSync, id: string, target: ScopedTarget): Promise<void> {
	const proposal = getProposal(db, id);
	if (proposal.state !== "applied") throw new Error("Proposal is not applied");
	const receipt = db
		.prepare("SELECT payload FROM receipts WHERE id = ? AND proposal_id = ? AND kind = 'application'")
		.get(id, id);
	if (!receipt || typeof receipt.payload !== "string") throw new Error("Application receipt missing");
	const recorded = JSON.parse(receipt.payload) as { version: string; beforeHash: string; afterHash: string };
	if (
		recorded.version !== proposal.version ||
		recorded.beforeHash !== hashBytes(proposal.before) ||
		recorded.afterHash !== hashBytes(proposal.after)
	)
		throw new Error("Receipt mismatch");
	if ((await target.read()) !== proposal.after || !(await target.compareAndSwap(proposal.after, proposal.before)))
		throw new Error("Target changed; rollback refused");
	if ((await target.read()) !== proposal.before) throw new Error("Rollback effect not observed");
	transition(db, proposal, "superseded", "Rolled back");
}
