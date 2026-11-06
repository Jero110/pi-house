import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { openMemory } from "../src/workflow/memory.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import { searchMemory } from "../src/workflow/search.ts";
import { initVault, vaultPaths } from "../src/workflow/vault-paths.ts";

function tree(root: string, rel = ""): string[] {
	const out: string[] = [];
	for (const name of readdirSync(join(root, rel)).sort()) {
		const path = rel ? `${rel}/${name}` : name;
		out.push(path);
		if (statSync(join(root, path)).isDirectory()) out.push(...tree(root, path));
	}
	return out;
}

const digestOf = (root: string) =>
	tree(root)
		.filter((p) => statSync(join(root, p)).isFile() && p !== "memory.sqlite")
		.map(
			(p) =>
				`${p}:${createHash("sha256")
					.update(readFileSync(join(root, p)))
					.digest("hex")}`,
		)
		.join("\n");

test("opening an empty folder creates the whole vault, an active store and FTS", () => {
	const root = mkdtempSync(join(tmpdir(), "pihouse-vault-"));
	try {
		const store = openMemory(root);
		for (const dir of [
			"conversations",
			"workflow/compact",
			"workflow/reviews",
			"workflow/proposals",
			"workflow/approved-records",
			"ask/ideas",
			"ask/consulted",
		])
			assert.ok(statSync(join(root, dir)).isDirectory(), `${dir} exists`);
		assert.ok(!existsSync(join(root, "migration-backup")), "no legacy migration ran");
		assert.ok(existsSync(join(root, "migration-active.json")));
		assert.ok(existsSync(join(root, "memory.sqlite")));
		const readme = readFileSync(join(root, "README.md"), "utf8");
		for (const folder of ["conversations/", "workflow/", "ask/", "migration-backup/", "memory.sqlite"])
			assert.ok(readme.includes(folder), `README mentions ${folder}`);
		assert.match(readme, /temporary/i);
		assert.match(readme, /permanent/i);
		assert.deepEqual(store.readIndex(), []);
		// FTS is available and the store is searchable straight away.
		assert.deepEqual(searchMemory(root, "anything", { project: "p", trusts: ["derived"] }), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a second open changes nothing, not even the README bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "pihouse-vault-"));
	try {
		openMemory(root);
		const before = { tree: tree(root), files: digestOf(root) };
		openMemory(root);
		initVault(root);
		assert.deepEqual(tree(root), before.tree);
		assert.equal(digestOf(root), before.files);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a README the user edited is left as it is", () => {
	const root = mkdtempSync(join(tmpdir(), "pihouse-vault-"));
	try {
		openMemory(root);
		writeFileSync(join(root, "README.md"), "mine\n");
		openMemory(root);
		assert.equal(readFileSync(join(root, "README.md"), "utf8"), "mine\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a folder with legacy content is not started as fresh", () => {
	const root = mkdtempSync(join(tmpdir(), "pihouse-vault-"));
	try {
		writeFileSync(join(root, "index.json"), JSON.stringify({ schema: 1, entries: [], rejected: [] }));
		openMemory(root);
		assert.ok(!existsSync(join(root, "migration-active.json")), "the legacy migration stays in charge");
		assert.ok(!existsSync(join(root, "memory.sqlite")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ideas and consulted notes under ask/ are findable by searchMemory after init", () => {
	const root = mkdtempSync(join(tmpdir(), "pihouse-vault-"));
	try {
		const store = openMemory(root);
		const meta = { project: "/p/app", projectSlug: "app" };
		store.writeIdea({ id: "src-1-cache", title: "Cache idea", ...meta }, "An idea about quokkacache.");
		store.writeConsulted(
			{ id: "src-1", title: "Source", source: "https://x.test", ...meta },
			"Fetched narwhaltext.",
			"sum",
		);
		assert.ok(existsSync(join(root, "ask", "ideas", "src-1-cache.md")));
		assert.ok(existsSync(join(root, "ask", "consulted", "src-1.md")));
		assert.ok(existsSync(join(root, "ask", "consulted", "src-1.txt")));
		const scope = { project: "app", trusts: ["derived", "external"] };
		assert.deepEqual(
			searchMemory(root, "quokkacache", scope).map((h) => h.kind),
			["idea"],
		);
		assert.deepEqual(
			searchMemory(root, "narwhaltext", scope).map((h) => h.kind),
			["consulted"],
		);
		// A file a model wrote by hand into ask/ideas is adopted and found too.
		writeFileSync(
			join(root, "ask", "ideas", "by-hand.md"),
			"---\nid: by-hand\ntitle: By hand\nproject: /p/app\nprojectSlug: app\n---\n\nPangolinnote here.\n",
		);
		// A consulted source moved in from an older vault has no index row either; it is adopted with its text.
		writeFileSync(
			join(root, "ask", "consulted", "old-src.md"),
			"---\nid: old-src\ntitle: Old source\nsource: https://x.test/old\nproject: /p/app\nprojectSlug: app\n---\n\n## Summary\n\nsum\n",
		);
		writeFileSync(join(root, "ask", "consulted", "old-src.txt"), "Axolotlbody fetched.");
		assert.deepEqual(store.adoptIdeas(), ["idea:by-hand", "consulted:old-src"]);
		assert.deepEqual(store.adoptIdeas(), []);
		assert.deepEqual(
			searchMemory(root, "axolotlbody", scope).map((h) => h.id),
			["consulted:old-src"],
		);
		assert.deepEqual(
			searchMemory(root, "pangolinnote", scope).map((h) => h.id),
			["idea:by-hand"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runs are captured under conversations/", () => {
	const root = mkdtempSync(join(tmpdir(), "pihouse-vault-"));
	try {
		const paths = vaultPaths(root);
		assert.equal(paths.runDir("run-a"), join(root, "conversations", "run-a"));
		assert.equal(paths.runJson("run-a"), join(root, "conversations", "run-a", "run.json"));
		assert.equal(paths.transcripts("run-a"), join(root, "conversations", "run-a", "transcripts"));
		assert.equal(paths.compactFile("run-a.r2"), join(root, "workflow", "compact", "run-a.r2.md"));
		assert.equal(paths.reviewFile("20261105T143000Z"), join(root, "workflow", "reviews", "review-20261105T143000Z.md"));
		assert.throws(() => paths.runDir("../escape"), /Unsafe/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("no source file builds a vault path with a literal; vault-paths.ts is the only place", () => {
	const src = join(import.meta.dirname, "..", "src");
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (path.endsWith(".ts")) files.push(path);
		}
	};
	walk(src);
	// A quoted segment inside a path-building call, or a template or string with `<folder>/`.
	const folders =
		"runs|conversations|ideas|consulted|proposals|digests|batches|archive|compact|reviews|approved-records";
	const joined = new RegExp(`(?:join|resolve|abs|dirname)\\([^)]*"(?:${folders})"`);
	const slashed = new RegExp(`[\`"'](?:${folders})/`);
	const embedded = new RegExp(`\\$\\{[^}]*\\}/(?:${folders})/|/(?:${folders})/\\$\\{`);
	const offenders: string[] = [];
	for (const file of files) {
		if (file.endsWith("vault-paths.ts")) continue;
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, i) => {
			const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
			if (joined.test(code) || slashed.test(code) || embedded.test(code) || code.includes("approved-records"))
				offenders.push(`${relative(src, file)}:${i + 1}: ${line.trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
	assert.ok(existsSync(join(src, "workflow", "vault-paths.ts")));
});

test("a fresh vault stays active after capture writes flags.json next to a stale migration backup", () => {
	const root = mkdtempSync(join(tmpdir(), "pihouse-vault-"));
	try {
		openMemory(root);
		// Problem: capture keeps its flags in flags.json, which looks like legacy content, so the next command ran the
		// legacy migration and failed on the old backup. Example: /workflow log, then /workflow review ("drifted").
		mkdirSync(join(root, "migration-backup", "files"), { recursive: true });
		writeFileSync(join(root, "migration-backup", "manifest.json"), '{"hash":"a810ef9e6b51","files":[]}');
		writeFileSync(join(root, "flags.json"), '{"schema":1,"runs":{}}');
		assert.deepEqual(migrateLegacyStore(root), { state: "active", manifestHash: "fresh" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
