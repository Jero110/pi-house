import assert from "node:assert/strict";
import { test } from "node:test";
import type { MetadataField, Passage, SourceVersion } from "../src/contracts.ts";
import { embeddingIdentity } from "../src/embeddings.ts";
import { type Catalog, canonical, digest, encodeCatalog, type HostedVersion, loadCatalog } from "../src/indexing.ts";
import { sha256 } from "../src/locations.ts";
import { Objects } from "../src/objects.ts";
import { Pinecone, passageRecord } from "../src/pinecone.ts";
import { readHostedPassage, searchBooks } from "../src/search.ts";
import { fakeServices } from "./fake-services.ts";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const unknown = <T>(): MetadataField<T> => ({ value: null, evidence: [], resolution: "unknown" });
function version(n: number, count = 2000): { version: HostedVersion; passage: Passage } {
	const source: SourceVersion = {
		bookId: `book_${hex(n)}`,
		versionId: `version_${hex(n)}`,
		sourceHash: sha256(`source-${n}`),
		originalPath: "/absent/synthetic.pdf",
		format: "pdf",
		pageCount: 1,
		metadata: {
			title: unknown(),
			authors: unknown(),
			publisher: unknown(),
			edition: unknown(),
			publicationDate: unknown(),
		},
		extractor: { name: "synthetic", version: "1", configurationHash: sha256("extractor") },
		coverage: { totalPages: 1, extractedPages: [1], gaps: [], status: "complete" },
		diagnostics: [],
	};
	const { originalPath: _path, ...hosted } = source;
	const passage: Passage = {
		bookId: source.bookId,
		versionId: source.versionId,
		sourceHash: source.sourceHash,
		id: `passage_${hex(n * 20000)}`,
		parentSectionId: `section_${hex(n)}`,
		headingPath: [
			{
				sectionId: `section_${hex(n)}`,
				title: "Synthetic",
				location: {
					kind: "pdf",
					pageNumber: 1,
					printedLabel: null,
					coordinateSystem: "pdf-points-top-left",
					pageWidth: 600,
					pageHeight: 800,
					bounds: null,
				},
			},
		],
		originalText: "Synthetic evidence only.",
		normalizedText: "Synthetic evidence only.",
		mappings: [{ kind: "literal", originalRange: { start: 0, end: 24 }, normalizedRange: { start: 0, end: 24 } }],
		spans: [
			{
				blockId: `block_${hex(n)}`,
				originalRange: { start: 0, end: 24 },
				location: {
					kind: "pdf",
					pageNumber: 1,
					printedLabel: null,
					coordinateSystem: "pdf-points-top-left",
					pageWidth: 600,
					pageHeight: 800,
					bounds: null,
				},
			},
		],
		neighbors: { previous: null, next: null },
		figures: [],
		quality: [],
		indexConfigurationHash: sha256("chunks"),
	};
	const generation = hex(n);
	const passages = Object.fromEntries(
		Array.from({ length: count }, (_, i) => [`passage_${hex(n * 20000 + i)}`, sha256(`record-${n}-${i}`)]),
	);
	passages[passage.id] = digest(passageRecord(passage, Array(768).fill(1), generation).metadata);
	return {
		version: {
			source: hosted,
			generation,
			indexConfigurationHash: passage.indexConfigurationHash,
			passages,
			figures: [],
			completed: true,
		},
		passage,
	};
}
async function world(t: { after: (fn: () => Promise<void>) => void }) {
	const fake = await fakeServices();
	t.after(() => fake.close());
	const objects = new Objects({
		endpoint: `${fake.url}/s3`,
		bucket: "private-books",
		region: "us-east-1",
		prefix: "library/",
		accessKeyId: "fake-id",
		secretAccessKey: "fake-secret",
		privateBucketConfirmed: true,
		retries: 0,
	});
	await objects.prepareWriter();
	const pinecone = new Pinecone({
		host: fake.url,
		controlUrl: fake.url,
		indexName: "books",
		namespace: "synthetic",
		apiKey: "fake-api",
		minimumWriteIntervalMs: 0,
		minimumQueryIntervalMs: 0,
		retries: 0,
	});
	const samples = Array.from({ length: 19 }, (_, i) => version(i + 1));
	const catalog: Catalog = {
		schema: 2,
		libraryId: hex(42),
		commit: hex(43),
		embeddingIdentity,
		versions: samples.map((s) => s.version),
	};
	const publication = encodeCatalog(catalog, objects);
	for (const shard of publication.shards) await objects.put(shard.object.key, shard.bytes, "application/json");
	await objects.put(objects.libraryKey("catalog.json"), Buffer.from(canonical(publication.root)), "application/json");
	return { fake, objects, pinecone, samples, catalog, publication };
}

test("schema-2 root and 19 source shards fit unchanged caps despite aggregate mapping above 1 MiB; empty-store reader", async (t) => {
	const w = await world(t);
	const aggregate = Buffer.byteLength(canonical(w.catalog.versions.map((v) => v.passages)));
	const rootBytes = Buffer.byteLength(canonical(w.publication.root));
	const maxShard = Math.max(...w.publication.shards.map((s) => s.bytes.length));
	assert.ok(aggregate > 1024 * 1024);
	assert.ok(rootBytes < 1024 * 1024 && maxShard < 1024 * 1024);
	assert.ok(!canonical(w.publication.root).includes("passage_"));
	t.diagnostic(`Synthetic 19-book mapping ${aggregate} B; root ${rootBytes} B; max source shard ${maxShard} B`);
	assert.equal((await loadCatalog(w.objects)).catalog?.versions.length, 19);
	const sample = w.samples[0];
	assert.ok(sample);
	await w.pinecone.upsert(
		[
			passageRecord(
				sample.passage,
				Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
				sample.version.generation,
			),
		],
		embeddingIdentity,
	);
	assert.equal((await readHostedPassage(w, sample.passage.id)).text, sample.passage.originalText);
	const before = w.fake.requests.length;
	const result = await searchBooks(
		{
			objects: w.objects,
			pinecone: w.pinecone,
			embeddings: { query: async () => Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) },
		},
		{ query: "synthetic evidence", bookIds: [sample.passage.bookId] },
	);
	assert.equal(result.status, "ok", JSON.stringify(result.diagnostics));
	assert.equal(result.hits[0]?.passageId, sample.passage.id);
	const reads = w.fake.requests.slice(before).filter((r) => r.includes("/manifests/"));
	assert.equal(reads.length, 2, "filtered search loads only the necessary source manifest and data part");
	assert.equal((await readHostedPassage(w, sample.passage.id)).text, sample.passage.originalText);
	assert.equal(
		w.fake.requests.some((r) => r.includes("/create") || r.includes("/pull")),
		false,
	);
});

test("source shard tampering is rejected even with matching self-declared S3 metadata", async (t) => {
	const w = await world(t);
	const first = w.publication.shards[0];
	assert.ok(first);
	const bytes = Buffer.from(first.bytes.toString().replace('"schema":2', '"schema":0'));
	w.fake.storage.set(`/s3/private-books/${first.object.key}`, { bytes, hash: sha256(bytes).slice(7) });
	await assert.rejects(loadCatalog(w.objects), /hash mismatch/u);
});

test("pinned shard cannot substitute a different source generation; root snapshot changes during shard reads fail closed", async (t) => {
	const w = await world(t);
	const first = w.publication.shards.find((s) => s.object.hash === w.publication.root.versions[0]?.manifest.hash);
	assert.ok(first);
	const bytes = Buffer.from(first.bytes.toString().replace(`"generation":"${hex(1)}"`, `"generation":"${hex(2)}"`));
	const hash = sha256(bytes);
	const key = w.objects.libraryKey(`manifests/version_${hex(1)}/${hash.slice(7)}.json`);
	await w.objects.put(key, bytes, "application/json");
	const root = {
		...w.publication.root,
		versions: w.publication.root.versions.map((v, i) =>
			i === 0 ? { ...v, manifest: { key, hash, bytes: bytes.length } } : v,
		),
	};
	await w.objects.put(w.objects.libraryKey("catalog.json"), Buffer.from(canonical(root)), "application/json");
	await assert.rejects(loadCatalog(w.objects), /version\/generation mismatch/u);
	await w.objects.put(
		w.objects.libraryKey("catalog.json"),
		Buffer.from(canonical(w.publication.root)),
		"application/json",
	);
	w.fake.faults.beforeObjectGet = (path) => {
		if (!path.includes("/manifests/")) return;
		w.fake.faults.beforeObjectGet = null;
		const bytes = Buffer.from(canonical({ ...w.publication.root, commit: hex(99) }));
		w.fake.storage.set("/s3/private-books/library/catalog.json", { bytes, hash: sha256(bytes).slice(7) });
	};
	await assert.rejects(loadCatalog(w.objects), /Catalog changed/u);
});

test("legacy root requires explicit reindex; a single oversized source fails before publishing anything", async (t) => {
	const w = await world(t);
	const previous = w.fake.storage.get("/s3/private-books/library/catalog.json");
	const big = version(1, 10000).version;
	assert.ok(Buffer.byteLength(canonical(big.passages)) > 1024 * 1024);
	const split = encodeCatalog({ ...w.catalog, versions: [big] }, w.objects);
	assert.ok(split.shards.length > 2, "oversized source maps are further sharded");
	for (const shard of split.shards) {
		assert.ok(shard.bytes.length <= 1024 * 1024);
		await w.objects.put(shard.object.key, shard.bytes, "application/json");
	}
	const tooLarge = {
		...big,
		source: { ...big.source, extractor: { ...big.source.extractor, name: "x".repeat(1024 * 1024) } },
	};
	assert.throws(() => encodeCatalog({ ...w.catalog, versions: [tooLarge] }, w.objects), /source manifest too large/u);
	assert.equal(w.fake.storage.get("/s3/private-books/library/catalog.json"), previous);
	await w.objects.put(w.objects.libraryKey("catalog.json"), Buffer.from(canonical(split.root)), "application/json");
	assert.equal(Object.keys((await loadCatalog(w.objects)).catalog?.versions[0]?.passages ?? {}).length, 10000);
	await w.objects.put(
		w.objects.libraryKey("catalog.json"),
		Buffer.from(canonical({ ...w.catalog, schema: 1, versions: [] })),
		"application/json",
	);
	await assert.rejects(loadCatalog(w.objects), /schema 1.*re-run index/u);
	const result = await searchBooks(
		{
			...w,
			embeddings: {
				query: async () => {
					throw new Error("Must not embed legacy root");
				},
			},
		},
		{ query: "synthetic" },
	);
	assert.equal(result.status, "incomplete_corpus");
	assert.ok(result.diagnostics.some((d) => /schema 1.*re-run index/u.test(d.message)));
});

test("a race inside the final root recheck discards already-collected search hits", async (t) => {
	const w = await world(t);
	const sample = w.samples[0];
	assert.ok(sample);
	const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
	await w.pinecone.upsert([passageRecord(sample.passage, vector, sample.version.generation)], embeddingIdentity);
	let rootReads = 0;
	w.fake.faults.beforeObjectGet = (path) => {
		if (!path.endsWith("catalog.json") || ++rootReads !== 4) return;
		const bytes = Buffer.from(canonical({ ...w.publication.root, commit: hex(99) }));
		w.fake.storage.set(path, { bytes, hash: sha256(bytes).slice(7) });
	};
	const result = await searchBooks(
		{ ...w, embeddings: { query: async () => vector } },
		{ query: "synthetic", bookIds: [sample.passage.bookId] },
	);
	assert.equal(rootReads, 4);
	assert.equal(result.status, "incomplete_corpus");
	assert.deepEqual(result.hits, []);
});
