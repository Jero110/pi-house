import { randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
	BookId,
	Figure,
	FigureId,
	Passage,
	PassageId,
	Sha256,
	SourceIdentity,
	SourceVersion,
	VersionId,
} from "./contracts.ts";
import { assertSourceIdentity, defineFigure, definePassage, defineSource } from "./contracts.ts";
import { assertId, assertOutsideCheckout, CorpusError, safePath, sha256, verifiedSourceBytes } from "./locations.ts";

const schemaVersion = 1;
const applicationId = 0x42524147; // BRAG: never adopt a workflow or arbitrary SQLite database.
const checkoutRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface StoreOptions {
	readonly directory: string;
	// Fault injection is local and synchronous; throwing must leave the live file unchanged.
	readonly beforePublish?: () => void;
}

export interface CorpusImport {
	readonly source: SourceVersion;
	readonly indexConfigurationHash: Sha256;
	readonly passages: readonly Passage[];
	readonly figures: readonly Figure[];
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError("Non-JSON corpus data");
	return encoded;
}

function text(value: unknown): string {
	if (typeof value !== "string") throw new CorpusError("store_corrupt", "Invalid corpus database value");
	return value;
}

function checkDatabase(db: DatabaseSync): void {
	if (db.prepare("PRAGMA application_id").get()?.application_id !== applicationId)
		throw new CorpusError("store_corrupt", "Not a books corpus database");
	if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
		throw new CorpusError("store_corrupt", "Corpus integrity check failed");
}

// No connection survives an operation. A writer owns a fail-closed lock and edits
// a private copy: e.g. a failed migration never journals into the existing file.
// Publish only a closed, fsynced database with one same-directory atomic rename.
export class CorpusStore {
	readonly directory: string;
	readonly databasePath: string;
	readonly libraryId: string;
	private readonly options: StoreOptions;

	constructor(options: StoreOptions) {
		this.options = options;
		assertOutsideCheckout(options.directory, checkoutRoot);
		this.directory = safePath(options.directory, true);
		if (!existsSync(this.directory)) mkdirSync(this.directory, { mode: 0o700 });
		const stat = lstatSync(this.directory);
		if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
			throw new CorpusError("unsafe_path", "Store directory must be private (mode 0700)");
		this.databasePath = join(this.directory, "corpus.sqlite");
		this.assertFiles();
		if (!existsSync(this.databasePath)) {
			this.change((db) => this.migrate(db));
		} else {
			const version = this.read((db) => db.prepare("PRAGMA user_version").get()?.user_version);
			if (version !== schemaVersion) this.change((db) => this.migrate(db));
		}
		this.libraryId = this.read((db) => {
			checkDatabase(db);
			if (db.prepare("SELECT count(*) AS count FROM library").get()?.count !== 1)
				throw new CorpusError("store_corrupt", "Expected exactly one library identity");
			const id = text(db.prepare("SELECT id FROM library").get()?.id);
			if (!/^[a-f0-9]{32}$/.test(id)) throw new CorpusError("store_corrupt", "Invalid library identity");
			return id;
		});
	}

	private assertFiles(): void {
		assertOutsideCheckout(this.directory, checkoutRoot);
		safePath(this.directory);
		const directoryStat = lstatSync(this.directory);
		if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0)
			throw new CorpusError("unsafe_path", "Store directory is no longer private");
		for (const path of [
			this.databasePath,
			`${this.databasePath}-wal`,
			`${this.databasePath}-shm`,
			`${this.databasePath}-journal`,
		]) {
			safePath(path, true);
			if (existsSync(path)) {
				const stat = lstatSync(path);
				if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
					throw new CorpusError("unsafe_path", "Unsafe corpus database file");
				if (path !== this.databasePath)
					throw new CorpusError("store_corrupt", "Unrecovered SQLite sidecar; explicit operator recovery required");
			}
		}
	}

	private assertLibrary(db: DatabaseSync): void {
		// A stale store handle must not write into a replacement library database.
		if (this.libraryId !== undefined && db.prepare("SELECT id FROM library").get()?.id !== this.libraryId)
			throw new CorpusError("identity_mismatch", "Configured library identity changed");
	}

	private read<T>(work: (db: DatabaseSync) => T): T {
		this.assertFiles();
		const db = new DatabaseSync(this.databasePath, { readOnly: true });
		try {
			this.assertLibrary(db);
			return work(db);
		} finally {
			db.close();
		}
	}

	private change<T>(work: (db: DatabaseSync) => T): T {
		this.assertFiles();
		const lock = join(this.directory, ".writer.lock");
		let lockFd: number;
		try {
			lockFd = openSync(lock, "wx", 0o600);
		} catch {
			throw new CorpusError("store_busy", "Store writer lock exists; do not remove an active lock");
		}
		const temporary = join(this.directory, `.corpus-${randomUUID()}.sqlite`);
		try {
			this.assertFiles();
			if (existsSync(this.databasePath)) copyFileSync(this.databasePath, temporary);
			else writeFileSync(temporary, "", { mode: 0o600, flag: "wx" });
			const db = new DatabaseSync(temporary);
			let result: T;
			try {
				this.assertLibrary(db);
				db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
				result = work(db);
				db.exec("COMMIT");
				checkDatabase(db);
			} finally {
				db.close();
			}
			const fd = openSync(temporary, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			this.options.beforePublish?.();
			this.assertFiles();
			renameSync(temporary, this.databasePath);
			return result;
		} finally {
			for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${temporary}${suffix}`, { force: true });
			closeSync(lockFd);
			rmSync(lock);
		}
	}

	private migrate(db: DatabaseSync): void {
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		if (version === schemaVersion) return;
		if (
			version !== 0 ||
			db.prepare("PRAGMA application_id").get()?.application_id !== 0 ||
			db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length !== 0
		) {
			throw new CorpusError("store_corrupt", "Unsupported corpus schema; original database preserved");
		}
		db.exec(`CREATE TABLE library(id TEXT PRIMARY KEY);
			CREATE TABLE versions(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, payload TEXT NOT NULL);
			CREATE TABLE current_versions(book_id TEXT PRIMARY KEY, version_id TEXT NOT NULL);
			PRAGMA user_version=1;
			PRAGMA application_id=${applicationId};`);
		db.prepare("INSERT INTO library VALUES (?)").run(randomBytes(16).toString("hex"));
	}

	newBookId(): BookId {
		return `book_${randomBytes(16).toString("hex")}`;
	}

	versionId(
		bookId: BookId,
		sourceHash: Sha256,
		extractor: SourceVersion["extractor"],
		indexConfigurationHash: Sha256,
	): VersionId {
		assertId(bookId, "book");
		if (
			![sourceHash, extractor.configurationHash, indexConfigurationHash].every((hash) =>
				/^sha256:[a-f0-9]{64}$/.test(hash),
			)
		)
			throw new TypeError("Invalid configuration/source hash");
		return `version_${sha256(canonical([this.libraryId, bookId, sourceHash, extractor, indexConfigurationHash])).slice(7, 39)}`;
	}

	recordId(kind: "passage", source: SourceIdentity, key: string): PassageId;
	recordId(kind: "figure", source: SourceIdentity, key: string): FigureId;
	recordId(kind: "passage" | "figure", source: SourceIdentity, key: string): PassageId | FigureId {
		assertSourceIdentity(source);
		if (!key || key.length > 1024) throw new TypeError("Invalid record key");
		return `${kind}_${sha256(canonical([this.libraryId, source, key])).slice(7, 39)}`;
	}

	import(input: CorpusImport): { readonly source: SourceVersion; readonly imported: boolean } {
		const source = defineSource(input.source);
		if (
			source.versionId !==
			this.versionId(source.bookId, source.sourceHash, source.extractor, input.indexConfigurationHash)
		)
			throw new CorpusError("identity_mismatch", "Source version does not match library/configuration");
		verifiedSourceBytes(source);
		const passages = input.passages.map((passage) => definePassage(passage, source));
		const figures = input.figures.map((figure) => defineFigure(figure, source));
		const ids = new Set([...passages, ...figures].map((record) => record.id));
		if (ids.size !== passages.length + figures.length) throw new TypeError("Duplicate corpus record ID");
		for (const passage of passages) {
			if (passage.indexConfigurationHash !== input.indexConfigurationHash)
				throw new CorpusError("identity_mismatch", "Passage configuration differs from import");
			for (const neighbor of [passage.neighbors.previous, passage.neighbors.next]) {
				if (neighbor !== null && !passages.some((other) => other.id === neighbor))
					throw new CorpusError("identity_mismatch", "Neighbor belongs to another version");
			}
			for (const link of passage.figures)
				if (!figures.some((figure) => figure.id === link.figureId))
					throw new CorpusError("identity_mismatch", "Missing linked figure");
		}
		const payload = canonical({ source, indexConfigurationHash: input.indexConfigurationHash, passages, figures });
		return this.change((db) => {
			const previous = db.prepare("SELECT payload FROM versions WHERE id=?").get(source.versionId);
			if (previous) {
				if (previous.payload !== payload)
					throw new CorpusError("immutable_conflict", "Immutable version already contains different records");
				return { source, imported: false };
			}
			// IDs are globally unique inside a library, even when supplied by a caller.
			for (const row of db.prepare("SELECT payload FROM versions").all()) {
				const old = this.decode(text(row.payload));
				if ([...old.passages, ...old.figures].some((record) => ids.has(record.id)))
					throw new CorpusError("identity_mismatch", "Record ID reused across versions");
			}
			verifiedSourceBytes(source);
			db.prepare("INSERT INTO versions VALUES (?, ?, ?)").run(source.versionId, source.bookId, payload);
			db.prepare(
				"INSERT INTO current_versions VALUES (?, ?) ON CONFLICT(book_id) DO UPDATE SET version_id=excluded.version_id",
			).run(source.bookId, source.versionId);
			return { source, imported: true };
		});
	}

	private decode(payload: string): CorpusImport {
		const input = JSON.parse(payload) as CorpusImport;
		const source = defineSource(input.source);
		if (
			source.versionId !==
			this.versionId(source.bookId, source.sourceHash, source.extractor, input.indexConfigurationHash)
		)
			throw new CorpusError("identity_mismatch", "Stored library identity mismatch");
		return {
			source,
			indexConfigurationHash: input.indexConfigurationHash,
			passages: input.passages.map((p) => definePassage(p, source)),
			figures: input.figures.map((f) => defineFigure(f, source)),
		};
	}

	listVersions(bookId?: BookId): readonly SourceVersion[] {
		if (bookId !== undefined) assertId(bookId, "book");
		return this.read((db) =>
			db
				.prepare("SELECT payload FROM versions WHERE (? IS NULL OR book_id=?) ORDER BY id")
				.all(bookId ?? null, bookId ?? null)
				.map((row) => this.decode(text(row.payload)).source),
		);
	}

	currentVersion(bookId: BookId): SourceVersion | null {
		assertId(bookId, "book");
		return this.read((db) => {
			const row = db
				.prepare(
					"SELECT payload FROM versions JOIN current_versions ON versions.id=current_versions.version_id WHERE current_versions.book_id=?",
				)
				.get(bookId);
			return row ? this.decode(text(row.payload)).source : null;
		});
	}

	private resolveVersion(expected: SourceIdentity): CorpusImport {
		assertSourceIdentity(expected);
		return this.read((db) => {
			const row = db.prepare("SELECT payload FROM versions WHERE id=?").get(expected.versionId);
			if (!row) throw new CorpusError("identity_mismatch", "Source version is not in this library");
			const record = this.decode(text(row.payload));
			assertSourceIdentity(record.source, expected);
			return record;
		});
	}

	listPassages(expected: SourceIdentity): readonly Passage[] {
		return this.resolveVersion(expected).passages;
	}
	listFigures(expected: SourceIdentity): readonly Figure[] {
		return this.resolveVersion(expected).figures;
	}

	readPassage(expected: SourceIdentity, id: PassageId): Passage {
		assertId(id, "passage");
		const record = this.resolveVersion(expected);
		const passage = record.passages.find((item) => item.id === id);
		if (!passage) throw new CorpusError("identity_mismatch", "Passage is not in this source version");
		verifiedSourceBytes(record.source);
		return passage;
	}

	readFigure(expected: SourceIdentity, id: FigureId): { readonly figure: Figure; readonly bytes: Uint8Array } {
		assertId(id, "figure");
		const record = this.resolveVersion(expected);
		const figure = record.figures.find((item) => item.id === id);
		if (!figure) throw new CorpusError("identity_mismatch", "Figure is not in this source version");
		return { figure, bytes: verifiedSourceBytes(record.source) };
	}
}
