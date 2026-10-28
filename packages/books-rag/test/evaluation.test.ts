import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateSynthetic, syntheticEmbedding } from "../src/evaluate.ts";
import { answerableCases, unrelatedCases } from "./evaluation-fixtures.ts";

test("text-derived fake vectors are deterministic, task-prefix independent, and not constant", () => {
	assert.deepEqual(
		syntheticEmbedding("search_document: precise_identifier"),
		syntheticEmbedding("search_query: precise_identifier"),
	);
	assert.notDeepEqual(syntheticEmbedding("precise_identifier"), syntheticEmbedding("different_identifier"));
	assert.ok(Math.abs(Math.hypot(...syntheticEmbedding("a multilingual identifier")) - 1) < 1e-12);
	assert.ok(answerableCases.length >= 20);
	assert.ok(answerableCases.some((q) => q.span.page === 1 && q.figure !== null));
	assert.ok(answerableCases.filter((q) => q.spanish !== null).length >= 10);
	assert.equal(unrelatedCases.length, 10);
});

test("synthetic PDF ingest to hosted search/read/next-page figures works on empty second stores at two frozen chunk bounds", async () => {
	const report = await evaluateSynthetic();
	assert.equal(report.kind, "synthetic-pipeline-only");
	assert.equal(report.corpusHash, "sha256:d87bb8167970c95a005dd07c1ceae610249cff67ee3150af4d66e35a515d00f9");
	assert.deepEqual(report.gate, { minimumScore: 0.78, maximumDrop: 0.08, version: "synthetic-cosine-v1" });
	assert.deepEqual(
		report.runs.map((r) => r.targetBound),
		[180, 320],
	);
	assert.notEqual(report.runs[0]?.chunks, report.runs[1]?.chunks);
	for (const run of report.runs) {
		assert.ok(run.recallAt5 >= 0.9);
		assert.deepEqual(run.falseNegatives, []);
		assert.deepEqual(run.falsePositives, []);
		assert.deepEqual(run.citationFailures, []);
		assert.deepEqual(run.figureFailures, []);
		assert.equal(run.unrelatedAbstentions, 10);
		assert.ok(run.provenanceChecks >= 24);
		assert.ok(run.unnecessaryCharacters > 0);
		assert.ok(run.redundantCharacters > 0);
	}
	assert.equal(report.passed, true);
	assert.match(report.liveEvaluation, /^NOT RUN:/u);
	console.log(
		JSON.stringify({
			corpusHash: report.corpusHash,
			answerable: report.answerable,
			unrelated: report.unrelated,
			runs: report.runs,
			liveEvaluation: report.liveEvaluation,
		}),
	);
});
