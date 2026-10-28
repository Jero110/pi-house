import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { embeddingIdentity, LocalEmbeddings } from "../src/embeddings.ts";
import { indexCorpus, loadCatalog, pruneSuperseded } from "../src/indexing.ts";
import { ingestPdf, publishIngest } from "../src/ingest.ts";
import { sha256 } from "../src/locations.ts";
import { Objects } from "../src/objects.ts";
import { Pinecone, type PineconeRecord } from "../src/pinecone.ts";
import { CorpusStore } from "../src/store.ts";
import { pdfFixture } from "./fixtures.ts";

// All three protocols use one literal-loopback fake server; no credentials or APIs.
async function fixture(t: { after: (fn: () => void) => void }) {
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
	let upserts = 0;
	let hidden = false;
	let publicBucket = false;
	let conflict = false;
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
		if (path === "/api/show")
			return reply({
				model_info: {
					"general.architecture": "nomic-bert",
					"nomic-bert.embedding_length": 768,
					"nomic-bert.context_length": 2048,
				},
			});
		if (path === "/api/embed") {
			const body = json();
			assert.equal(body.truncate, false);
			return reply({ embeddings: (body.input as string[]).map(() => Array.from({ length: 768 }, () => 1)) });
		}
		if (path === "/indexes/books")
			return reply({
				name: "books",
				host: url,
				dimension: 768,
				metric: "cosine",
				vector_type: "dense",
				spec: { serverless: { cloud: "aws", region: "us-east-1" } },
				status: { ready: true },
			});
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
			for (const record of records) vectors.set(record.id, record);
			return reply({ upsertedCount: records.length });
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
		upserts: () => upserts,
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
	// Remove one confirmed remote item: resume must re-embed it, not trust receipt.
	f.vectors.delete(receipt.confirmed[0] ?? "");
	const catalog = await indexCorpus(f);
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
	assert.equal((await loadCatalog(f.objects)).incomplete, true);
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
