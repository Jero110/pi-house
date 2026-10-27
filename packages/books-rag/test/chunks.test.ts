import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chunkPreparedIngest, embeddingInputBound, passageEmbeddingInput } from "../src/chunks.ts";
import { discoverFigures } from "../src/figures.ts";
import { ingestPdf } from "../src/ingest.ts";
import { sha256 } from "../src/locations.ts";
import { CorpusStore } from "../src/store.ts";
import { pdfFixture, structuralPdf, subsectionPdf } from "./fixtures.ts";

async function prepared(
	bytes: Uint8Array,
	run: (document: Awaited<ReturnType<typeof ingestPdf>>, store: CorpusStore) => void,
) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-chunks-"));
	try {
		const input = join(root, "source.pdf");
		writeFileSync(input, bytes);
		const store = new CorpusStore({ directory: join(root, "store") });
		const document = await ingestPdf({
			store,
			bookId: store.newBookId(),
			input,
			indexConfigurationHash: sha256("chunks-test-1"),
		});
		run(document, store);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
test("subsection spans physical pages without crossing the next heading; next-page figure uses identity", async () => {
	await prepared(subsectionPdf(), (document, store) => {
		const figures = discoverFigures(document, store);
		const chunks = chunkPreparedIngest(document, store, figures);
		const semantic = chunks.filter((p) => p.headingPath.at(-1)?.title === "Semantic chunking");
		assert.equal(semantic.length, 1);
		const passage = semantic[0];
		assert.ok(passage);
		assert.deepEqual([...new Set(passage.spans.map((s) => s.location.pageNumber))], [1, 2]);
		assert.match(passage.originalText, /A coherent subsection/);
		assert.doesNotMatch(passage.originalText, /Semantic chunking|Handling images|Different topic/);
		const reference = chunks.find((p) => p.originalText.includes("See Figure 3-7"));
		assert.ok(reference);
		assert.equal(reference.figures.length, 1);
		assert.equal(figures.find((f) => f.id === reference.figures[0]?.figureId)?.location.pageNumber, 4);
		assert.equal(reference.figures[0]?.evidence.location.pageNumber, 3);
		for (const p of chunks) {
			assert.ok(embeddingInputBound(passageEmbeddingInput(p)) <= 2048);
			assert.equal(p.originalText.length, p.spans.at(-1)?.originalRange.end);
			assert.equal(p.normalizedText.length, p.mappings.at(-1)?.normalizedRange.end);
		}
		assert.deepEqual(chunkPreparedIngest(document, store, figures), chunks);
	});
});
test("code across pages remains literal, isolated from prose; tables keep rows and units", async () => {
	await prepared(structuralPdf(), (document, store) => {
		const chunks = chunkPreparedIngest(document, store);
		const code = chunks.find((p) => p.originalText.includes("embedding_ vectors"));
		assert.ok(code);
		assert.equal(
			code.originalText,
			document.blocks
				.filter((b) => b.kind === "code")
				.map((b) => b.originalText)
				.join("\n"),
		);
		assert.deepEqual([...new Set(code.spans.map((s) => s.location.pageNumber))], [1, 2]);
		assert.ok(code.quality.some((q) => q.code === "uncertain_code"));
		const table = chunks.find((p) => p.originalText.includes("Length (ms)"));
		assert.ok(table);
		assert.match(table.originalText, /Value \(MB\)/);
		assert.match(table.originalText, /10\s+20/);
		assert.ok(table.quality.some((q) => q.code === "uncertain_table"));
	});
});
test("oversized blocks continue explicitly, retain all scalars, and fit alternate bounds", async () => {
	await prepared(
		pdfFixture({
			pages: [
				{
					geometry: [20000, 600],
					text: [
						{ text: "Code", y: 560, size: 18 },
						{ text: "value_ ".repeat(180), y: 500, font: "Courier" },
					],
				},
			],
		}),
		(document, store) => {
			const chunks = chunkPreparedIngest(document, store, [], { targetBound: 256 });
			assert.ok(chunks.length > 2);
			assert.equal(
				chunks.map((p) => p.originalText).join(""),
				document.blocks
					.filter((b) => b.kind === "code")
					.map((b) => b.originalText)
					.join(""),
			);
			for (const p of chunks) {
				assert.ok(embeddingInputBound(passageEmbeddingInput(p)) <= 256);
				assert.ok(p.quality.some((q) => q.message.includes("continuation")));
			}
			assert.throws(() => chunkPreparedIngest(document, store, [], { targetBound: 2049 }), /bound/);
		},
	);
});
test("oversized tables share explicit unverified header context without inserting it into quotes", async () => {
	await prepared(
		pdfFixture({
			pages: [
				{
					geometry: [400, 2000],
					text: [
						{ text: "Measurements", y: 1950, size: 18 },
						{ text: "Length (ms)", x: 30, y: 1900 },
						{ text: "Value (MB)", x: 210, y: 1900 },
						...Array.from({ length: 40 }, (_, i) => [
							{ text: `row_${i}`, x: 30, y: 1850 - i * 20 },
							{ text: `value_${i}`, x: 210, y: 1850 - i * 20 },
						]).flat(),
					],
				},
			],
		}),
		(document, store) => {
			const chunks = chunkPreparedIngest(document, store, [], { targetBound: 256 });
			assert.ok(chunks.length > 2);
			for (const [index, p] of chunks.entries()) {
				assert.equal(p.structure.part, index + 1);
				assert.equal(p.structure.totalParts, chunks.length);
				assert.match(p.structure.sharedHeader?.text ?? "", /Length \(ms\).*Value \(MB\)/);
				assert.ok(embeddingInputBound(passageEmbeddingInput(p)) <= 256);
				if (index) assert.doesNotMatch(p.originalText, /Length \(ms\)/);
				for (const slice of p.structure.sourceSlices) {
					const block = document.blocks.find((b) => b.id === slice.blockId);
					assert.ok(block);
					assert.ok(
						p.originalText.includes(block.originalText.slice(slice.originalRange.start, slice.originalRange.end)),
					);
				}
			}
		},
	);
});

test("bound includes prefix, heading, NFD/lowercase expansion and rejects malformed Unicode", () => {
	const text = "search_document: École İ\n\n中文 ﬀ";
	assert.equal(
		embeddingInputBound(text),
		Math.max(Buffer.byteLength(text), Buffer.byteLength(text.normalize("NFD").toLowerCase())) + 32,
	);
	assert.throws(() => embeddingInputBound("\ud800"), /surrogates/);
	assert.ok(passageEmbeddingInput({ headingPath: [], normalizedText: "quote" }).startsWith("search_document: "));
});
