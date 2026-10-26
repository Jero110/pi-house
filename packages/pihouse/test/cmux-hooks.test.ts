import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CMUX_HOOK_MARKER, cmuxHookExtension } from "../src/cmux-hooks.ts";
import { piCommand } from "../src/launcher.ts";
import { pihousePaths } from "../src/paths.ts";

/** A cmux CLI that answers `hooks pi extension-source` with `source`, and a pane for it to belong to. */
function fakeCmux(t: { after: (fn: () => void) => void }, source: string) {
	const dir = mkdtempSync(join(tmpdir(), "pihouse-cmux-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const cli = join(dir, "cmux");
	writeFileSync(join(dir, "source.ts"), source);
	writeFileSync(cli, `#!/bin/sh\n/bin/cat "${join(dir, "source.ts")}"\n`, { mode: 0o755 });
	mkdirSync(join(dir, "tmp"));
	const env: NodeJS.ProcessEnv = {
		HOME: dir,
		PATH: "",
		TMPDIR: join(dir, "tmp"),
		CMUX_SURFACE_ID: "SURFACE-1",
		CMUX_BUNDLED_CLI_PATH: cli,
	};
	return { dir, env };
}

const SOURCE = `// ${CMUX_HOOK_MARKER} v4\nexport default function () {}\n`;

test("outside cmux, or with the hooks switched off, pihouse loads no cmux extension", (t) => {
	const { env } = fakeCmux(t, SOURCE);
	assert.deepEqual(cmuxHookExtension({ ...env, CMUX_SURFACE_ID: undefined }), []);
	assert.deepEqual(cmuxHookExtension({ ...env, CMUX_PI_HOOKS_DISABLED: "1" }), []);
});

test("in a cmux pane the extension cmux generates is written where cmux's own wrapper keeps it, and reused", (t) => {
	const { dir, env } = fakeCmux(t, SOURCE);
	const [file] = cmuxHookExtension(env);
	assert.equal(file, join(dir, "tmp", "cmux-pi-extensions", "SURFACE-1", "cmux-session.ts"));
	assert.equal(readFileSync(file ?? "", "utf8"), SOURCE);
	assert.equal(statSync(file ?? "").mode & 0o777, 0o600, "private to the user");
	assert.deepEqual(cmuxHookExtension(env), [file], "the same file the second time");
});

test("a cmux that cannot produce a marked extension leaves pihouse as it was", (t) => {
	const { env } = fakeCmux(t, "not an extension\n");
	assert.deepEqual(cmuxHookExtension(env), []);
	assert.deepEqual(cmuxHookExtension({ ...env, CMUX_BUNDLED_CLI_PATH: "/nope", PATH: "" }), []);
});

test("pihouse's pi command line adds the cmux extension only inside cmux", (t) => {
	const { dir, env } = fakeCmux(t, SOURCE);
	const paths = pihousePaths({ HOME: dir }, dir);
	const inside = piCommand(paths, ["hi"], env, dir).argv;
	const file = join(dir, "tmp", "cmux-pi-extensions", "SURFACE-1", "cmux-session.ts");
	assert.ok(inside.includes(file), "loaded");
	assert.equal(inside[inside.indexOf(file) - 1], "-e");
	assert.equal(inside.at(-1), "hi", "the user's arguments stay last");
	const outside = piCommand(paths, ["hi"], { ...env, CMUX_SURFACE_ID: undefined }, dir).argv;
	assert.ok(!outside.some((a) => a.includes("cmux-session.ts")));
});
