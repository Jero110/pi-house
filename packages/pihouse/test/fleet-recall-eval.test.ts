import assert from "node:assert/strict";
import { test } from "node:test";
import type { FleetJob } from "../src/fleet-jobs.ts";
import { addFeedback, evaluateRecall, promoteRecall, type RecallEvaluation } from "../src/fleet-recall-eval.ts";

test("a higher aggregate holdout score with one lost answer is ineligible and spends the whole cohort", () => {
	const state: RecallEvaluation = { profile: "balanced", revision: 0, lastTrial: 0, examples: [], trials: [] };
	const rows: FleetJob[] = [];
	for (let i = 0; i < 9; i++) {
		const q = `reference${i}`;
		const evidenceOnly = i === 8;
		for (const [id, title, text] of [
			[`target${i}`, evidenceOnly ? "other" : q, evidenceOnly ? q : "other"],
			[`distractor${i}`, evidenceOnly ? q : "other", evidenceOnly ? "other" : q],
		])
			rows.push({
				id,
				title,
				project: "p",
				agent: "pi",
				status: "completed",
				updatedAt: 10,
				messages: [{ role: "assistant", text }],
			});
		addFeedback(state, `target${i}`, q);
	}
	const source = () => ({
		list: () => rows,
		get: (id: string) => rows.find((r) => r.id === id),
		evidenceDigest: () => "verified-fixture",
	});
	assert.match(evaluateRecall(state, "p", "review", source), /incumbent was retained/);
	const trial = state.trials[0];
	assert.deepEqual(trial.holdout, { total: 3, incumbent: 1, candidate: 2 });
	assert.equal(trial.holdoutCases?.filter((c) => c.incumbentHit && !c.candidateHit).length, 1);
	assert.equal(trial.evaluatedIn, "review");
	assert.equal(state.profile, "balanced");
	assert.match(promoteRecall(state, "p", "owner", trial.id ?? "", source), /ineligible/);
	assert.match(evaluateRecall(state, "p", "review", source), /0 fresh holdout/);
	assert.equal(state.trials.length, 1);
});
