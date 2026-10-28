import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publicationLimits } from "../src/capacity.ts";
import { embeddingIdentity, LocalEmbeddings } from "../src/embeddings.ts";
import {
	generationPassages,
	indexCorpus,
	loadCatalog,
	loadPreviousCatalogs,
	pruneSuperseded,
} from "../src/indexing.ts";
import { ingestPdf, publishIngest } from "../src/ingest.ts";
import { sha256 } from "../src/locations.ts";
import { booksTools } from "../src/mcp.ts";
import { Objects } from "../src/objects.ts";
import { Pinecone, type PineconeRecord } from "../src/pinecone.ts";
import { fetchHostedFigure } from "../src/search.ts";
import { CorpusStore } from "../src/store.ts";
import { pdfFixture } from "./fixtures.ts";

// All three protocols use one literal-loopback fake server; no credentials or APIs.
async function fixture(t: { after: (fn: () => void) => void }, additionalFigures = 0, unavailable = false) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-index-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new CorpusStore({ directory: join(root, "store") });
	const input = join(root, "synthetic.pdf");
	writeFileSync(
		input,
		pdfFixture({
			pages: [
				{
					geometry: [900, 900],
					text: Array.from({ length: 15 }, (_, i) => ({
						text: `Technical subsection ${i}: embedding_vectors preserve exact identifiers and source citations. Figure 1-1.`,
						y: 750 - i * 40,
					})),
				},
				{ geometry: [900, 900], text: [{ text: "Figure 1-1. Synthetic diagram", y: 750 }] },
				...(unavailable
					? [
							{
								geometry: [900, 900] as const,
								text: [{ text: "Figure 9-9. Unavailable diagram", y: 750 }],
								oversizedImage: true,
							},
						]
					: []),
				...Array.from({ length: additionalFigures }, (_, i) => ({
					geometry: [900, 900] as const,
					text: [{ text: `Figure 1-${i + 2}. Synthetic diagram`, y: 750 }],
				})),
			],
		}),
	);
	const prepared = await ingestPdf({
		store,
		input,
		bookId: store.newBookId(),
		indexConfigurationHash: sha256("synthetic-256"),
	});
	await publishIngest(prepared, store, { targetBound: 256 });
	const source = prepared.source;
	const vectors = new Map<string, PineconeRecord>();
	const storage = new Map<string, { bytes: Buffer; hash: string }>();
	const calls: string[] = [];
	let failBatch = 0;
	let failShard = -1;
	let upserts = 0;
	let hidden = false;
	let hideRounds = 0;
	let publicBucket = false;
	let conflict = false;
	let raceAfterUpsert = false;
	let describes = 0;
	let modelProbes = 0;
	let url = "";
	const server = createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", url).pathname;
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
		const bytes = Buffer.concat(chunks);
		const json = () => JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
		const reply = (body: unknown) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(body));
		};
		if (path.startsWith("/s3/")) {
			if (!req.headers.authorization) {
				calls.push("probe");
				res.statusCode = publicBucket ? 200 : storage.has(path) ? 403 : 404;
				res.end();
				return;
			}
			calls.push(`${req.method} ${path}`);
			if (req.method === "PUT") {
				if (path.includes("/manifests/") && failShard >= 0 && failShard-- === 0) {
					res.statusCode = 503;
					res.end();
					return;
				}
				storage.set(path, { bytes, hash: String(req.headers["x-amz-meta-sha256"]) });
				res.end();
				return;
			}
			const stored = storage.get(path);
			if (!stored) {
				res.statusCode = 404;
				res.end();
				return;
			}
			if (conflict && path.endsWith("writer.json")) {
				const altered = Buffer.from(stored.bytes.toString().replace(/"run":"[a-f0-9]+"/u, `"run":"${"f".repeat(32)}"`));
				res.setHeader("x-amz-meta-sha256", sha256(altered).slice(7));
				res.end(altered);
				return;
			}
			res.setHeader("x-amz-meta-sha256", stored.hash);
			res.setHeader("content-length", stored.bytes.length);
			res.end(req.method === "HEAD" ? undefined : stored.bytes);
			return;
		}
		if (path === "/api/version") return reply({ version: embeddingIdentity.runtimeVersion });
		if (path === "/api/tags")
			return reply({ models: [{ name: embeddingIdentity.model, digest: embeddingIdentity.digest }] });
		if (path === "/api/show") {
			modelProbes++;
			return reply({
				model_info: {
					"general.architecture": "nomic-bert",
					"nomic-bert.embedding_length": 768,
					"nomic-bert.context_length": 2048,
				},
			});
		}
		if (path === "/api/embed") {
			const body = json();
			assert.equal(body.truncate, false);
			return reply({ embeddings: (body.input as string[]).map(() => Array.from({ length: 768 }, () => 1)) });
		}
		if (path === "/indexes/books") {
			describes++;
			return reply({
				name: "books",
				host: url,
				dimension: 768,
				metric: "cosine",
				vector_type: "dense",
				spec: { serverless: { cloud: "aws", region: "us-east-1" } },
				status: { ready: true },
			});
		}
		if (path === "/vectors/upsert") {
			calls.push("upsert");
			upserts++;
			if (upserts === failBatch) {
				res.statusCode = 503;
				res.end();
				return;
			}
			const body = json();
			assert.equal(body.namespace, "synthetic");
			const records = body.vectors as PineconeRecord[];
			assert.ok(records.length <= 8);
			if (raceAfterUpsert) conflict = true;
			for (const record of records) vectors.set(record.id, record);
			return reply({ upsertedCount: records.length });
		}
		if (path === "/vectors/list") {
			calls.push("list");
			const query = new URL(req.url ?? "", url).searchParams;
			assert.equal(query.get("namespace"), "synthetic");
			const start = Number(query.get("paginationToken") ?? 0);
			const ids = hidden || hideRounds-- > 0 ? [] : [...vectors.keys()].sort();
			return reply({
				namespace: "synthetic",
				vectors: ids.slice(start, start + 100).map((id) => ({ id })),
				...(ids.length > start + 100 ? { pagination: { next: String(start + 100) } } : {}),
			});
		}
		if (path === "/vectors/fetch") {
			const query = new URL(req.url ?? "", url).searchParams;
			assert.equal(query.get("namespace"), "synthetic");
			return reply({
				namespace: "synthetic",
				vectors: Object.fromEntries(
					query.getAll("ids").flatMap((id) => (!hidden && vectors.has(id) ? [[id, vectors.get(id)]] : [])),
				),
			});
		}
		if (path === "/vectors/delete") {
			const body = json();
			assert.equal(body.namespace, "synthetic");
			assert.equal(body.deleteAll, undefined);
			for (const id of body.ids as string[]) vectors.delete(id);
			return reply({});
		}
		res.statusCode = 404;
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const objects = new Objects({
		endpoint: `${url}/s3`,
		region: "us-east-1",
		bucket: "private-books",
		prefix: "library/",
		accessKeyId: "synthetic-access",
		secretAccessKey: "synthetic-secret",
		privateBucketConfirmed: true,
		retries: 0,
	});
	const pinecone = new Pinecone({
		host: url,
		controlUrl: url,
		indexName: "books",
		namespace: "synthetic",
		apiKey: "synthetic-api",
		minimumWriteIntervalMs: 0,
		minimumQueryIntervalMs: 0,
		retries: 0,
	});
	const embeddings = new LocalEmbeddings({ url, retries: 0 });
	return {
		store,
		objects,
		pinecone,
		embeddings,
		source,
		storage,
		vectors,
		calls,
		root,
		input,
		writerId: store.libraryId,
		fail: (batch: number) => {
			failBatch = batch;
		},
		failShard: (value: number) => {
			failShard = value;
		},
		upserts: () => upserts,
		probes: () => ({ describes, modelProbes }),
		race: () => {
			raceAfterUpsert = true;
		},
		hideFor: (rounds: number) => {
			hideRounds = rounds;
		},
		hide: (value: boolean) => {
			hidden = value;
		},
		public: () => {
			publicBucket = true;
		},
		conflict: () => {
			conflict = true;
		},
	};
}

test("generation IDs are disjoint and visibility checks wait for all completed upserts", async (t) => {
	const f = await fixture(t);
	const passages = f.store.listPassages(f.source);
	const a = generationPassages(passages, "a".repeat(32));
	const b = generationPassages(passages, "b".repeat(32));
	assert.ok(a.every((p) => !b.some((q) => q.id === p.id) && !passages.some((q) => q.id === p.id)));
	assert.equal(a[0]?.neighbors.next, a[1]?.id);
	f.hideFor(1); // first final snapshot is not visible; fresh runs never list an absent namespace
	await indexCorpus(f);
	assert.equal(f.calls.filter((c) => c === "list").length, 2);
	assert.ok((await loadCatalog(f.objects)).catalog);
});

test("unsupported render retains text and good figure through atomic storage and hosted roundtrip", async (t) => {
	const f = await fixture(t, 0, true);
	const figures = f.store.listFigures(f.source);
	assert.equal(figures.length, 2);
	assert.equal(f.store.readFigureAssets(f.source).length, 1);
	assert.ok(f.store.listPassages(f.source).length);
	const missing = figures.find((figure) => figure.unavailable);
	assert.ok(missing);
	assert.deepEqual(missing.unavailable, { status: "unsupported", reason: "no_render_operators" });
	const catalog = await indexCorpus(f);
	assert.equal(catalog.versions[0]?.figures.length, 2);
	const result = await fetchHostedFigure(f.objects, missing.id);
	assert.equal(result.asset, null);
	assert.equal(result.figure.caption, "Figure 9-9. Unavailable diagram");
	assert.equal(result.figure.location.pageNumber, 3);
	const tool = booksTools({ services: () => f }).find((tool) => tool.name === "books_figure");
	assert.ok(tool);
	const response = await tool.run({ figureId: missing.id });
	assert.equal(response.content.length, 1);
	assert.equal(response.content[0]?.type, "text");
	assert.match(JSON.stringify(response), /unsupported/);
	assert.match(JSON.stringify(response), /PDF page 3/);
	const good = figures.find((figure) => !figure.unavailable);
	assert.ok(good);
	assert.ok((await fetchHostedFigure(f.objects, good.id)).asset);
});

test("index figures first, vectors in bounded batches, manifest last; resume re-verifies confirmed IDs", async (t) => {
	const f = await fixture(t);
	assert.ok(f.store.listPassages(f.source).length > 8);
	f.fail(2);
	await assert.rejects(indexCorpus(f), /unavailable/u);
	assert.equal((await loadCatalog(f.objects)).catalog, null);
	assert.equal((await loadCatalog(f.objects)).incomplete, true);
	const receipt = JSON.parse(readFileSync(join(f.store.directory, `index-${f.source.versionId}.json`), "utf8")) as {
		confirmed: string[];
	};
	assert.equal(receipt.confirmed.length, 8);
	// A stale ID with the same metadata is not the completed expected upsert.
	const removed = f.vectors.get(receipt.confirmed[0] ?? "");
	assert.ok(removed);
	f.vectors.delete(removed.id);
	const staleId = `passage_${"f".repeat(32)}`;
	f.vectors.set(staleId, { ...removed, id: staleId, metadata: { ...removed.metadata, generation: "0".repeat(32) } });
	const catalog = await indexCorpus(f);
	assert.ok(f.vectors.has(removed.id), "resume repaired the missing expected ID despite an unrelated stale ID");
	assert.equal(catalog.versions.length, 1);
	assert.equal((await loadCatalog(f.objects)).incomplete, false);
	assert.ok(f.calls.findIndex((call) => call.includes("PUT") && call.includes("figure_")) < f.calls.indexOf("upsert"));
	assert.ok(
		f.calls.findIndex((call) => call.includes("catalog.json") && call.startsWith("PUT")) >
			f.calls.lastIndexOf("upsert"),
	);
	const payload = JSON.stringify(catalog);
	assert.ok(!payload.includes(f.root));
	assert.ok(!payload.includes("originalPath"));
	assert.ok(!payload.includes("base64"));
	const before = f.upserts();
	await indexCorpus(f);
	assert.equal(f.upserts(), before);
	// Fetch remains namespace-bound and rejects unrelated exact-ID reads locally.
	await assert.rejects(f.pinecone.fetch(["not-an-id"], embeddingIdentity), /opaque/u);
	await assert.rejects(
		f.pinecone.fetch(Object.keys(catalog.versions[0]?.passages ?? {}).slice(0, 9), embeddingIdentity),
		/batch/u,
	);
});

test("visibility interruption leaves no searchable generation; local lock and foreign writer fail closed", async (t) => {
	const f = await fixture(t);
	f.hide(true);
	await assert.rejects(indexCorpus(f), /visibility incomplete/u);
	assert.equal((await loadCatalog(f.objects)).incomplete, true);
	f.hide(false);
	writeFileSync(join(f.store.directory, ".index.lock"), "active", { mode: 0o600 });
	await assert.rejects(indexCorpus(f), /lock exists/u);
	rmSync(join(f.store.directory, ".index.lock"));
	await assert.rejects(indexCorpus({ ...f, writerId: "e".repeat(32) }), /Another writer/u);
	await indexCorpus(f);
});

test("new source version commits without mixing generations; changed originals fail before publication", async (t) => {
	const f = await fixture(t);
	const original = readFileSync(f.input);
	const previous = await indexCorpus(f);
	writeFileSync(f.input, Buffer.from("%PDF-1.7\nchanged original\n"));
	const skipped: string[] = [];
	await assert.rejects(
		indexCorpus({ ...f, onSkip: (skip) => skipped.push(skip.versionId) }),
		/Every current version was skipped/u,
	);
	assert.deepEqual(skipped, [f.source.versionId]);
	assert.equal((await loadCatalog(f.objects)).catalog?.commit, previous.commit);
	// Offline preflight fails before creating a pending hosted claim.
	assert.equal((await loadCatalog(f.objects)).incomplete, false);
	writeFileSync(f.input, original);
	// Publish a distinct source under the same book identity.
	const nextPath = join(f.root, "replacement.pdf");
	writeFileSync(
		nextPath,
		pdfFixture({ pages: [{ text: [{ text: "New source with different technical evidence", y: 500 }] }] }),
	);
	const prepared = await ingestPdf({
		store: f.store,
		input: nextPath,
		bookId: f.source.bookId,
		indexConfigurationHash: sha256("replacement chunks"),
	});
	await publishIngest(prepared, f.store);
	const current = await indexCorpus(f);
	assert.notEqual(current.versions[0]?.generation, previous.versions[0]?.generation);
	assert.equal(current.versions[0]?.source.versionId, prepared.source.versionId);
	assert.equal(current.versions.length, 1);
	assert.ok(Object.keys(previous.versions[0]?.passages ?? {}).every((id) => f.vectors.has(id)));
	await pruneSuperseded(previous, current, f.pinecone);
	assert.ok(Object.keys(previous.versions[0]?.passages ?? {}).every((id) => !f.vectors.has(id)));
});

test("writer creates default privacy canary itself and refuses public storage before book upload", async (t) => {
	const f = await fixture(t);
	f.public();
	await assert.rejects(indexCorpus(f), /public/u);
	assert.equal(f.calls[0], "PUT /s3/private-books/library/_private-probe");
	assert.equal(f.calls[1], "probe");
	assert.equal(f.storage.size, 1);
	assert.equal(f.upserts(), 0);
	assert.equal([...f.storage.values()][0]?.bytes.toString(), "books-rag private canary v1\n");
});

test("concurrent claim conflicts are detected rather than claiming S3 compare-and-swap", async (t) => {
	const f = await fixture(t);
	f.conflict();
	await assert.rejects(indexCorpus(f), /Concurrent writer conflict/u);
	assert.equal(f.upserts(), 0);
});

test("source-shard write failures leave the previous root unchanged and resume safely", async (t) => {
	const f = await fixture(t);
	const previous = await indexCorpus(f);
	const key = "/s3/private-books/library/catalog.json";
	const oldRoot = f.storage.get(key);
	assert.ok(oldRoot);
	const nextPath = join(f.root, "second-book.pdf");
	writeFileSync(nextPath, pdfFixture({ pages: [{ text: [{ text: "Synthetic second book", y: 500 }] }] }));
	const prepared = await ingestPdf({
		store: f.store,
		input: nextPath,
		bookId: f.store.newBookId(),
		indexConfigurationHash: sha256("second-book"),
	});
	await publishIngest(prepared, f.store);
	f.failShard(2); // The first source's data and header succeed; the second source fails.
	await assert.rejects(indexCorpus(f), /unavailable/u);
	assert.deepEqual(f.storage.get(key), oldRoot);
	assert.equal((await loadCatalog(f.objects)).catalog?.commit, previous.commit);
	assert.equal((await loadCatalog(f.objects)).incomplete, true);
	const before = f.upserts();
	f.failShard(-1);
	const current = await indexCorpus(f);
	assert.equal(f.upserts(), before, "resume still fetch-verifies receipts before skipping vectors");
	assert.notEqual(current.commit, previous.commit);
	assert.equal((await loadCatalog(f.objects)).incomplete, false);
	const writes = f.calls.filter((call) => call.startsWith("PUT"));
	assert.ok(writes.at(-1)?.endsWith("catalog.json"), "root is COMMIT LAST");
});

test("writer explicitly reindexes a legacy root without re-ingesting or losing prune ownership", async (t) => {
	const f = await fixture(t);
	const previous = await indexCorpus(f);
	await f.objects.put(
		f.objects.libraryKey("catalog.json"),
		Buffer.from(JSON.stringify({ ...previous, schema: 1 })),
		"application/json",
	);
	await assert.rejects(loadCatalog(f.objects), /schema 1.*re-run index/u);
	const before = f.upserts();
	const current = await indexCorpus(f);
	assert.equal(current.schema, 2);
	assert.equal(f.upserts(), before);
	assert.equal((await loadCatalog(f.objects)).incomplete, false);
	const snapshotPath = join(f.store.directory, `previous-catalog-${previous.commit}.json`);
	assert.ok(readFileSync(snapshotPath).length > 0);
	writeFileSync(snapshotPath, JSON.stringify({ ...previous, schema: 1 }), { mode: 0o600 });
	assert.deepEqual(loadPreviousCatalogs(f.store)[0]?.catalog, previous);
});

test("superseded cleanup deletes only explicit previous-owned IDs absent from current", async (t) => {
	const f = await fixture(t);
	const previous = await indexCorpus(f);
	const current = { ...previous, versions: [] };
	const unrelated = `passage_${"f".repeat(32)}`;
	f.vectors.set(unrelated, { id: unrelated, metadata: {}, values: [] });
	await pruneSuperseded(previous, current, f.pinecone);
	assert.deepEqual([...f.vectors.keys()], [unrelated]);
	await assert.rejects(
		pruneSuperseded(previous, { ...current, libraryId: "a".repeat(32) }, f.pinecone),
		/another library/u,
	);
});

test("capacity preflight rejects before the first hosted write, including canary and figures", async (t) => {
	const f = await fixture(t);
	const summaries: string[] = [];
	await assert.rejects(
		indexCorpus({ ...f, capacity: { ...publicationLimits, uploadBytes: 1 }, onPlan: (s) => summaries.push(s) }),
		/uploadBytes planned=.*remaining=1/u,
	);
	for (const key of ["pineconeResponseBytes", "s3ResponseBytes"] as const)
		await assert.rejects(
			indexCorpus({ ...f, capacity: { ...publicationLimits, [key]: 1 } }),
			new RegExp(`${key} planned=.*remaining=1`),
		);
	assert.equal(f.storage.size, 0);
	assert.equal(f.calls.length, 0);
	assert.match(summaries[0] ?? "", /planned.*remaining.*caps/u);
	assert.ok(!summaries.join().includes("Technical subsection"));
});

test("write-run probes are cached, physical usage survives interruption and resume", async (t) => {
	const f = await fixture(t);
	f.fail(2);
	await assert.rejects(indexCorpus(f), /unavailable/u);
	const path = join(f.store.directory, "index-capacity.json");
	const before = JSON.parse(readFileSync(path, "utf8")).used;
	assert.ok(before.requests > 0 && before.responseBytes > 0 && before.uploadBytes > 0);
	assert.deepEqual(f.probes(), { describes: 1, modelProbes: 1 });
	await indexCorpus(f);
	const after = JSON.parse(readFileSync(path, "utf8")).used;
	assert.ok(after.requests > before.requests);
	assert.ok(after.responseBytes > before.responseBytes);
	assert.ok(after.pineconeResponseBytes > before.pineconeResponseBytes);
	assert.ok(after.s3ResponseBytes > before.s3ResponseBytes);
	assert.ok(after.vectors >= before.vectors);
	assert.deepEqual(f.probes(), { describes: 2, modelProbes: 2 });
});

test("claim changes inside a vector batch cannot commit a mixed root", async (t) => {
	const f = await fixture(t);
	f.race();
	await assert.rejects(indexCorpus(f), /Concurrent writer conflict/u);
	assert.ok(f.upserts() > 0);
	assert.ok(![...f.storage.keys()].some((key) => key.endsWith("catalog.json")));
});

test("figure guards amortize calls but never allow more than sixteen writes unchecked", async (t) => {
	const f = await fixture(t, 32);
	const figures = f.store.listFigures(f.source).length;
	assert.ok(figures > 16);
	await indexCorpus(f);
	let writesSinceGuard = 0;
	for (const call of f.calls) {
		if (call.startsWith("PUT") && call.includes("/figure_")) writesSinceGuard++;
		if (call.startsWith("GET") && call.endsWith("/writer.json")) {
			assert.ok(writesSinceGuard <= 16);
			writesSinceGuard = 0;
		}
	}
	const first = f.calls.findIndex((call) => call.startsWith("PUT") && call.includes("/figure_"));
	const last = f.calls.findLastIndex((call) => call.startsWith("PUT") && call.includes("/figure_"));
	const guardReads = f.calls
		.slice(first, last + 1)
		.filter((call) => call.startsWith("GET") && call.endsWith("/writer.json")).length;
	assert.ok(guardReads <= 2 * Math.ceil(figures / 16));
	assert.ok(guardReads < figures, "not one claim read per figure");
});
