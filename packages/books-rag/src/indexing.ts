import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdapterError, boundedInteger } from "./config.ts";
import type { Figure, Passage, PassageId, Sha256, SourceVersion } from "./contracts.ts";
import { assertSourceIdentity, defineFigure, definePassage, defineSource } from "./contracts.ts";
import type { LocalEmbeddings } from "./embeddings.ts";
import { assertEmbeddingIdentity, embeddingIdentity } from "./embeddings.ts";
import type { FigureAsset } from "./figures.ts";
import { safePath, sha256 } from "./locations.ts";
import type { ObjectReceipt, Objects } from "./objects.ts";
import type { Pinecone, PineconeMetadata } from "./pinecone.ts";
import { passageRecord } from "./pinecone.ts";
import type { CorpusStore } from "./store.ts";

/** Stable hashes survive JSON property ordering across hosted providers. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	const result = JSON.stringify(value);
	if (result === undefined) throw new AdapterError("invalid_response", "Non-JSON catalog data");
	return result;
}
export const digest = (value: unknown): Sha256 => sha256(canonical(value));
export type HostedSource = Omit<SourceVersion, "originalPath">;
export interface HostedFigure {
	readonly figure: Figure;
	readonly object: ObjectReceipt;
	readonly asset: Omit<FigureAsset, "base64">;
}
export interface HostedVersion {
	readonly source: HostedSource;
	readonly generation: string;
	readonly indexConfigurationHash: Sha256;
	readonly passages: Readonly<Record<PassageId, Sha256>>;
	readonly figures: readonly HostedFigure[];
	readonly completed: true;
}
export interface Catalog {
	readonly schema: 1;
	readonly libraryId: string;
	readonly commit: string;
	readonly embeddingIdentity: typeof embeddingIdentity;
	readonly versions: readonly HostedVersion[];
}
interface Writer {
	readonly schema: 1;
	readonly writerId: string;
	readonly run: string;
	readonly base: Sha256 | null;
}
interface Receipt {
	readonly schema: 1;
	readonly intent: Sha256;
	readonly confirmed: readonly PassageId[];
}
const opaque = (value: string): void => {
	if (!/^[a-f0-9]{32}$/u.test(value))
		throw new AdapterError("identity_mismatch", "Invalid catalog identity/generation");
};
export function validationSource(source: HostedSource): SourceVersion {
	// This placeholder exists only to reuse source validators; it is never read.
	return defineSource({ ...source, originalPath: "/hosted-original-not-available.pdf" });
}
export function validateCatalog(input: unknown): Catalog {
	const value = input as Catalog;
	if (value?.schema !== 1 || !Array.isArray(value.versions))
		throw new AdapterError("invalid_response", "Invalid hosted catalog");
	opaque(value.libraryId);
	opaque(value.commit);
	assertEmbeddingIdentity(value.embeddingIdentity);
	boundedInteger(value.versions.length, 0, 20, "catalog books");
	const books = new Set<string>();
	for (const entry of value.versions) {
		const source = validationSource(entry.source);
		if ("originalPath" in entry.source || books.has(source.bookId) || entry.completed !== true)
			throw new AdapterError("identity_mismatch", "Mixed or incomplete catalog generation");
		books.add(source.bookId);
		opaque(entry.generation);
		if (!/^sha256:[a-f0-9]{64}$/u.test(entry.indexConfigurationHash))
			throw new AdapterError("identity_mismatch", "Invalid index configuration");
		boundedInteger(Object.keys(entry.passages).length, 0, 20000, "catalog passages");
		for (const [id, hash] of Object.entries(entry.passages))
			if (!/^passage_[a-f0-9]{32}$/u.test(id) || typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(hash))
				throw new AdapterError("identity_mismatch", "Invalid passage manifest");
		const figures = new Set<string>();
		for (const figure of entry.figures) {
			defineFigure(figure.figure, source);
			assertSourceIdentity(figure.asset, source);
			if (
				figures.has(figure.figure.id) ||
				figure.asset.figureId !== figure.figure.id ||
				figure.asset.assetHash !== figure.object.hash ||
				!/^sha256:[a-f0-9]{64}$/u.test(figure.object.hash)
			)
				throw new AdapterError("identity_mismatch", "Invalid hosted figure manifest");
			figures.add(figure.figure.id);
		}
	}
	return structuredClone(value);
}
export async function loadCatalog(
	objects: Objects,
): Promise<{ readonly catalog: Catalog | null; readonly incomplete: boolean; readonly hash: Sha256 | null }> {
	const object = await objects.discover(objects.libraryKey("catalog.json"));
	const writerObject = await objects.discover(objects.libraryKey("writer.json"));
	const catalog = object ? validateCatalog(JSON.parse(object.bytes.toString("utf8")) as unknown) : null;
	const writer = writerObject ? (JSON.parse(writerObject.bytes.toString("utf8")) as Writer) : null;
	if (writer) {
		opaque(writer.writerId);
		opaque(writer.run);
	}
	return {
		catalog,
		hash: object?.hash ?? null,
		incomplete: catalog === null || (writer !== null && writer.run !== catalog.commit),
	};
}
/** Hash every citation/text field against the committed manifest, not just IDs.
 * A provider's matching source label alone cannot make altered text evidence. */
export function resolveHostedPassage(id: string, metadata: PineconeMetadata, version: HostedVersion): Passage {
	const expected = version.passages[id as PassageId];
	if (
		!expected ||
		digest(metadata) !== expected ||
		metadata.generation !== version.generation ||
		metadata.indexConfigurationHash !== version.indexConfigurationHash
	)
		throw new AdapterError("identity_mismatch", "Hosted passage is stale or corrupted");
	const parse = <T>(key: string): T => {
		const value = metadata[key];
		if (typeof value !== "string") throw new AdapterError("invalid_response", "Missing hosted citation field");
		return JSON.parse(value) as T;
	};
	const passage = definePassage(
		{
			id: id as PassageId,
			bookId: metadata.bookId as Passage["bookId"],
			versionId: metadata.versionId as Passage["versionId"],
			sourceHash: metadata.sourceHash as Sha256,
			indexConfigurationHash: metadata.indexConfigurationHash as Sha256,
			parentSectionId: metadata.parentSectionId as Passage["parentSectionId"],
			originalText: metadata.originalText as string,
			normalizedText: metadata.normalizedText as string,
			headingPath: parse("headingPath"),
			spans: parse("spans"),
			mappings: parse("mappings"),
			neighbors: parse("neighbors"),
			figures: parse("figures"),
			quality: [],
		},
		validationSource(version.source),
	);
	if (passage.figures.some((link) => !version.figures.some((f) => f.figure.id === link.figureId)))
		throw new AdapterError("identity_mismatch", "Figure is absent from committed generation");
	return passage;
}
export interface IndexOptions {
	readonly store: CorpusStore;
	readonly objects: Objects;
	readonly pinecone: Pick<Pinecone, "upsert" | "fetch" | "delete">;
	readonly embeddings: Pick<LocalEmbeddings, "documents">;
	/** Operator explicitly selects the single authorized writer (normally libraryId).
	 * A different machine must not take over an existing claim automatically. */
	readonly writerId: string;
}
function readReceipt(path: string): Receipt | null {
	safePath(path, true);
	if (!existsSync(path)) return null;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024)
		throw new AdapterError("configuration", "Unsafe indexing receipt");
	return JSON.parse(readFileSync(path, "utf8")) as Receipt;
}
function saveReceipt(path: string, receipt: Receipt): void {
	const temporary = `${path}.${randomBytes(8).toString("hex")}`;
	try {
		writeFileSync(temporary, canonical(receipt), { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
/** S3 has no portable CAS: the persistent writer claim and repeated token/base
 * checks DETECT observed races, not a distributed mutex. Example: simultaneous
 * first claims may briefly race; stop on conflict and require operator recovery.
 * Never expire/steal claims. Local wx lock excludes same-store writers. */
export async function indexCorpus(options: IndexOptions): Promise<Catalog> {
	const { store, objects, pinecone, embeddings } = options;
	opaque(options.writerId);
	const lock = safePath(join(store.directory, ".index.lock"), true);
	let fd: number;
	try {
		fd = openSync(lock, "wx", 0o600);
	} catch {
		throw new AdapterError("busy", "Index writer lock exists; explicit recovery required");
	}
	try {
		await objects.prepareWriter();
		const initial = await loadCatalog(objects);
		if (initial.catalog && initial.catalog.libraryId !== store.libraryId)
			throw new AdapterError("identity_mismatch", "Hosted library differs from writer store");
		const claimKey = objects.libraryKey("writer.json");
		const previous = await objects.discover(claimKey);
		if (previous && (JSON.parse(previous.bytes.toString("utf8")) as Writer).writerId !== options.writerId)
			throw new AdapterError("busy", "Another writer owns the hosted library; operator recovery required");
		const run = randomBytes(16).toString("hex");
		const claim: Writer = { schema: 1, writerId: options.writerId, run, base: initial.hash };
		const claimReceipt = await objects.put(claimKey, Buffer.from(canonical(claim)), "application/json");
		const guard = async () => {
			const current = await objects.discover(claimKey);
			const catalog = await objects.discover(objects.libraryKey("catalog.json"));
			if (current?.hash !== claimReceipt.hash || (catalog?.hash ?? null) !== initial.hash)
				throw new AdapterError("busy", "Concurrent writer conflict detected; publication stopped");
		};
		await guard();
		const sources = store.listVersions().filter((s) => store.currentVersion(s.bookId)?.versionId === s.versionId);
		boundedInteger(sources.length, 0, 20, "indexed books");
		const versions: HostedVersion[] = [];
		for (const source of sources) {
			const passages = store.listPassages(source).map((p) => store.readPassage(source, p.id));
			const indexConfigurationHash = passages[0]?.indexConfigurationHash ?? source.extractor.configurationHash;
			const generation = digest([store.libraryId, source.versionId, indexConfigurationHash, embeddingIdentity]).slice(
				7,
				39,
			);
			const recordHashes = Object.fromEntries(
				passages.map((p) => [
					p.id,
					digest(
						passageRecord(
							p,
							Array.from({ length: 768 }, () => 1),
							generation,
						).metadata,
					),
				]),
			) as Record<PassageId, Sha256>;
			const intent = digest([source.versionId, generation, recordHashes]);
			const path = join(store.directory, `index-${source.versionId}.json`);
			const oldReceipt = readReceipt(path);
			if (
				oldReceipt &&
				(oldReceipt.schema !== 1 || oldReceipt.intent !== intent || !Array.isArray(oldReceipt.confirmed))
			)
				throw new AdapterError("identity_mismatch", "Receipt intent differs from immutable source");
			const confirmed = new Set<PassageId>();
			// Figures precede every vector and catalog upload, including resume.
			const figures: HostedFigure[] = [];
			for (const figure of store.listFigures(source)) {
				await guard();
				const { base64: _base64, ...asset } = store.readFigureAsset(source, figure.id);
				const key = objects.libraryKey(`${source.versionId}/${figure.id}`);
				const existing = await objects.discover(key);
				const object = existing
					? await objects.head(key, asset.assetHash)
					: await objects.putFigure(store, source, figure.id);
				if (existing && sha256(existing.bytes) !== asset.assetHash)
					throw new AdapterError("identity_mismatch", "Resumed figure content mismatch");
				figures.push({ figure, object, asset });
			}
			for (let offset = 0; offset < passages.length; offset += 8) {
				await guard();
				const batch = passages.slice(offset, offset + 8);
				const resumeIds = batch.filter((p) => oldReceipt?.confirmed.includes(p.id)).map((p) => p.id);
				if (resumeIds.length) {
					const found = await pinecone.fetch(resumeIds, embeddingIdentity);
					for (const p of batch)
						if (found.some((r) => r.id === p.id && digest(r.metadata) === recordHashes[p.id])) confirmed.add(p.id);
				}
				const pending = batch.filter((p) => !confirmed.has(p.id));
				if (pending.length) {
					const vectors = await embeddings.documents(pending, embeddingIdentity);
					await guard();
					await pinecone.upsert(
						pending.map((p, i) => passageRecord(p, vectors[i] ?? [], generation)),
						embeddingIdentity,
					);
					// Eventual consistency: acknowledgement is NOT visibility. Bounded
					// verification leaves the receipt for a later explicit resume.
					let visible = false;
					for (let attempt = 0; attempt < 3; attempt++) {
						const found = await pinecone.fetch(
							pending.map((p) => p.id),
							embeddingIdentity,
						);
						visible = pending.every((p) =>
							found.some((r) => r.id === p.id && digest(r.metadata) === recordHashes[p.id]),
						);
						if (visible) break;
						if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50));
					}
					if (!visible) throw new AdapterError("unavailable", "Index visibility incomplete; resume indexing later");
					for (const passage of pending) confirmed.add(passage.id);
				}
				saveReceipt(path, { schema: 1, intent, confirmed: [...confirmed] });
			}
			const { originalPath: _originalPath, ...hostedSource } = source;
			versions.push({
				source: hostedSource,
				generation,
				indexConfigurationHash,
				passages: recordHashes,
				figures,
				completed: true,
			});
		}
		const catalog = validateCatalog({
			schema: 1,
			libraryId: store.libraryId,
			commit: run,
			embeddingIdentity,
			versions,
		});
		await guard();
		const committed = await objects.put(
			objects.libraryKey("catalog.json"),
			Buffer.from(canonical(catalog)),
			"application/json",
		);
		// Post-commit race detection also fails closed to this writer. Readers check
		// claim.run === catalog.commit and reject a competing incomplete claim.
		const state = await loadCatalog(objects);
		if (state.hash !== committed.hash || state.incomplete)
			throw new AdapterError("busy", "Concurrent publication conflict detected");
		return catalog;
	} finally {
		closeSync(fd);
		rmSync(lock);
	}
}
/** Explicit cleanup only, after publication. IDs must be owned by the previous
 * catalog and absent from current; never a generation/filter/namespace delete. */
export async function pruneSuperseded(
	previous: Catalog,
	current: Catalog,
	pinecone: Pick<Pinecone, "delete">,
): Promise<void> {
	validateCatalog(previous);
	validateCatalog(current);
	if (previous.libraryId !== current.libraryId)
		throw new AdapterError("identity_mismatch", "Cannot prune another library");
	const retained = new Set(current.versions.flatMap((v) => Object.keys(v.passages)));
	const stale = previous.versions.flatMap((v) => Object.keys(v.passages)).filter((id) => !retained.has(id));
	for (let offset = 0; offset < stale.length; offset += 50) await pinecone.delete(stale.slice(offset, offset + 50));
}
