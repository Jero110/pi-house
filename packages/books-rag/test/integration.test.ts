// Offline end-to-end contract: a synthetic PDF goes through the real CLI (ingest, index) into loopback fakes of
// Ollama, Pinecone and a private S3 bucket, then a reader with an empty local store and no original queries the
// real MCP server. Nothing here talks to a real service, spends tokens or reads a supplied book.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { sha256 } from "../src/locations.ts";
import { maxResponseCharacters, runBooksMcp } from "../src/mcp.ts";
import { CorpusStore } from "../src/store.ts";
import { type FakeServices, fakeServices } from "./fake-services.ts";
import { pdfFixture, structuralPdf } from "./fixtures.ts";

const mcpEntry = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
const secrets = {
	PINE_CONE_API: "pc-secret-value-123",
	S3_ACCESS_KEY_ID: "akid-secret-456",
	S3_SECRET_ACCESS_KEY: "sak-secret-789",
};
const sectionQuery = "A subsection starts halfway down this page.";
const figureQuery = "Continuation with Figure 3-7 on the next page.";
const codeQuery = "embedding_ vectors = [ first_value, second_value]";
const unrelatedQuery = "When do lunar eclipses occur on the far side of Jupiter?";

interface World {
	readonly root: string;
	readonly fake: FakeServices;
	readonly store: string;
	readonly envFile: string;
	/** Process environment of a client: only the env file path and the loopback test hook, never a secret. */
	readonly clientEnv: Record<string, string>;
	readonly originals: string;
}
async function world(
	t: { after: (fn: () => void | Promise<void>) => void },
	options: { readonly publicProbe?: boolean } = {},
): Promise<World> {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-integration-"));
	const fake = await fakeServices(options);
	t.after(async () => {
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	});
	const store = join(root, "store");
	const settings: Record<string, string> = {
		BOOKS_DATA_DIR: store,
		OLLAMA_URL: fake.url,
		PINECONE_INDEX_NAME: "books",
		PINECONE_HOST: fake.url,
		PINECONE_NAMESPACE: "synthetic",
		S3_ENDPOINT: `${fake.url}/s3`,
		S3_REGION: "us-east-1",
		S3_BUCKET: "private-books",
		S3_LIBRARY_PREFIX: "library/",
		S3_BUCKET_PRIVATE_CONFIRMED: "true",
		...secrets,
	};
	const envFile = join(root, "books.env");
	writeFileSync(
		envFile,
		`${Object.entries(settings)
			.map(([k, v]) => `${k}=${v}`)
			.join("\n")}\n`,
		{ mode: 0o600 },
	);
	const originals = join(root, "originals");
	mkdirSync(originals);
	return {
		root,
		fake,
		store,
		envFile,
		originals,
		clientEnv: { BOOKS_ENV_FILE: envFile, BOOKS_PINECONE_CONTROL_URL: fake.url },
	};
}

async function cli(w: World, argv: string[], cwd = w.root) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, {
		stdout: (s) => out.push(s),
		stderr: (s) => err.push(s),
		env: w.clientEnv,
		cwd,
	});
	return { code, out: out.join(""), err: err.join("") };
}

interface Reply {
	readonly isError?: boolean;
	readonly content: { type: string; text?: string; data?: string; mimeType?: string }[];
}
/** Newline-delimited JSON-RPC over any stdio pair: a real child process or fake in-process streams. */
function rpc(input: Writable, output: Readable) {
	const waiting = new Map<number, (message: Record<string, unknown>) => void>();
	let buffer = "";
	output.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const message = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
			buffer = buffer.slice(at + 1);
			waiting.get(message.id as number)?.(message);
		}
	});
	let next = 1;
	const request = (method: string, params?: unknown) =>
		new Promise<Record<string, unknown>>((resolve) => {
			const id = next++;
			waiting.set(id, resolve);
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	return {
		request,
		tool: async (name: string, args: unknown) => {
			const result = (await request("tools/call", { name, arguments: args })).result as Reply;
			const first = result.content[0];
			assert.equal(first?.type, "text");
			const text = first?.text ?? "";
			return { result, text, json: JSON.parse(text) as Record<string, unknown> };
		},
	};
}
/** In-process server on fake streams, as a client would see it. */
function inProcess(env: Record<string, string>, t: { after: (fn: () => Promise<void>) => void }) {
	const input = new PassThrough();
	const output = new PassThrough();
	const done = runBooksMcp({ ...env }, { input, output });
	t.after(async () => {
		input.end();
		await done;
	});
	return rpc(input, output);
}
/** The real entry point as `node <checkout>/packages/books-rag/src/mcp.ts`, the command the clients run. */
function spawned(env: Record<string, string>, t: { after: (fn: () => Promise<void>) => void }) {
	const child = spawn(process.execPath, [mcpEntry], {
		env: { PATH: process.env.PATH ?? "", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stderr: string[] = [];
	child.stderr.on("data", (c: Buffer) => stderr.push(c.toString("utf8")));
	const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
	t.after(async () => {
		child.stdin.end();
		await exited;
	});
	return {
		...rpc(child.stdin, child.stdout),
		stderr,
		finish: async () => {
			child.stdin.end();
			return exited;
		},
	};
}

const structuralBytes = () => Buffer.from(structuralPdf());
function writeOriginal(w: World, name: string, bytes: Uint8Array): string {
	const path = join(w.originals, name);
	writeFileSync(path, bytes);
	return path;
}
/** Writer machine: ingest, index, then forget the original and the whole local store (a fresh second machine). */
async function publish(w: World, name = "book.pdf", bytes: Uint8Array = structuralBytes()) {
	const original = writeOriginal(w, name, bytes);
	const ingested = await cli(w, ["ingest", "--input", original]);
	assert.equal(ingested.code, 0, ingested.out + ingested.err);
	const indexed = await cli(w, ["index"]);
	assert.equal(indexed.code, 0, indexed.out + indexed.err);
	return { original, ingested, indexed };
}
function forgetLocalCopy(w: World, original: string): void {
	rmSync(original);
	rmSync(w.store, { recursive: true, force: true });
	assert.equal(existsSync(original) || existsSync(w.store), false);
}
const noSecrets = (text: string) => {
	for (const value of Object.values(secrets)) assert.equal(text.includes(value), false, "secret leaked");
};
const hits = (json: Record<string, unknown>) =>
	json.hits as {
		bookId: string;
		versionId: string;
		sourceHash: string;
		passageId: string;
		excerpt: string;
		headingPath: { title: string; location: string }[];
		locations: { label: string }[];
		figures: { figureId: string; association: string; location: string }[];
	}[];
/** Searches and returns the hit whose excerpt contains the marker, so a test never depends on rank order. */
async function hitFor(
	server: ReturnType<typeof rpc>,
	query: string,
	marker: string,
): Promise<ReturnType<typeof hits>[number]> {
	const hit = hits((await server.tool("books_search", { query })).json).find((h) => h.excerpt.includes(marker));
	assert.ok(hit, `no hit containing ${marker}`);
	return hit;
}
const diagnosticCodes = (json: Record<string, unknown>) => (json.diagnostics as { code: string }[]).map((d) => d.code);

test("synthetic PDF to cited figure through the CLI and a real MCP process on a fresh machine", async (t) => {
	const w = await world(t);
	const bytes = structuralBytes();
	const { original, indexed } = await publish(w, "book.pdf", bytes);
	assert.match(indexed.out, /Indexed 1 book\(s\), \d+ passage\(s\), 1 figure\(s\)\. Catalog commit [a-f0-9]{32}/u);
	assert.equal((await cli(w, ["doctor"])).code, 0);
	// Structural chunks reached the index: several passages, one per outline section.
	const published = [...w.fake.vectors.values()];
	assert.ok(published.length >= 3, `${published.length} structural passages`);
	assert.ok(published.every((r) => r.metadata.schema === 2 && r.values.length === 768));
	forgetLocalCopy(w, original);

	const mark = w.fake.requests.length;
	const server = spawned(w.clientEnv, t);
	const init = (await server.request("initialize", { protocolVersion: "2025-06-18" })).result as {
		instructions: string;
	};
	assert.match(init.instructions, /books_read/u);
	const tools = ((await server.request("tools/list")).result as { tools: { name: string }[] }).tools;
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["books_list", "books_search", "books_read", "books_figure"],
	);

	const list = (await server.tool("books_list", {})).json;
	assert.equal(list.status, "ok");
	const [entry] = list.entries as { bookId: string; versionId: string; sourceHash: string; pdfPages: number }[];
	assert.equal(entry?.sourceHash, sha256(bytes));
	assert.equal(entry?.pdfPages, 3);

	const search = await server.tool("books_search", { query: sectionQuery, bookIds: [entry?.bookId] });
	assert.equal(search.json.status, "ok");
	assert.equal(search.json.corpus, "complete");
	const found = hits(search.json);
	assert.ok(found.length >= 1 && found.length <= 5);
	const top = found[0];
	assert.ok(top);
	assert.equal(top.versionId, entry?.versionId);
	assert.equal(top.sourceHash, entry?.sourceHash);
	assert.deepEqual(
		top.headingPath.map((h) => h.title),
		["Semantic chunking"],
		"the section heading from the PDF outline travels with the passage",
	);
	assert.deepEqual(
		top.locations.map((l) => l.label),
		["PDF page 1"],
	);
	assert.ok(top.excerpt.length <= 800);
	const read = await server.tool("books_read", { passageId: top.passageId });
	assert.equal(read.json.status, "ok");
	assert.equal((read.json.source as { versionId: string }).versionId, entry?.versionId);
	assert.equal((read.json.source as { sourceHash: string }).sourceHash, entry?.sourceHash);
	assert.match(String(read.json.text), /A subsection starts halfway down this page\./u);
	assert.match(String(read.json.verification), /recorded-ingestion-hash-only/u);
	assert.equal(read.json.truncated, false);

	// The code block is its own structural passage and keeps its two-page location.
	const code = await hitFor(server, codeQuery, "first_value");
	assert.deepEqual(
		code.locations.map((l) => l.label),
		["PDF page 1", "PDF page 2"],
	);
	assert.match(String((await server.tool("books_read", { passageId: code.passageId })).json.text), /second_value\]$/u);

	// The passage that names Figure 3-7 links the figure on the NEXT page.
	const cited = await hitFor(server, figureQuery, "Continuation with Figure 3-7");
	const link = cited.figures.find((f) => f.association.includes("Figure 3-7"));
	assert.ok(link, "the passage names Figure 3-7 explicitly");
	assert.equal(link.location, "PDF page 2", "the reference sits on PDF page 2");
	const figure = await server.tool("books_figure", { figureId: link.figureId });
	assert.match(String(figure.json.caption), /^Figure 3-7\./u);
	assert.equal(figure.json.location, "PDF page 3", "the figure is on the following page");
	assert.equal((figure.json.source as { sourceHash: string }).sourceHash, entry?.sourceHash);
	const image = figure.result.content[1];
	assert.equal(image?.type, "image");
	const png = Buffer.from(image?.data ?? "", "base64");
	assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
	assert.ok((image?.data?.length ?? Number.POSITIVE_INFINITY) <= 2 * 1024 * 1024);
	const size = figure.json.image as { width: number; height: number };
	assert.ok(Math.max(size.width, size.height) <= 1600);

	const unrelated = await server.tool("books_search", { query: unrelatedQuery });
	assert.equal(unrelated.json.status, "insufficient_evidence");
	assert.deepEqual(unrelated.json.hits, []);
	assert.match(String(unrelated.json.next), /does not prove/u);

	// Read-only machine: no local store appeared, no write reached any service, no secret reached the client.
	const reads = w.fake.requests.slice(mark);
	assert.deepEqual(
		reads.filter((r) => /^(PUT|DELETE|PATCH) /u.test(r) || /\/vectors\/(upsert|delete)/u.test(r)),
		[],
	);
	assert.equal(existsSync(w.store), false);
	assert.equal(await server.finish(), 0);
	assert.deepEqual(server.stderr, [], "the server starts and exits without warnings");
	for (const part of [list.entries, search.text, read.text, figure.text]) noSecrets(JSON.stringify(part));
});

test("privacy: Pinecone and the catalog carry no local path, secret or image bytes; figures stay in the bucket", async (t) => {
	const w = await world(t);
	const { original } = await publish(w);
	const pinecone = JSON.stringify([...w.fake.vectors.values()].map((r) => r.metadata));
	const objects = [...w.fake.storage.entries()];
	const documents = objects.filter(([key]) => !key.includes("figure_"));
	assert.ok(
		objects.some(([key]) => key.includes("figure_")),
		"a figure object was uploaded",
	);
	assert.ok(documents.some(([key]) => key.endsWith("catalog.json")));
	const everythingTextual = `${pinecone}${documents.map(([, v]) => v.bytes.toString("utf8")).join("")}`;
	for (const forbidden of [w.root, original, "book.pdf", ...Object.values(secrets), "iVBORw0KGgo", "data:image"])
		assert.equal(everythingTextual.includes(forbidden), false, `${forbidden} must not be hosted`);
	assert.equal(Buffer.from(pinecone).includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
	// The original PDF itself is never uploaded: no stored object contains its bytes.
	const bytes = structuralBytes();
	for (const [, item] of objects) assert.equal(item.bytes.includes(bytes.subarray(0, 64)), false);
	for (const request of w.fake.requests) assert.doesNotMatch(request, /originals|\.pdf/u);
	// The only unauthenticated access is the refusal probe; everything else is signed (fake answers 403/404 otherwise).
	assert.ok(w.fake.requests.every((r) => !r.startsWith("DELETE")));
});

test("a publicly readable bucket is refused by doctor, index and the MCP, and nothing is uploaded", async (t) => {
	const w = await world(t, { publicProbe: true });
	const original = writeOriginal(w, "book.pdf", structuralBytes());
	assert.equal((await cli(w, ["ingest", "--input", original])).code, 0);
	const indexed = await cli(w, ["index"]);
	assert.equal(indexed.code, 1);
	assert.match(indexed.err, /Bucket appears public/u);
	assert.equal(w.fake.vectors.size, 0, "no passage text reached Pinecone");
	assert.deepEqual(
		[...w.fake.storage.keys()].filter((key) => key.includes("catalog") || key.includes("figure_")),
		[],
	);
	const doctor = await cli(w, ["doctor"]);
	assert.equal(doctor.code, 1);
	assert.match(doctor.out, /Bucket appears public/u);
	noSecrets(indexed.err + doctor.out);
	const server = inProcess(w.clientEnv, t);
	const listed = await server.tool("books_list", {});
	assert.equal(listed.result.isError, true);
	assert.match(String(listed.json.message), /Bucket appears public/u);
	assert.match(String(listed.json.message), /not evidence that the library lacks|not evidence/u);
	noSecrets(listed.text);
});

test("runtime and backend outages are explicit unavailable results, never absence of evidence", async (t) => {
	const w = await world(t);
	const { original } = await publish(w);
	forgetLocalCopy(w, original);
	const noRuntime = inProcess({ ...w.clientEnv, OLLAMA_URL: "http://127.0.0.1:1" }, t);
	const outage = await noRuntime.tool("books_search", { query: sectionQuery });
	assert.equal(outage.json.status, "unavailable");
	assert.equal(outage.json.backend, "unavailable");
	assert.deepEqual(outage.json.hits, []);
	assert.ok(diagnosticCodes(outage.json).includes("runtime_unavailable"));
	assert.match(JSON.stringify(outage.json.diagnostics), /no absence-of-evidence claim/u);
	assert.match(String(outage.json.next), /not an absence claim/u);
	// The catalog still lists: only the failing stage is reported.
	assert.equal((await noRuntime.tool("books_list", {})).json.status, "ok");

	const noPinecone = inProcess(
		{ ...w.clientEnv, PINECONE_HOST: "http://127.0.0.1:1", BOOKS_PINECONE_CONTROL_URL: "http://127.0.0.1:1" },
		t,
	);
	const down = await noPinecone.tool("books_search", { query: sectionQuery });
	assert.equal(down.json.status, "unavailable");
	assert.ok(diagnosticCodes(down.json).includes("backend_unavailable"));
	assert.notEqual(down.json.status, "insufficient_evidence");

	const server = inProcess(w.clientEnv, t);
	const found = hits((await server.tool("books_search", { query: sectionQuery })).json);
	const passageId = found[0]?.passageId;
	assert.ok(passageId);
	// The same passage is unreadable while Pinecone is down: an explicit, bounded error naming no secret.
	const failed = await noPinecone.tool("books_read", { passageId });
	assert.equal(failed.result.isError, true);
	assert.ok(failed.text.length < 1000);
	assert.match(String(failed.json.message), /not evidence that the library lacks/u);
	noSecrets(outage.text + down.text + failed.text);
	// A missing configuration key is a tool error and the server still starts.
	const bad = inProcess({ BOOKS_ENV_FILE: join(w.root, "absent.env") }, t);
	const unconfigured = await bad.tool("books_list", {});
	assert.equal(unconfigured.json.code, "configuration");
});

test("a changed hosted record, a tampered figure and an old schema fail explicitly; unchanged evidence still reads", async (t) => {
	const w = await world(t);
	const { original } = await publish(w);
	forgetLocalCopy(w, original);
	const server = inProcess(w.clientEnv, t);
	const good = await hitFor(server, figureQuery, "Continuation with Figure 3-7");
	const other = await hitFor(server, sectionQuery, "A subsection starts halfway");
	const link = good.figures[0];
	assert.ok(link);

	// Text changed in Pinecone after publication: the manifest hash no longer matches.
	const record = w.fake.vectors.get(good.passageId);
	assert.ok(record);
	w.fake.vectors.set(good.passageId, {
		...record,
		metadata: { ...record.metadata, originalText: `${String(record.metadata.originalText)} injected` },
	});
	const stale = await server.tool("books_search", { query: figureQuery });
	assert.equal(stale.json.corpus, "incomplete");
	assert.ok(diagnosticCodes(stale.json).includes("stale_index"));
	assert.ok(!hits(stale.json).some((h) => h.passageId === good.passageId), "altered evidence is dropped");
	const refused = await server.tool("books_read", { passageId: good.passageId });
	assert.equal(refused.result.isError, true);
	assert.equal(refused.json.code, "identity_mismatch");
	const intact = await server.tool("books_read", { passageId: other.passageId });
	assert.equal(intact.json.status, "ok");
	assert.equal((intact.json.source as { sourceHash: string }).sourceHash, other.sourceHash);

	// A record written by an older schema is refused with a reindex hint-bearing identity error, not parsed.
	const old = w.fake.vectors.get(other.passageId);
	assert.ok(old);
	w.fake.vectors.set(other.passageId, { ...old, metadata: { ...old.metadata, schema: 1 } });
	const legacy = await server.tool("books_read", { passageId: other.passageId });
	assert.equal(legacy.result.isError, true);
	assert.match(String(legacy.json.code), /configuration|identity_mismatch/u);
	assert.ok(legacy.text.length < 1000);

	// Figure bytes altered in the bucket: the pinned hash fails the fetch and no image is delivered.
	for (const [key, item] of w.fake.storage) if (key.includes("figure_")) item.bytes = Buffer.from("tampered");
	const tampered = await server.tool("books_figure", { figureId: link.figureId });
	assert.equal(tampered.result.isError, true);
	assert.equal(tampered.result.content.length, 1);
	assert.match(String(tampered.json.code), /identity_mismatch|invalid_response/u);
	noSecrets(stale.text + refused.text + legacy.text + tampered.text);
});

test("a changed or missing original stops the writer explicitly; a missing one is fine", async (t) => {
	const w = await world(t);
	const bytes = structuralBytes();
	const { original } = await publish(w, "book.pdf", bytes);
	const server = inProcess(w.clientEnv, t);
	const before = await hitFor(server, sectionQuery, "A subsection starts halfway");
	const catalogBefore = [...w.fake.storage.entries()].find(([key]) => key.endsWith("catalog.json"))?.[1].hash;
	const upserts = w.fake.requests.filter((r) => r.includes("/vectors/upsert")).length;

	// The file was replaced by a different edition after ingestion: its hash no longer matches the version.
	const edited = pdfFixture({
		pages: [{ geometry: [900, 900], text: [{ text: "A different edition rewrote this page entirely.", y: 800 }] }],
	});
	writeFileSync(original, edited);
	const changed = await cli(w, ["index"]);
	assert.equal(changed.code, 1);
	assert.match(changed.err, /index failed: Original hash differs from the recorded version/u);
	assert.ok(changed.err.length < 500);
	// Ingesting the new file makes a distinct book with its own hash; the old version is never rewritten.
	const reingest = await cli(w, ["ingest", "--input", original]);
	assert.equal(reingest.code, 0, reingest.out + reingest.err);
	assert.equal(new CorpusStore({ directory: w.store }).listVersions().length, 2);

	assert.equal(
		w.fake.requests.filter((r) => r.includes("/vectors/upsert")).length,
		upserts,
		"the refused index uploaded nothing",
	);
	assert.equal([...w.fake.storage.entries()].find(([key]) => key.endsWith("catalog.json"))?.[1].hash, catalogBefore);
	const still = await server.tool("books_read", { passageId: before.passageId });
	assert.equal(still.json.status, "ok");
	assert.equal((still.json.source as { sourceHash: string }).sourceHash, sha256(bytes));

	// Originals are optional after ingestion: with the file gone, indexing publishes the stored evidence and a
	// reader then sees both books, each under its own recorded hash.
	rmSync(original);
	const published = await cli(w, ["index"]);
	assert.equal(published.code, 0, published.out + published.err);
	const hashes = ((await server.tool("books_list", {})).json.entries as { sourceHash: string }[]).map(
		(e) => e.sourceHash,
	);
	assert.deepEqual(hashes.sort(), [sha256(bytes), sha256(edited)].sort());
	noSecrets(changed.err + published.out);
});

test("incomplete corpus: extraction gaps, a pending writer claim and an interrupted index are reported, not mixed", async (t) => {
	const w = await world(t);
	// A page with no extractable text is an extraction gap, not silent absence.
	const gappy = pdfFixture({
		pages: [
			{ geometry: [900, 900], text: [{ text: "Readable gap coverage sentence about lanterns.", y: 800 }] },
			{ geometry: [900, 900] },
		],
	});
	const { original } = await publish(w, "gappy.pdf", gappy);
	forgetLocalCopy(w, original);
	const server = inProcess(w.clientEnv, t);
	const entries = (await server.tool("books_list", {})).json.entries as {
		extraction: { status: string; gapPdfPages: number[] };
	}[];
	assert.equal(entries[0]?.extraction.status, "incomplete");
	assert.deepEqual(entries[0]?.extraction.gapPdfPages, [2]);
	const gap = await server.tool("books_search", { query: "Readable gap coverage sentence about lanterns." });
	assert.equal(gap.json.status, "incomplete_corpus");
	assert.equal(gap.json.corpus, "incomplete");
	assert.ok(hits(gap.json).length >= 1, "readable pages still answer, with the gap named");
	assert.equal((gap.json.coverage as { gapPdfPages: number[] }[])[0]?.gapPdfPages[0], 2);
	assert.ok(diagnosticCodes(gap.json).includes("extraction_failed"));

	// A second writer claim that never committed makes the publication incomplete for every reader.
	const claimKey = [...w.fake.storage.keys()].find((key) => key.endsWith("writer.json"));
	assert.ok(claimKey);
	const claimBytes = Buffer.from(
		JSON.stringify({ schema: 1, writerId: "f".repeat(32), run: "f".repeat(32), base: null }),
	);
	w.fake.storage.set(claimKey, { bytes: claimBytes, hash: sha256(claimBytes).slice(7) });
	const pending = await server.tool("books_list", {});
	assert.equal(pending.json.status, "incomplete_publication");
	const partial = await server.tool("books_search", { query: "Readable gap coverage sentence about lanterns." });
	assert.equal(partial.json.corpus, "incomplete");
	assert.ok(diagnosticCodes(partial.json).includes("index_incomplete"));
});

test("an interrupted index resumes; a foreign writer claim stops the writer", async (t) => {
	const w = await world(t);
	const original = writeOriginal(w, "book.pdf", structuralBytes());
	assert.equal((await cli(w, ["ingest", "--input", original])).code, 0);
	w.fake.faults.upsertStatus = 500;
	const interrupted = await cli(w, ["index"]);
	assert.equal(interrupted.code, 1);
	assert.match(interrupted.err, /index failed: Service unavailable after bounded attempts/u);
	assert.ok(interrupted.err.length < 500);
	noSecrets(interrupted.err);
	const reader = inProcess(w.clientEnv, t);
	const during = await reader.tool("books_list", {});
	assert.equal(during.json.status, "no_catalog", "nothing was committed, so readers see no half-published corpus");
	const searched = await reader.tool("books_search", { query: sectionQuery });
	assert.notEqual(searched.json.status, "ok");
	assert.deepEqual(searched.json.hits, []);

	w.fake.faults.upsertStatus = null;
	const resumed = await cli(w, ["index"]);
	assert.equal(resumed.code, 0, resumed.err);
	const after = await reader.tool("books_search", { query: sectionQuery });
	assert.equal(after.json.status, "ok");
	assert.equal(after.json.corpus, "complete");

	// Another machine's claim: the writer refuses to take over and writes nothing new.
	const claimKey = [...w.fake.storage.keys()].find((key) => key.endsWith("writer.json"));
	assert.ok(claimKey);
	const foreign = Buffer.from(JSON.stringify({ schema: 1, writerId: "b".repeat(32), run: "a".repeat(32), base: null }));
	w.fake.storage.set(claimKey, { bytes: foreign, hash: sha256(foreign).slice(7) });
	const upserts = w.fake.requests.filter((r) => r.includes("/vectors/upsert")).length;
	const conflict = await cli(w, ["index"]);
	assert.equal(conflict.code, 1);
	assert.match(conflict.err, /Another writer owns the hosted library/u);
	assert.equal(w.fake.requests.filter((r) => r.includes("/vectors/upsert")).length, upserts);
	assert.deepEqual(w.fake.storage.get(claimKey)?.bytes, foreign, "the foreign claim is left untouched");
});

test("output budgets: bounded arguments, excerpts, reads, response size and image switch", async (t) => {
	const w = await world(t);
	const line = "Shared retrieval notes describe bounded citations in detail.";
	const pages = Array.from({ length: 8 }, (_, n) =>
		[...Array.from({ length: 15 }, () => line), `marker_${n}`].map((text, i) => ({ text, y: 800 - i * 50 })),
	);
	const long = pdfFixture({ pages: pages.map((text) => ({ geometry: [900, 900] as const, text })) });
	const { original } = await publish(w, "long.pdf", long);
	forgetLocalCopy(w, original);
	const server = inProcess(w.clientEnv, t);
	const question = Array.from({ length: 15 }, () => line).join(" ");
	const search = await server.tool("books_search", { query: `${question} marker_0` });
	assert.ok(search.text.length <= maxResponseCharacters);
	const found = hits(search.json);
	assert.ok(found.length >= 1 && found.length <= 5);
	for (const hit of found) {
		assert.ok(hit.excerpt.length <= 800);
		assert.ok(hit.versionId && hit.sourceHash && hit.locations.length > 0, "citation fields survive every trim");
	}
	const first = found[0];
	assert.ok(first);
	const pieces: string[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 40; guard++) {
		const page = await server.tool("books_read", {
			passageId: first.passageId,
			maxChars: 300,
			...(cursor ? { cursor } : {}),
		});
		assert.ok(page.text.length <= maxResponseCharacters);
		assert.ok(String(page.json.text).length <= 300);
		assert.equal((page.json.source as { sourceHash: string }).sourceHash, first.sourceHash);
		assert.ok((page.json.spans as unknown[]).length > 0);
		pieces.push(String(page.json.text));
		if (!page.json.truncated) break;
		cursor = page.json.nextCursor as string;
	}
	const whole = await server.tool("books_read", { passageId: first.passageId, maxChars: 8000 });
	assert.equal(pieces.join(""), whole.json.text, "continuation reassembles the passage exactly");
	assert.ok(pieces.length > 1, "the passage needed several bounded reads");
	assert.ok(String(whole.json.text).length > 800, "excerpts are prefixes of longer evidence");

	const before = w.fake.requests.length;
	for (const [tool, args] of [
		["books_search", { query: "x".repeat(1801) }],
		["books_search", { query: "ok", limit: 6 }],
		["books_read", { passageId: first.passageId, maxChars: 8001 }],
		["books_figure", { figureId: "../../secret.png" }],
		["books_list", { limit: 21 }],
	] as const) {
		const refused = await server.tool(tool, args);
		assert.equal(refused.result.isError, true);
		assert.equal(refused.json.code, "invalid_arguments");
	}
	assert.equal(w.fake.requests.length, before, "invalid arguments never reach a service");
	const unrelated = await server.tool("books_search", { query: unrelatedQuery });
	assert.equal(unrelated.json.status, "insufficient_evidence");
});

test("image delivery can be switched off for clients without image support; the caption stays", async (t) => {
	const w = await world(t);
	const { original } = await publish(w);
	forgetLocalCopy(w, original);
	const server = inProcess({ ...w.clientEnv, BOOKS_MCP_IMAGES: "off" }, t);
	const figureId = (await hitFor(server, figureQuery, "Continuation with Figure 3-7")).figures[0]?.figureId;
	assert.ok(figureId);
	const figure = await server.tool("books_figure", { figureId });
	assert.equal(figure.result.content.length, 1, "no image block");
	assert.match(String(figure.json.imageDelivery), /Image omitted/u);
	assert.match(String(figure.json.caption), /^Figure 3-7\./u);
	assert.equal(figure.json.location, "PDF page 3");
});

test("the env file may come from BOOKS_ENV_FILE, --env-file or ./.env, and an unreadable path is bounded", async (t) => {
	const w = await world(t);
	const fromVariable = await cli(w, ["doctor"]);
	assert.match(fromVariable.out, /books\.env syntax valid/u);
	const flagged = await cli({ ...w, clientEnv: { BOOKS_PINECONE_CONTROL_URL: w.fake.url } }, [
		"doctor",
		"--env-file",
		w.envFile,
	]);
	assert.match(flagged.out, /books\.env syntax valid/u);
	const bare = join(w.root, "cwd");
	mkdirSync(bare);
	writeFileSync(join(bare, ".env"), readFileSync(w.envFile));
	const implicit = await cli({ ...w, clientEnv: { BOOKS_PINECONE_CONTROL_URL: w.fake.url } }, ["doctor"], bare);
	assert.match(implicit.out, /\.env syntax valid/u);
	const missing = await cli({ ...w, clientEnv: {} }, ["doctor"], w.originals);
	assert.equal(missing.code, 1);
	assert.match(missing.out, /missing BOOKS_DATA_DIR/u);
	for (const result of [fromVariable, flagged, implicit, missing]) noSecrets(result.out + result.err);
});
