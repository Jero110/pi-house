import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectJsonlCursor, type JsonlSourceCursor } from "../src/workflow/source-cursor.ts";

function fixture(): { dir: string; source: string } {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-source-cursor-"));
	return { dir, source: join(dir, "session.jsonl") };
}

const header = JSON.stringify({ type: "session", id: "session-a", cwd: "/synthetic" });
const entry = (id: string) =>
	JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: `synthetic ${id}` },
	});

test("same-timestamp JSONL append verifies the prefix and returns only appended records", () => {
	const { source } = fixture();
	writeFileSync(source, `${header}\n${entry("one")}\n`);
	const initial = inspectJsonlCursor(source, "session-a", null);
	assert.equal(initial.state, "verified");
	if (initial.state !== "verified") return;
	writeFileSync(source, `${header}\n${entry("one")}\n${entry("two")}\n`);
	const next = inspectJsonlCursor(source, "session-a", initial.cursor);
	assert.equal(next.state, "verified");
	if (next.state !== "verified") return;
	assert.deepEqual(next.appendedRecordIds, ["two"]);
	assert.match(next.appendedText, /synthetic two/);
	assert.doesNotMatch(next.appendedText, /synthetic one/);
	assert.equal(next.cursor.byteOffset, Buffer.byteLength(`${header}\n${entry("one")}\n${entry("two")}\n`));
});

test("truncated or rotated JSONL source defers instead of treating old history as a new capture", () => {
	const { source } = fixture();
	writeFileSync(source, `${header}\n${entry("one")}\n`);
	const initial = inspectJsonlCursor(source, "session-a", null);
	assert.equal(initial.state, "verified");
	if (initial.state !== "verified") return;
	writeFileSync(source, `${header}\n${entry("replacement")}\n`);
	assert.equal(inspectJsonlCursor(source, "session-a", initial.cursor).state, "deferred");
});

test("a missing retained copy does not prevent native JSONL cursor verification", () => {
	const { dir, source } = fixture();
	writeFileSync(source, `${header}\n${entry("one")}\n`);
	const initial = inspectJsonlCursor(source, "session-a", null);
	assert.equal(initial.state, "verified");
	if (initial.state !== "verified") return;
	rmSync(join(dir, "captured-copy.json"), { force: true });
	writeFileSync(source, `${header}\n${entry("one")}\n${entry("two")}\n`);
	const next = inspectJsonlCursor(source, "session-a", initial.cursor);
	assert.equal(next.state, "verified");
	if (next.state !== "verified") return;
	assert.deepEqual(next.appendedRecordIds, ["two"]);
});

test("JSONL fork parent metadata is retained when observable", () => {
	const { source } = fixture();
	writeFileSync(
		source,
		`${JSON.stringify({ type: "session", id: "session-a", parentSessionId: "session-parent" })}\n${entry("one")}\n`,
	);
	const result = inspectJsonlCursor(source, "session-a", null);
	assert.equal(result.state, "verified");
	if (result.state !== "verified") return;
	assert.equal(result.cursor.forkedFrom, "session-parent");
});

test("changed session identity and unsupported cursor provenance defer", () => {
	const { source } = fixture();
	writeFileSync(source, `${header}\n${entry("one")}\n`);
	const initial = inspectJsonlCursor(source, "session-a", null);
	assert.equal(initial.state, "verified");
	if (initial.state !== "verified") return;
	assert.equal(inspectJsonlCursor(source, "session-b", initial.cursor).state, "deferred");
	assert.equal(
		inspectJsonlCursor(source, "session-a", {
			...initial.cursor,
			sourceKind: "native-unknown",
		} as unknown as JsonlSourceCursor).state,
		"deferred",
	);
});
