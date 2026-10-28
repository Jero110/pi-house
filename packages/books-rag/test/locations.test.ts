import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SourceVersion } from "../src/contracts.ts";
import {
	assertId,
	assertOutsideCheckout,
	CorpusError,
	readLocalPdf,
	safePath,
	sha256,
	verifiedSourceBytes,
} from "../src/locations.ts";

function fixture(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-locations-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "synthetic.pdf");
	writeFileSync(path, "%PDF-1.7\nsynthetic only\n");
	return { root, path };
}

const code = (expected: CorpusError["code"]) => (error: unknown) =>
	error instanceof CorpusError && error.code === expected;

test("verified source reads return the exact hash-checked bytes and detect changed/missing originals", (t) => {
	const { path } = fixture(t);
	const original = readFileSync(path);
	const source = { originalPath: path, sourceHash: sha256(original) } as SourceVersion;
	assert.deepEqual(verifiedSourceBytes(source), original);
	writeFileSync(path, "same-size altered data");
	assert.throws(() => verifiedSourceBytes(source), code("source_changed"));
	rmSync(path);
	assert.throws(() => verifiedSourceBytes(source), code("source_missing"));
});

test("local paths fail closed for traversal, relative paths, NULs and symlink ancestors/leaves", (t) => {
	const { root, path } = fixture(t);
	for (const invalid of ["relative.pdf", `${root}/../synthetic.pdf`, `${path}\0`]) {
		assert.throws(() => readLocalPdf(invalid), code("unsafe_path"));
	}
	const alias = join(root, "alias.pdf");
	symlinkSync(path, alias);
	assert.throws(() => readLocalPdf(alias), code("unsafe_path"));
	const dirAlias = join(root, "alias");
	symlinkSync(root, dirAlias);
	assert.throws(() => readLocalPdf(join(dirAlias, "synthetic.pdf")), code("unsafe_path"));
	rmSync(path);
	assert.throws(() => readLocalPdf(alias), code("unsafe_path"));
	assert.equal(safePath(join(root, "new"), true), join(root, "new"));
});

test("non-PDF, oversized inputs, special files and invalid IDs are explicitly rejected", (t) => {
	const { root, path } = fixture(t);
	const unsupported = join(root, "unsupported.txt");
	writeFileSync(unsupported, "synthetic");
	assert.throws(() => readLocalPdf(unsupported), code("unsupported_format"));
	assert.throws(() => readLocalPdf(path, 1), code("resource_limit"));
	assert.throws(() => readLocalPdf(path, Number.NaN), code("resource_limit"));
	const directory = join(root, "directory.pdf");
	mkdirSync(directory);
	assert.throws(() => readLocalPdf(directory), code("unsafe_path"));
	for (const id of [
		"../passage",
		`passage_${"A".repeat(32)}`,
		`figure_${"a".repeat(32)}`,
		`passage_${"a".repeat(32)}/x`,
	]) {
		assert.throws(() => assertId(id, "passage"), code("invalid_id"));
	}
	assertId(`passage_${"a".repeat(32)}`, "passage");
});

test("data destinations inside this or another checkout are forbidden", (t) => {
	const { root } = fixture(t);
	const checkout = join(root, "checkout");
	mkdirSync(checkout);
	writeFileSync(join(checkout, ".git"), "gitdir: synthetic");
	assert.throws(() => assertOutsideCheckout(join(checkout, "private"), checkout), code("unsafe_path"));
	assert.throws(() => assertOutsideCheckout(join(checkout, "private"), join(root, "other")), code("unsafe_path"));
	assert.doesNotThrow(() => assertOutsideCheckout(join(root, "checkout-other"), checkout));
});
