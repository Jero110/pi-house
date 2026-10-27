import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CorpusError, readLocalPdf } from "../src/locations.ts";

// Operator-only, local bytes/assets, no corpus writes or service adapters. Print
// locations/counts/labels only; never passages, metadata authors or table cells.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--input" || args[2] !== "--pages" || !/^\d+-\d+$/u.test(args[3] ?? "")) {
	throw new Error("Usage: node packages/books-rag/dev/inspect-pdf.ts --input <absolute.pdf> --pages <start-end>");
}
const [start = 0, end = 0] = (args[3] ?? "").split("-").map(Number);
if (start < 1 || end < start || end - start > 20) throw new Error("Invalid inspection page range");
try {
	const bytes = readLocalPdf(args[1] ?? "", 128 * 1024 * 1024);
	const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
	const assets = (name: string) => join(root, name) + sep;
	let decoderDiagnostics = 0;
	const output = console.log.bind(console);
	const old = { log: console.log, warn: console.warn, error: console.error };
	console.log =
		console.warn =
		console.error =
			() => {
				decoderDiagnostics++;
			};
	const task = getDocument({
		data: new Uint8Array(bytes),
		useSystemFonts: false,
		useWorkerFetch: false,
		cMapUrl: assets("cmaps"),
		cMapPacked: true,
		standardFontDataUrl: assets("standard_fonts"),
		wasmUrl: assets("wasm"),
		disableFontFace: true,
		stopAtErrors: true,
		maxImageSize: 16000000,
		isOffscreenCanvasSupported: false,
		isImageDecoderSupported: false,
	});
	try {
		const doc = await task.promise;
		if (doc.numPages > 2000 || end > doc.numPages) throw new Error("PDF page budget/range exceeded");
		const outline = await doc.getOutline();
		const count = (items: NonNullable<typeof outline>): number =>
			items.reduce((n, item) => n + 1 + count(item.items), 0);
		output(
			JSON.stringify({
				pages: doc.numPages,
				expected694: doc.numPages === 694,
				outlineTopLevel: outline?.length ?? 0,
				outlineTotal: count(outline ?? []),
			}),
		);
		let firstTable: number | null = null;
		for (let number = 1; number <= doc.numPages; number++) {
			const page = await doc.getPage(number);
			try {
				const content = await page.getTextContent({ disableNormalization: true });
				const items = content.items.filter((i) => "str" in i);
				const labels = [...new Set(items.flatMap((i) => i.str.match(/\b(?:Figure|Table)\s+\d+(?:[-.]\d+)+/gu) ?? []))];
				const tableCaption = items.some((i) => /^Table\s+\d+[-.]\d+\./u.test(i.str.trim()));
				if (tableCaption && firstTable === null && number > 30) firstTable = number;
				if (
					(number >= start && number <= end) ||
					(firstTable !== null && number >= firstTable && number <= firstTable + 1)
				) {
					const headings = items
						.filter((i) => i.height >= 16 && i.str.trim().length > 0 && i.str.length < 100)
						.map((i) => i.str);
					for (const title of ["Semantic chunking", "Handling images and videos"]) {
						if (items.some((i) => i.str.trim().toLowerCase() === title.toLowerCase())) headings.push(title);
					}
					const captionLabels = items.flatMap((i) => /^\s*(Figure\s+\d+(?:[-.]\d+)+)[.:]/u.exec(i.str)?.[1] ?? []);
					const code = items.some((i) => /mono|courier/iu.test(content.styles[i.fontName]?.fontFamily ?? ""));
					let tableRows = 0;
					for (let i = 1; i < items.length; i++) {
						const a = items[i - 1],
							b = items[i];
						if (
							a &&
							b &&
							Math.abs((a.transform[5] ?? 0) - (b.transform[5] ?? 0)) < 3 &&
							(b.transform[4] ?? 0) - (a.transform[4] ?? 0) - a.width > 8
						)
							tableRows++;
					}
					output(
						JSON.stringify({
							page: number,
							textItems: items.length,
							headings,
							labels,
							captionLabels,
							codeLikeFont: code,
							tableCaption,
							candidateTableRows: tableRows,
							scanned: !items.some((i) => i.str.trim()),
						}),
					);
				}
				if ((number >= start && number <= end && (number === 172 || number === 174)) || number === firstTable) {
					try {
						const base = page.getViewport({ scale: 1 });
						if (![base.width, base.height].every((n) => Number.isFinite(n) && n > 0 && n <= 100000))
							throw new Error("Geometry budget");
						const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(base.width, base.height)) });
						const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
						await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport, background: "white" })
							.promise;
						const encoded = canvas.toBuffer("image/png");
						output(
							JSON.stringify({
								renderPage: number,
								framing: "full-page-fallback",
								width: canvas.width,
								height: canvas.height,
								pngBytes: encoded.length,
								base64Within2MiB: encoded.toString("base64").length <= 2 * 1024 * 1024,
								persisted: false,
								legibility: "not assessed",
							}),
						);
					} catch {
						output(JSON.stringify({ renderPage: number, status: "unavailable", framing: "full-page-fallback" }));
					}
				}
			} finally {
				page.cleanup();
			}
		}
		output(
			JSON.stringify({
				firstTableCaptionPage: firstTable,
				tableFidelity: "unverified; coordinates only, no reconstructed cells",
				decoderDiagnostics,
			}),
		);
	} finally {
		await task.destroy();
		Object.assign(console, old);
	}
} catch (error) {
	if (error instanceof CorpusError && error.code === "source_missing") {
		console.log("UNAVAILABLE: supplied local PDF missing; operator extraction check not run");
		process.exitCode = 2;
	} else throw error;
}
