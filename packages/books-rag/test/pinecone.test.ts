import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { productionTargetBound } from "../src/chunks.ts";
import type { Passage } from "../src/contracts.ts";
import { embeddingIdentity } from "../src/embeddings.ts";
import { ingestPdf, publishIngest } from "../src/ingest.ts";
import { sha256 } from "../src/locations.ts";
import {
	expandPassageEvidence,
	Pinecone,
	passageRecord,
	recordBudgetBytes,
	validateMetadata,
} from "../src/pinecone.ts";
import { CorpusStore } from "../src/store.ts";
import { pdfFixture, structuralPdf } from "./fixtures.ts";

const generation = "a".repeat(32);
const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
function passage(): Passage {
	const location = {
		kind: "pdf",
		pageNumber: 2,
		printedLabel: null,
		coordinateSystem: "pdf-points-top-left",
		pageWidth: 600,
		pageHeight: 800,
		bounds: [0, 0, 50, 50],
	} as const;
	return {
		bookId: `book_${"b".repeat(32)}`,
		versionId: `version_${"c".repeat(32)}`,
		sourceHash: `sha256:${"d".repeat(64)}`,
		id: `passage_${"e".repeat(32)}`,
		parentSectionId: `section_${"f".repeat(32)}`,
		headingPath: [{ sectionId: `section_${"f".repeat(32)}`, title: "Test heading", location }],
		originalText: "Literal  evidence",
		normalizedText: "Literal evidence",
		spans: [{ blockId: `block_${"0".repeat(32)}`, location, originalRange: { start: 0, end: 17 } }],
		mappings: [],
		neighbors: { previous: null, next: null },
		figures: [],
		quality: [],
		indexConfigurationHash: `sha256:${"1".repeat(64)}`,
	};
}

test("Pinecone checks exact read-only index before writes; scoped text/citations only, no paths, credentials or image bytes", async (t) => {
	const calls: { path: string; method: string; body: Record<string, unknown>; key: string | undefined }[] = [];
	let compatible = true;
	let host = "";
	let mismatchHost = false;
	let invalidMode = false;
	const item = passageRecord(
		{
			...passage(),
			originalPath: "/private/book.pdf",
			secret: "synthetic-api-secret",
			base64: "DO-NOT-SEND-IMAGE",
		} as Passage,
		vector,
		generation,
	);
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += String(chunk);
		calls.push({
			path: req.url ?? "",
			method: req.method ?? "",
			body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
			key: req.headers["api-key"] as string | undefined,
		});
		assert.equal(req.headers["x-pinecone-api-version"], "2025-10");
		res.setHeader("Content-Type", "application/json");
		if (req.url === "/indexes/books")
			res.end(
				JSON.stringify({
					name: "books",
					dimension: compatible ? 768 : 384,
					metric: "cosine",
					vector_type: "dense",
					spec: invalidMode ? { pod: {} } : { serverless: { cloud: "aws", region: "us-east-1" } },
					status: { ready: true },
					host: mismatchHost ? "https://never-contact.invalid" : host,
				}),
			);
		else if (req.url === "/vectors/upsert") res.end(JSON.stringify({ upsertedCount: 1 }));
		else if (req.url === "/query")
			res.end(
				JSON.stringify({ namespace: "owned-library", matches: [{ id: item.id, score: 0.8, metadata: item.metadata }] }),
			);
		else if (req.url === "/vectors/delete") res.end("{}");
		else {
			res.statusCode = 400;
			res.end("not allowed synthetic-api-secret");
		}
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const options = {
		apiKey: "synthetic-api-secret",
		indexName: "books",
		host,
		controlUrl: host,
		namespace: "owned-library",
		minimumWriteIntervalMs: 0,
		minimumQueryIntervalMs: 0,
		retries: 0,
	};
	const client = new Pinecone(options);
	await client.upsert([item], embeddingIdentity);
	const matches = await client.query(vector, embeddingIdentity, {
		generation,
		topK: 5,
		versionIds: [passage().versionId],
	});
	assert.equal(matches[0]?.metadata.originalText, passage().originalText);
	await client.delete([item.id]);
	assert.deepEqual(
		calls.map((c) => [c.method, c.path]),
		[
			["GET", "/indexes/books"],
			["POST", "/vectors/upsert"],
			["POST", "/query"],
			["GET", "/indexes/books"],
			["POST", "/vectors/delete"],
		],
	);
	for (const call of calls) {
		assert.equal(call.key, "synthetic-api-secret");
		const encoded = JSON.stringify(call.body);
		for (const forbidden of ["/private", "originalPath", "synthetic-api-secret", "DO-NOT-SEND-IMAGE", "deleteAll"])
			assert.ok(!encoded.includes(forbidden));
		if (call.method === "POST") assert.equal(call.body.namespace, "owned-library");
	}
	assert.equal(item.metadata.sourceHash, passage().sourceHash);
	const evidence = expandPassageEvidence(item.metadata);
	assert.deepEqual(evidence.spans, passage().spans);
	assert.deepEqual(evidence.headingPath, passage().headingPath);
	const probes = calls.filter((c) => c.path === "/indexes/books").length;
	await client.query(vector, embeddingIdentity, { generation });
	await client.query(vector, embeddingIdentity, { generation });
	assert.equal(calls.filter((c) => c.path === "/indexes/books").length, probes);
	const expiring = new Pinecone({ ...options, verificationTtlMs: 1 });
	await expiring.query(vector, embeddingIdentity, { generation });
	await new Promise((resolve) => setTimeout(resolve, 5));
	await expiring.query(vector, embeddingIdentity, { generation });
	assert.equal(calls.filter((c) => c.path === "/indexes/books").length, probes + 2);
	for (const mode of ["dimension", "host", "pod"]) {
		compatible = mode !== "dimension";
		mismatchHost = mode === "host";
		invalidMode = mode === "pod";
		const before = calls.length;
		await assert.rejects(client.upsert([item], embeddingIdentity), /serverless dense cosine/u);
		assert.equal(calls.length, before + 2);
	}
	compatible = true;
	mismatchHost = false;
	invalidMode = false;
	const before = calls.length;
	await assert.rejects(
		client.upsert([{ ...item, metadata: { ...item.metadata, originalPath: "/private/path" } }], embeddingIdentity),
		/allowlisted/u,
	);
	await assert.rejects(
		client.upsert(
			[{ ...item, metadata: { ...item.metadata, originalText: "synthetic-api-secret" } }],
			embeddingIdentity,
		),
		/Credential/u,
	);
	const largeItem = { ...item, metadata: { ...item.metadata, originalText: "x".repeat(30000) } };
	await assert.rejects(
		client.upsert(
			Array.from({ length: 50 }, () => largeItem),
			embeddingIdentity,
		),
		/budget/u,
	);
	await assert.rejects(client.delete(["../other-namespace"]), /opaque/u);
	await assert.rejects(
		client.upsert(
			Array.from({ length: 51 }, () => item),
			embeddingIdentity,
		),
		/batch/u,
	);
	await assert.rejects(client.query(vector, embeddingIdentity, { generation, topK: 21 }), /topK/u);
	await assert.rejects(client.query(vector, { ...embeddingIdentity, digest: "wrong" }, { generation }), /mismatch/u);
	assert.equal(calls.length, before);
	const tiny = new Pinecone({ ...options, maxVectors: 1 });
	await tiny.upsert([item], embeddingIdentity);
	await assert.rejects(tiny.upsert([item], embeddingIdentity), /budget/u);
	const requests = new Pinecone({ ...options, maxRequests: 1 });
	await requests.doctor();
	await assert.rejects(requests.doctor(), /request budget/u);
	const deletion = new Pinecone({ ...options, maxVectors: 1 });
	await deletion.delete([item.id]);
	await assert.rejects(deletion.delete([item.id]), /delete run budget/u);
	const bytes = new Pinecone({ ...options, maxWriteBytes: 10 });
	await assert.rejects(bytes.upsert([item], embeddingIdentity), /budget/u);
});

test("metadata exceeds 40 KB explicitly, rejects null/nested/nonfinite values, accepts allowed flat types", () => {
	assert.throws(
		() => passageRecord({ ...passage(), originalText: "x".repeat(41000) }, vector, generation),
		/Passage passage_e+ record is \d+ bytes, above the 32768-byte budget/u,
	);
	assert.throws(() => validateMetadata({ text: "x".repeat(41000) }), /40 KB/u);
	for (const value of [null, { nested: true }, [1], Number.NaN])
		assert.throws(() => validateMetadata({ value } as never), /flat/u);
	validateMetadata({ text: "x", number: 1, flag: false, strings: ["a", "b"] });
	assert.throws(
		() => new Pinecone({ apiKey: "fake", indexName: "books", host: "https://example.test", namespace: "" }),
		/configuration/u,
	);
	assert.throws(
		() =>
			new Pinecone({
				apiKey: "fake",
				indexName: "books",
				host: "https://example.test",
				namespace: "owned",
				minimumWriteIntervalMs: 0,
			}),
		/rate bounds/u,
	);
});

test("Pinecone transient retries are bounded and quota 429 is not retried; errors never echo keys", async (t) => {
	let count = 0;
	let quota = false;
	const server = createServer((_req, res) => {
		count++;
		res.writeHead(429, { "Retry-After": "0" });
		res.end(quota ? "monthly quota upgrade fake-secret" : "transient fake-secret");
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const client = new Pinecone({
		apiKey: "fake-secret",
		indexName: "books",
		host,
		controlUrl: host,
		namespace: "owned",
		retryDelayMs: 0,
	});
	await assert.rejects(
		client.doctor(),
		(e: unknown) => e instanceof Error && /bounded/u.test(e.message) && !e.message.includes("fake-secret"),
	);
	assert.equal(count, 3);
	quota = true;
	await assert.rejects(client.doctor(), /quota or billing/u);
	assert.equal(count, 4);
});

test("Pinecone queues work, re-probes malformed results, and leaves stale-candidate manifest checks to search", async (t) => {
	let host = "";
	let release: (() => void) | undefined;
	let hold = true;
	let mode = "malformed";
	let probes = 0;
	const server = createServer(async (req, res) => {
		for await (const _chunk of req) {
			/* Drain fake request without retaining text. */
		}
		if (req.url === "/indexes/books") {
			probes++;
			const send = () =>
				res.end(
					JSON.stringify({
						name: "books",
						dimension: 768,
						metric: "cosine",
						vector_type: "dense",
						spec: { serverless: { cloud: "aws", region: "us-east-1" } },
						status: { ready: true },
						host,
					}),
				);
			if (hold) release = send;
			else send();
		} else
			res.end(
				mode === "malformed"
					? "{bad"
					: JSON.stringify({
							matches: [
								{ id: passage().id, score: 1, metadata: passageRecord(passage(), vector, "0".repeat(32)).metadata },
							],
						}),
			);
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const client = new Pinecone({
		apiKey: "fake-secret",
		indexName: "books",
		host,
		controlUrl: host,
		namespace: "owned",
		minimumQueryIntervalMs: 0,
	});
	const active = client.doctor();
	while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
	const queued = client.doctor();
	hold = false;
	release();
	await active;
	await queued;
	const beforeMismatch = probes;
	await assert.rejects(client.query(vector, embeddingIdentity, { generation }), /JSON/u);
	assert.equal(probes, beforeMismatch + 1);
	mode = "stale";
	const stale = await client.query(vector, embeddingIdentity, { generation });
	assert.equal(stale[0]?.metadata.generation, "0".repeat(32));
	assert.equal(probes, beforeMismatch + 1);
});

const evidenceOf = (p: Passage) => ({
	headingPath: p.headingPath,
	spans: p.spans,
	mappings: p.mappings,
	neighbors: p.neighbors,
	figures: p.figures,
	normalizedText: p.normalizedText,
});

/** Dense two-page layout: prose, many short table-like items, a Courier code block, ligature-bearing text
 * (NFKC changes it, so mappings alternate between literal and normalized runs) and figure references. */
function densePdf(): Uint8Array {
	const prose = (n: number) => `Dense line ${n}: retrieval of cited passages \ufb01xes ligature \ufb02ow in sentences.`;
	const page = (offset: number) => ({
		geometry: [900, 900] as const,
		text: [
			{ text: `Dense chapter ${offset}`, y: 880, size: 18 },
			...Array.from({ length: 28 }, (_, i) => ({ text: prose(offset + i), y: 850 - i * 14, size: 8 })),
			...Array.from({ length: 12 }, (_, i) => ({ text: `v${i}`, x: 40 + i * 30, y: 440, size: 8 })),
			...Array.from({ length: 14 }, (_, i) => ({
				text: `    value_${i} = f(${i})`,
				y: 420 - i * 12,
				size: 8,
				font: "Courier" as const,
			})),
			{ text: `See Figure 1-${offset + 1} for the layout.`, y: 240, size: 8 },
		],
	});
	return pdfFixture({
		pages: [
			page(0),
			page(1),
			{
				geometry: [900, 900],
				text: [
					{ text: "Figure 1-1. First", y: 800 },
					{ text: "Figure 1-2. Second", y: 700 },
				],
			},
		],
	});
}

async function chunked(t: { after: (fn: () => void) => void }, pdf: Uint8Array, targetBound: number) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-record-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new CorpusStore({ directory: join(root, "store") });
	const input = join(root, "book.pdf");
	writeFileSync(input, pdf);
	const prepared = await ingestPdf({
		store,
		input,
		bookId: store.newBookId(),
		indexConfigurationHash: sha256(`r-${targetBound}`),
	});
	await publishIngest(prepared, store, { targetBound });
	return store.listPassages(prepared.source).map((p) => store.readPassage(prepared.source, p.id));
}

test("compact hosted records round-trip exactly the evidence the local store holds", async (t) => {
	for (const pdf of [structuralPdf(), densePdf()]) {
		const passages = await chunked(t, pdf, 400);
		assert.ok(passages.length > 1);
		for (const p of passages) {
			const record = passageRecord(p, vector, generation);
			assert.equal(record.metadata.schema, 2);
			assert.deepEqual(expandPassageEvidence(record.metadata), evidenceOf(p));
		}
	}
});

test("mixed literal, normalized and omitted mappings round-trip through runs", () => {
	const base = passage();
	const mixed: Passage = {
		...base,
		originalText: "abc\ufb01d\u00adef",
		normalizedText: "abcfid" + "ef",
		mappings: [
			{ originalRange: { start: 0, end: 1 }, normalizedRange: { start: 0, end: 1 }, kind: "literal" },
			{ originalRange: { start: 1, end: 2 }, normalizedRange: { start: 1, end: 2 }, kind: "literal" },
			{ originalRange: { start: 2, end: 3 }, normalizedRange: { start: 2, end: 3 }, kind: "literal" },
			{ originalRange: { start: 3, end: 4 }, normalizedRange: { start: 3, end: 5 }, kind: "normalized" },
			{ originalRange: { start: 4, end: 5 }, normalizedRange: { start: 5, end: 6 }, kind: "literal" },
			{ originalRange: { start: 5, end: 6 }, normalizedRange: { start: 6, end: 6 }, kind: "omitted" },
			{ originalRange: { start: 6, end: 7 }, normalizedRange: { start: 6, end: 7 }, kind: "literal" },
			{ originalRange: { start: 7, end: 8 }, normalizedRange: { start: 7, end: 8 }, kind: "literal" },
		],
		spans: [{ ...base.spans[0], originalRange: { start: 0, end: 8 } } as Passage["spans"][number]],
	};
	const record = passageRecord(mixed, vector, generation);
	assert.deepEqual(
		JSON.parse(String(record.metadata.mappings)),
		[0, 1, 1, 3, 1, 1, 2, 1, 0, 1, 1, 1, 2, 1, 0, 1, 0, 1, 1, 2],
	);
	assert.deepEqual(expandPassageEvidence(record.metadata).mappings, mixed.mappings);
});

test("identical original and normalized text is stored once; schema 1 records are incompatible", () => {
	const same = { ...passage(), normalizedText: passage().originalText };
	const record = passageRecord(same, vector, generation);
	assert.equal(record.metadata.sameText, true);
	assert.equal("normalizedText" in record.metadata, false);
	assert.equal(expandPassageEvidence(record.metadata).normalizedText, same.originalText);
	assert.throws(() => expandPassageEvidence({ ...record.metadata, schema: 1 }), /incompatible/u);
});

test("production-bound passages from dense two-page text serialize within the 32 KB record budget", async (t) => {
	let largest = 0;
	for (const pdf of [densePdf(), structuralPdf()]) {
		for (const p of await chunked(t, pdf, productionTargetBound)) {
			const bytes = Buffer.byteLength(JSON.stringify(passageRecord(p, vector, generation).metadata));
			largest = Math.max(largest, bytes);
			assert.ok(bytes <= recordBudgetBytes, `${bytes} bytes`);
		}
	}
	const dense = await chunked(t, densePdf(), productionTargetBound);
	assert.ok(Math.max(...dense.map((p) => p.spans.length)) >= 20, "passages hold many text items");
	assert.ok(
		dense.some((p) => new Set(p.spans.map((s) => s.location.pageNumber)).size === 2),
		"a passage spans two pages",
	);
	assert.ok(dense.some((p) => p.figures.length > 0));
	console.log(`largest production-bound record: ${largest} bytes at bound ${productionTargetBound}`);
});
