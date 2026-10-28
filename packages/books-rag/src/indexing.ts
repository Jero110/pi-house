import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Capacity, PublicationBudget, publicationLimits } from "./capacity.ts";
import { AdapterError, boundedInteger } from "./config.ts";
import type { Figure, Passage, PassageId, Sha256, SourceVersion } from "./contracts.ts";
import { assertSourceIdentity, defineFigure, definePassage, defineSource } from "./contracts.ts";
import type { LocalEmbeddings } from "./embeddings.ts";
import { assertEmbeddingIdentity, embeddingIdentity } from "./embeddings.ts";
import type { FigureAsset } from "./figures.ts";
import { CorpusError, safePath, sha256 } from "./locations.ts";
import type { ObjectReceipt, Objects } from "./objects.ts";
import type { Pinecone, PineconeMetadata } from "./pinecone.ts";
import { expandPassageEvidence, incompatibleSchemaMessage, passageRecord, recordSchema } from "./pinecone.ts";
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
export type HostedFigure =
	| {
			readonly figure: Figure;
			readonly unavailable: true;
			readonly object?: never;
			readonly asset?: never;
	  }
	| {
			readonly figure: Figure;
			readonly unavailable?: false;
			readonly object: ObjectReceipt;
			readonly asset: Omit<FigureAsset, "base64">;
	  };
export interface HostedVersion {
	readonly source: HostedSource;
	readonly generation: string;
	readonly indexConfigurationHash: Sha256;
	readonly passages: Readonly<Record<PassageId, Sha256>>;
	readonly figures: readonly HostedFigure[];
	readonly completed: true;
}
export interface Catalog {
	readonly schema: 2;
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
	readonly figures?: readonly string[];
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
	if (value?.schema !== 2 || !Array.isArray(value.versions))
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
			if (figure.unavailable) {
				if (!figure.figure.unavailable || figure.object || figure.asset || figures.has(figure.figure.id))
					throw new AdapterError("identity_mismatch", "Invalid unavailable figure manifest");
				figures.add(figure.figure.id);
				continue;
			}
			if (figure.figure.unavailable) throw new AdapterError("identity_mismatch", "Unavailable figure has image");
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

/** Wire schema 2: bounded immutable per-source manifests, then a small mutable
 * root committed last. Hydrated Catalogs stay local (including prune snapshots). */
export interface CatalogEntry {
	readonly source: Pick<HostedSource, "bookId" | "versionId" | "sourceHash">;
	readonly generation: string;
	readonly indexConfigurationHash: Sha256;
	readonly manifest: ObjectReceipt;
}
export interface CatalogRoot extends Omit<Catalog, "versions"> {
	readonly versions: readonly CatalogEntry[];
}
export const catalogReindexMessage = "Hosted catalog schema 1 is incompatible; re-run index to publish schema 2";
const jsonLimit = 1024 * 1024;
function jsonBytes(value: unknown): Buffer {
	const bytes = Buffer.from(canonical(value));
	boundedInteger(bytes.length, 1, jsonLimit, "catalog JSON size; source manifest too large");
	return bytes;
}
function parseCatalogJson(bytes: Buffer): unknown {
	boundedInteger(bytes.length, 1, jsonLimit, "catalog JSON size");
	try {
		return JSON.parse(bytes.toString("utf8")) as unknown;
	} catch {
		throw new AdapterError("invalid_response", "Invalid catalog JSON");
	}
}
function entryIdentity(version: HostedVersion): Omit<CatalogEntry, "manifest"> {
	const { bookId, versionId, sourceHash } = version.source;
	return {
		source: { bookId, versionId, sourceHash },
		generation: version.generation,
		indexConfigurationHash: version.indexConfigurationHash,
	};
}
interface SourceManifest {
	readonly schema: 2;
	readonly libraryId: string;
	readonly embeddingIdentity: typeof embeddingIdentity;
	readonly version: Omit<HostedVersion, "passages" | "figures">;
	readonly parts: readonly ObjectReceipt[];
}
interface ManifestPart {
	readonly schema: 2;
	readonly libraryId: string;
	readonly identity: Omit<CatalogEntry, "manifest">;
	readonly passages: Readonly<Record<PassageId, Sha256>>;
	readonly figures: readonly HostedFigure[];
}
function assertManifestPin(pin: ObjectReceipt, versionId: string, objects: Pick<Objects, "libraryKey">): void {
	if (
		!pin ||
		!/^sha256:[a-f0-9]{64}$/u.test(pin.hash) ||
		pin.key !== objects.libraryKey(`manifests/${versionId}/${pin.hash.slice(7)}.json`)
	)
		throw new AdapterError("identity_mismatch", "Invalid source manifest pin/key");
	boundedInteger(pin.bytes, 1, jsonLimit, "source manifest size");
}
/** Preflight every object before any shard upload. Maps and figures are packed
 * into <=512 KiB payloads plus their small identity envelope. At most 128 parts
 * per source; oversized individual items/source headers fail explicitly. */
export function encodeCatalog(
	catalog: Catalog,
	objects: Pick<Objects, "libraryKey">,
): {
	readonly root: CatalogRoot;
	readonly shards: readonly { readonly object: ObjectReceipt; readonly bytes: Buffer }[];
} {
	validateCatalog(catalog);
	const shards: { object: ObjectReceipt; bytes: Buffer }[] = [];
	const versions = catalog.versions.map((version): CatalogEntry => {
		const add = (value: unknown): ObjectReceipt => {
			const bytes = jsonBytes(value);
			const hash = sha256(bytes);
			const key = objects.libraryKey(`manifests/${version.source.versionId}/${hash.slice(7)}.json`);
			const object = { key, hash, bytes: bytes.length };
			shards.push({ object, bytes });
			return object;
		};
		const identity = entryIdentity(version);
		const parts: ObjectReceipt[] = [];
		let passages: Record<PassageId, Sha256> = {};
		let figures: HostedFigure[] = [];
		let size = 0;
		const flush = () => {
			if (!size) return;
			boundedInteger(parts.length + 1, 1, 128, "source manifest parts");
			parts.push(add({ schema: 2, libraryId: catalog.libraryId, identity, passages, figures } satisfies ManifestPart));
			passages = {};
			figures = [];
			size = 0;
		};
		const reserve = (value: unknown) => {
			const bytes = Buffer.byteLength(canonical(value)) + 2;
			boundedInteger(bytes, 1, jsonLimit / 2, "source manifest item size");
			if (size + bytes > jsonLimit / 2) flush();
			size += bytes;
		};
		for (const [id, hash] of Object.entries(version.passages)) {
			reserve({ [id]: hash });
			passages[id as PassageId] = hash;
		}
		for (const figure of version.figures) {
			reserve(figure);
			figures.push(figure);
		}
		flush();
		const { passages: _passages, figures: _figures, ...header } = version;
		const manifest = add({
			schema: 2,
			libraryId: catalog.libraryId,
			embeddingIdentity,
			version: header,
			parts,
		} satisfies SourceManifest);
		return { ...identity, manifest };
	});
	const root: CatalogRoot = { ...catalog, versions };
	jsonBytes(root);
	return { root, shards };
}
function validateRoot(input: unknown, objects: Objects): CatalogRoot {
	const root = input as CatalogRoot;
	if (root?.schema === (1 as number)) throw new AdapterError("identity_mismatch", catalogReindexMessage);
	if (root?.schema !== 2 || !Array.isArray(root.versions))
		throw new AdapterError("invalid_response", "Invalid hosted catalog root");
	opaque(root.libraryId);
	opaque(root.commit);
	assertEmbeddingIdentity(root.embeddingIdentity);
	boundedInteger(root.versions.length, 0, 20, "catalog books");
	const books = new Set<string>();
	for (const entry of root.versions) {
		if (
			!entry?.source ||
			!/^book_[a-f0-9]{32}$/u.test(entry.source.bookId) ||
			!/^version_[a-f0-9]{32}$/u.test(entry.source.versionId) ||
			!/^sha256:[a-f0-9]{64}$/u.test(entry.source.sourceHash) ||
			books.has(entry.source.bookId) ||
			!/^sha256:[a-f0-9]{64}$/u.test(entry.indexConfigurationHash) ||
			!entry.manifest ||
			!/^sha256:[a-f0-9]{64}$/u.test(entry.manifest.hash)
		)
			throw new AdapterError("identity_mismatch", "Invalid source manifest pin");
		books.add(entry.source.bookId);
		opaque(entry.generation);
		assertManifestPin(entry.manifest, entry.source.versionId, objects);
	}
	return root;
}
export async function loadCatalog(
	objects: Objects,
	options: { readonly bookIds?: readonly string[]; readonly allowLegacy?: boolean } = {},
): Promise<{ readonly catalog: Catalog | null; readonly incomplete: boolean; readonly hash: Sha256 | null }> {
	const object = await objects.discover(objects.libraryKey("catalog.json"));
	let catalog: Catalog | null = null;
	if (object) {
		const input = parseCatalogJson(object.bytes);
		// Only the explicit writer migration can read schema 1, and still validates
		// all identities before preserving a local prune snapshot. Readers fail closed.
		if (options.allowLegacy && (input as { schema?: unknown })?.schema === 1) {
			catalog = validateCatalog({ ...(input as object), schema: 2 });
		} else {
			const root = validateRoot(input, objects);
			const versions: HostedVersion[] = [];
			for (const entry of root.versions) {
				if (options.bookIds && !options.bookIds.includes(entry.source.bookId)) continue;
				const bytes = await objects.get(entry.manifest.key, entry.manifest.hash);
				if (bytes.length !== entry.manifest.bytes)
					throw new AdapterError("identity_mismatch", "Source manifest size mismatch");
				const shard = parseCatalogJson(bytes) as SourceManifest;
				if (shard?.schema !== 2 || shard.libraryId !== root.libraryId)
					throw new AdapterError("identity_mismatch", "Source manifest library/schema mismatch");
				assertEmbeddingIdentity(shard.embeddingIdentity);
				if (!Array.isArray(shard.parts)) throw new AdapterError("identity_mismatch", "Invalid source manifest parts");
				boundedInteger(shard.parts.length, 0, 128, "source manifest parts");
				const passages: Record<PassageId, Sha256> = {};
				const figures: HostedFigure[] = [];
				const expectedIdentity = {
					source: entry.source,
					generation: entry.generation,
					indexConfigurationHash: entry.indexConfigurationHash,
				};
				for (const pin of shard.parts) {
					assertManifestPin(pin, entry.source.versionId, objects);
					const bytes = await objects.get(pin.key, pin.hash);
					if (bytes.length !== pin.bytes)
						throw new AdapterError("identity_mismatch", "Source manifest part size mismatch");
					const part = parseCatalogJson(bytes) as ManifestPart;
					if (
						part?.schema !== 2 ||
						part.libraryId !== root.libraryId ||
						canonical(part.identity) !== canonical(expectedIdentity) ||
						!part.passages ||
						!Array.isArray(part.figures)
					)
						throw new AdapterError("identity_mismatch", "Source manifest part version/generation mismatch");
					for (const [id, hash] of Object.entries(part.passages)) {
						if (
							!/^passage_[a-f0-9]{32}$/u.test(id) ||
							!/^sha256:[a-f0-9]{64}$/u.test(hash) ||
							Object.hasOwn(passages, id)
						)
							throw new AdapterError("identity_mismatch", "Invalid or duplicate manifest passage");
						passages[id as PassageId] = hash;
					}
					for (const figure of part.figures) figures.push(figure);
					boundedInteger(Object.keys(passages).length, 0, 20000, "catalog passages");
				}
				const version = validateCatalog({ ...root, versions: [{ ...shard.version, passages, figures }] }).versions[0];
				if (!version) throw new AdapterError("identity_mismatch", "Missing source manifest version");
				if (
					canonical(entryIdentity(version)) !==
					canonical({
						source: entry.source,
						generation: entry.generation,
						indexConfigurationHash: entry.indexConfigurationHash,
					})
				)
					throw new AdapterError("identity_mismatch", "Source manifest version/generation mismatch");
				versions.push(version);
			}
			catalog = validateCatalog({ ...root, versions });
		}
	}
	const writerObject = await objects.discover(objects.libraryKey("writer.json"));
	const writer = writerObject ? (JSON.parse(writerObject.bytes.toString("utf8")) as Writer) : null;
	if (writer) {
		opaque(writer.writerId);
		opaque(writer.run);
	}
	// A root can change while its shards are being fetched. Never expose that
	// superseded snapshot, including list calls that have no later backend read.
	if ((await objects.discover(objects.libraryKey("catalog.json")))?.hash !== object?.hash)
		throw new AdapterError("identity_mismatch", "Catalog changed while loading source manifests; retry");
	return {
		catalog,
		hash: object?.hash ?? null,
		incomplete: catalog === null || (writer !== null && writer.run !== catalog.commit),
	};
}
/** Hash every citation/text field against the committed manifest, not just IDs.
 * A provider's matching source label alone cannot make altered text evidence. */
export function resolveHostedPassage(id: string, metadata: PineconeMetadata, version: HostedVersion): Passage {
	if (metadata.schema !== recordSchema)
		throw new AdapterError("identity_mismatch", incompatibleSchemaMessage(metadata.schema));
	const expected = version.passages[id as PassageId];
	if (
		!expected ||
		digest(metadata) !== expected ||
		metadata.generation !== version.generation ||
		metadata.indexConfigurationHash !== version.indexConfigurationHash
	)
		throw new AdapterError("identity_mismatch", "Hosted passage is stale or corrupted");
	const evidence = expandPassageEvidence(metadata);
	const passage = definePassage(
		{
			id: id as PassageId,
			bookId: metadata.bookId as Passage["bookId"],
			versionId: metadata.versionId as Passage["versionId"],
			sourceHash: metadata.sourceHash as Sha256,
			indexConfigurationHash: metadata.indexConfigurationHash as Sha256,
			parentSectionId: metadata.parentSectionId as Passage["parentSectionId"],
			originalText: metadata.originalText as string,
			...evidence,
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
	readonly pinecone: Pick<Pinecone, "upsert" | "listIds" | "delete" | "setAccounting" | "doctor">;
	readonly embeddings: Pick<LocalEmbeddings, "documents" | "setAccounting" | "doctor">;
	readonly capacity?: Capacity;
	readonly onPlan?: (summary: string) => void;
	/** Operator explicitly selects the single authorized writer (normally libraryId).
	 * A different machine must not take over an existing claim automatically. */
	readonly writerId: string;
	/** Called for each current version that is left out of this publication, with the reason. */
	readonly onSkip?: (skip: SkippedVersion) => void;
}
export interface SkippedVersion {
	readonly bookId: string;
	readonly versionId: string;
	readonly reason: string;
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
/** IDs cannot collide with any other generation. Neighbor links use the same
 * transformation, so all eventual read/search evidence still hashes exactly. */
export function generationPassages(passages: readonly Passage[], generation: string): readonly Passage[] {
	const id = (value: PassageId): PassageId => `passage_${digest(["hosted-id-v1", generation, value]).slice(7, 39)}`;
	return passages.map((p) => ({
		...p,
		id: id(p.id),
		neighbors: {
			previous: p.neighbors.previous === null ? null : id(p.neighbors.previous),
			next: p.neighbors.next === null ? null : id(p.neighbors.next),
		},
	}));
}
interface PublicationPlan {
	readonly sources: readonly SourceVersion[];
	readonly estimated: Partial<Capacity>;
}
/** Offline whole-publication sizing, retaining no image payload across books.
 * Wire vector numbers use a conservative 24 bytes per finite JSON number. */
export function planPublication(options: IndexOptions): PublicationPlan {
	const { store, objects } = options;
	const sources: SourceVersion[] = [];
	const versions: HostedVersion[] = [];
	let vectors = 0,
		inputs = 0,
		figuresCount = 0,
		figureBytes = 0,
		uploadBytes = 0,
		wire = 0,
		batches = 0;
	for (const source of store.listVersions().filter((s) => store.currentVersion(s.bookId)?.versionId === s.versionId)) {
		let book: ReturnType<CorpusStore["publicationSource"]>;
		try {
			book = store.publicationSource(source);
		} catch (error) {
			if (!(error instanceof CorpusError && error.code === "source_changed")) throw error;
			options.onSkip?.({
				bookId: source.bookId,
				versionId: source.versionId,
				reason:
					"the original file changed after ingestion; run `ingest --input <file> --book <bookId>` to record the new edition as a new version",
			});
			continue;
		}
		sources.push(source);
		boundedInteger(sources.length, 0, 20, "indexed books");
		const indexConfigurationHash = book.passages[0]?.indexConfigurationHash ?? source.extractor.configurationHash;
		const generation = digest([store.libraryId, source.versionId, indexConfigurationHash, embeddingIdentity]).slice(
			7,
			39,
		);
		const passages: Record<PassageId, Sha256> = {};
		let sourceWire = 0;
		for (const p of generationPassages(book.passages, generation)) {
			const record = passageRecord(
				p,
				Array.from({ length: 768 }, () => 1),
				generation,
			);
			passages[p.id] = digest(record.metadata);
			sourceWire += Buffer.byteLength(JSON.stringify(record)) + 768 * 23 + 128;
		}
		const intent = digest([source.versionId, generation, passages]);
		const receipt = readReceipt(join(store.directory, `index-${source.versionId}.json`));
		if (
			receipt &&
			(receipt.schema !== 1 ||
				receipt.intent !== intent ||
				!Array.isArray(receipt.confirmed) ||
				receipt.confirmed.some((id) => !Object.hasOwn(passages, id)))
		)
			throw new AdapterError("identity_mismatch", "Receipt intent differs from immutable source");
		const pending = book.passages.length - new Set(receipt?.confirmed ?? []).size;
		vectors += pending;
		inputs += pending;
		// Conservative wire estimate retains full source bytes on partial resume.
		if (pending) wire += sourceWire;
		batches += Math.ceil(book.passages.length / 8);
		const figures = book.figures.map((figure): HostedFigure => {
			if (figure.unavailable) return { figure, unavailable: true };
			const found = book.figureAssets?.find((a) => a.figureId === figure.id);
			if (!found) throw new AdapterError("identity_mismatch", "Missing persisted figure asset");
			const { base64, ...asset } = found;
			const bytes = Buffer.byteLength(base64, "base64");
			if (!receipt?.figures?.includes(figure.id)) uploadBytes += bytes;
			figuresCount++;
			figureBytes += bytes;
			return {
				figure,
				asset,
				object: { key: objects.libraryKey(`${source.versionId}/${figure.id}`), hash: asset.assetHash, bytes },
			};
		});
		const { originalPath: _originalPath, ...hostedSource } = source;
		versions.push({ source: hostedSource, generation, indexConfigurationHash, passages, figures, completed: true });
	}
	if (store.listVersions().length && !sources.length)
		throw new AdapterError(
			"configuration",
			"Every current version was skipped; nothing was published. Fix the skipped versions first",
		);
	const publication = encodeCatalog(
		{ schema: 2, libraryId: store.libraryId, commit: "0".repeat(32), embeddingIdentity, versions },
		objects,
	);
	const catalogBytes = publication.shards.reduce((n, s) => n + s.bytes.length, 0) + jsonBytes(publication.root).length;
	uploadBytes += catalogBytes + 512;
	// Four bounded namespace snapshots, all three transport attempts, upsert
	// acknowledgements/errors, and 256 control-plane probes. No full-vector reads.
	const pineconeResponseBytes = 4000 * 3 * (16384 + 8192) + batches * 3 * (4096 + 8192) + 256 * 3 * (16384 + 8192);
	if (pineconeResponseBytes > 600000000)
		throw new AdapterError("resource_limit", "Planned Pinecone egress exceeds 600MB");
	const s3ResponseBytes = 3 * (figureBytes + batches * 4 * 16384 + catalogBytes * 3) + 100000 * 8192;
	return {
		sources,
		estimated: {
			vectors,
			inputs,
			uploadBytes,
			pineconeBytes: wire,
			writeBytes: uploadBytes + wire + inputs * 2200,
			// Includes up to three visibility reads, resume figure downloads, local vectors,
			// root guards and hydrated manifests. Retries consume hard remaining caps.
			pineconeResponseBytes,
			s3ResponseBytes,
			responseBytes: pineconeResponseBytes + s3ResponseBytes + inputs * 768 * 24,
			requests: batches * 9 + figuresCount * 2 + Math.ceil(figuresCount / 16) * 4 + publication.shards.length * 4 + 256,
		},
	};
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
		const budget = new PublicationBudget(
			join(store.directory, "index-capacity.json"),
			options.capacity ?? publicationLimits,
		);
		const plan = planPublication(options);
		options.onPlan?.(
			`Publication capacity (payload estimates, not provider quotas): ${JSON.stringify({ planned: plan.estimated, remaining: budget.remaining(), caps: budget.limits })}; retries and actual response bytes consume remaining hard caps`,
		);
		budget.check(plan.estimated);
		objects.setAccounting((write, response) => {
			budget.charge({ uploadBytes: write });
			return budget.providerAccount("s3")(write, response);
		});
		pinecone.setAccounting((write, response) => {
			budget.charge({ pineconeBytes: write });
			return budget.providerAccount("pinecone")(write, response);
		});
		embeddings.setAccounting(budget.account);
		// Fail model/index identity before even the privacy-canary write.
		await pinecone.doctor();
		await embeddings.doctor();
		await objects.prepareWriter();
		const initial = await loadCatalog(objects, { allowLegacy: true });
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
		const sources = plan.sources;
		boundedInteger(sources.length, 0, 20, "indexed books");
		const versions: HostedVersion[] = [];
		// One namespace snapshot for resume, not one full-vector fetch per batch.
		const hasCompletedUpserts = sources.some(
			(source) => (readReceipt(join(store.directory, `index-${source.versionId}.json`))?.confirmed.length ?? 0) > 0,
		);
		// Do not list a not-yet-materialized namespace on a fresh publication.
		const resumedIds = new Set(hasCompletedUpserts ? await pinecone.listIds(embeddingIdentity) : []);
		for (const source of sources) {
			let book: ReturnType<CorpusStore["publicationSource"]>;
			let passages: readonly Passage[];
			try {
				book = store.publicationSource(source);
				passages = book.passages;
			} catch (error) {
				// Problem: one edited original used to abort the whole library. Example: a book saved over by
				// its new edition makes the old version fail source_changed. Solution: skip exactly that version
				// with a named reason and keep the rest; a changed original is never re-read as if unchanged.
				if (error instanceof CorpusError && error.code === "source_changed") {
					options.onSkip?.({
						bookId: source.bookId,
						versionId: source.versionId,
						reason:
							"the original file changed after ingestion; run `ingest --input <file> --book <bookId>` to record the new edition as a new version",
					});
					continue;
				}
				throw error;
			}
			const indexConfigurationHash = passages[0]?.indexConfigurationHash ?? source.extractor.configurationHash;
			const generation = digest([store.libraryId, source.versionId, indexConfigurationHash, embeddingIdentity]).slice(
				7,
				39,
			);
			passages = generationPassages(passages, generation);
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
			const uploadedFigures = new Set(oldReceipt?.figures ?? []);
			for (const [figureIndex, figure] of book.figures.entries()) {
				if (figureIndex % 16 === 0) await guard();
				if (figure.unavailable) {
					figures.push({ figure, unavailable: true });
					continue;
				}
				const foundAsset = book.figureAssets?.find((a) => a.figureId === figure.id);
				if (!foundAsset) throw new AdapterError("identity_mismatch", "Missing persisted figure asset");
				const { base64, ...asset } = foundAsset;
				const key = objects.libraryKey(`${source.versionId}/${figure.id}`);
				const existing = await objects.discover(key);
				const object = existing
					? await objects.head(key, asset.assetHash)
					: await objects.put(key, Buffer.from(base64, "base64"), asset.mimeType);
				if (object.hash !== asset.assetHash || (existing && sha256(existing.bytes) !== asset.assetHash))
					throw new AdapterError("identity_mismatch", "Stored/resumed figure content mismatch");
				figures.push({ figure, object, asset });
				uploadedFigures.add(figure.id);
				if (figureIndex % 16 === 15 || figureIndex === book.figures.length - 1) {
					await guard();
					saveReceipt(path, {
						schema: 1,
						intent,
						confirmed: oldReceipt?.confirmed ?? [],
						figures: [...uploadedFigures],
					});
				}
			}
			for (let offset = 0; offset < passages.length; offset += 8) {
				await guard();
				const batch = passages.slice(offset, offset + 8);
				const resumeIds = batch.filter((p) => oldReceipt?.confirmed.includes(p.id)).map((p) => p.id);
				if (resumeIds.length) {
					for (const id of resumeIds) if (resumedIds.has(id)) confirmed.add(id);
				}
				const pending = batch.filter((p) => !confirmed.has(p.id));
				if (pending.length) {
					budget.charge({ inputs: pending.length });
					const vectors = await embeddings.documents(pending, embeddingIdentity);
					budget.charge({ vectors: pending.length });
					await pinecone.upsert(
						pending.map((p, i) => passageRecord(p, vectors[i] ?? [], generation)),
						embeddingIdentity,
					);
					// Receipt records only completed upserts. Visibility is a separate
					// whole-namespace phase below, mandatory before root commit.
					for (const passage of pending) confirmed.add(passage.id);
				}
				await guard();
				saveReceipt(path, { schema: 1, intent, confirmed: [...confirmed], figures: [...uploadedFigures] });
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
		if (sources.length > 0 && versions.length === 0)
			throw new AdapterError(
				"configuration",
				"Every current version was skipped; nothing was published. Fix the skipped versions first",
			);
		// Never commit from acknowledgement or a stale initial snapshot alone.
		// New generation IDs are never overwritten by a different generation;
		// metadata hashes remain mandatory on EVERY eventual evidence read.
		const expectedIds = versions.flatMap((v) => Object.keys(v.passages));
		let visible = expectedIds.length === 0;
		for (let attempt = 0; !visible && attempt < 3; attempt++) {
			await guard();
			const ids = new Set(await pinecone.listIds(embeddingIdentity));
			visible = expectedIds.every((id) => ids.has(id));
			if (!visible && attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!visible) throw new AdapterError("unavailable", "Index visibility incomplete; resume indexing later");
		const catalog = validateCatalog({
			schema: 2,
			libraryId: store.libraryId,
			commit: run,
			embeddingIdentity,
			versions,
		});
		const publication = encodeCatalog(catalog, objects);
		for (const shard of publication.shards) {
			await guard();
			await objects.put(shard.object.key, shard.bytes, "application/json");
			// Verify the actual stored bytes, not merely acknowledged uploads.
			await objects.get(shard.object.key, shard.object.hash);
		}
		// Persist prune ownership before replacing the only hosted root. A crash
		// after root PUT must not lose the superseded IDs; pending claims block prune.
		if (initial.catalog && initial.catalog.commit !== catalog.commit)
			savePrevious(join(store.directory, `previous-catalog-${initial.catalog.commit}.json`), initial.catalog);
		await guard();
		const committed = await objects.put(
			objects.libraryKey("catalog.json"),
			jsonBytes(publication.root),
			"application/json",
		);
		// Post-commit race detection also fails closed to this writer. Readers check
		// claim.run === catalog.commit and reject a competing incomplete claim.
		const state = await loadCatalog(objects);
		if (state.hash !== committed.hash || state.incomplete)
			throw new AdapterError("busy", "Concurrent publication conflict detected");
		return catalog;
	} finally {
		objects.setAccounting(undefined);
		pinecone.setAccounting(undefined);
		embeddings.setAccounting(undefined);
		closeSync(fd);
		rmSync(lock);
	}
}
function savePrevious(path: string, catalog: Catalog): void {
	safePath(path, true);
	if (existsSync(path)) return;
	writeFileSync(path, canonical(catalog), { mode: 0o600, flag: "wx" });
}
const previousCatalogName = /^previous-catalog-[a-f0-9]{32}\.json$/u;
/** Catalogs saved by earlier `index` runs, oldest names first. Each is validated like a hosted catalog. */
export function loadPreviousCatalogs(store: Pick<CorpusStore, "directory">): readonly {
	readonly file: string;
	readonly catalog: Catalog;
}[] {
	return readdirSync(store.directory)
		.filter((name) => previousCatalogName.test(name))
		.sort()
		.map((name) => {
			const file = join(store.directory, name);
			safePath(file);
			const stat = lstatSync(file);
			if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024 * 1024)
				throw new AdapterError("configuration", "Unsafe previous-catalog file");
			const input = JSON.parse(readFileSync(file, "utf8")) as Catalog;
			// Local schema-1 snapshots already contain the full validated maps. Keep
			// their prune ownership across root reindexing; never treat them as roots.
			return { file, catalog: validateCatalog(input.schema === (1 as number) ? { ...input, schema: 2 } : input) };
		});
}
/** Passage IDs owned by `previous` and absent from `current`: the only IDs a prune may ever name. */
export function supersededIds(previous: Catalog, current: Catalog): readonly string[] {
	validateCatalog(previous);
	validateCatalog(current);
	if (previous.libraryId !== current.libraryId)
		throw new AdapterError("identity_mismatch", "Cannot prune another library");
	const retained = new Set(current.versions.flatMap((v) => Object.keys(v.passages)));
	return previous.versions.flatMap((v) => Object.keys(v.passages)).filter((id) => !retained.has(id));
}
/** Explicit cleanup only, after publication. IDs must be owned by the previous
 * catalog and absent from current; never a generation/filter/namespace delete. */
export async function pruneSuperseded(
	previous: Catalog,
	current: Catalog,
	pinecone: Pick<Pinecone, "delete">,
): Promise<number> {
	const stale = supersededIds(previous, current);
	for (let offset = 0; offset < stale.length; offset += 50) await pinecone.delete(stale.slice(offset, offset + 50));
	return stale.length;
}
