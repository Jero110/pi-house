import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertPdfLocation } from "../src/contracts.ts";
import { ingestPdf } from "../src/ingest.ts";
import { CorpusError, sha256 } from "../src/locations.ts";
import { extractPdf } from "../src/pdf.ts";
import { CorpusStore } from "../src/store.ts";
import { pdfFixture, structuralPdf } from "./fixtures.ts";

function local(t: { after: (fn: () => void) => void }, bytes = structuralPdf()) {
	const directory = mkdtempSync(join(realpathSync(tmpdir()), "books-extraction-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const input = join(directory, "synthetic.pdf");
	writeFileSync(input, bytes, { mode: 0o600 });
	const store = new CorpusStore({ directory: join(directory, "store") });
	return {
		directory,
		input,
		store,
		bookId: store.newBookId(),
		indexConfigurationHash: sha256("synthetic-chunk-config"),
	};
}
function code(expected: CorpusError["code"]) {
	return (error: unknown) => error instanceof CorpusError && error.code === expected;
}

test("ingest prepares immutable, unpublished structural spans across mid-page and cross-page boundaries", async (t) => {
	const options = local(t);
	const prepared = await ingestPdf(options);
	assert.equal(prepared.state, "prepared-unpublished");
	assert.deepEqual(options.store.listVersions(), []);
	assert.equal(prepared.source.sourceHash, sha256(structuralPdf()));
	assert.equal(prepared.source.coverage.status, "complete");
	assert.deepEqual(
		prepared.extraction.headings.map((h) => [h.title, h.evidence]),
		[
			["Introduction", "validated-outline"],
			["Semantic chunking", "validated-outline"],
			["Handling images", "validated-outline"],
		],
	);
	const semantic = prepared.sections.find((section) => section.heading?.title === "Semantic chunking");
	assert.ok(semantic?.heading);
	assert.equal(semantic.heading.location.pageNumber, 1);
	assert.ok((semantic.heading.location.bounds?.[1] ?? 0) > 200);
	const blocks = prepared.blocks.slice(semantic.blockRange.start, semantic.blockRange.end);
	assert.deepEqual([...new Set(blocks.map((b) => b.location.pageNumber))], [1, 2]);
	assert.ok(blocks.some((b) => b.originalText.includes("Continuation with Figure 3-7")));
	assert.ok(!blocks.some((b) => b.originalText.includes("Handling images")));
	assert.ok(
		prepared.blocks.some(
			(b) => b.originalText.includes("Figure 3-7. Synthetic vector diagram") && b.location.pageNumber === 3,
		),
	);
	for (const block of prepared.blocks) {
		assertPdfLocation(block.location, 3);
		assert.equal(block.location.printedLabel, null);
		assert.equal(block.span.blockId, block.id);
		assert.deepEqual(block.span.originalRange, { start: 0, end: block.originalText.length });
		assert.ok(Object.isFrozen(block.items));
		assert.ok(Object.isFrozen(block.span.location));
		let offset = 0;
		for (const mapping of block.mappings) {
			assert.equal(mapping.originalRange.start, offset);
			offset = mapping.originalRange.end;
		}
		assert.equal(offset, block.originalText.length);
	}
	assert.equal(Reflect.set(prepared.source, "sourceHash", sha256("changed")), false);
	const again = await ingestPdf(options);
	assert.equal(again.source.versionId, prepared.source.versionId);
	const changed = await ingestPdf({ ...options, limits: { itemsPerPage: 1000 } });
	assert.notEqual(changed.source.versionId, prepared.source.versionId);
});

test("two-page fragmented code is never guessed; table cells, units and coordinates survive with fallback", async () => {
	const extraction = await extractPdf(structuralPdf());
	const codeBlocks = extraction.blocks.filter((b) => b.kind === "code");
	assert.deepEqual([...new Set(codeBlocks.map((b) => b.location.pageNumber))], [1, 2]);
	assert.ok(codeBlocks.some((b) => b.originalText === "embedding_ vectors = ["));
	assert.ok(!codeBlocks.some((b) => b.originalText.includes("embedding_vectors")));
	assert.ok(codeBlocks.some((b) => b.originalText.includes("second_value]")));
	for (const block of codeBlocks) {
		assert.equal(block.normalizedText, block.originalText);
		assert.equal(block.renderingFallback, "full-page");
		assert.ok(block.diagnostics.some((d) => d.code === "uncertain_code"));
	}
	const tables = extraction.blocks.filter((b) => b.kind === "table");
	assert.equal(tables.length, 2);
	assert.deepEqual(
		tables[0]?.items.filter((i) => i.text.trim()).map((i) => i.text),
		["Length (ms)", "Value (MB)"],
	);
	assert.deepEqual(
		tables[1]?.items.filter((i) => i.text.trim()).map((i) => i.text),
		["10", "20"],
	);
	assert.ok((tables[0]?.items.at(-1)?.location.bounds?.[0] ?? 0) > 200);
	assert.ok(
		tables.every((b) => b.renderingFallback === "full-page" && b.diagnostics.some((d) => d.code === "uncertain_table")),
	);
});

test("normalization is a separate mapped representation, never a rewrite of source items", async () => {
	const result = await extractPdf(pdfFixture({ pages: [{ text: [{ text: "µ units", y: 400 }] }] }));
	const block = result.blocks[0];
	assert.ok(block);
	assert.equal(block.originalText, "µ units");
	assert.equal(block.normalizedText, "μ units");
	assert.equal(block.items[0]?.text, "µ units");
	assert.deepEqual(block.mappings[0], {
		originalRange: { start: 0, end: 1 },
		normalizedRange: { start: 0, end: 1 },
		kind: "normalized",
	});
});

test("metadata preserves verified title-page conflicts and explicit overrides; unknowns stay null", async (t) => {
	const options = local(t);
	const extracted = await extractPdf(structuralPdf());
	const authorsLocation = extracted.blocks.find((b) => b.originalText === "First Author; Second Author")?.location;
	assert.ok(authorsLocation);
	const evidence = {
		origin: "title-page" as const,
		value: ["First Author", "Second Author"],
		location: authorsLocation,
	};
	const prepared = await ingestPdf({ ...options, metadataEvidence: { authors: [evidence] } });
	assert.equal(prepared.source.metadata.authors.resolution, "conflict");
	assert.equal(prepared.source.metadata.authors.value, null);
	assert.deepEqual(
		prepared.source.metadata.authors.evidence.map((e) => e.value),
		[["First Author"], ["First Author", "Second Author"]],
	);
	assert.equal(prepared.source.metadata.edition.value, null);
	assert.equal(prepared.source.metadata.publisher.resolution, "unknown");
	const override = await ingestPdf({
		...options,
		metadataEvidence: { authors: [evidence, { ...evidence, origin: "operator-override" }] },
	});
	assert.equal(override.source.metadata.authors.resolution, "override");
	assert.equal(override.source.metadata.authors.evidence.length, 3);
	assert.notEqual(override.source.versionId, prepared.source.versionId);
	await assert.rejects(
		ingestPdf({ ...options, metadataEvidence: { authors: [{ ...evidence, location: null }] } }),
		code("identity_mismatch"),
	);
});

test("image-only pages are gaps; text beside raster figures retains quality diagnostics without gaps", async (t) => {
	const options = local(
		t,
		pdfFixture({ pages: [{ image: true }, { image: true, text: [{ text: "Text beside a raster", y: 400 }] }] }),
	);
	const prepared = await ingestPdf(options);
	assert.equal(prepared.source.coverage.status, "incomplete");
	assert.deepEqual(prepared.source.coverage.extractedPages, [2]);
	assert.deepEqual(
		prepared.source.coverage.gaps.map((g) => g.pageNumber),
		[1],
	);
	assert.ok(prepared.source.diagnostics.some((d) => d.code === "scanned_page" && d.location?.pageNumber === 1));
	assert.ok(
		prepared.source.diagnostics.some(
			(d) => d.code === "unsupported_asset" && d.pageRanges?.some(([start, end]) => start <= 2 && end >= 2),
		),
	);
	assert.deepEqual(options.store.listVersions(), []);
});

test("700 text/raster pages aggregate quality notes without gaps or budget failure", async () => {
	const result = await extractPdf(
		pdfFixture({
			pages: Array.from({ length: 700 }, () => ({
				image: true,
				text: [{ text: "Synthetic text beside image", y: 400 }],
			})),
		}),
	);
	assert.equal(result.pages, 700);
	assert.equal(result.gaps.length, 0);
	const raster = result.diagnostics.find((d) => d.code === "unsupported_asset");
	assert.equal(raster?.occurrences, 700);
	assert.deepEqual(raster?.pageRanges, [[1, 700]]);
	assert.ok(Buffer.byteLength(JSON.stringify(result.diagnostics)) < 4096);
});

test("unmatched or misplaced outlines remain uncertain, not authoritative section boundaries", async () => {
	const result = await extractPdf(
		pdfFixture({
			pages: [{ text: [{ text: "Real heading", y: 300, size: 18 }] }],
			outlines: [
				{ title: "Real heading", page: 1, y: 550 },
				{ title: "Invented heading", page: 1, y: 300 },
			],
		}),
	);
	assert.equal(result.headings[0]?.evidence, "layout-candidate");
	assert.ok(!result.headings.some((h) => h.title === "Invented heading"));
	assert.equal(result.diagnostics.find((d) => d.message.includes("not validated"))?.occurrences, 2);
	assert.equal(result.gaps.length, 0);
	assert.ok(result.diagnostics.every((d) => d.location === null));
});

test("ignored external links are document diagnostics, not whole-document text gaps", async () => {
	const bytes = pdfFixture({
		pages: [{ text: [{ text: "Linked text", y: 400 }] }, { text: [{ text: "More text", y: 400 }] }],
		navigation: true,
	});
	const result = await extractPdf(bytes);
	assert.equal(result.gaps.length, 0);
	assert.ok(result.diagnostics.some((d) => d.code === "unsupported_asset" && d.location === null));
});

test("literal asset names do not establish whole-document unsafety", async () => {
	const result = await extractPdf(
		pdfFixture({
			pages: [{ text: [{ text: "/JS /EmbeddedFile /RichMedia /Launch /XFA", y: 400 }] }],
		}),
	);
	assert.equal(result.gaps.length, 0);
	assert.ok(result.diagnostics.some((d) => d.code === "unsupported_asset" && d.location === null));
});

test("active/external content and attachments are not executed, fetched or ingested", async (t) => {
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		response.end("never follow PDF URLs");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const result = await extractPdf(
		pdfFixture({
			pages: [{ text: [{ text: "Safe literal text", y: 400 }] }],
			unsafe: true,
			externalUrl: `http://127.0.0.1:${address.port}/do-not-fetch`,
		}),
	);
	assert.equal(requests, 0);
	assert.deepEqual(
		result.blocks.map((b) => b.originalText),
		["Safe literal text"],
	);
	assert.ok(result.diagnostics.some((d) => d.code === "unsupported_asset" && d.message.includes("ignored")));
	assert.equal(result.gaps.length, 1);
	assert.ok(!JSON.stringify(result).includes("127.0.0.1"));
	assert.ok(!JSON.stringify(result).includes("MUST NOT RUN"));
});

test("oversized image assets produce rendering diagnostics without discarding extracted text", async () => {
	const result = await extractPdf(
		pdfFixture({ pages: [{ oversizedImage: true, text: [{ text: "Remaining text", y: 400 }] }] }),
	);
	assert.ok(result.blocks.some((b) => b.originalText === "Remaining text"));
	assert.ok(result.diagnostics.some((d) => d.code === "extraction_failed" || d.code === "unsupported_asset"));
	assert.equal(result.gaps.length, 0);
});

test("malformed, encrypted and unsupported inputs fail explicitly with no parser output", async () => {
	await assert.rejects(extractPdf(Buffer.from("%PDF-1.7\nnot a document")), code("malformed_pdf"));
	await assert.rejects(extractPdf(pdfFixture({ pages: [{}], encrypted: true })), code("encrypted_pdf"));
	for (const text of ["PK\u0003\u0004unsupported EPUB", "<html>not PDF</html>", "%PDF-2.x", "%PDF-9.9"]) {
		await assert.rejects(extractPdf(Buffer.from(text)), code("unsupported_format"));
	}
});

test("unsafe paths/symlinks, format mismatches and input/resource budgets fail closed", async (t) => {
	const options = local(t);
	await assert.rejects(
		ingestPdf({ ...options, input: join(options.directory, "missing.pdf") }),
		code("source_missing"),
	);
	const link = join(options.directory, "link.pdf");
	symlinkSync(options.input, link);
	await assert.rejects(ingestPdf({ ...options, input: link }), code("unsafe_path"));
	await assert.rejects(ingestPdf({ ...options, input: `${options.directory}/../synthetic.pdf` }), code("unsafe_path"));
	const epub = join(options.directory, "book.epub");
	writeFileSync(epub, structuralPdf());
	await assert.rejects(ingestPdf({ ...options, input: epub }), code("unsupported_format"));
	writeFileSync(options.input, "PK unsupported PDF masquerade");
	await assert.rejects(ingestPdf(options), code("unsupported_format"));
	await assert.rejects(extractPdf(structuralPdf(), { inputBytes: 10 }), code("resource_limit"));
	await assert.rejects(extractPdf(structuralPdf(), { pages: 1 }), code("resource_limit"));
	await assert.rejects(extractPdf(structuralPdf(), { textBytesPerPage: 10 }), code("resource_limit"));
	await assert.rejects(extractPdf(structuralPdf(), { itemsPerPage: 1 }), code("resource_limit"));
	await assert.rejects(extractPdf(structuralPdf(), { outlineEntries: 1 }), code("resource_limit"));
	await assert.rejects(extractPdf(structuralPdf(), { pageMilliseconds: 1 }), code("resource_limit"));
	await assert.rejects(extractPdf(structuralPdf(), { pages: NaN }), code("resource_limit"));
	await assert.rejects(extractPdf(structuralPdf(), { pages: 2001 }), code("resource_limit"));
	await assert.rejects(extractPdf(pdfFixture({ pages: [{ geometry: [200000, 600] }] })), code("resource_limit"));
	assert.equal((await extractPdf(pdfFixture({ pages: [{}] }), { diagnostics: 1 })).diagnostics.length, 1);
	const capped = await extractPdf(pdfFixture({ pages: [{ image: true }] }), { diagnostics: 1 });
	assert.equal(capped.diagnostics.length, 1);
	assert.match(capped.diagnostics[0]?.message ?? "", /Diagnostics truncated:.*code scanned_page/);
	assert.deepEqual(capped.gaps, [{ pageNumber: 1, reason: "scanned_page" }]);
});
