import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { chunkPreparedIngest } from "../src/chunks.ts";
import { discoverFigures, figureLimits, linkFigures, renderFigure, validateFigureAsset } from "../src/figures.ts";
import { ingestPdf, publishIngest } from "../src/ingest.ts";
import { sha256 } from "../src/locations.ts";
import { CorpusStore } from "../src/store.ts";
import { pdfFixture, subsectionPdf } from "./fixtures.ts";

async function fixture(
	run: (context: {
		document: Awaited<ReturnType<typeof ingestPdf>>;
		store: CorpusStore;
		input: string;
		directory: string;
	}) => Promise<void>,
	bytes = subsectionPdf(),
) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-figures-"));
	try {
		const input = join(root, "source.pdf");
		writeFileSync(input, bytes);
		const directory = join(root, "store");
		const store = new CorpusStore({ directory });
		const document = await ingestPdf({
			store,
			bookId: store.newBookId(),
			input,
			indexConfigurationHash: sha256("figures-test-1"),
		});
		await run({ document, store, input, directory });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
test("vector-drawn figure renders once with labeled whole-page fallback, verifiable dimensions and provenance", async () => {
	await fixture(async ({ document, store }) => {
		const figure = discoverFigures(document, store)[0];
		assert.ok(figure);
		const asset = await renderFigure(document.source, figure);
		assert.equal(asset.figureId, figure.id);
		assert.equal(asset.sourceHash, document.source.sourceHash);
		assert.equal(asset.framing.kind, "full-page-fallback");
		assert.match(asset.notice, /legibility not assessed/);
		assert.ok(asset.width <= 1600 && asset.height <= 1600);
		assert.ok(asset.base64.length <= figureLimits.base64Bytes);
		const image = await loadImage(Buffer.from(asset.base64, "base64"));
		assert.equal(image.width, asset.width);
		assert.equal(image.height, asset.height);
		assert.throws(() => validateFigureAsset({ ...asset, width: 1 }, document.source, [figure]), {
			code: "unsupported_asset",
		});
		const canvas = createCanvas(image.width, image.height);
		const ctx = canvas.getContext("2d");
		ctx.drawImage(image, 0, 0);
		// The synthetic blue vector rectangle at PDF x=20..80,y=20..50 survives rendering.
		const scale = image.width / 400;
		const pixels = ctx.getImageData(Math.round(20 * scale), Math.round(565 * scale), 2, 2).data;
		assert.ok(
			[...pixels].some((n, index) => index % 4 === 0 && n < 200),
			"vector stroke is not blank white",
		);
		assert.throws(
			() =>
				validateFigureAsset({ ...asset, base64: "a".repeat(figureLimits.base64Bytes + 4) }, document.source, [figure]),
			/bounds|encoding/,
		);
		assert.throws(
			() => validateFigureAsset({ ...asset, sourceHash: sha256("wrong") }, document.source, [figure]),
			/identity/,
		);
	});
});
test("verified crop and large-page downsampling are explicit and bounded", async () => {
	await fixture(
		async ({ document, store }) => {
			const figure = discoverFigures(document, store)[0];
			assert.ok(figure);
			const full = await renderFigure(document.source, figure);
			assert.equal(Math.max(full.width, full.height), 1600);
			assert.equal(full.reducedResolution, true);
			const crop = await renderFigure(document.source, {
				...figure,
				rendering: { kind: "crop", bounds: [10, 5940, 100, 5990] },
			});
			assert.equal(crop.framing.kind, "crop");
			assert.equal(crop.width, 180);
			assert.equal(crop.height, 100);
			const decoded = await loadImage(Buffer.from(crop.base64, "base64"));
			const canvas = createCanvas(decoded.width, decoded.height);
			const ctx = canvas.getContext("2d");
			ctx.drawImage(decoded, 0, 0);
			assert.ok(
				[...ctx.getImageData(0, 0, decoded.width, decoded.height).data].some((n, i) => i % 4 === 0 && n < 200),
				"verified crop retains the vector diagram",
			);
		},
		pdfFixture({ pages: [{ geometry: [4000, 6000], text: [{ text: "Figure 1-1. Large vector page", y: 100 }] }] }),
	);
});
test("oversized PNG uses bounded JPEG fallback, labeling loss of resolution/legibility", async () => {
	await fixture(
		async ({ document, store }) => {
			const figure = discoverFigures(document, store)[0];
			assert.ok(figure);
			const asset = await renderFigure(document.source, figure);
			assert.equal(asset.mimeType, "image/jpeg");
			assert.equal(asset.reducedResolution, true);
			assert.ok(asset.base64.length <= figureLimits.base64Bytes);
			assert.match(asset.notice, /lossy image/);
			const image = await loadImage(Buffer.from(asset.base64, "base64"));
			assert.equal(image.width, asset.width);
			assert.equal(image.height, asset.height);
		},
		pdfFixture({
			pages: [{ geometry: [1600, 1600], noisyImage: true, text: [{ text: "Figure 1-1. Noise raster", y: 100 }] }],
		}),
	);
});

test("explicit label crosses pages; proximity and duplicate captions do not establish certainty", async () => {
	await fixture(async ({ document, store }) => {
		const figures = discoverFigures(document, store);
		const figure = figures[0];
		assert.ok(figure);
		const passages = chunkPreparedIngest(document, store, figures);
		const reference = passages.find((p) => p.originalText.includes("See Figure"));
		assert.ok(reference);
		assert.equal(reference.figures[0]?.evidence.kind, "explicit-reference");
		assert.deepEqual(
			linkFigures(reference, [figure, { ...figure, id: store.recordId("figure", document.source, "duplicate") }]),
			[],
		);
		assert.deepEqual(linkFigures({ ...reference, originalText: "A diagram is nearby." }, figures), []);
		assert.deepEqual(linkFigures(reference, []), []);
		assert.throws(() => store.readFigureAsset(document.source, figure.id), /Source version/);
	});
});
test("rendering detects original mutation/missing data and unsupported assets", async () => {
	await fixture(async ({ document, store, input }) => {
		const figure = discoverFigures(document, store)[0];
		assert.ok(figure);
		writeFileSync(input, pdfFixture({ pages: [{ text: [{ text: "changed", y: 100 }] }] }));
		await assert.rejects(renderFigure(document.source, figure), { code: "source_changed" });
		rmSync(input);
		await assert.rejects(renderFigure(document.source, figure), { code: "source_missing" });
	});
	await fixture(
		async ({ document, store }) => {
			const figure = discoverFigures(document, store)[0];
			assert.ok(figure);
			await assert.rejects(renderFigure(document.source, figure), {
				code: "unsupported_asset",
				message: /Figure could not be rendered safely:.*\(no_render_operators\)/,
			});
			await publishIngest(document, store);
			assert.equal(store.listVersions().length, 1);
			assert.equal(store.listFigures(document.source)[0]?.unavailable?.reason, "no_render_operators");
			assert.equal(store.readFigureAssets(document.source).length, 0);
		},
		pdfFixture({ pages: [{ text: [{ text: "Figure 1-1. Unsafe image", y: 100 }], oversizedImage: true }] }),
	);
});
test("atomic publication is idempotent; stored read/figure survive restart and deletion, never mutation", async (t) => {
	await fixture(async ({ document, store, input, directory }) => {
		assert.equal(store.listVersions().length, 0);
		assert.equal((await publishIngest(document, store)).imported, true);
		const bulk = t.mock.method(store, "readFigureAssets");
		assert.equal((await publishIngest(document, store)).imported, false);
		assert.equal(bulk.mock.callCount(), 1, "re-ingestion validates persisted images once per book");
		const fresh = new CorpusStore({ directory });
		const passage = fresh.listPassages(document.source).find((p) => p.figures.length);
		assert.ok(passage);
		const id = passage.figures[0]?.figureId;
		assert.ok(id);
		const before = fresh.readFigureAsset(document.source, id);
		writeFileSync(input, "changed");
		assert.throws(() => fresh.readPassage(document.source, passage.id), { code: "source_changed" });
		assert.throws(() => fresh.readFigureAsset(document.source, id), { code: "source_changed" });
		assert.throws(() => fresh.readFigureAssets(document.source), { code: "source_changed" });
		rmSync(input);
		const restarted = new CorpusStore({ directory });
		assert.deepEqual(restarted.readPassage(document.source, passage.id), passage);
		assert.deepEqual(restarted.readFigureAsset(document.source, id), before);
		assert.deepEqual(
			restarted.readFigureAssets(document.source).find((a) => a.figureId === id),
			before,
		);
		assert.ok(passage.mappings.length);
		assert.ok(passage.spans.length);
		assert.ok(passage.headingPath.length);
	});
});
test("source mutation between extraction/import and immediately before publication leaves database unchanged", async () => {
	await fixture(async ({ document, store, input, directory }) => {
		const old = readFileSync(store.databasePath);
		writeFileSync(input, "mutation after extraction");
		await assert.rejects(publishIngest(document, store), { code: "source_changed" });
		assert.deepEqual(readFileSync(store.databasePath), old);
		writeFileSync(input, subsectionPdf());
		const fault = new CorpusStore({
			directory,
			beforePublish: () => {
				writeFileSync(input, "mutation at rename");
			},
		});
		await assert.rejects(publishIngest(document, fault), { code: "source_changed" });
		assert.deepEqual(readFileSync(store.databasePath), old);
		assert.equal(store.listVersions().length, 0);
	});
});
