import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { AdapterError, defaultRelevanceGate, loadConfig, relevanceGateFromEnv } from "../src/config.ts";
import type { Figure, MetadataField, Passage, SourceVersion } from "../src/contracts.ts";
import { definePassage } from "../src/contracts.ts";
import { embeddingIdentity } from "../src/embeddings.ts";
import {
	type Catalog,
	canonical,
	digest,
	encodeCatalog,
	resolveHostedPassage,
	validateCatalog,
} from "../src/indexing.ts";
import { lexicalPolicy } from "../src/lexical.ts";
import { sha256 } from "../src/locations.ts";
import { Objects } from "../src/objects.ts";
import { type PineconeMatch, passageRecord } from "../src/pinecone.ts";
import { fetchHostedFigure, gatedCandidates, readHostedPassage, relevanceGate, searchBooks } from "../src/search.ts";

async function fixture(t: { after: (fn: () => void) => void }) {
	const unknown = <T>(): MetadataField<T> => ({ value: null, evidence: [], resolution: "unknown" });
	const source: SourceVersion = {
		bookId: `book_${"1".repeat(32)}`,
		versionId: `version_${"2".repeat(32)}`,
		sourceHash: sha256("synthetic original"),
		format: "pdf",
		originalPath: "/not-present/book.pdf",
		pageCount: 2,
		metadata: {
			title: unknown(),
			authors: unknown(),
			publisher: unknown(),
			edition: unknown(),
			publicationDate: unknown(),
		},
		extractor: { name: "synthetic", version: "1", configurationHash: sha256("extractor") },
		coverage: { totalPages: 2, extractedPages: [1, 2], gaps: [], status: "complete" },
		diagnostics: [],
	};
	const location = {
		kind: "pdf",
		pageNumber: 1,
		printedLabel: null,
		coordinateSystem: "pdf-points-top-left",
		pageWidth: 600,
		pageHeight: 800,
		bounds: null,
	} as const;
	const sectionId = `section_${"3".repeat(32)}` as const;
	const figure: Figure = {
		bookId: source.bookId,
		versionId: source.versionId,
		sourceHash: source.sourceHash,
		id: `figure_${"4".repeat(32)}`,
		location: { ...location, pageNumber: 2 },
		label: "Figure 1-1",
		caption: "Synthetic diagram",
		rendering: { kind: "full-page-fallback", reason: "No verified crop" },
		linkingEvidence: [],
		diagnostics: [],
	};
	const text = `embedding_vectors preserve source identifiers. See Figure 1-1. ${"Literal source text. ".repeat(45)}`;
	const passages = Array.from(
		{ length: 7 },
		(_, i): Passage =>
			definePassage(
				{
					bookId: source.bookId,
					versionId: source.versionId,
					sourceHash: source.sourceHash,
					id: `passage_${i.toString(16).padStart(32, "0")}`,
					parentSectionId: sectionId,
					headingPath: [{ sectionId, title: "Technical terms", location }],
					originalText: text,
					normalizedText: text,
					mappings: [
						{
							kind: "literal",
							originalRange: { start: 0, end: text.length },
							normalizedRange: { start: 0, end: text.length },
						},
					],
					spans: [{ blockId: `block_${"5".repeat(32)}`, location, originalRange: { start: 0, end: text.length } }],
					neighbors: { previous: null, next: null },
					figures: [
						{
							figureId: figure.id,
							evidence: {
								kind: "explicit-reference",
								figureLabel: "Figure 1-1",
								referenceText: "Figure 1-1",
								location,
							},
						},
					],
					quality: [],
					indexConfigurationHash: sha256("chunks"),
				},
				source,
			),
	);
	const generation = "6".repeat(32);
	const vector = Array.from({ length: 768 }, () => 1);
	let matches: readonly PineconeMatch[] = passages.map((p) => ({
		...passageRecord(p, vector, generation),
		score: 0.9,
	}));
	const bytes = createCanvas(2, 2).toBuffer("image/png");
	const { originalPath: _path, ...hostedSource } = source;
	let catalog: Catalog = validateCatalog({
		schema: 2,
		libraryId: "7".repeat(32),
		commit: "8".repeat(32),
		embeddingIdentity,
		versions: [
			{
				source: hostedSource,
				completed: true,
				generation,
				indexConfigurationHash: sha256("chunks"),
				passages: Object.fromEntries(matches.map((m) => [m.id, digest(m.metadata)])),
				figures: [
					{
						figure,
						object: { key: "library/figure", hash: sha256(bytes), bytes: bytes.length },
						asset: {
							bookId: source.bookId,
							versionId: source.versionId,
							sourceHash: source.sourceHash,
							figureId: figure.id,
							mimeType: "image/png",
							assetHash: sha256(bytes),
							width: 2,
							height: 2,
							framing: figure.rendering,
							reducedResolution: false,
							notice: "Full page; legibility not assessed; original unavailable",
						},
					},
				],
			},
		],
	});
	let writer = catalog.commit;
	let objectFailure = false;
	let corruptFigure = false;
	let embeddingFailure: "unavailable" | "identity_mismatch" | null = null;
	let pineconeFailure = false;
	let calls = 0;
	const server = createServer((req, res) => {
		if (!req.headers.authorization) {
			res.statusCode = 403;
			res.end();
			return;
		}
		if (objectFailure) {
			res.statusCode = 503;
			res.end();
			return;
		}
		const publication = encodeCatalog(catalog, { libraryKey: (name) => `library/${name}` });
		const shard = publication.shards.find((s) => req.url?.endsWith(s.object.key));
		const data = shard
			? shard.bytes
			: req.url?.endsWith("catalog.json")
				? Buffer.from(canonical(publication.root))
				: req.url?.endsWith("writer.json")
					? Buffer.from(canonical({ writerId: "7".repeat(32), run: writer }))
					: corruptFigure
						? Buffer.from("corrupt")
						: bytes;
		res.setHeader("x-amz-meta-sha256", sha256(data).slice(7));
		res.end(data);
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const objects = new Objects({
		endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		region: "us-east-1",
		bucket: "private-books",
		prefix: "library/",
		accessKeyId: "synthetic-access",
		secretAccessKey: "synthetic-secret",
		privateBucketConfirmed: true,
		retries: 0,
	});
	const embeddings = {
		query: async (query: string, expected: unknown) => {
			assert.deepEqual(expected, embeddingIdentity);
			assert.ok(query.includes("embedding_vectors"));
			if (embeddingFailure) throw new AdapterError(embeddingFailure, "synthetic");
			return vector;
		},
	};
	const pinecone = {
		query: async (
			_vector: readonly number[],
			expected: unknown,
			options: { generation: string; versionIds?: readonly string[] },
		) => {
			calls++;
			if (pineconeFailure) throw new AdapterError("unavailable", "synthetic");
			assert.deepEqual(expected, embeddingIdentity);
			assert.equal(options.generation, generation);
			assert.deepEqual(options.versionIds, [source.versionId]);
			return matches;
		},
		fetch: async (ids: readonly string[], expected: unknown) => {
			assert.deepEqual(expected, embeddingIdentity);
			return matches.filter((m) => ids.includes(m.id));
		},
	};
	return {
		objects,
		embeddings,
		pinecone,
		passages,
		source,
		figure,
		text,
		bytes,
		catalog: () => catalog,
		update: (value: Catalog) => {
			catalog = value;
		},
		candidates: (value: readonly PineconeMatch[]) => {
			matches = value;
		},
		matches: () => matches,
		calls: () => calls,
		pending: () => {
			writer = "9".repeat(32);
		},
		objectsDown: () => {
			objectFailure = true;
		},
		corruptFigure: () => {
			corruptFigure = true;
		},
		runtimeDown: (code: "unavailable" | "identity_mismatch") => {
			embeddingFailure = code;
		},
		pineconeDown: () => {
			pineconeFailure = true;
		},
	};
}

test("empty local machine searches hosted evidence, deduplicates, caps literal excerpts, filters books and reads next-page figure", async (t) => {
	const f = await fixture(t);
	const first = f.matches()[0];
	assert.ok(first);
	f.candidates([first, ...f.matches()]);
	const result = await searchBooks(f, { query: "How does embedding_vectors preserve source identifiers?" });
	assert.equal(result.status, "ok");
	assert.equal(result.hits.length, 5);
	assert.equal(new Set(result.hits.map((h) => h.passageId)).size, 5);
	for (const hit of result.hits) {
		assert.equal(hit.excerpt, f.text.slice(0, 800));
		assert.equal(hit.sourceHash, f.source.sourceHash);
		assert.equal(hit.locations[0]?.pageNumber, 1);
		assert.equal(hit.scores.lexical, null);
		assert.ok(!("confidence" in hit));
	}
	const id = result.hits[0]?.passageId;
	assert.ok(id);
	const read = await readHostedPassage(f, id, { limit: 100 });
	assert.equal(read.text, f.text.slice(0, 100));
	assert.equal(read.nextOffset, 100);
	assert.equal(read.originalVerification, "recorded-ingestion-hash-only");
	const continuation = await readHostedPassage(f, id, { offset: 100, limit: 8000 });
	assert.equal(read.text + continuation.text, f.text);
	assert.equal(continuation.nextOffset, null);
	const image = await fetchHostedFigure(f.objects, f.figure.id);
	assert.equal(image.figure.location.pageNumber, 2);
	assert.ok(image.asset);
	assert.deepEqual(Buffer.from(image.asset.base64, "base64"), f.bytes);
	assert.equal(image.asset.framing.kind, "full-page-fallback");
	const before = f.calls();
	assert.equal(
		(await searchBooks(f, { query: "embedding_vectors", bookIds: [`book_${"a".repeat(32)}`] })).hits.length,
		0,
	);
	assert.equal(f.calls(), before);
	await assert.rejects(searchBooks(f, { query: "embedding_vectors", limit: 6 }), /bound/u);
	await assert.rejects(readHostedPassage(f, id, { limit: 8001 }), /bound/u);
	await assert.rejects(readHostedPassage(f, `passage_${"f".repeat(32)}`), /current generation/u);
	f.corruptFigure();
	await assert.rejects(fetchHostedFigure(f.objects, f.figure.id), /hash mismatch/u);
});

test("stale generation/hash/configuration/text and unknown IDs are dropped, never fresh evidence", async (t) => {
	const f = await fixture(t);
	const first = f.matches()[0];
	assert.ok(first);
	for (const metadata of [
		{ ...first.metadata, sourceHash: sha256("other") },
		{ ...first.metadata, generation: "a".repeat(32) },
		{ ...first.metadata, originalText: "forged quote" },
		{ ...first.metadata, indexConfigurationHash: sha256("other chunks") },
	]) {
		f.candidates([{ ...first, metadata }]);
		const result = await searchBooks(f, { query: "embedding_vectors" });
		assert.equal(result.status, "incomplete_corpus");
		assert.equal(result.hits.length, 0);
		assert.equal(result.diagnostics[0]?.code, "stale_index");
	}
	const version = f.catalog().versions[0];
	assert.ok(version);
	assert.throws(
		() => resolveHostedPassage(`passage_${"a".repeat(32)}`, first.metadata, version),
		/stale or corrupted/u,
	);
	f.candidates([{ ...first, id: `passage_${"a".repeat(32)}` }]);
	assert.equal((await searchBooks(f, { query: "embedding_vectors" })).status, "incomplete_corpus");
});

test("low relevance, incomplete extraction/publication, runtime/model and backend outages remain distinct", async (t) => {
	let f = await fixture(t);
	f.candidates(f.matches().map((m) => ({ ...m, score: 0.4 })));
	assert.equal((await searchBooks(f, { query: "embedding_vectors" })).status, "insufficient_evidence");
	f.pending();
	assert.equal((await searchBooks(f, { query: "embedding_vectors" })).status, "incomplete_corpus");
	f = await fixture(t);
	f.update({
		...f.catalog(),
		versions: f.catalog().versions.map((v) => ({
			...v,
			source: {
				...v.source,
				coverage: {
					totalPages: 2,
					extractedPages: [1],
					gaps: [{ pageNumber: 2, reason: "scanned_page" }],
					status: "incomplete",
				},
			},
		})),
	});
	const incomplete = await searchBooks(f, { query: "embedding_vectors" });
	assert.equal(incomplete.status, "ok");
	assert.equal(incomplete.coverage[0]?.coverage.gaps[0]?.reason, "scanned_page");
	assert.ok(incomplete.diagnostics.some((d) => d.source && d.message.includes("1 unextracted PDF page(s)")));
	const candidates = f.matches();
	f.candidates(candidates.map((m) => ({ ...m, score: 0.2 })));
	const unrelated = await searchBooks(f, { query: "unrelated planetary geology vs embedding_vectors" });
	assert.equal(unrelated.status, "insufficient_evidence");
	assert.ok(unrelated.diagnostics.some((d) => d.message.includes("answer could be on unextracted pages")));
	f.candidates(candidates);
	f.runtimeDown("unavailable");
	const runtime = await searchBooks(f, { query: "embedding_vectors" });
	assert.equal(runtime.status, "unavailable");
	assert.ok(runtime.diagnostics.some((d) => d.code === "runtime_unavailable"));
	f.runtimeDown("identity_mismatch");
	assert.ok(
		(await searchBooks(f, { query: "embedding_vectors" })).diagnostics.some((d) => d.code === "model_mismatch"),
	);
	const p = await fixture(t);
	p.pineconeDown();
	assert.equal((await searchBooks(p, { query: "embedding_vectors" })).status, "unavailable");
	const s = await fixture(t);
	s.objectsDown();
	assert.equal((await searchBooks(s, { query: "embedding_vectors" })).status, "unavailable");
});

test("selected books without searchable published content make the corpus incomplete", async (t) => {
	const f = await fixture(t);
	f.update({ ...f.catalog(), versions: f.catalog().versions.map((v) => ({ ...v, passages: {} })) });
	f.candidates([]);
	const result = await searchBooks(f, { query: "embedding_vectors" });
	assert.equal(result.status, "incomplete_corpus");
	assert.ok(result.diagnostics.some((d) => d.message.includes("no searchable published content")));
});

test("publication changing during search discards the snapshot rather than returning superseded evidence", async (t) => {
	const f = await fixture(t);
	const query = f.pinecone.query;
	const services = {
		...f,
		pinecone: {
			...f.pinecone,
			query: async (...args: Parameters<typeof query>) => {
				const matches = await query(...args);
				f.update({ ...f.catalog(), commit: "b".repeat(32) });
				return matches;
			},
		},
	};
	const result = await searchBooks(services, { query: "embedding_vectors" });
	assert.equal(result.status, "incomplete_corpus");
	assert.equal(result.hits.length, 0);
	assert.ok(result.diagnostics.some((d) => d.code === "stale_index"));
});

test("frozen relevance floor and margin evaluated on synthetic cosine pairs, not nearest-k or per-query tuning", () => {
	// Two-dimensional unit-vector pairs embedded in the 768-dimensional model
	// space. This measures the policy, NOT learned Nomic semantic quality.
	const unit = (angle: number) => [Math.cos(angle), Math.sin(angle), ...Array.from({ length: 766 }, () => 0)];
	const cosine = (a: readonly number[], b: readonly number[]) =>
		a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
	const answerableAngles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
	const unrelatedAngles = [0.76, 0.8, 0.9, 1, 1.2, 1.4];
	const positive = answerableAngles.map((angle) => cosine(unit(0), unit(angle)));
	const negative = unrelatedAngles.map((angle) => cosine(unit(0), unit(angle)));
	const outcomes = [0.6, 0.7, 0.78, 0.85].map((threshold) => ({
		threshold,
		falsePositive: negative.filter((s) => s >= threshold).length,
		falseNegative: positive.filter((s) => s < threshold).length,
	}));
	assert.deepEqual(outcomes, [
		{ threshold: 0.6, falsePositive: 3, falseNegative: 0 },
		{ threshold: 0.7, falsePositive: 1, falseNegative: 0 },
		{ threshold: 0.78, falsePositive: 0, falseNegative: 0 },
		{ threshold: 0.85, falsePositive: 0, falseNegative: 1 },
	]);
	assert.equal(relevanceGate.minimumScore, 0.78);
	const match = (id: string, score: number): PineconeMatch => ({ id, score, metadata: {} });
	assert.equal(gatedCandidates(negative.map((s, i) => match(String(i), s))).length, 0);
	assert.equal(gatedCandidates([match("a", 0.95), match("b", 0.88), match("c", 0.86)]).length, 2);
	// Exact identifiers can occur in both supporting and incidental passages.
	// Overlap cannot distinguish these fixtures, so FTS is not enabled/ranked.
	const exactId = (s: string) => s.match(/\bembedding_vectors\b/gu)?.length ?? 0;
	assert.equal(
		exactId("embedding_vectors stores the embeddings"),
		exactId("unrelated discussion references embedding_vectors in a footnote"),
	);
	assert.equal(lexicalPolicy.enabled, false);
});

test("the relevance gate is configurable, strictly validated, versioned and reported in every result", async (t) => {
	assert.deepEqual(relevanceGateFromEnv({}), defaultRelevanceGate);
	assert.equal(defaultRelevanceGate.version, "synthetic-cosine-v1");
	const custom = relevanceGateFromEnv({ BOOKS_RELEVANCE_FLOOR: "0.6", BOOKS_RELEVANCE_MARGIN: "0.1" });
	assert.deepEqual(custom, { minimumScore: 0.6, maximumDrop: 0.1, version: "operator-cosine-v1" });
	// One value alone keeps the other frozen default but is still an operator gate version.
	assert.deepEqual(relevanceGateFromEnv({ BOOKS_RELEVANCE_FLOOR: "1" }), {
		minimumScore: 1,
		maximumDrop: 0.08,
		version: "operator-cosine-v1",
	});
	for (const [key, bad] of [
		["BOOKS_RELEVANCE_FLOOR", "0"],
		["BOOKS_RELEVANCE_FLOOR", "-0.5"],
		["BOOKS_RELEVANCE_FLOOR", "1.5"],
		["BOOKS_RELEVANCE_FLOOR", "0,6"],
		["BOOKS_RELEVANCE_FLOOR", "1e-1"],
		["BOOKS_RELEVANCE_FLOOR", ""],
		["BOOKS_RELEVANCE_FLOOR", "NaN"],
		["BOOKS_RELEVANCE_MARGIN", "2"],
		["BOOKS_RELEVANCE_MARGIN", "-0.01"],
		["BOOKS_RELEVANCE_MARGIN", " 0.1"],
	] as const)
		assert.throws(
			() => relevanceGateFromEnv({ [key]: bad }),
			/BOOKS_RELEVANCE_(FLOOR|MARGIN) must be/u,
			`${key}=${bad}`,
		);
	assert.equal(relevanceGateFromEnv({ BOOKS_RELEVANCE_MARGIN: "0" }).maximumDrop, 0);
	const env = {
		BOOKS_DATA_DIR: "/x",
		PINE_CONE_API: "a",
		PINECONE_INDEX_NAME: "b",
		PINECONE_HOST: "c",
		PINECONE_NAMESPACE: "d",
		S3_ENDPOINT: "e",
		S3_REGION: "f",
		S3_BUCKET: "g",
		S3_ACCESS_KEY_ID: "h",
		S3_SECRET_ACCESS_KEY: "i",
		S3_LIBRARY_PREFIX: "j/",
		S3_BUCKET_PRIVATE_CONFIRMED: "true",
	};
	assert.deepEqual(loadConfig({ env }).relevanceGate, defaultRelevanceGate);
	assert.equal(loadConfig({ env: { ...env, BOOKS_RELEVANCE_FLOOR: "0.5" } }).relevanceGate.minimumScore, 0.5);
	assert.throws(() => loadConfig({ env: { ...env, BOOKS_RELEVANCE_FLOOR: "abc" } }), /BOOKS_RELEVANCE_FLOOR/u);

	const f = await fixture(t);
	const query = "How does embedding_vectors preserve source identifiers?";
	const byDefault = await searchBooks(f, { query });
	assert.equal(byDefault.status, "ok");
	assert.deepEqual(byDefault.gate, {
		version: "synthetic-cosine-v1",
		minimumScore: 0.78,
		maximumDrop: 0.08,
	});
	// Candidates score 0.9: a stricter operator floor abstains, and the result says which gate did it.
	const strict = await searchBooks({ ...f, gate: relevanceGateFromEnv({ BOOKS_RELEVANCE_FLOOR: "0.95" }) }, { query });
	assert.equal(strict.status, "insufficient_evidence");
	assert.equal(strict.gate?.version, "operator-cosine-v1");
	assert.equal(strict.gate?.minimumScore, 0.95);
	const loose = await searchBooks({ ...f, gate: relevanceGateFromEnv({ BOOKS_RELEVANCE_FLOOR: "0.5" }) }, { query });
	assert.equal(loose.status, "ok");
});

test("a schema 1 hosted record is dropped per candidate with a reindex remedy, never as a backend outage", async (t) => {
	const f = await fixture(t);
	const valid = f.matches();
	const [stale] = valid;
	assert.ok(stale);
	const old = { ...stale, metadata: { ...stale.metadata, schema: 1 } };
	f.candidates([old, ...valid.slice(1)]);
	const result = await searchBooks(f, { query: "How does embedding_vectors preserve source identifiers?" });
	assert.equal(result.backend, "available");
	assert.equal(result.corpus, "incomplete");
	assert.equal(result.hits.length, 5, "valid schema 2 candidates are still returned");
	assert.equal(
		result.hits.some((h) => h.passageId === stale.id),
		false,
	);
	const codes = result.diagnostics.map((d) => d.code);
	assert.equal(codes.includes("backend_unavailable"), false);
	const note = result.diagnostics.find((d) => d.code === "identity_mismatch");
	assert.match(note?.message ?? "", /schema 1 is incompatible.*re-run `index`/u);
	// An unknown schema is the same explicit incompatibility.
	f.candidates([{ ...stale, metadata: { ...stale.metadata, schema: 99 } }]);
	const unknown = await searchBooks(f, { query: "How does embedding_vectors preserve source identifiers?" });
	assert.equal(unknown.backend, "available");
	assert.match(unknown.diagnostics[0]?.message ?? "", /schema 99.*`index`/u);
	// A direct read of that record fails with the same remedy.
	f.candidates([old]);
	await assert.rejects(readHostedPassage(f, stale.id as never), /re-run `index`/u);
});
