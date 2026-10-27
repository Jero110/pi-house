import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createProposal, mergeEvidence, type Proposal } from "./proposals.ts";

const MAX_BLOCK = 100_000;
const MAX_PROPOSALS = 50;
const MAX_FIELD = 12_000;
export interface IntakeEntry {
	kind: string;
	scope: "project" | "global";
	target: string;
	before: string;
	after: string;
	supporting: string[];
	opposing: string[];
	conditions: string[];
	uncertainty: string;
	validation: string;
	reopen?: string;
}
export type IntakeResult =
	| { status: "ingested"; created: number; merged: number; suppressed: number }
	| { status: "failed"; reason: string };

function fail(db: DatabaseSync, reviewId: string, reason: string): IntakeResult {
	db.prepare(
		"INSERT INTO receipts(id, proposal_id, kind, payload) VALUES (?, NULL, 'intake-failure', ?) ON CONFLICT(id) DO NOTHING",
	).run(`intake-failure:${reviewId}`, JSON.stringify({ reviewId, reason }));
	return { status: "failed", reason };
}

function parseReview(text: string): IntakeEntry[] {
	if (text.length > MAX_BLOCK) throw new Error("review artifact exceeds limit");
	const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
	if (matches.length !== 1 || !matches[0]?.[1]) throw new Error("expected exactly one fenced JSON block");
	const parsed: unknown = JSON.parse(matches[0][1]);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!("schemaVersion" in parsed) ||
		parsed.schemaVersion !== 1 ||
		!("proposals" in parsed) ||
		!Array.isArray(parsed.proposals) ||
		parsed.proposals.length > MAX_PROPOSALS
	)
		throw new Error("invalid proposal block schema");
	return parsed.proposals.map((raw: unknown) => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid proposal entry");
		const value = raw as Record<string, unknown>;
		for (const key of ["kind", "target", "before", "after", "uncertainty", "validation"])
			if (typeof value[key] !== "string" || value[key].length > MAX_FIELD) throw new Error(`invalid ${key}`);
		if (value.scope !== "project" && value.scope !== "global") throw new Error("invalid scope");
		for (const key of ["supporting", "opposing", "conditions"])
			if (
				!Array.isArray(value[key]) ||
				value[key].length > 100 ||
				!(value[key] as unknown[]).every((x) => typeof x === "string" && x.length <= 500)
			)
				throw new Error(`invalid ${key}`);
		if (
			value.reopen !== undefined &&
			(typeof value.reopen !== "string" || !value.reopen.trim() || value.reopen.length > 1000)
		)
			throw new Error("invalid reopen explanation");
		if (!value.target || value.before === value.after) throw new Error("empty target or unchanged proposal");
		return value as unknown as IntakeEntry;
	});
}

function changeHash(before: string, after: string): string {
	return createHash("sha256")
		.update(`${before.replace(/\r\n/g, "\n")}\0${after.replace(/\r\n/g, "\n")}`)
		.digest("hex");
}

function resolveEntry(db: DatabaseSync, entry: IntakeEntry) {
	const support: string[] = [];
	for (const ref of entry.supporting) {
		const row = db.prepare("SELECT run_id FROM revisions WHERE id = ?").get(ref);
		if (!row) throw new Error(`unknown supporting digest reference: ${ref}`);
		support.push(String(row.run_id));
	}
	const opposing: string[] = [];
	for (const ref of entry.opposing) {
		const row = db.prepare("SELECT run_id FROM revisions WHERE id = ?").get(ref);
		if (!row) throw new Error(`unknown opposing digest reference: ${ref}`);
		opposing.push(String(row.run_id));
	}
	return {
		entry,
		support: [...new Set(support)],
		fingerprint: changeHash(entry.before, entry.after),
	};
}

/** Intake is all-or-nothing: malformed model output is recorded, never partially trusted. */
export function ingestReview(db: DatabaseSync, reviewId: string, review: string): IntakeResult {
	let entries: IntakeEntry[];
	try {
		entries = parseReview(review);
	} catch (error) {
		return fail(db, reviewId, String(error));
	}
	const prior = db
		.prepare("SELECT payload FROM receipts WHERE id = ? AND kind = 'proposal-intake'")
		.get(`intake:${reviewId}`);
	if (prior) return JSON.parse(String(prior.payload)) as IntakeResult;
	let resolved: ReturnType<typeof resolveEntry>[];
	try {
		resolved = entries.map((entry) => resolveEntry(db, entry));
	} catch (error) {
		return fail(db, reviewId, String(error));
	}
	let created = 0;
	let merged = 0;
	let suppressed = 0;
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const { entry, support, fingerprint } of resolved) {
			const rows = db.prepare("SELECT id, payload FROM proposals ORDER BY id").all();
			let match: (Proposal & { scope?: string; changeHash?: string }) | undefined;
			for (const row of rows) {
				const candidate = JSON.parse(String(row.payload)) as Proposal & { scope?: string; changeHash?: string };
				if (
					candidate.target === entry.target &&
					candidate.scope === entry.scope &&
					candidate.changeHash === fingerprint
				) {
					match = candidate;
					break;
				}
			}
			if (match?.state === "rejected" && (!entry.reopen || support.every((item) => match?.evidence.includes(item)))) {
				suppressed++;
				continue;
			}
			if (match && (match.state === "open" || match.state === "rejected")) {
				const newEvidence = support.filter((item) => !match?.evidence.includes(item));
				if (newEvidence.length === 0) {
					suppressed++;
					continue;
				}
				mergeEvidence(db, match.id, newEvidence, {
					kind: match.state === "rejected" ? "reopen" : "merge",
					explanation: entry.reopen ?? "Additional supporting run evidence",
				});
				merged++;
				continue;
			}
			if (match) {
				suppressed++;
				continue;
			}
			const id = `proposal-${createHash("sha256").update(`${reviewId}\0${entry.target}\0${entry.scope}\0${fingerprint}`).digest("hex").slice(0, 20)}`;
			const proposal = createProposal(db, {
				id,
				target: entry.target,
				before: entry.before,
				after: entry.after,
				evidence: support,
			});
			const extended = {
				...proposal,
				kind: entry.kind,
				scope: entry.scope,
				supporting: entry.supporting,
				opposing: entry.opposing,
				conditions: entry.conditions,
				uncertainty: entry.uncertainty,
				validation: entry.validation,
				changeHash: fingerprint,
			};
			db.prepare("UPDATE proposals SET payload = ? WHERE id = ?").run(JSON.stringify(extended), id);
			created++;
		}
		const result: IntakeResult = { status: "ingested", created, merged, suppressed };
		db.prepare("INSERT INTO receipts(id, proposal_id, kind, payload) VALUES (?, NULL, 'proposal-intake', ?)").run(
			`intake:${reviewId}`,
			JSON.stringify(result),
		);
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		return fail(db, reviewId, String(error));
	}
}
