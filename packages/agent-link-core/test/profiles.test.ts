import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harnessNames, loadProfiles, parseProfile } from "../src/profiles.ts";

test("the shipped profiles load: the four harnesses with their adapters and defaults", () => {
	const profiles = loadProfiles();
	assert.deepEqual([...profiles.keys()].sort(), ["claude", "codex", "opencode", "pi"]);
	assert.equal(profiles.get("claude")?.adapter, "claude");
	assert.equal(profiles.get("opencode")?.defaultModel, "opencode/glm-5.3-flash-free");
	assert.equal(profiles.get("codex")?.defaultModel, null);
	assert.ok(profiles.get("claude")?.dialogs.some((d) => d.name === "trust"));
});

test("a paste profile in another folder adds a harness; spawn offers it after the four", () => {
	const dir = mkdtempSync(join(tmpdir(), "xl-prof-"));
	try {
		writeFileSync(
			join(dir, "aider.json"),
			JSON.stringify({
				harness: "aider",
				adapter: "paste",
				label: "Aider",
				defaultModel: null,
				dialogs: [],
				command: ["aider", "--model", "{model}"],
			}),
		);
		const profiles = loadProfiles([join(import.meta.dirname, "../profiles"), dir, join(dir, "missing")]);
		assert.deepEqual(profiles.get("aider")?.command, ["aider", "--model", "{model}"]);
		assert.deepEqual(harnessNames(profiles), ["claude", "codex", "opencode", "pi", "aider"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a wrong profile fails with its file and the field", () => {
	assert.throws(
		() => parseProfile({ harness: "x", adapter: "paste", label: "X", dialogs: [] }, "x.json"),
		/x.json: a paste profile needs "command"/,
	);
	assert.throws(() => parseProfile({ harness: "x", label: "X", dialogs: [] }, "x.json"), /"adapter" missing/);
	assert.throws(() => parseProfile({ harness: "x", adapter: "a", label: "X" }, "x.json"), /"dialogs" must be an array/);
	const base = { harness: "x", adapter: "pi", label: "X", dialogs: [] };
	assert.throws(() => parseProfile({ ...base, env: { A: 1 } }, "x.json"), /"env" must map names to strings/);
	assert.throws(() => parseProfile({ ...base, env: ["A"] }, "x.json"), /"env" must map names to strings/);
	assert.deepEqual(parseProfile({ ...base, env: { PIHOUSE_HOME: "/f" } }).env, { PIHOUSE_HOME: "/f" });
});
