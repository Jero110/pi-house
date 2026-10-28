import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { getDocument, OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, TextItem } from "pdfjs-dist/types/src/display/api.d.ts";
import type { Diagnostic, ErrorCode, PdfLocation, TextMapping } from "./contracts.ts";
import { DiagnosticCollector } from "./diagnostics.ts";
import { CorpusError, sha256 } from "./locations.ts";

export const pdfLimits = Object.freeze({
	inputBytes: 128 * 1024 * 1024,
	pages: 2000,
	textBytesPerPage: 4 * 1024 * 1024,
	itemsPerPage: 100000,
	outlineEntries: 10000,
	// Aggregate repeats; reserve a slot for explicit per-code truncation counts.
	diagnostics: 500,
	pageMilliseconds: 30000,
	importMilliseconds: 30 * 60 * 1000,
});
export type PdfLimits = { readonly [Key in keyof typeof pdfLimits]: number };
export interface PdfTextItem {
	readonly text: string;
	readonly transform: readonly number[];
	readonly width: number;
	readonly height: number;
	readonly fontName: string;
	readonly fontFamily: string | null;
	readonly direction: string;
	readonly hasEOL: boolean;
	readonly location: PdfLocation;
}
export interface PdfBlock {
	readonly key: string;
	readonly kind: "heading" | "text" | "code" | "table";
	readonly originalText: string;
	readonly normalizedText: string;
	readonly mappings: readonly TextMapping[];
	readonly items: readonly PdfTextItem[];
	readonly location: PdfLocation;
	readonly headingKeys: readonly string[];
	readonly diagnostics: readonly Diagnostic[];
	readonly renderingFallback: "full-page";
}
export interface PdfHeading {
	readonly key: string;
	readonly title: string;
	readonly level: number;
	readonly location: PdfLocation;
	readonly evidence: "validated-outline" | "layout-candidate";
}
export interface PdfExtraction {
	readonly pages: number;
	readonly blocks: readonly PdfBlock[];
	readonly headings: readonly PdfHeading[];
	readonly metadata: { readonly title: string | null; readonly author: string | null };
	readonly extractedPages: readonly number[];
	readonly gaps: readonly { readonly pageNumber: number; readonly reason: ErrorCode }[];
	readonly diagnostics: readonly Diagnostic[];
}
interface WorkerInput {
	readonly booksPdfExtraction: true;
	readonly bytes: Uint8Array;
	readonly limits: PdfLimits;
}
interface WorkerMessage {
	readonly progress?: boolean;
	readonly result?: PdfExtraction;
	readonly error?: { readonly code: ErrorCode; readonly message: string };
}

function diagnostic(code: ErrorCode, message: string, location: PdfLocation | null = null): Diagnostic {
	return { code, message, location, source: null };
}
export function freezeExtraction<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeExtraction(child);
		Object.freeze(value);
	}
	return value;
}

/** Local byte input only. A disposable worker bounds parsing time and V8 heap;
 * native decoder memory is not a sandbox guarantee. No viewer or scripting host runs. */
export async function extractPdf(bytes: Uint8Array, overrides: Partial<PdfLimits> = {}): Promise<PdfExtraction> {
	const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
	if (major < 26 || (major === 26 && (minor < 11 || (minor === 11 && patch < 1))))
		throw new CorpusError("unsupported_runtime", "Books PDF extraction requires Node >=26.11.1");
	const limits = { ...pdfLimits, ...overrides };
	for (const key of Object.keys(pdfLimits) as (keyof PdfLimits)[]) {
		if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > pdfLimits[key])
			throw new CorpusError("resource_limit", "Invalid PDF extraction budget");
	}
	if (bytes.length > limits.inputBytes) throw new CorpusError("resource_limit", "PDF input exceeds byte budget");
	if (!/^%PDF-(?:1\.[0-7]|2\.0)/.test(Buffer.from(bytes.subarray(0, 8)).toString("ascii")))
		throw new CorpusError("unsupported_format", "Only PDF 1.0-1.7 or 2.0 byte signatures are supported");
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL(import.meta.url), {
			workerData: { booksPdfExtraction: true, bytes, limits } satisfies WorkerInput,
			// Node executes .ts directly. Do not replay test-runner/V8/CLI flags
			// (including --input-type) into this dedicated parser worker.
			execArgv: [],
			resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
			stdout: true,
			stderr: true,
		});
		let settled = false;
		const finish = (error: CorpusError | null, result?: PdfExtraction) => {
			if (settled) return;
			settled = true;
			clearTimeout(pageTimer);
			clearTimeout(importTimer);
			void worker.terminate();
			if (error) reject(error);
			else if (result) resolve(freezeExtraction(result));
		};
		const timeout = () => finish(new CorpusError("resource_limit", "PDF extraction exceeded time budget"));
		let pageTimer = setTimeout(timeout, limits.pageMilliseconds);
		const importTimer = setTimeout(timeout, limits.importMilliseconds);
		// Unexpected native/library output is never allowed to leak paths or book text.
		worker.stdout?.on("data", () => finish(new CorpusError("extraction_failed", "Unexpected PDF worker output")));
		worker.stderr?.on("data", () => finish(new CorpusError("extraction_failed", "PDF worker emitted a diagnostic")));
		worker.on("message", (message: WorkerMessage) => {
			if (message.progress) {
				clearTimeout(pageTimer);
				pageTimer = setTimeout(timeout, limits.pageMilliseconds);
			} else if (message.error) finish(new CorpusError(message.error.code, message.error.message));
			else if (message.result) finish(null, message.result);
		});
		worker.on("error", () => finish(new CorpusError("resource_limit", "PDF worker failed or exhausted its heap")));
		worker.on("exit", () => {
			if (!settled) finish(new CorpusError("extraction_failed", "PDF worker exited without a result"));
		});
	});
}

function normalize(original: string): { normalizedText: string; mappings: TextMapping[] } {
	let normalizedText = "";
	const mappings: TextMapping[] = [];
	let offset = 0;
	// Problem: normalization can change ligatures/whitespace and invalidate offsets.
	// Example: a ligature expands to two searchable characters. Map each scalar,
	// never repair identifiers, dehyphenate, reorder cells or overwrite extraction.
	for (const scalar of original) {
		const replacement = scalar.normalize("NFKC");
		mappings.push({
			originalRange: { start: offset, end: offset + scalar.length },
			normalizedRange: { start: normalizedText.length, end: normalizedText.length + replacement.length },
			kind: scalar === replacement ? "literal" : "normalized",
		});
		offset += scalar.length;
		normalizedText += replacement;
	}
	return { normalizedText, mappings };
}

function location(
	pageNumber: number,
	width: number,
	height: number,
	bounds: PdfLocation["bounds"] = null,
): PdfLocation {
	return {
		kind: "pdf",
		pageNumber,
		printedLabel: null,
		coordinateSystem: "pdf-points-top-left",
		pageWidth: width,
		pageHeight: height,
		bounds,
	};
}
function union(items: readonly PdfTextItem[]): PdfLocation {
	const first = items[0];
	if (!first) throw new CorpusError("extraction_failed", "Empty PDF block");
	if (items.some((item) => item.location.bounds === null)) return { ...first.location, bounds: null };
	const bounds = items.reduce<[number, number, number, number]>(
		(out, item) => {
			const b = item.location.bounds;
			return b ? [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])] : out;
		},
		[Infinity, Infinity, -Infinity, -Infinity],
	);
	return { ...first.location, bounds };
}

async function outlines(
	doc: PDFDocumentProxy,
	limits: PdfLimits,
	add: (d: Diagnostic) => void,
): Promise<{ title: string; level: number; page: number; y: number | null }[]> {
	const result: { title: string; level: number; page: number; y: number | null }[] = [];
	const queue = ((await doc.getOutline()) ?? []).map((entry) => ({ entry, level: 1 }));
	let count = 0;
	while (queue.length) {
		if (++count > limits.outlineEntries) throw new CorpusError("resource_limit", "PDF outline exceeds entry budget");
		const current = queue.shift();
		if (!current) break;
		const { entry, level } = current;
		if (level > 32 || entry.title.length > 4096)
			throw new CorpusError("resource_limit", "PDF outline exceeds depth/title budget");
		queue.unshift(...entry.items.map((child) => ({ entry: child, level: level + 1 })));
		try {
			const destination = typeof entry.dest === "string" ? await doc.getDestination(entry.dest) : entry.dest;
			if (!Array.isArray(destination) || destination.length < 2) throw new Error("No local destination");
			const target: unknown = destination[0];
			const page =
				typeof target === "number" ? target + 1 : (await doc.getPageIndex(target as { num: number; gen: number })) + 1;
			const mode: unknown = destination[1];
			const name = mode !== null && typeof mode === "object" && "name" in mode ? mode.name : null;
			const y: unknown = name === "XYZ" ? destination[3] : name === "FitH" ? destination[2] : null;
			result.push({ title: entry.title, level, page, y: typeof y === "number" && Number.isFinite(y) ? y : null });
		} catch {
			add(diagnostic("extraction_failed", "Outline hint has no supported local content destination"));
		}
	}
	return result;
}

async function parsePdf(input: WorkerInput): Promise<PdfExtraction> {
	const { bytes, limits } = input;
	const diagnostics = new DiagnosticCollector(limits.diagnostics);
	let currentLocation: PdfLocation | null = null;
	let decodingText = false;
	const gaps = new Map<number, ErrorCode>();
	const add = (d: Diagnostic) => diagnostics.add(d);
	// PDF.js logs parser recovery/image warnings instead of always rejecting. Capture
	// them inside this disposable worker as bounded quality diagnostics;
	// never print a library message containing source content into a client session.
	console.log =
		console.warn =
		console.error =
			() => {
				add(diagnostic("extraction_failed", "PDF decoder reported recovery or unsupported content", currentLocation));
				if (decodingText && currentLocation) gaps.set(currentLocation.pageNumber, "extraction_failed");
			};
	const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
	const assets = (name: string) => join(root, name) + sep;
	const task = getDocument({
		data: new Uint8Array(bytes),
		useSystemFonts: false,
		useWorkerFetch: false,
		cMapUrl: assets("cmaps"),
		cMapPacked: true,
		standardFontDataUrl: assets("standard_fonts"),
		wasmUrl: assets("wasm"),
		stopAtErrors: true,
		maxImageSize: 16000000,
		canvasMaxAreaInBytes: 16000000 * 4,
		isOffscreenCanvasSupported: false,
		isImageDecoderSupported: false,
		disableFontFace: true,
	});
	try {
		const doc = await task.promise;
		// Owner-password PDFs may open with an empty user password. Do not treat
		// successful decoding as authorization to ingest encrypted content.
		const metadata = await doc.getMetadata();
		const info: unknown = metadata.info;
		if (
			(await doc.getPermissions()) !== null ||
			(info !== null && typeof info === "object" && "EncryptFilterName" in info && info.EncryptFilterName !== null)
		)
			throw new CorpusError(
				"encrypted_pdf",
				"Encrypted/owner-password PDF is unsupported; no password handling attempted",
			);
		if (doc.numPages > limits.pages) throw new CorpusError("resource_limit", "PDF exceeds page budget");
		// Raw bytes can contain literal names or obsolete incremental revisions.
		// Only parsed current-document content can establish document-wide risk.
		const raw = Buffer.from(bytes).toString("latin1");
		const unsafe =
			(await doc.hasJSActions()) ||
			Object.keys((await doc.getAttachments()) ?? {}).length > 0 ||
			(info !== null && typeof info === "object" && "IsXFAPresent" in info && info.IsXFAPresent === true);
		if (unsafe)
			add(
				diagnostic(
					"unsupported_asset",
					"Potential active, external or embedded content ignored; source-page fallback required",
				),
			);
		if (/\/(?:URI|OpenAction|AA|JS|JavaScript|Launch|EmbeddedFiles|EmbeddedFile|RichMedia|XFA)\b/.test(raw))
			add(
				diagnostic(
					"unsupported_asset",
					"Potential link/action/asset names ignored; no destinations followed or URLs fetched",
				),
			);
		const hints = await outlines(doc, limits, add);
		const blocks: PdfBlock[] = [];
		const headings: PdfHeading[] = [];
		const extractedPages: number[] = [];
		const validated = new Set<number>();
		let path: PdfHeading[] = [];
		for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
			parentPort?.postMessage({ progress: true });
			const page = await doc.getPage(pageNumber);
			try {
				const viewport = page.getViewport({ scale: 1 });
				if (![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0 && n <= 100000))
					throw new CorpusError("resource_limit", "PDF page geometry exceeds budget");
				currentLocation = location(pageNumber, viewport.width, viewport.height);
				decodingText = true;
				const content = await page.getTextContent({ disableNormalization: true });
				decodingText = false;
				if (content.items.length > limits.itemsPerPage)
					throw new CorpusError("resource_limit", "PDF exceeds text item budget");
				const items: PdfTextItem[] = [];
				let textBytes = 0;
				for (const item of content.items) {
					if (!("str" in item)) continue;
					textBytes += Buffer.byteLength(item.str);
					if (textBytes > limits.textBytesPerPage)
						throw new CorpusError("resource_limit", "PDF page exceeds text budget");
					const textItem: TextItem = item;
					if (![...textItem.transform, item.width, item.height].every(Number.isFinite))
						throw new CorpusError("malformed_pdf", "Non-finite PDF text geometry");
					const t = Util.transform(viewport.transform, item.transform);
					const axisAligned = Math.abs(t[1] ?? 0) < 0.001 && Math.abs(t[2] ?? 0) < 0.001;
					if (!axisAligned)
						add(
							diagnostic(
								"extraction_failed",
								"Rotated/skewed text retained with original transform; crop geometry unverified",
								currentLocation,
							),
						);
					const x = Math.max(0, Math.min(viewport.width, t[4] ?? 0));
					const baseline = t[5] ?? 0;
					const y = Math.max(0, Math.min(viewport.height, baseline - Math.abs(item.height)));
					const x1 = Math.min(viewport.width, x + Math.max(0.01, Math.abs(item.width)));
					const y1 = Math.min(viewport.height, Math.max(y + 0.01, baseline));
					if (x1 <= x || y1 <= y) {
						add(
							diagnostic(
								"extraction_failed",
								"Text outside page geometry retained without crop bounds",
								currentLocation,
							),
						);
					}
					items.push({
						text: item.str,
						transform: [...item.transform],
						width: item.width,
						height: item.height,
						fontName: item.fontName,
						fontFamily: content.styles[item.fontName]?.fontFamily ?? null,
						direction: item.dir,
						hasEOL: item.hasEOL,
						location: { ...currentLocation, bounds: axisAligned && x1 > x && y1 > y ? [x, y, x1, y1] : null },
					});
				}
				// Decode rendering separately: image failures do not imply lost text.
				const operators = await page.getOperatorList();
				// Problem: PDF.js 6.4 can resolve an empty operator list after a
				// stopAtErrors asset failure (e.g. an oversized image), without warning.
				// Text on that page proves the list cannot describe its rendering.
				// Preserve the text and report uncertain rendering, not a text gap.
				if (items.some((item) => item.text.trim()) && operators.fnArray.length === 0) {
					add(
						diagnostic(
							"extraction_failed",
							"PDF render operators unavailable; unsafe/unsupported asset or decoder failure; inspect original page",
							currentLocation,
						),
					);
				}
				const imageOps = new Set([
					OPS.paintImageXObject,
					OPS.paintInlineImageXObject,
					OPS.paintInlineImageXObjectGroup,
					OPS.paintImageXObjectRepeat,
					OPS.paintImageMaskXObject,
					OPS.paintImageMaskXObjectGroup,
					OPS.paintImageMaskXObjectRepeat,
				]);
				if (operators.fnArray.some((op: number) => imageOps.has(op))) {
					add(
						diagnostic(
							"unsupported_asset",
							"Raster figure content is not OCR-extracted; render the page to view it",
							currentLocation,
						),
					);
				}
				if (!items.some((item) => item.text.trim())) {
					gaps.set(pageNumber, "scanned_page");
					add(
						diagnostic(
							"scanned_page",
							"No extractable text; OCR is not enabled; inspect original page",
							currentLocation,
						),
					);
				} else extractedPages.push(pageNumber);
				// Keep decoder order verbatim. Same-baseline items form a candidate row;
				// neither geometric ordering nor table/code semantics are asserted as fact.
				const rows: PdfTextItem[][] = [];
				for (const item of items) {
					const previous = rows.at(-1);
					const last = previous?.at(-1);
					if (
						previous &&
						last &&
						!last.hasEOL &&
						Math.abs((last.transform[5] ?? -100) - (item.transform[5] ?? 100)) < 3
					)
						previous.push(item);
					else rows.push([item]);
				}
				for (const [rowIndex, row] of rows.entries()) {
					const originalText = row.map((item) => item.text).join("");
					if (!originalText) continue;
					const rowLocation = union(row);
					let match: (typeof hints)[number] | undefined;
					for (const [hintIndex, hint] of hints.entries()) {
						if (
							validated.has(hintIndex) ||
							hint.page !== pageNumber ||
							hint.title.trim().replace(/\s+/g, " ") !== originalText.trim().replace(/\s+/g, " ")
						)
							continue;
						// A page-only hint cannot disambiguate repeated running headings.
						if (
							hint.y === null &&
							rows.filter(
								(candidate) =>
									candidate
										.map((item) => item.text)
										.join("")
										.trim()
										.replace(/\s+/g, " ") === hint.title.trim().replace(/\s+/g, " "),
							).length !== 1
						)
							continue;
						const top = rowLocation.bounds?.[1];
						const destinationY = hint.y === null ? null : viewport.convertToViewportPoint(0, hint.y)[1];
						if (
							top === undefined ||
							(destinationY !== null &&
								destinationY !== undefined &&
								Math.abs(top - destinationY) > Math.max(36, ...row.map((i) => i.height * 2)))
						)
							continue;
						validated.add(hintIndex);
						match = hint;
						break;
					}
					const size = row.reduce((maximum, item) => Math.max(maximum, item.height), 0);
					const headingCandidate = !match && size >= 16 && originalText.trim().length > 0 && originalText.length < 200;
					if (match || headingCandidate) {
						const level = match?.level ?? 1;
						const heading: PdfHeading = {
							key: `heading-${pageNumber}-${rowIndex}`,
							title: originalText,
							level,
							location: rowLocation,
							evidence: match ? "validated-outline" : "layout-candidate",
						};
						while (path.length && (path.at(-1)?.level ?? 0) >= level) path.pop();
						path = [...path, heading];
						headings.push(heading);
					}
					const code = row.some((item) => /mono|courier/i.test(item.fontFamily ?? ""));
					const cells = row.filter((item) => item.text.trim());
					const table =
						cells.length >= 2 &&
						cells.some(
							(item, index) =>
								index > 0 && (item.location.bounds?.[0] ?? 0) - (cells[index - 1]?.location.bounds?.[2] ?? 0) > 8,
						);
					const quality = code
						? [
								diagnostic(
									"uncertain_code",
									"Code-like font: extraction/continuation not repaired; inspect source page",
									rowLocation,
								),
							]
						: table
							? [
									diagnostic(
										"uncertain_table",
										"Candidate table row: retain items, headers/units/cells and coordinates; relationships unverified; inspect source page",
										rowLocation,
									),
								]
							: [];
					blocks.push({
						key: `page-${pageNumber}-row-${rowIndex}`,
						kind: match || headingCandidate ? "heading" : code ? "code" : table ? "table" : "text",
						originalText,
						...normalize(originalText),
						items: row,
						location: rowLocation,
						headingKeys: path.map((h) => h.key),
						diagnostics: quality,
						renderingFallback: "full-page",
					});
				}
			} finally {
				page.cleanup();
			}
		}
		for (const index of hints.keys()) {
			if (!validated.has(index))
				add(
					diagnostic(
						"extraction_failed",
						"Outline heading not validated against content and destination position",
						null,
					),
				);
		}
		if (unsafe) {
			for (let page = 1; page <= doc.numPages; page++) if (!gaps.has(page)) gaps.set(page, "unsupported_asset");
		}
		const value = (key: string) =>
			info !== null && typeof info === "object" && key in info && typeof Reflect.get(info, key) === "string"
				? String(Reflect.get(info, key)).slice(0, 4096)
				: null;
		return {
			pages: doc.numPages,
			blocks,
			headings,
			metadata: { title: value("Title"), author: value("Author") },
			extractedPages,
			gaps: [...gaps].map(([pageNumber, reason]) => ({ pageNumber, reason })),
			diagnostics: diagnostics.finish(),
		};
	} finally {
		await task.destroy();
	}
}

if (!isMainThread && (workerData as Partial<WorkerInput> | null)?.booksPdfExtraction === true) {
	try {
		parentPort?.postMessage({ result: await parsePdf(workerData as WorkerInput) });
	} catch (error) {
		const code =
			error instanceof CorpusError
				? error.code
				: error instanceof Error && error.name === "PasswordException"
					? "encrypted_pdf"
					: "malformed_pdf";
		parentPort?.postMessage({
			error: {
				code,
				message:
					error instanceof CorpusError
						? error.message
						: code === "encrypted_pdf"
							? "Encrypted PDF requires unsupported password/DRM handling"
							: "PDF decoding failed; malformed or unsupported content",
			},
		});
	}
}

export const pdfExtractor = Object.freeze({
	name: "pdfjs-dist",
	version: "6.4.299",
	configurationHash: sha256(
		JSON.stringify({
			limits: pdfLimits,
			adapter: 4,
			diagnostics: "code-message-count-page-ranges-32-cap-500-with-truncation",
			coverage: "text-loss-only",
			normalization: "per-scalar-NFKC",
			activeContent: "parsed-js-attachments-xfa-unsafe-raw-names-diagnostic-only",
			encryption: "reject-including-owner-password",
			workerHeapMb: 1024,
		}),
	),
});
