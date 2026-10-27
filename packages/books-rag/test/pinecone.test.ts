import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Passage } from "../src/contracts.ts";
import { embeddingIdentity } from "../src/embeddings.ts";
import { Pinecone, passageRecord, validateMetadata } from "../src/pinecone.ts";

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
			["GET", "/indexes/books"],
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
	assert.deepEqual(JSON.parse(String(item.metadata.spans)), passage().spans);
	assert.deepEqual(JSON.parse(String(item.metadata.headingPath)), passage().headingPath);
	for (const mode of ["dimension", "host", "pod"]) {
		compatible = mode !== "dimension";
		mismatchHost = mode === "host";
		invalidMode = mode === "pod";
		const before = calls.length;
		await assert.rejects(client.upsert([item], embeddingIdentity), /serverless dense cosine/u);
		assert.equal(calls.length, before + 1);
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
	assert.throws(() => passageRecord({ ...passage(), originalText: "x".repeat(41000) }, vector, generation), /40 KB/u);
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

test("Pinecone refuses concurrent work and malformed/stale query results", async (t) => {
	let host = "";
	let release: (() => void) | undefined;
	let hold = true;
	let mode = "malformed";
	const server = createServer(async (req, res) => {
		for await (const _chunk of req) {
			/* Drain fake request without retaining text. */
		}
		if (req.url === "/indexes/books") {
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
	await assert.rejects(client.doctor(), /concurrency/u);
	release();
	await active;
	hold = false;
	await assert.rejects(client.query(vector, embeddingIdentity, { generation }), /JSON/u);
	mode = "stale";
	await assert.rejects(client.query(vector, embeddingIdentity, { generation }), /stale/u);
});
