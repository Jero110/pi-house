import assert from "node:assert/strict";
import test from "node:test";
import {
	buildReview,
	REVIEW_CHILD_MAX_CHARS,
	REVIEW_INPUT_MAX_CHARS,
	REVIEW_MAX_CHARS,
	REVIEW_PROMPT,
	REVIEW_SECTIONS,
	type ReviewIdentity,
	reviewContractText,
	reviewStamp,
} from "../src/workflow/review-contract.ts";

const identity: ReviewIdentity = {
	reviewId: "review-20261105T143000Z",
	covered: ["run-a.r2", "run-b.r1"],
	previousReview: "review-20261029T101500Z",
};
const meta = { generatedAt: "2026-11-05T14:30:00.000Z" };

function child(patch: Record<string, unknown> = {}, sections: Record<string, unknown> = {}, proposals: unknown[] = []) {
	return JSON.stringify({
		schemaVersion: 1,
		reviewId: identity.reviewId,
		covered: identity.covered,
		previousReview: identity.previousReview,
		sections: {
			...Object.fromEntries(REVIEW_SECTIONS.map((key) => [key, `text of ${key}`])),
			...sections,
		},
		proposals,
		...patch,
	});
}

const proposal = {
	kind: "edit-file",
	scope: "project",
	target: "file:/work/app/AGENTS.md",
	before: "a",
	after: "b",
	supporting: ["run-a.r2"],
	opposing: [],
	conditions: [],
	uncertainty: "low",
	validation: "read it",
};

test("reviewStamp formats the UTC timestamp the file name uses", () => {
	assert.equal(reviewStamp(new Date("2026-11-05T14:30:00.123Z")), "20261105T143000Z");
});

test("a valid child output renders the header, five sections and one fenced proposals block", () => {
	const built = buildReview(child({}, {}, [proposal]), identity, "stop", meta);
	assert.ok(built.ok, built.ok ? "" : built.reason);
	const text = built.markdown;
	assert.match(text, /^# Review: review-20261105T143000Z\n/);
	assert.match(text, /- Previous review: review-20261029T101500Z/);
	assert.match(text, /- Covered: run-a\.r2, run-b\.r1/);
	for (const heading of ["New runs", "Decisions", "Errors and failures", "Repeated patterns", "Carried forward"])
		assert.match(text, new RegExp(`\\n## ${heading}\\n`));
	assert.equal([...text.matchAll(/```json/g)].length, 1);
	const block = /```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "";
	assert.deepEqual(JSON.parse(block), { schemaVersion: 1, proposals: [proposal] });
	assert.ok(text.length <= REVIEW_MAX_CHARS);
});

test("a first review has no previous review and says so", () => {
	const first = { ...identity, previousReview: null };
	const built = buildReview(child({ previousReview: null }), first, "stop", meta);
	assert.ok(built.ok);
	assert.match(built.markdown, /- Previous review: none/);
});

const invalid: [string, string, () => string][] = [
	["not JSON", "invalid JSON", () => "not json"],
	["wrong schema version", "invalid schema", () => child({ schemaVersion: 2 })],
	["wrong review id", "wrong reviewId", () => child({ reviewId: "review-other" })],
	["covered with an extra revision", "wrong covered", () => child({ covered: [...identity.covered, "run-c.r1"] })],
	["covered missing a revision", "wrong covered", () => child({ covered: ["run-a.r2"] })],
	["covered in another order", "wrong covered", () => child({ covered: ["run-b.r1", "run-a.r2"] })],
	["wrong previous review", "wrong previousReview", () => child({ previousReview: "review-19990101T000000Z" })],
	["missing previous review", "wrong previousReview", () => child({ previousReview: null })],
	["an empty section", "missing section decisions", () => child({}, { decisions: "  " })],
	["a non-string section", "missing section errors", () => child({}, { errors: 3 })],
	["no sections", "missing sections", () => child({ sections: undefined })],
	["proposals that are not an array", "invalid proposals", () => child({ proposals: {} })],
	["a section with a code fence", "code fence", () => child({}, { patterns: "see ```json\n{}\n``` here" })],
	["over the child bound", "output bound exceeded", () => child({}, { newRuns: "x".repeat(REVIEW_CHILD_MAX_CHARS) })],
	[
		"over the rendered bound",
		"rendered review over the size bound",
		() => child({}, { newRuns: "x".repeat(REVIEW_MAX_CHARS) }),
	],
];
for (const [name, reason, make] of invalid) {
	test(`refuses ${name}`, () => {
		const built = buildReview(make(), identity, "stop", meta);
		assert.equal(built.ok, false);
		if (!built.ok) assert.match(built.reason, new RegExp(reason));
	});
}

test("refuses a finish reason other than stop", () => {
	const built = buildReview(child(), identity, "length", meta);
	assert.equal(built.ok, false);
	if (!built.ok) assert.match(built.reason, /finish/);
});

test("the contract text carries the exact identity the child must copy", () => {
	const text = reviewContractText(identity);
	assert.match(text, /review-20261105T143000Z/);
	assert.match(text, /"run-a\.r2"/);
	assert.match(text, /review-20261029T101500Z/);
	assert.match(text, new RegExp(String(REVIEW_CHILD_MAX_CHARS)));
});

test("the prompt calls the input untrusted and forbids transcripts", () => {
	assert.match(REVIEW_PROMPT, /untrusted/);
	assert.match(REVIEW_PROMPT, /transcript/);
	assert.ok(REVIEW_INPUT_MAX_CHARS === 60_000);
});
