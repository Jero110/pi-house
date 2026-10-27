import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkflowEvidence, WorkflowEvidenceParticipant } from "./report.ts";

export interface PersistEvidenceInput {
	runId: string;
	revision: number;
	fingerprint: string;
	evidence: WorkflowEvidence;
	capturedAt: string;
}

const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]*$/i;

/** The canonical evidence fingerprint: exactly this JSON serialization, never a run.json file hash. */
export function evidenceFingerprint(evidence: WorkflowEvidence): string {
	return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

/**
 * Problem: capture numbers revisions per run, so bare "1" collides across runs and legacy revisions use ":".
 * Example: run-alpha and run-beta both capture revision 1. Solution: scope a safe id by run identity.
 */
export function revisionIdFor(runId: string, revision: number): string {
	if (!SAFE_RUN_ID.test(runId)) throw new Error(`Unsafe run id for a revision: ${JSON.stringify(runId)}`);
	if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(`Invalid revision number: ${String(revision)}`);
	return `${runId}.r${revision}`;
}

function known(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function participantMetric(participant: WorkflowEvidenceParticipant): Record<string, unknown> {
	return {
		participantId: participant.id,
		usage: {
			input: known(participant.usage.input),
			output: known(participant.usage.output),
			cacheRead: known(participant.usage.cacheRead),
			cacheWrite: known(participant.usage.cacheWrite),
		},
		activeMs: known(participant.activeMs),
		messages: known(participant.messages),
		summary: participant.summary
			? {
					assistantMessages: known(participant.summary.assistantMessages),
					slowestMs: known(participant.summary.slowestMs),
					failedToolCalls: known(participant.summary.failedToolCalls),
					toolCalls: known(participant.summary.toolCalls),
				}
			: null,
	};
}

function participantLineage(participant: WorkflowEvidenceParticipant): Record<string, unknown> {
	return {
		id: participant.id,
		parent: participant.parent,
		role: participant.role,
		harness: participant.harness,
		model: participant.model,
		taskId: participant.taskId,
		taskTitle: participant.taskTitle,
		assignedSkills: [...participant.assignedSkills],
		loadedSkills: [...participant.loadedSkills],
		missing: participant.missing,
		validation: "unknown",
		// Only a participant a routing decision chose carries the key; the payload of an unrouted run is unchanged.
		...(participant.routing ? { routing: participant.routing } : {}),
	};
}

function runMetrics(evidence: WorkflowEvidence): Record<string, number | null> {
	return {
		newTokens: known(evidence.metrics.newTokens),
		cacheRead: known(evidence.metrics.cacheRead),
		activeMs: known(evidence.metrics.activeMs),
		wallMs: known(evidence.metrics.wallMs),
		agents: known(evidence.metrics.agents) ?? 0,
		messages: known(evidence.metrics.messages),
	};
}

function runLineage(evidence: WorkflowEvidence): Record<string, unknown> {
	return {
		lineage: evidence.lineage,
		lineageStatus: evidence.lineageStatus ?? null,
		forkProvenance: evidence.forkProvenance ?? null,
		destructiveEligibility: evidence.destructiveEligibility ?? null,
		project: evidence.project,
		plan: evidence.plan,
	};
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

/**
 * Persist one immutable evidence snapshot into the operational schema. Same run/fingerprint is idempotent; a different
 * fingerprint under an existing revision is refused before any row is written. This function never deletes anything.
 */
export function persistEvidence(db: DatabaseSync, input: PersistEvidenceInput): string {
	const { runId, revision, fingerprint, evidence, capturedAt } = input;
	const revisionId = revisionIdFor(runId, revision);
	if (!capturedAt) throw new Error("capturedAt is required");
	const actual = evidenceFingerprint(evidence);
	if (fingerprint !== actual) throw new Error("Evidence fingerprint does not match the canonical JSON serialization");
	if (typeof evidence !== "object" || evidence === null || !Array.isArray(evidence.participants))
		throw new Error("Evidence participants are required");

	return transaction(db, () => {
		const existing = db.prepare("SELECT run_id, source_hash FROM revisions WHERE id = ?").get(revisionId);
		if (existing) {
			if (existing.run_id !== runId || existing.source_hash !== fingerprint)
				throw new Error(`Immutable revision conflict for ${revisionId}`);
			return revisionId;
		}
		const sameSnapshot = db
			.prepare("SELECT id FROM revisions WHERE run_id = ? AND source_hash = ? ORDER BY created_at, rowid LIMIT 1")
			.get(runId, fingerprint);
		if (typeof sameSnapshot?.id === "string") return sameSnapshot.id;

		db.prepare("INSERT INTO runs(id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(runId, capturedAt);
		db.prepare("INSERT INTO revisions(id, run_id, source_hash, created_at) VALUES (?, ?, ?, ?)").run(
			revisionId,
			runId,
			fingerprint,
			capturedAt,
		);

		let metric = 0;
		const insertMetric = db.prepare("INSERT INTO metrics(id, revision_id, kind, value) VALUES (?, ?, ?, ?)");
		const metricRow = (kind: string, value: unknown): void => {
			insertMetric.run(`${revisionId}.metric.${metric++}`, revisionId, kind, JSON.stringify(value));
		};
		const insertParticipant = db.prepare(
			"INSERT INTO participants(id, revision_id, role, payload) VALUES (?, ?, ?, ?)",
		);
		evidence.participants.forEach((participant, index) => {
			insertParticipant.run(
				`${revisionId}.participant.${index + 1}`,
				revisionId,
				participant.role,
				JSON.stringify(participantLineage(participant)),
			);
			metricRow(`participant.${index + 1}.usage`, {
				participantId: participant.id,
				input: known(participant.usage.input),
				output: known(participant.usage.output),
				cacheRead: known(participant.usage.cacheRead),
				cacheWrite: known(participant.usage.cacheWrite),
			});
			metricRow(`participant.${index + 1}.activity`, {
				participantId: participant.id,
				activeMs: known(participant.activeMs),
				messages: known(participant.messages),
				summary: participantMetric(participant).summary,
			});
		});
		metricRow("run.metrics", runMetrics(evidence));
		metricRow("run.lineage", runLineage(evidence));
		metricRow("validation", { outcome: "unknown" });
		return revisionId;
	});
}
