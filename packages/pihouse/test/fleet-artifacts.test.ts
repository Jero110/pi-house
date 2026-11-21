import assert from "node:assert/strict";
import {
	copyFileSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { createArtifactStore } from "../src/fleet-artifacts.ts";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-files-")));
	const cwd = join(root, "checkout");
	const out = join(cwd, "artifacts");
	mkdirSync(out, { recursive: true });
	const db = new DatabaseSync(":memory:");
	const store = createArtifactStore(db);
	t.after(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	return { root, cwd, out, store };
}

test("only changed flat files are published, with immutable chat-scoped bytes", (t) => {
	const { root, cwd, out, store } = fixture(t);
	writeFileSync(join(out, "existing.txt"), "clone file");
	const before = store.baseline(cwd);
	writeFileSync(join(out, "report.md"), "hello");
	writeFileSync(join(out, "page.html"), "<script>hello</script>");
	writeFileSync(join(out, "fake.png"), "<svg></svg>");
	mkdirSync(join(out, "nested"));
	writeFileSync(join(out, "nested", "private.txt"), "nested");
	writeFileSync(join(root, "private"), "outside");
	symlinkSync(join(root, "private"), join(out, "link.txt"));
	linkSync(join(root, "private"), join(out, "hard.txt"));
	store.capture("a", cwd, before);
	const files = store.list("a");
	assert.deepEqual(
		files.map((f) => [f.name, f.type]),
		[
			["fake.png", "file"],
			["page.html", "file"],
			["report.md", "text"],
		],
	);
	const id = files[2].id;
	const prior = store.baseline(cwd);
	writeFileSync(join(out, "report.md"), "later");
	store.capture("a", cwd, prior);
	assert.equal(store.get("a", id)?.bytes.toString(), "hello");
	assert.equal(store.get("b", id), undefined);
	assert.equal(store.list("a").length, 4);
});

test("rejects symlink ancestry and refuses capture when the before-scan was over budget", (t) => {
	const { root, cwd, out, store } = fixture(t);
	const outside = join(root, "other");
	mkdirSync(outside);
	writeFileSync(join(outside, "private.txt"), "never");
	const clean = store.baseline(cwd);
	rmSync(out, { recursive: true });
	symlinkSync(outside, out);
	store.capture("a", cwd, clean);
	assert.deepEqual(store.list("a"), []);
	rmSync(out);
	mkdirSync(out);
	for (let i = 0; i < 100; i++) writeFileSync(join(out, `f${i}.txt`), "already here");
	const oversized = store.baseline(cwd);
	rmSync(out, { recursive: true });
	mkdirSync(out);
	writeFileSync(join(out, "f1.txt"), "already here");
	store.capture("a", cwd, oversized);
	assert.deepEqual(store.list("a"), []);
});

test("recognizes a native-decodable PNG and keeps SVG download-only", { skip: process.platform !== "darwin" }, (t) => {
	const { cwd, out, store } = fixture(t);
	const before = store.baseline(cwd);
	copyFileSync(new URL("../../../assets/pihouse.png", import.meta.url), join(out, "preview.png"));
	writeFileSync(join(out, "plot.svg"), "<svg></svg>");
	store.capture("a", cwd, before);
	const files = store.list("a");
	assert.deepEqual(
		files.map((f) => [f.name, f.type]),
		[
			["plot.svg", "file"],
			["preview.png", "image"],
		],
	);
	assert.equal(store.get("a", files[1].id)?.mime, "image/png");
});
