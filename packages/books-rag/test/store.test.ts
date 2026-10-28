import assert from "node:assert/strict";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { MetadataField, Passage, PdfLocation, Sha256, SourceVersion } from "../src/contracts.ts";
import { CorpusError, sha256 } from "../src/locations.ts";
import { type CorpusImport, CorpusStore } from "../src/store.ts";

const configurationHash = sha256("synthetic configuration");
const unknown = <T>(): MetadataField<T> => ({ value: null, evidence: [], resolution: "unknown" });
const location: PdfLocation = {
	kind: "pdf",
	pageNumber: 1,
	printedLabel: null,
	coordinateSystem: "pdf-points-top-left",
	pageWidth: 600,
	pageHeight: 800,
	bounds: [0, 0, 100, 100],
};
const sectionId = `section_${"1".repeat(32)}` as const;
const code = (expected: CorpusError["code"]) => (error: unknown) =>
	error instanceof CorpusError && error.code === expected;

function fixture(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-store-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "synthetic.pdf");
	writeFileSync(path, "%PDF-1.7\nsynthetic only\n");
	const directory = join(root, "private");
	const store = new CorpusStore({ directory });
	return { root, path, directory, store };
}

function corpus(
	store: CorpusStore,
	path: string,
	options: { bookId?: SourceVersion["bookId"]; indexHash?: Sha256; extractorVersion?: string } = {},
): CorpusImport {
	const bookId = options.bookId ?? store.newBookId();
	const sourceHash = sha256(readFileSync(path));
	const indexConfigurationHash = options.indexHash ?? configurationHash;
	const extractor = { name: "synthetic", version: options.extractorVersion ?? "1", configurationHash };
	const source: SourceVersion = {
		bookId,
		sourceHash,
		versionId: store.versionId(bookId, sourceHash, extractor, indexConfigurationHash),
		format: "pdf",
		originalPath: path,
		pageCount: 1,
		metadata: {
			title: unknown(),
			authors: unknown(),
			publisher: unknown(),
			edition: unknown(),
			publicationDate: unknown(),
		},
		extractor,
		coverage: { totalPages: 1, extractedPages: [1], gaps: [], status: "complete" },
		diagnostics: [],
	};
	const figureId = store.recordId("figure", source, "figure-1");
	const passage: Passage = {
		...source,
		id: store.recordId("passage", source, "paragraph-1"),
		parentSectionId: sectionId,
		headingPath: [{ sectionId, title: "Synthetic heading", location }],
		originalText: "a  b",
		normalizedText: "a b",
		mappings: [
			{ kind: "literal", originalRange: { start: 0, end: 1 }, normalizedRange: { start: 0, end: 1 } },
			{ kind: "normalized", originalRange: { start: 1, end: 3 }, normalizedRange: { start: 1, end: 2 } },
			{ kind: "literal", originalRange: { start: 3, end: 4 }, normalizedRange: { start: 2, end: 3 } },
		],
		spans: [{ blockId: `block_${"2".repeat(32)}`, location, originalRange: { start: 0, end: 4 } }],
		neighbors: { previous: null, next: null },
		figures: [],
		quality: [],
		indexConfigurationHash,
	};
	return {
		source,
		indexConfigurationHash,
		passages: [passage],
		figures: [
			{
				...source,
				id: figureId,
				label: null,
				caption: null,
				location,
				rendering: { kind: "full-page-fallback", reason: "Unknown crop" },
				linkingEvidence: [],
				diagnostics: [],
			},
		],
	};
}

test("imports round-trip separate original/normalized text, mappings, provenance and immutable versions", (t) => {
	const { store, path, directory } = fixture(t);
	const input = corpus(store, path);
	assert.equal(store.import(input).imported, true);
	const first = input.passages[0];
	assert.ok(first);
	assert.deepEqual(store.readPassage(input.source, first.id), first);
	const reopened = new CorpusStore({ directory });
	assert.equal(reopened.libraryId, store.libraryId);
	assert.equal(reopened.import(input).imported, false);
	assert.equal(reopened.listVersions().length, 1);
	assert.deepEqual(reopened.currentVersion(input.source.bookId), input.source);
	assert.equal(reopened.currentVersion(store.newBookId()), null);
	assert.equal(reopened.listPassages(input.source)[0]?.originalText, "a  b");
	assert.equal(reopened.listPassages(input.source)[0]?.normalizedText, "a b");
	assert.ok(Object.isFrozen(reopened.listPassages(input.source)[0]?.mappings));
	assert.equal(reopened.listFigures(input.source).length, 1);
});

test("source, extractor and chunk configuration changes create distinct immutable versions", (t) => {
	const { store, path } = fixture(t);
	const first = corpus(store, path);
	store.import(first);
	const bookId = first.source.bookId;
	const second = corpus(store, path, { bookId, extractorVersion: "2" });
	store.import(second);
	const third = corpus(store, path, { bookId, indexHash: sha256("different chunking") });
	store.import(third);
	assert.equal(store.import(first).imported, false);
	assert.deepEqual(store.currentVersion(bookId), third.source);
	writeFileSync(path, "%PDF-1.7\nchanged synthetic source\n");
	const fourth = corpus(store, path, { bookId });
	store.import(fourth);
	assert.equal(new Set([first, second, third, fourth].map((entry) => entry.source.versionId)).size, 4);
	assert.equal(store.listVersions(bookId).length, 4);
	assert.deepEqual(store.currentVersion(bookId), fourth.source);
	assert.throws(
		() => store.readPassage(first.source, first.passages[0]?.id ?? "passage_invalid"),
		code("source_changed"),
	);
	assert.throws(() => store.import({ ...fourth, passages: [] }), code("immutable_conflict"));
	assert.deepEqual(store.listPassages(first.source), first.passages);
});

test("passage and figure resolution cannot cross versions or libraries", (t) => {
	const { store, root, path } = fixture(t);
	const first = corpus(store, path);
	store.import(first);
	const second = corpus(store, path, { bookId: first.source.bookId, extractorVersion: "2" });
	store.import(second);
	const passage = first.passages[0];
	const figure = first.figures[0];
	assert.ok(passage && figure);
	assert.throws(() => store.readPassage(second.source, passage.id), code("identity_mismatch"));
	assert.throws(() => store.readFigure(second.source, figure.id), code("identity_mismatch"));
	const other = new CorpusStore({ directory: join(root, "other") });
	assert.notEqual(other.libraryId, store.libraryId);
	assert.notEqual(
		other.versionId(first.source.bookId, first.source.sourceHash, first.source.extractor, first.indexConfigurationHash),
		first.source.versionId,
	);
	assert.throws(() => other.readPassage(first.source, passage.id), code("identity_mismatch"));
	assert.throws(() => other.import(first), code("identity_mismatch"));
	assert.throws(
		() => store.import({ ...second, passages: [{ ...second.passages[0], id: passage.id } as Passage] }),
		code("immutable_conflict"),
	);
	assert.throws(() => store.readPassage(first.source, "passage_../../escape"), code("invalid_id"));
	assert.throws(() => store.listVersions("book_../escape"), code("invalid_id"));
	assert.throws(() => store.readPassage({ ...first.source, sourceHash: sha256("incorrect") }, passage.id), /identity/);
});

test("verified passage and lazy figure reads explicitly fail for changed or missing originals", (t) => {
	const { store, path } = fixture(t);
	const input = corpus(store, path);
	store.import(input);
	const passage = input.passages[0];
	const figure = input.figures[0];
	assert.ok(passage && figure);
	assert.deepEqual(store.readFigure(input.source, figure.id).bytes, readFileSync(path));
	writeFileSync(path, "altered");
	assert.throws(() => store.readPassage(input.source, passage.id), code("source_changed"));
	assert.throws(() => store.readFigure(input.source, figure.id), code("source_changed"));
	rmSync(path);
	assert.throws(() => store.readPassage(input.source, passage.id), code("source_missing"));
	assert.throws(() => store.readFigure(input.source, figure.id), code("source_missing"));
	assert.equal(store.listVersions().length, 1); // Catalog remains usable for diagnosis.
});

test("invalid, conflicting and partial imports preserve every existing database byte", (t) => {
	const { store, path } = fixture(t);
	const input = corpus(store, path);
	store.import(input);
	const before = readFileSync(store.databasePath);
	const invalid = corpus(store, path);
	assert.throws(
		() => store.import({ ...invalid, passages: [{ ...invalid.passages[0], mappings: [] } as Passage] }),
		/mappings/,
	);
	assert.throws(
		() => store.import({ ...invalid, source: { ...invalid.source, sourceHash: sha256("wrong") } }),
		code("identity_mismatch"),
	);
	assert.throws(() => store.import({ ...input, figures: [] }), code("immutable_conflict"));
	const failed = new CorpusStore({
		directory: store.directory,
		beforePublish: () => {
			throw new Error("simulated partial write");
		},
	});
	assert.throws(() => failed.import(invalid), /simulated partial write/);
	assert.deepEqual(readFileSync(store.databasePath), before);
	assert.deepEqual(readdirSync(store.directory), ["corpus.sqlite"]);
	assert.equal(store.listVersions().length, 1);
});

test("creation and schema migration failures preserve existing bytes and clean temporary files", (t) => {
	const { root } = fixture(t);
	const directory = join(root, "creation");
	assert.throws(
		() =>
			new CorpusStore({
				directory,
				beforePublish: () => {
					throw new Error("creation failure");
				},
			}),
		/creation failure/,
	);
	assert.deepEqual(readdirSync(directory), []);
	const database = join(directory, "corpus.sqlite");
	writeFileSync(database, "", { mode: 0o600 });
	const db = new DatabaseSync(database);
	db.exec("PRAGMA user_version=0");
	db.close();
	const before = readFileSync(database);
	assert.throws(
		() =>
			new CorpusStore({
				directory,
				beforePublish: () => {
					throw new Error("migration failure");
				},
			}),
		/migration failure/,
	);
	assert.deepEqual(readFileSync(database), before);
	assert.deepEqual(readdirSync(directory), ["corpus.sqlite"]);
	const migrated = new CorpusStore({ directory });
	assert.deepEqual(migrated.listVersions(), []);
});

test("unknown schemas, foreign tables and corrupt databases are never overwritten", (t) => {
	const { root } = fixture(t);
	for (const [name, sql] of [
		["future", "PRAGMA user_version=99"],
		["foreign-application", "PRAGMA application_id=123"],
		["foreign", "CREATE TABLE workflow_jobs(id TEXT)"],
	] as const) {
		const directory = join(root, name);
		mkdirSync(directory, { mode: 0o700 });
		const database = join(directory, "corpus.sqlite");
		writeFileSync(database, "", { mode: 0o600 });
		const db = new DatabaseSync(database);
		db.exec(sql);
		db.close();
		const bytes = readFileSync(database);
		assert.throws(() => new CorpusStore({ directory }), code("store_corrupt"));
		assert.deepEqual(readFileSync(database), bytes);
	}
	const directory = join(root, "broken");
	mkdirSync(directory, { mode: 0o700 });
	const database = join(directory, "corpus.sqlite");
	writeFileSync(database, "partial SQLite file", { mode: 0o600 });
	const bytes = readFileSync(database);
	assert.throws(() => new CorpusStore({ directory }));
	assert.deepEqual(readFileSync(database), bytes);
});

test("unsafe store roots, database symlinks/hardlinks, permissions and sidecars fail closed", (t) => {
	const { root, directory, store } = fixture(t);
	assert.throws(() => new CorpusStore({ directory: join(process.cwd(), "private-corpus") }), code("unsafe_path"));
	assert.equal(existsSync(join(process.cwd(), "private-corpus")), false);
	const alias = join(root, "alias");
	symlinkSync(directory, alias);
	assert.throws(() => new CorpusStore({ directory: alias }), code("unsafe_path"));
	chmodSync(directory, 0o755);
	assert.throws(() => new CorpusStore({ directory }), code("unsafe_path"));
	chmodSync(directory, 0o700);
	const original = readFileSync(store.databasePath);
	const backup = join(root, "backup.sqlite");
	copyFileSync(store.databasePath, backup);
	rmSync(store.databasePath);
	symlinkSync(backup, store.databasePath);
	assert.throws(() => store.listVersions(), code("unsafe_path"));
	rmSync(store.databasePath);
	linkSync(backup, store.databasePath);
	assert.throws(() => store.listVersions(), code("unsafe_path"));
	rmSync(store.databasePath);
	writeFileSync(store.databasePath, original, { mode: 0o600 });
	writeFileSync(`${store.databasePath}-journal`, "partial", { mode: 0o600 });
	assert.throws(() => store.listVersions(), code("store_corrupt"));
	assert.deepEqual(readFileSync(store.databasePath), original);
});

test("replaced libraries cannot be read or modified through a stale store handle", (t) => {
	const { store, directory, root, path } = fixture(t);
	const input = corpus(store, path);
	const other = new CorpusStore({ directory: join(root, "replacement") });
	copyFileSync(other.databasePath, store.databasePath);
	const bytes = readFileSync(store.databasePath);
	assert.throws(() => store.listVersions(), code("identity_mismatch"));
	assert.throws(() => store.import(input), code("identity_mismatch"));
	assert.deepEqual(readFileSync(store.databasePath), bytes);
	assert.equal(new CorpusStore({ directory }).libraryId, other.libraryId);
});

test("cross-version record reuse and unresolved neighbors/figures fail atomically", (t) => {
	const { store, path } = fixture(t);
	const first = corpus(store, path);
	store.import(first);
	const next = corpus(store, path, { bookId: first.source.bookId, extractorVersion: "2" });
	const passage = next.passages[0];
	const previous = first.passages[0];
	assert.ok(passage && previous);
	const bytes = readFileSync(store.databasePath);
	assert.throws(
		() => store.import({ ...next, passages: [{ ...passage, id: previous.id }] }),
		code("identity_mismatch"),
	);
	assert.throws(
		() => store.import({ ...next, passages: [{ ...passage, neighbors: { previous: previous.id, next: null } }] }),
		code("identity_mismatch"),
	);
	assert.throws(
		() =>
			store.import({
				...next,
				passages: [
					{
						...passage,
						figures: [
							{
								figureId: `figure_${"f".repeat(32)}`,
								evidence: { kind: "caption-layout", status: "uncertain", reason: "Synthetic", location },
							},
						],
					},
				],
			}),
		code("identity_mismatch"),
	);
	assert.deepEqual(readFileSync(store.databasePath), bytes);
	assert.deepEqual(store.currentVersion(first.source.bookId), first.source);
});

test("writer locks fail explicitly, and independently opened stores serialize on fresh snapshots", (t) => {
	const { store, directory, path } = fixture(t);
	const other = new CorpusStore({ directory });
	const input = corpus(store, path);
	writeFileSync(join(directory, ".writer.lock"), "synthetic interrupted writer", { mode: 0o600 });
	const before = readFileSync(store.databasePath);
	assert.throws(() => other.import(input), code("store_busy"));
	assert.deepEqual(readFileSync(store.databasePath), before);
	rmSync(join(directory, ".writer.lock"));
	store.import(input);
	assert.equal(other.listVersions().length, 1);
	assert.equal(other.import(input).imported, false);
	const db = new DatabaseSync(store.databasePath, { readOnly: true });
	try {
		assert.deepEqual(
			db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all()
				.map((row) => row.name),
			["current_versions", "library", "versions"],
		);
	} finally {
		db.close();
	}
});
