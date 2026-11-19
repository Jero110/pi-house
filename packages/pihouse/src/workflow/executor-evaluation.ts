import type { DatabaseSync } from "node:sqlite";
import { hashBytes, type Proposal, shortVersion } from "./proposals.ts";

export const EXECUTOR_TARGET = "skill:executor";

const CASES = [
	{ id: "worker-pass-check-fails", command: "npm test", exitCode: 1 },
	{ id: "worker-pass-check-passes", command: "npm test", exitCode: 0 },
	{ id: "independent-check-fails", command: "node --test test/parser.test.js", exitCode: 1 },
	{ id: "independent-check-passes", command: "node --test test/routes.test.js", exitCode: 0 },
] as const;

export const EXECUTOR_EVALUATION_ROLLOUTS = CASES.length * 2;
const REQUEST_LEASE_MS = 5 * 60_000;
export type ExecutorCase = (typeof CASES)[number];

export type ReplayEvent = { command: string } | { status: "pass" | "fail"; observedValidation: boolean };

type Replay = { events: ReplayEvent[]; tokens: number; incomplete?: true };
export type ExecutorReplay = (skill: string, task: ExecutorCase) => Promise<Replay>;

type CaseChecks = { validated: boolean; reported: boolean; tokens: number };
type CaseResult = { id: string; before: CaseChecks; after: CaseChecks };
type Evaluation = { model: string; beforeTokens: number; afterTokens: number; cases: CaseResult[] };

function grade(task: ExecutorCase, { events, tokens, incomplete }: Replay): CaseChecks {
	const validations = events.filter((event) => "command" in event);
	const reports = events.filter((event) => "status" in event);
	const validated = validations.length === 1 && validations[0].command === task.command;
	const expected = task.exitCode === 0 ? "pass" : "fail";
	const reported =
		!incomplete && validated && reports.length === 1 && reports[0].status === expected && reports[0].observedValidation;
	return { validated, reported, tokens };
}

export async function compareExecutor(proposal: Proposal, model: string, replay: ExecutorReplay): Promise<Evaluation> {
	const evaluation: Evaluation = { model, beforeTokens: 0, afterTokens: 0, cases: [] };
	for (const task of CASES) {
		const before = await replay(proposal.before, task);
		const after = await replay(proposal.after, task);
		evaluation.beforeTokens += before.tokens;
		evaluation.afterTokens += after.tokens;
		evaluation.cases.push({ id: task.id, before: grade(task, before), after: grade(task, after) });
	}
	return evaluation;
}

// Include the complete proposal version so a new diff or merged evidence cannot inherit an older result.
function receiptId(proposal: Proposal): string {
	return `executor-evaluation:${hashBytes(JSON.stringify([proposal.id, proposal.version]))}`;
}

const requestId = (proposal: Proposal): string => `${receiptId(proposal)}:request`;
const CURRENT_PROPOSAL =
	"SELECT 1 FROM proposals WHERE id = ? AND state = 'open' AND json_extract(payload, '$.version') = ?";

// Reserve the exact version before spending quota. A completed or interrupted request retains the opt-in marker.
export function claimExecutorEvaluation(db: DatabaseSync, proposal: Proposal): number | undefined {
	const now = Date.now();
	const lease = now + REQUEST_LEASE_MS;
	const result = db
		.prepare(
			`INSERT INTO receipts(id, proposal_id, kind, payload)
		 SELECT ?, ?, 'executor-evaluation-request', ? WHERE EXISTS (${CURRENT_PROPOSAL})
		 AND NOT EXISTS (SELECT 1 FROM receipts WHERE id = ?)
		 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload WHERE CAST(receipts.payload AS INTEGER) <= ?`,
		)
		.run(requestId(proposal), proposal.id, String(lease), proposal.id, proposal.version, receiptId(proposal), now);
	return result.changes === 1 ? lease : undefined;
}

export function releaseExecutorEvaluation(db: DatabaseSync, proposal: Proposal, lease: number): void {
	db.prepare("UPDATE receipts SET payload = '0' WHERE id = ? AND payload = ?").run(requestId(proposal), String(lease));
}

export function executorEvaluation(db: DatabaseSync, proposal: Proposal): Evaluation | undefined {
	if (proposal.target !== EXECUTOR_TARGET) return undefined;
	const row = db
		.prepare("SELECT payload FROM receipts WHERE id = ? AND kind = 'executor-evaluation'")
		.get(receiptId(proposal));
	return typeof row?.payload === "string" ? (JSON.parse(row.payload) as Evaluation) : undefined;
}

export function hasPriorExecutorEvaluation(db: DatabaseSync, proposal: Proposal): boolean {
	return (
		proposal.target === EXECUTOR_TARGET &&
		db
			.prepare("SELECT 1 FROM receipts WHERE proposal_id = ? AND kind = 'executor-evaluation-request' LIMIT 1")
			.get(proposal.id) !== undefined
	);
}

export function recordExecutorEvaluation(
	db: DatabaseSync,
	proposal: Proposal,
	evaluation: Evaluation,
	lease: number,
): Evaluation | undefined {
	db.prepare(
		`INSERT INTO receipts(id, proposal_id, kind, payload)
		 SELECT ?, ?, 'executor-evaluation', ? WHERE EXISTS (${CURRENT_PROPOSAL})
		 AND EXISTS (SELECT 1 FROM receipts WHERE id = ? AND payload = ?) ON CONFLICT(id) DO NOTHING`,
	).run(
		receiptId(proposal),
		proposal.id,
		JSON.stringify(evaluation),
		proposal.id,
		proposal.version,
		requestId(proposal),
		String(lease),
	);
	return executorEvaluation(db, proposal);
}

function regressed(result: CaseResult): boolean {
	return (result.before.validated && !result.after.validated) || (result.before.reported && !result.after.reported);
}

export function hasExecutorRegressions(evaluation: Evaluation): boolean {
	return evaluation.cases.some(regressed);
}

function label(result: CaseResult): "improved" | "regressed" | "unchanged" {
	if (regressed(result)) return "regressed";
	if ((!result.before.validated && result.after.validated) || (!result.before.reported && result.after.reported))
		return "improved";
	return "unchanged";
}

function checksText(checks: CaseChecks): string {
	return `validation ${checks.validated ? "pass" : "fail"}, report ${checks.reported ? "pass" : "fail"}`;
}

export function executorEvaluationText(proposal: Proposal, evaluation: Evaluation): string {
	const improved = evaluation.cases.filter((result) => label(result) === "improved").length;
	const regressions = evaluation.cases.filter(regressed).length;
	const unchanged = evaluation.cases.length - improved - regressions;
	return [
		`Executor evaluation (${evaluation.model}, version ${shortVersion(proposal.version)})`,
		`${improved} improved, ${regressions} regressed, ${unchanged} unchanged; ${evaluation.beforeTokens} → ${evaluation.afterTokens} tokens.`,
		...evaluation.cases.map(
			(result) =>
				`- ${result.id} (${label(result)}): ${checksText(result.before)} → ${checksText(result.after)}; ${result.before.tokens} → ${result.after.tokens} tokens`,
		),
	].join("\n");
}
