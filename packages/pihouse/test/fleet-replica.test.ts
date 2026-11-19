import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { receiveReplica } from "../src/fleet-replica.ts";

test("publishes only complete verified images and retains previous verified recovery points on failure", async (t) => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "pih-replica-")));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	const fetch = async (p: string) => {
		writeFileSync(p, "source snapshot");
	};
	const verify = async (p: string) => {
		assert.equal(readFileSync(p, "utf8"), "source snapshot");
	};
	for (let i = 0; i < 4; i++) await receiveReplica(d, fetch, verify, Date.UTC(2026, 0, 1, 1, i));
	const saved = readdirSync(d)
		.filter((x) => x.endsWith(".snapshot"))
		.sort();
	assert.equal(saved.length, 3);
	const receipt = JSON.parse(readFileSync(join(d, "last-success.json"), "utf8"));
	assert.equal(receipt.file, saved.at(-1));
	await assert.rejects(
		receiveReplica(
			d,
			async (p) => {
				writeFileSync(p, "truncated");
			},
			verify,
		),
		/source snapshot/,
	);
	assert.deepEqual(
		readdirSync(d)
			.filter((x) => x.endsWith(".snapshot"))
			.sort(),
		saved,
	);
	assert.equal(JSON.parse(readFileSync(join(d, "last-success.json"), "utf8")).file, receipt.file);
	assert.ok(!readdirSync(d).some((f) => f.endsWith(".partial")));
});
