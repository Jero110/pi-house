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
