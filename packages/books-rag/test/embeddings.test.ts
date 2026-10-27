import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { passageEmbeddingInput } from "../src/chunks.ts";
import { AdapterError, loadConfig, parseEnv, requestBytes } from "../src/config.ts";
import { embeddingIdentity, LocalEmbeddings, validateVector } from "../src/embeddings.ts";

test("local embeddings verify pinned runtime, model digest and show metadata; preserve task prefixes and truncate:false", async (t) => {
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	let digest = embeddingIdentity.digest as string;
	let dimension = 768;
	let runtime = "0.40.11";
	let malformed = false;
	let blocked: (() => void) | undefined;
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += String(chunk);
		const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		calls.push({ path: req.url ?? "", body });
		res.setHeader("Content-Type", "application/json");
		if (req.url === "/api/version") res.end(JSON.stringify({ version: runtime }));
		else if (req.url === "/api/tags") res.end(JSON.stringify({ models: [{ name: embeddingIdentity.model, digest }] }));
		else if (req.url === "/api/show")
			res.end(
				JSON.stringify({
					model_info: {
						"general.architecture": "nomic-bert",
						"nomic-bert.embedding_length": dimension,
						"nomic-bert.context_length": 2048,
					},
				}),
			);
		else if (req.url === "/api/embed") {
			const send = () =>
				res.end(
					JSON.stringify({
						embeddings: (body.input as string[]).map(() =>
							malformed ? [null] : Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
						),
					}),
				);
			if (blocked) {
				blocked = send;
			} else send();
		} else {
			res.statusCode = 404;
			res.end();
		}
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const client = new LocalEmbeddings({ url, retries: 0 });
	assert.equal((await client.query("technical_identifier", embeddingIdentity)).length, 768);
	const passage = { headingPath: [], normalizedText: "literal technical text" };
	await client.documents([passage], embeddingIdentity);
	assert.deepEqual(
		calls.filter((c) => c.path === "/api/embed").map((c) => c.body),
		[
			{ model: embeddingIdentity.model, input: ["search_query: technical_identifier"], truncate: false },
			{ model: embeddingIdentity.model, input: [passageEmbeddingInput(passage)], truncate: false },
		],
	);
	assert.ok(calls.every((c) => ["/api/version", "/api/tags", "/api/show", "/api/embed"].includes(c.path)));
	digest = embeddingIdentity.digest.slice(7);
	await client.doctor();
	digest = embeddingIdentity.digest;
	const count = calls.length;
	await assert.rejects(client.query("x", { ...embeddingIdentity, dimension: 10 }), /mismatch/u);
	await assert.rejects(client.query("x".repeat(2048), embeddingIdentity), /context/u);
	await assert.rejects(
		client.documents(
			Array.from({ length: 9 }, () => passage),
			embeddingIdentity,
		),
		/batch/u,
	);
	assert.equal(calls.length, count);
	digest = "sha256:wrong";
	await assert.rejects(client.query("x", embeddingIdentity), /not installed/u);
	digest = embeddingIdentity.digest;
	dimension = 384;
	await assert.rejects(client.query("x", embeddingIdentity), /dimension/u);
	dimension = 768;
	runtime = "another";
	await assert.rejects(client.query("x", embeddingIdentity), /version mismatch/u);
	runtime = "0.40.11";
	malformed = true;
	await assert.rejects(client.query("x", embeddingIdentity), /768 finite/u);
	malformed = false;
	blocked = () => {};
	const previousCount = calls.length;
	const active = client.query("x", embeddingIdentity);
	while (calls.length <= previousCount || calls.at(-1)?.path !== "/api/embed")
		await new Promise((resolve) => setTimeout(resolve, 1));
	await assert.rejects(client.query("x", embeddingIdentity), /concurrency/u);
	blocked();
	await active;
	blocked = undefined;
	const tiny = new LocalEmbeddings({ url, maxInputs: 1 });
	await tiny.query("x", embeddingIdentity);
	await assert.rejects(tiny.query("x", embeddingIdentity), /budget/u);
});

test("embedding endpoints cannot resolve DNS, redirect, contain credentials, or select a cloud model", () => {
	for (const url of [
		"https://example.com",
		"http://localhost:11434",
		"http://127.0.0.2",
		"http://user:secret@127.0.0.1",
		"http://127.0.0.1/path",
		"http://127.0.0.1?secret=value",
	])
		assert.throws(() => new LocalEmbeddings({ url }), AdapterError);
	assert.throws(() => new LocalEmbeddings({ url: "http://127.0.0.1", model: "nomic:cloud" }), /model/u);
	// URL's permissive integer/short IPv4 forms are not literal approved endpoints.
	for (const url of ["http://2130706433", "http://127.1", "http://0x7f000001"])
		assert.throws(() => new LocalEmbeddings({ url }), /literal/u);
});

test("embedding vectors reject non-finite, zero, wrong dimensions and unsupported input scalars", async () => {
	for (const vector of [
		Array(768).fill(0),
		Array(767).fill(1),
		[...Array(767).fill(1), Number.NaN],
		[...Array(767).fill(1), Number.POSITIVE_INFINITY],
	])
		assert.throws(() => validateVector(vector), /768 finite/u);
	const client = new LocalEmbeddings({ url: "http://127.0.0.1:1", retries: 0 });
	await assert.rejects(client.query("\ud800", embeddingIdentity), /surrogates/u);
	await assert.rejects(client.query(" ", embeddingIdentity), /Empty/u);
	await assert.rejects(client.query("valid", embeddingIdentity), /unavailable/u);
});

test("dotenv/config errors name keys but never echo credential values", () => {
	assert.deepEqual(parseEnv("# comment\nPINE_CONE_API=synthetic-key\nS3_REGION='us-east-1'"), {
		PINE_CONE_API: "synthetic-key",
		S3_REGION: "us-east-1",
	});
	for (const key of ["PINE_CONE_API", "S3_SECRET_ACCESS_KEY"])
		assert.throws(
			() => parseEnv(`${key}:do-not-echo`),
			(e: unknown) => e instanceof Error && e.message.includes(key) && !e.message.includes("do-not-echo"),
		);
	const env = {
		BOOKS_DATA_DIR: "/tmp/private-books",
		PINE_CONE_API: "fake-api-key",
		PINECONE_INDEX_NAME: "books",
		PINECONE_HOST: "example.test",
		PINECONE_NAMESPACE: "library",
		S3_ENDPOINT: "https://example.test/storage/v1/s3",
		S3_REGION: "us-east-1",
		S3_BUCKET: "books",
		S3_ACCESS_KEY_ID: "fake-id",
		S3_SECRET_ACCESS_KEY: "fake-secret",
		S3_LIBRARY_PREFIX: "library/",
	};
	assert.equal(loadConfig({ env }).objects.bucket, "books");
	assert.throws(
		() => loadConfig({ env: { ...env, S3_ACCESS_KEY_ID: "sbp_not-a-real-token" } }),
		(e: unknown) => e instanceof Error && /personal access token/u.test(e.message) && !e.message.includes("sbp_"),
	);
	assert.throws(() => loadConfig({ env: { ...env, PINE_CONE_API: "" } }), /PINE_CONE_API/u);
});

test("transport caps retries, response bytes, timeouts, redirects and redacts echoed provider errors", async (t) => {
	let count = 0;
	let mode = "transient";
	const server = createServer((_req, res) => {
		count++;
		if (mode === "timeout") return;
		if (mode === "redirect") {
			res.writeHead(302, { Location: "https://never-contact.invalid" });
			res.end();
			return;
		}
		if (mode === "large") {
			res.end("x".repeat(100));
			return;
		}
		res.writeHead(mode === "bad" ? 401 : 429, { "retry-after": mode === "wait" ? "30" : "0" });
		res.end(mode === "quota" ? "monthly quota exhausted fake-secret" : "fake-secret");
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	const call = () =>
		requestBytes(() => ({ url, init: {} }), mode === "large" ? 20 : 200, {
			retries: 2,
			retryDelayMs: 0,
			timeoutMs: 30,
		});
	await assert.rejects(call(), /bounded attempts/u);
	assert.equal(count, 3);
	for (const next of ["quota", "bad", "wait", "large"]) {
		mode = next;
		const before: number = count;
		await assert.rejects(call(), (e: unknown) => e instanceof AdapterError && !e.message.includes("fake-secret"));
		assert.equal(count, before + 1);
	}
	mode = "timeout";
	await assert.rejects(call(), /bounded attempts/u);
	mode = "redirect";
	await assert.rejects(call(), /bounded attempts/u);
});
