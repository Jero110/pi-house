import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capacitySettings, PublicationBudget, publicationLimits } from "../src/capacity.ts";
import { requestBytes } from "../src/config.ts";

function budgetFixture(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-capacity-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return join(root, "index-capacity.json");
}

test("finite configurable capacity admits >20k vectors and >100MB without huge fixtures", (t) => {
	const path = budgetFixture(t);
	const budget = new PublicationBudget(path, publicationLimits);
	budget.check({ vectors: 36951, inputs: 36951, uploadBytes: 780793914, pineconeBytes: 810056095 });
	budget.charge({ vectors: 20001, inputs: 20001, uploadBytes: 100000001 });
	const restarted = new PublicationBudget(path, publicationLimits);
	assert.equal(restarted.remaining().vectors, 29999);
	assert.equal(restarted.remaining().uploadBytes, 1073741824 - 100000001);
	assert.throws(() => restarted.charge({ vectors: 30000 }), /planned=30000 remaining=29999/u);
	for (const value of ["Infinity", "0", "-1", "100001", "1.5"])
		assert.throws(() => capacitySettings({ BOOKS_PUBLICATION_REQUESTS: value }));
	assert.equal(capacitySettings({ BOOKS_PUBLICATION_REQUESTS: "42" }).requests, 42);
});

test("ambiguous response reservations survive restart and successful responses settle actual bytes", (t) => {
	const path = budgetFixture(t);
	const budget = new PublicationBudget(path, publicationLimits);
	budget.account(100, 1000); // killed request: no settlement
	const restarted = new PublicationBudget(path, publicationLimits);
	assert.equal(restarted.remaining().requests, publicationLimits.requests - 1);
	assert.equal(restarted.remaining().responseBytes, publicationLimits.responseBytes - 1000);
	restarted.account(50, 1000)(123);
	assert.equal(
		new PublicationBudget(path, publicationLimits).remaining().responseBytes,
		publicationLimits.responseBytes - 1123,
	);
	const overflowPath = join(path, "..", "overflow.json");
	const overflowLimits = { ...publicationLimits, responseBytes: 4 };
	const overflow = new PublicationBudget(overflowPath, overflowLimits);
	assert.throws(() => overflow.account(0, 4)(5), /capacity insufficient/u);
	assert.equal(new PublicationBudget(overflowPath, overflowLimits).remaining().responseBytes, -1);
});

test("per-provider egress survives restart, includes retry envelopes and stops before dispatch", async (t) => {
	const path = budgetFixture(t);
	const limits = { ...publicationLimits, pineconeResponseBytes: 20000 };
	const budget = new PublicationBudget(path, limits);
	budget.providerAccount("pinecone")(0, 1000)(100);
	budget.providerAccount("s3")(0, 1000)(50);
	const restarted = new PublicationBudget(path, limits);
	assert.equal(restarted.remaining().pineconeResponseBytes, 20000 - 8292);
	assert.equal(restarted.remaining().s3ResponseBytes, publicationLimits.s3ResponseBytes - 8242);
	// An interrupted physical attempt keeps its whole reservation, not just actual bytes.
	restarted.providerAccount("pinecone")(0, 1000);
	assert.equal(new PublicationBudget(path, limits).remaining().pineconeResponseBytes, 20000 - 8292 - 9192);
	let calls = 0;
	await assert.rejects(
		requestBytes(
			() => {
				calls++;
				return { url: new URL("http://127.0.0.1:9"), init: {} };
			},
			1000,
			{ accounting: restarted.providerAccount("pinecone"), retries: 0 },
		),
		/capacity insufficient/,
	);
	assert.equal(calls, 1, "request was prepared but never dispatched");
});

test("physical retries, request bodies and full vector/metadata response bytes are cumulative", async (t) => {
	const path = budgetFixture(t);
	const budget = new PublicationBudget(path, publicationLimits);
	let attempts = 0;
	const payload = JSON.stringify({
		vectors: { id: { values: [0.123, 0.456], metadata: { originalText: "synthetic" } } },
	});
	const server = createServer(async (req, res) => {
		for await (const _ of req) {
			/* consume the synthetic body */
		}
		attempts++;
		res.statusCode = attempts === 1 ? 503 : 200;
		res.end(attempts === 1 ? "retry" : payload);
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	await requestBytes(() => ({ url, init: { method: "POST", body: "abc" } }), 1024, {
		accounting: budget.providerAccount("pinecone"),
		retryDelayMs: 0,
	});
	assert.equal(attempts, 2);
	assert.equal(budget.remaining().requests, publicationLimits.requests - 2);
	assert.equal(budget.remaining().writeBytes, publicationLimits.writeBytes - 6);
	assert.equal(
		new PublicationBudget(path, publicationLimits).remaining().pineconeResponseBytes,
		publicationLimits.pineconeResponseBytes - 2 * 8192 - 5 - Buffer.byteLength(payload),
	);
	assert.equal(budget.remaining().responseBytes, publicationLimits.responseBytes - 5 - Buffer.byteLength(payload));
	const tiny = new PublicationBudget(join(path, "..", "tiny.json"), { ...publicationLimits, responseBytes: 1 });
	await assert.rejects(
		requestBytes(() => ({ url, init: {} }), 1024, { accounting: tiny.account }),
		/capacity insufficient/u,
	);
	assert.equal(attempts, 2, "reservation refusal never dispatches");
});
