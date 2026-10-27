import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DIGEST_SECTIONS, validateDigest } from "../src/workflow/digest-contract.ts";

const identity = { runId: "synthetic-run", project: "fixture-project", revision: "r1" };
const artifact = () => ({
	schemaVersion: 1,
	...identity,
	sections: Object.fromEntries(DIGEST_SECTIONS.map((key) => [key, "Recorded evidence."])),
});
const validate = (value: unknown, finish = "stop", maxChars = 12000) =>
	validateDigest(JSON.stringify(value), identity, finish, maxChars);

test("accepts complete bounded artifacts above the legacy cap", () => {
	const value = artifact();
	value.sections.objective = "x".repeat(2500);
	assert.equal(validate(value).ok, true);
});

test("rejects wrong identity, schema, missing or empty sections", () => {
	assert.equal(validate({ ...artifact(), runId: "other" }).ok, false);
	assert.equal(validate({ ...artifact(), schemaVersion: 2 }).ok, false);
	const value = artifact();
	delete value.sections.failures;
	assert.equal(validate(value).ok, false);
	value.sections.failures = "  ";
	assert.equal(validate(value).ok, false);
});

test("rejects malformed section containers and values", () => {
	for (const sections of [null, [], "text", 42]) {
		assert.equal(validate({ ...artifact(), sections }).ok, false);
	}
	for (const invalid of [null, [], {}, 42, false]) {
		assert.equal(validate({ ...artifact(), sections: { ...artifact().sections, participants: invalid } }).ok, false);
	}
	assert.equal(validate([]).ok, false);
	assert.equal(validate(null).ok, false);
});

test("rejects incomplete finish, malformed JSON and oversized output without truncation", () => {
	assert.equal(validate(artifact(), "length").ok, false);
	assert.equal(validate(artifact(), "unknown").ok, false);
	assert.equal(validateDigest("{", identity, "stop").ok, false);
	assert.equal(validate(artifact(), "stop", 10).ok, false);
	assert.equal(validate(artifact(), "stop", NaN).ok, false);
});
