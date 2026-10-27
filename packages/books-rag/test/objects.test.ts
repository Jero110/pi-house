import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Objects, signV4 } from "../src/objects.ts";
import type { CorpusStore } from "../src/store.ts";

// Public documentation fixture, not credentials for a real AWS account.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
const example = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
test("SigV4 matches the published AWS IAM ListUsers example, byte-for-byte", () => {
	const result = signV4({
		method: "GET",
		url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
		region: "us-east-1",
		service: "iam",
		...example,
		date: new Date("2015-08-30T12:36:00Z"),
		headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
		contentHashHeader: false,
	});
	assert.equal(
		result.canonicalRequest,
		"GET\n/\nAction=ListUsers&Version=2010-05-08\ncontent-type:application/x-www-form-urlencoded; charset=utf-8\nhost:iam.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-type;host;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	);
	assert.equal(
		result.stringToSign,
		"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/iam/aws4_request\nf536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
	);
	assert.equal(result.signature, "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
});

test("default probe is read-only on reader machines; discovery distinguishes absent objects from corruption", async (t) => {
	const calls: string[] = [];
	let corrupt = false;
	const server = createServer((req, res) => {
		calls.push(`${req.method} ${req.url}`);
		assert.equal(req.method, "GET");
		if (!req.headers.authorization) {
			assert.equal(req.url, "/books/library/_private-probe");
			res.statusCode = 403;
			res.end();
			return;
		}
		if (req.url?.endsWith("missing")) {
			res.statusCode = 404;
			res.end();
			return;
		}
		res.setHeader("x-amz-meta-sha256", createHash("sha256").update("{}").digest("hex"));
		res.end(corrupt ? "changed" : "{}");
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const client = new Objects({
		endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		region: "us-east-1",
		bucket: "books",
		prefix: "library/",
		...example,
		privateBucketConfirmed: true,
		retries: 0,
	});
	assert.equal(await client.discover(client.libraryKey("missing")), null);
	assert.equal((await client.discover(client.libraryKey("catalog.json")))?.bytes.toString(), "{}");
	assert.equal(calls[0], "GET /books/library/_private-probe");
	assert.ok(calls.every((call) => call.startsWith("GET")));
	corrupt = true;
	await assert.rejects(client.discover(client.libraryKey("catalog.json")), /hash mismatch/u);
});

test("S3 canonical request matches the published AWS S3 GET object example", () => {
	// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
	const result = signV4({
		method: "GET",
		url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
		region: "us-east-1",
		...example,
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		date: new Date("2013-05-24T00:00:00Z"),
		headers: { Range: "bytes=0-9" },
	});
	assert.equal(
		createHash("sha256").update(result.canonicalRequest).digest("hex"),
		"7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
	);
});

test("private path-style S3 PUT/GET/HEAD/delete use signed headers, pinned content hash, bounded keys and no ACL/public endpoints", async (t) => {
	const calls: { method: string; path: string; body: Buffer }[] = [];
	const storage = new Map<string, { bytes: Buffer; hash: string }>();
	let corrupt = false;
	let unsigned = 0;
	const server = createServer(async (req, res) => {
		if (!req.headers.authorization) {
			unsigned++;
			assert.equal(req.url, "/storage/v1/s3/private-books/library/private-probe");
			assert.equal(req.method, "GET");
			assert.equal(req.headers["x-amz-date"], undefined);
			res.writeHead(403);
			res.end("denied");
			return;
		}
		const parts: Buffer[] = [];
		for await (const chunk of req) parts.push(Buffer.from(chunk as Uint8Array));
		const bytes = Buffer.concat(parts);
		const path = req.url ?? "";
		calls.push({ method: req.method ?? "", path, body: bytes });
		assert.ok(path.startsWith("/storage/v1/s3/private-books/library/"));
		assert.ok(!path.includes(example.accessKeyId));
		assert.equal(req.headers["x-amz-acl"], undefined);
		const url = new URL(path, `http://${req.headers.host}`);
		const signedHeaders =
			String(req.headers.authorization)
				.match(/SignedHeaders=([^,]+)/u)?.[1]
				?.split(";") ?? [];
		const headers: Record<string, string> = {};
		for (const name of signedHeaders) headers[name] = String(req.headers[name]);
		const date = String(req.headers["x-amz-date"]);
		const parsedDate = new Date(
			`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
		);
		const signed = signV4({
			method: req.method ?? "",
			url,
			region: "us-east-1",
			...example,
			date: parsedDate,
			headers,
			payload: bytes,
		});
		assert.equal(req.headers.authorization, signed.headers.authorization);
		assert.equal(req.headers["x-amz-content-sha256"], createHash("sha256").update(bytes).digest("hex"));
		if (req.method === "PUT") {
			storage.set(path, { bytes, hash: String(req.headers["x-amz-meta-sha256"]) });
			res.end();
		} else if (req.method === "DELETE") {
			storage.delete(path);
			res.statusCode = 204;
			res.end();
		} else {
			const stored = storage.get(path);
			if (!stored) {
				res.statusCode = 404;
				res.end("not found");
				return;
			}
			res.setHeader("x-amz-meta-sha256", stored.hash);
			res.setHeader("Content-Length", stored.bytes.length);
			res.end(req.method === "HEAD" ? undefined : corrupt ? Buffer.alloc(stored.bytes.length) : stored.bytes);
		}
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const options = {
		endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/storage/v1/s3`,
		region: "us-east-1",
		bucket: "private-books",
		prefix: "library/",
		...example,
		privateBucketConfirmed: true as const,
		privateProbeKey: "library/private-probe",
		retries: 0,
	};
	const client = new Objects(options);
	const content = Buffer.from("synthetic-image-bytes");
	const receipt = await client.put("library/version/figure.png", content, "image/png");
	assert.equal(receipt.hash, `sha256:${createHash("sha256").update(content).digest("hex")}`);
	const [retrieved, described] = await Promise.all([
		client.get(receipt.key, receipt.hash),
		client.head(receipt.key, receipt.hash),
	]);
	assert.deepEqual(retrieved, content);
	assert.deepEqual(described, receipt);
	assert.equal(unsigned, 1);
	corrupt = true;
	await assert.rejects(client.get(receipt.key, receipt.hash), /hash mismatch/u);
	corrupt = false;
	await assert.rejects(client.get(receipt.key, `sha256:${"0".repeat(64)}`), /hash mismatch/u);
	const before = calls.length;
	for (const key of [
		"other/figure.png",
		"library/../other",
		"library/%2e%2e/other",
		"library/",
		"library/a?acl",
		"library/a#b",
		"library//a",
	])
		await assert.rejects(client.delete(key), /prefix/u);
	await assert.rejects(client.put("library/large", Buffer.alloc(2 * 1024 * 1024 + 1), "image/png"), /size/u);
	await assert.rejects(client.put("library/catalog", Buffer.alloc(1024 * 1024 + 1), "application/json"), /size/u);
	assert.equal(calls.length, before);
	await client.delete(receipt.key);
	assert.equal(storage.size, 0);
	const source = {
		bookId: `book_${"a".repeat(32)}`,
		versionId: `version_${"b".repeat(32)}`,
		sourceHash: `sha256:${"c".repeat(64)}`,
	} as const;
	const figureId = `figure_${"d".repeat(32)}` as const;
	let read = false;
	const fakeStore = {
		readFigureAsset(expected: unknown, id: string) {
			assert.deepEqual(expected, source);
			assert.equal(id, figureId);
			read = true;
			return { base64: content.toString("base64"), mimeType: "image/png", assetHash: receipt.hash };
		},
	} as unknown as CorpusStore;
	const figure = await client.putFigure(fakeStore, source, figureId);
	assert.equal(read, true);
	assert.equal(figure.key, `library/${source.versionId}/${figureId}`);
	assert.deepEqual(await client.get(figure.key, figure.hash), content);
	await client.delete(figure.key);
	assert.ok(calls.every((c) => ["PUT", "GET", "HEAD", "DELETE"].includes(c.method)));
	for (const c of calls) assert.ok(!JSON.stringify(c).includes(example.secretAccessKey));
	const tiny = new Objects({ ...options, maxRequests: 1 });
	await tiny.put("library/catalog", Buffer.from("{}"), "application/json");
	await assert.rejects(tiny.head("library/catalog", receipt.hash), /budget/u);
	const bytes = new Objects({ ...options, maxUploadBytes: 1 });
	await assert.rejects(bytes.put("library/catalog", Buffer.from("{}"), "application/json"), /budget/u);
	assert.throws(() => new Objects({ ...options, accessKeyId: "sbp_fake" }), /personal access/u);
	for (const bucket of [".", "..", "a..b", "../outside"])
		assert.throws(() => new Objects({ ...options, bucket }), /bucket/u);
	assert.throws(() => new Objects({ ...options, privateBucketConfirmed: false } as never), /private bucket/u);
});

test("S3 unsigned known-object probe fails closed for public/missing objects and accepts only explicit refusal", async (t) => {
	let status = 200;
	let signed = 0;
	let unsigned = 0;
	const server = createServer((req, res) => {
		if (req.headers.authorization) {
			signed++;
			res.end();
		} else {
			unsigned++;
			res.writeHead(status);
			res.end();
		}
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const options = {
		endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		region: "us-east-1",
		bucket: "books",
		prefix: "library/",
		...example,
		privateBucketConfirmed: true as const,
		privateProbeKey: "library/private-probe",
		retries: 0,
	};
	await assert.rejects(
		new Objects(options).put("library/catalog", Buffer.from("{}"), "application/json"),
		/Bucket appears public/u,
	);
	assert.equal(signed, 0);
	status = 404;
	await assert.rejects(new Objects(options).put("library/catalog", Buffer.from("{}"), "application/json"), /404/u);
	assert.equal(signed, 0);
	for (const refusal of [400, 401, 403]) {
		status = refusal;
		await new Objects(options).put("library/catalog", Buffer.from("{}"), "application/json");
	}
	assert.equal(signed, 3);
	assert.equal(unsigned, 5);
	const expiring = new Objects({ ...options, verificationTtlMs: 1 });
	await expiring.put("library/catalog", Buffer.from("{}"), "application/json");
	status = 200;
	await new Promise((resolve) => setTimeout(resolve, 5));
	await assert.rejects(
		expiring.put("library/catalog", Buffer.from("{}"), "application/json"),
		/Bucket appears public/u,
	);
});

test("S3 bounded retries, timeouts, queue waits and redacted failures use fake loopback only", async (t) => {
	let count = 0;
	let mode = "transient";
	const server = createServer((req, res) => {
		if (!req.headers.authorization) {
			res.writeHead(403);
			res.end();
			return;
		}
		count++;
		if (mode === "timeout") return;
		res.writeHead(mode === "denied" ? 403 : 429, { "retry-after": "0" });
		res.end(mode === "quota" ? `billing quota ${example.secretAccessKey}` : example.secretAccessKey);
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const client = new Objects({
		endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		region: "us-east-1",
		bucket: "books",
		prefix: "library/",
		...example,
		privateBucketConfirmed: true,
		privateProbeKey: "library/private-probe",
		queueWaitMs: 10,
		retryDelayMs: 0,
		timeoutMs: 30,
	});
	const call = () => client.put("library/catalog", Buffer.from("{}"), "application/json");
	await assert.rejects(call(), /bounded attempts/u);
	assert.equal(count, 3);
	mode = "quota";
	await assert.rejects(call(), /quota or billing/u);
	assert.equal(count, 4);
	mode = "denied";
	await assert.rejects(
		call(),
		(e: unknown) => e instanceof Error && /403/u.test(e.message) && !e.message.includes(example.secretAccessKey),
	);
	assert.equal(count, 5);
	mode = "timeout";
	const active = call();
	await assert.rejects(call(), /queue wait timed out/u);
	await assert.rejects(active, /bounded attempts/u);
});
