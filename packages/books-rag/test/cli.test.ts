import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runCli, usage } from "../src/cli.ts";
import { runBooksMcp } from "../src/mcp.ts";
import { CorpusStore } from "../src/store.ts";
import { type FakeServices, fakeServices } from "./fake-services.ts";
import { pdfFixture } from "./fixtures.ts";

const secrets = {
	PINE_CONE_API: "pc-secret-value-123",
	S3_ACCESS_KEY_ID: "akid-secret-456",
	S3_SECRET_ACCESS_KEY: "sak-secret-789",
};
const lines = [
	"Hosted corpora keep passage text in Pinecone metadata.",
	"Figures stay in a private bucket for later retrieval.",
];
const samplePdf = () =>
	pdfFixture({ pages: [{ geometry: [900, 900], text: lines.map((text, i) => ({ text, y: 800 - i * 50 })) }] });

async function run(argv: string[], env: Record<string, string>, cwd: string) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env, cwd });
	return { code, out: out.join(""), err: err.join("") };
}
const workspace = (t: { after: (fn: () => void) => void }) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-cli-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
};
const settings = (fake: FakeServices, root: string): Record<string, string> => ({
	BOOKS_DATA_DIR: join(root, "store"),
	OLLAMA_URL: fake.url,
	PINECONE_INDEX_NAME: "books",
	PINECONE_HOST: fake.url,
	PINECONE_NAMESPACE: "synthetic",
	BOOKS_PINECONE_CONTROL_URL: fake.url,
	S3_ENDPOINT: `${fake.url}/s3`,
	S3_REGION: "us-east-1",
	S3_BUCKET: "private-books",
	S3_LIBRARY_PREFIX: "library/",
	S3_BUCKET_PRIVATE_CONFIRMED: "true",
	...secrets,
});
const noSecrets = (text: string) => {
	for (const value of Object.values(secrets)) assert.equal(text.includes(value), false, "secret leaked");
};

test("help, unknown commands and bad options", async (t) => {
	const root = workspace(t);
	for (const argv of [["--help"], ["-h"], []]) {
		const result = await run(argv, {}, root);
		assert.equal(result.code, 0);
		assert.equal(result.out.trim(), usage);
	}
	for (const word of [
		"doctor",
		"ingest --input",
		"index",
		"evaluate --synthetic",
		"PDF only",
		"not recursive",
		"never modified or deleted",
	])
		assert.match(usage, new RegExp(word, "iu"));
	assert.equal((await run(["frobnicate"], {}, root)).code, 2);
	assert.equal((await run(["doctor", "extra"], {}, root)).code, 2);
	assert.equal((await run(["--bogus"], {}, root)).code, 2);
	assert.equal((await run(["evaluate"], {}, root)).code, 2);
	assert.equal((await run(["ingest"], {}, root)).code, 2);
});

test("evaluate --synthetic ignores configuration and calls only literal 127.0.0.1 endpoints", async (t) => {
	const root = workspace(t);
	const original = globalThis.fetch;
	const hosts = new Set<string>();
	globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		hosts.add(new URL(input instanceof Request ? input.url : String(input)).hostname);
		return original(input, init);
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	const result = await run(
		["evaluate", "--synthetic"],
		{ ...secrets, PINECONE_HOST: "https://real.example.com" },
		root,
	);
	assert.equal(result.code, 0, result.err);
	const report = JSON.parse(result.out) as { kind: string; passed: boolean; liveEvaluation: string };
	assert.equal(report.kind, "synthetic-pipeline-only");
	assert.equal(report.passed, true);
	assert.match(report.liveEvaluation, /NOT RUN/u);
	assert.deepEqual([...hosts], ["127.0.0.1"]);
	noSecrets(result.out);
});

test("ingest rejects non-PDF and symlinks per file, continues past failures, and never touches originals", async (t) => {
	const root = workspace(t);
	const books = join(root, "books");
	mkdirSync(join(books, "nested"), { recursive: true });
	const good = join(books, "good.pdf");
	writeFileSync(good, samplePdf());
	writeFileSync(join(books, "notes.txt"), "text");
	writeFileSync(join(books, "story.epub"), "epub");
	writeFileSync(join(books, "broken.pdf"), "not a pdf at all");
	writeFileSync(join(books, ".DS_Store"), "x");
	symlinkSync(good, join(books, "link.pdf"));
	const before = readFileSync(good);
	const env = { BOOKS_DATA_DIR: join(root, "store") };
	const result = await run(["ingest", "--input", books], env, root);
	assert.equal(result.code, 1);
	assert.match(result.out, /broken\.pdf: failed: /u);
	assert.match(result.out, /good\.pdf: ingested \(1 PDF pages, extraction complete\)/u);
	assert.match(result.out, /link\.pdf: rejected: symlinks are not followed/u);
	assert.match(result.out, /notes\.txt: rejected: unsupported_format/u);
	assert.match(result.out, /story\.epub: rejected: unsupported_format/u);
	assert.match(result.out, /nested: skipped: subdirectories are not traversed/u);
	assert.doesNotMatch(result.out, /DS_Store/u);
	assert.match(result.out, /1 ingested, 0 already present, 3 rejected, 1 skipped, 1 failed/u);
	assert.match(result.out, /never deleted/u);
	assert.deepEqual(readFileSync(good), before);
	assert.ok(existsSync(join(books, "notes.txt")) && existsSync(join(books, "broken.pdf")));
	assert.equal(new CorpusStore({ directory: env.BOOKS_DATA_DIR }).listVersions().length, 1);

	const again = await run(["ingest", "--input", good], env, root);
	assert.equal(again.code, 0, again.err + again.out);
	assert.match(again.out, /already ingested/u);
	assert.equal(new CorpusStore({ directory: env.BOOKS_DATA_DIR }).listVersions().length, 1);

	const text = await run(["ingest", "--input", join(books, "notes.txt")], env, root);
	assert.equal(text.code, 1);
	assert.match(text.out, /unsupported_format/u);
	const link = await run(["ingest", "--input", join(books, "link.pdf")], env, root);
	assert.equal(link.code, 1);
	assert.match(link.out, /symlinks are not followed/u);
	const missing = await run(["ingest", "--input", join(books, "absent.pdf")], env, root);
	assert.equal(missing.code, 1);
	assert.equal((await run(["ingest", "--input", good], {}, root)).code, 1);
});

test("doctor reports problems read-only; ingest then index make it ready; a reader with no store searches", async (t) => {
	const root = workspace(t);
	const fake = await fakeServices();
	t.after(() => fake.close());
	const env = settings(fake, root);
	const file = join(root, "books.env");
	writeFileSync(
		file,
		`${Object.entries(env)
			.map(([k, v]) => `${k}=${v}`)
			.join("\n")}\n`,
	);

	// Before the writer ran: the privacy probe object does not exist, so doctor must fail without creating it.
	const mark = fake.requests.length;
	const early = await run(["doctor", "--env-file", file], {}, root);
	assert.equal(early.code, 1);
	assert.match(early.out, /\[OK {2}\] ollama/u);
	assert.match(early.out, /\[OK {2}\] pinecone/u);
	assert.match(early.out, /\[FAIL\] s3 privacy\/catalog/u);
	assert.match(early.out, /doctor never writes/u);
	assert.equal(existsSync(env.BOOKS_DATA_DIR as string), false, "doctor creates no store");
	noSecrets(early.out);
	const mutating = (list: string[]) =>
		list.filter((r) => /^(PUT|DELETE|PATCH) /u.test(r) || /\/vectors\/(upsert|delete)/u.test(r));
	assert.deepEqual(mutating(fake.requests.slice(mark)), []);

	const input = join(root, "good.pdf");
	writeFileSync(input, samplePdf());
	assert.equal((await run(["ingest", "--input", input, "--env-file", file], {}, root)).code, 0);
	const indexed = await run(["index", "--env-file", file], {}, root);
	assert.equal(indexed.code, 0, indexed.err);
	assert.match(indexed.out, /Indexed 1 book\(s\), 1 passage\(s\), 0 figure\(s\)\. Catalog commit [a-f0-9]{32}/u);
	assert.match(indexed.out, /never deleted/u);
	noSecrets(indexed.out + indexed.err);

	const mark2 = fake.requests.length;
	const ready = await run(["doctor", "--env-file", file], {}, root);
	assert.equal(ready.code, 0, ready.out);
	assert.match(ready.out, /\[OK {2}\] catalog: 1 book\(s\) committed/u);
	assert.match(ready.out, /doctor: ready/u);
	noSecrets(ready.out);
	assert.deepEqual(mutating(fake.requests.slice(mark2)), []);

	// A second machine: same hosted services, no local store, no originals.
	rmSync(input);
	rmSync(env.BOOKS_DATA_DIR as string, { recursive: true, force: true });
	const inputStream = new PassThrough();
	const outputStream = new PassThrough();
	const received: string[] = [];
	outputStream.on("data", (chunk: Buffer) => received.push(chunk.toString("utf8")));
	const served = runBooksMcp({ ...env, BOOKS_MCP_IMAGES: "off" }, { input: inputStream, output: outputStream });
	const call = (id: number, name: string, args: unknown) =>
		inputStream.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`,
		);
	call(1, "books_list", {});
	call(2, "books_search", { query: lines.join("\n") });
	await new Promise((resolve) => setTimeout(resolve, 1500));
	inputStream.end();
	await served;
	const replies = received
		.join("")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { id: number; result: { content: { text: string }[] } });
	const list = JSON.parse(replies.find((r) => r.id === 1)?.result.content[0]?.text ?? "{}") as { entries: unknown[] };
	assert.equal(list.entries.length, 1);
	const search = JSON.parse(replies.find((r) => r.id === 2)?.result.content[0]?.text ?? "{}") as {
		status: string;
		hits: { locations: { label: string }[] }[];
	};
	assert.equal(search.status, "ok");
	assert.equal(search.hits[0]?.locations[0]?.label, "PDF page 1");
	assert.equal(existsSync(env.BOOKS_DATA_DIR as string), false, "the reader never creates a local store");
});

test("doctor names bad .env lines without values, lists missing keys, and flags a public bucket", async (t) => {
	const root = workspace(t);
	const bad = join(root, "bad.env");
	writeFileSync(bad, "PINE_CONE_API: pc-secret-value-123\n");
	const colon = await run(["doctor", "--env-file", bad], {}, root);
	assert.equal(colon.code, 1);
	assert.match(colon.out, /Use KEY=value for PINE_CONE_API/u);
	assert.match(colon.out, /missing BOOKS_DATA_DIR/u);
	assert.match(colon.out, /skipped until configuration is complete/u);
	noSecrets(colon.out);

	const fake = await fakeServices({ publicProbe: true });
	t.after(() => fake.close());
	const env = settings(fake, root);
	const exposed = await run(["doctor"], env, root);
	assert.equal(exposed.code, 1);
	assert.match(exposed.out, /Bucket appears public/u);
	noSecrets(exposed.out);

	const pat = await run(["doctor"], { ...env, S3_ACCESS_KEY_ID: "sbp_personal_access_token_value" }, root);
	assert.equal(pat.code, 1);
	assert.match(pat.out, /S3_ACCESS_KEY_ID requires an S3 credential/u);
	assert.doesNotMatch(pat.out, /sbp_personal_access_token_value/u);

	const none = await run(["index"], { BOOKS_DATA_DIR: join(root, "s") }, root);
	assert.equal(none.code, 1);
	assert.match(none.err, /Configuration: /u);
	const empty = await run(["index"], settings(fake, root), root);
	assert.equal(empty.code, 1);
	assert.match(empty.err, /no ingested books/u);
});
