import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Figure, FigureId, FigureLink, Passage, SourceIdentity, SourceVersion } from "./contracts.ts";
import { assertSourceIdentity, defineFigure } from "./contracts.ts";
import type { PreparedIngest } from "./ingest.ts";
import { CorpusError, sha256, verifiedSourceBytes } from "./locations.ts";
import type { CorpusStore } from "./store.ts";

const renderFailureMessages = {
	decoder_diagnostic: "PDF decoder emitted a recovery/unsupported-content diagnostic",
	geometry_mismatch: "Page geometry differs from the verified figure location",
	no_render_operators: "PDF decoder supplied no rendering operators",
	image_budget: "Encoded image exceeds the unchanged output budget after bounded reductions",
	decoder_failure: "PDF/canvas decoder failed (unclassified; source details withheld)",
} as const;
type RenderFailureReason = keyof typeof renderFailureMessages;
export class UnsupportedFigureRender extends CorpusError {
	readonly reason: "no_render_operators";
	constructor(reason: "no_render_operators") {
		super("unsupported_asset", `Figure could not be rendered safely: ${renderFailureMessages[reason]} (${reason})`);
		this.reason = reason;
	}
}
class RenderFailure extends Error {
	readonly reason: RenderFailureReason;
	constructor(reason: RenderFailureReason) {
		super(renderFailureMessages[reason]);
		this.reason = reason;
	}
}

export const figureLimits = Object.freeze({ longestSide: 1600, base64Bytes: 2 * 1024 * 1024, milliseconds: 30000 });
export interface FigureAsset extends SourceIdentity {
	readonly figureId: FigureId;
	readonly mimeType: "image/png" | "image/jpeg";
	readonly base64: string;
	readonly width: number;
	readonly height: number;
	readonly assetHash: `sha256:${string}`;
	readonly framing: Figure["rendering"];
	readonly reducedResolution: boolean;
	readonly notice: string;
}
const captionPattern = /^\s*(Figure\s+\d+(?:[-.]\d+)*)(?:[.:](?:\s|$)|$)/i;
const labelKey = (label: string) => label.toLowerCase().replace(/\s+/g, " ");

/** Caption identity, not same-page proximity. Crops are NOT inferred from captions. */
export function discoverFigures(document: PreparedIngest, store: CorpusStore): readonly Figure[] {
	return document.blocks.flatMap((block) => {
		const label = captionPattern.exec(block.originalText)?.[1];
		if (!label) return [];
		return [
			defineFigure(
				{
					bookId: document.source.bookId,
					versionId: document.source.versionId,
					sourceHash: document.source.sourceHash,
					id: store.recordId("figure", document.source, block.key),
					label,
					caption: block.originalText,
					location: block.location,
					rendering: { kind: "full-page-fallback", reason: "Caption found, but diagram crop bounds are unverified" },
					linkingEvidence: [],
					diagnostics: [],
				},
				document.source,
			),
		];
	});
}
export function linkFigures(
	passage: Pick<Passage, "originalText" | "spans">,
	figures: readonly Figure[],
): readonly FigureLink[] {
	const links: FigureLink[] = [];
	for (const match of passage.originalText.matchAll(/\bFigure\s+\d+(?:[-.]\d+)*/gi)) {
		const label = match[0];
		const candidates = figures.filter((figure) => figure.label !== null && labelKey(figure.label) === labelKey(label));
		// Duplicate captions are ambiguous, even if one happens to be nearby.
		const figure = candidates.length === 1 ? candidates[0] : undefined;
		const span = passage.spans.find((s) => s.originalRange.start <= match.index && s.originalRange.end > match.index);
		// The base contract requires the exact caption label in literal evidence.
		// Do not manufacture a case-corrected quote to satisfy that invariant.
		if (!figure || !span || figure.label !== label || links.some((l) => l.figureId === figure.id)) continue;
		links.push({
			figureId: figure.id,
			evidence: {
				kind: "explicit-reference",
				figureLabel: figure.label ?? label,
				referenceText: label,
				location: span.location,
			},
		});
	}
	return links;
}
function encodedDimensions(bytes: Buffer, mime: FigureAsset["mimeType"]): readonly [number, number] | null {
	if (mime === "image/png") {
		if (
			bytes.length < 33 ||
			!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
			bytes.toString("ascii", 12, 16) !== "IHDR"
		)
			return null;
		return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
	}
	if (mime !== "image/jpeg" || bytes[0] !== 255 || bytes[1] !== 216) return null;
	// Inspect bounded segment headers only; never allocate from decoder dimensions.
	for (let offset = 2; offset + 4 <= bytes.length; ) {
		if (bytes[offset] !== 255) return null;
		while (bytes[offset] === 255) offset++;
		const marker = bytes[offset];
		offset++;
		if (marker === undefined || marker === 218 || marker === 217 || offset + 2 > bytes.length) return null;
		const length = bytes.readUInt16BE(offset);
		if (length < 2 || offset + length > bytes.length) return null;
		if (marker === 192 || marker === 194)
			return length >= 8 ? [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)] : null;
		offset += length;
	}
	return null;
}
export function validateFigureAsset(
	asset: FigureAsset,
	source: SourceVersion,
	figures: readonly Figure[],
): FigureAsset {
	assertSourceIdentity(asset, source);
	const figure = figures.find((f) => f.id === asset.figureId);
	if (!figure || JSON.stringify(figure.rendering) !== JSON.stringify(asset.framing))
		throw new CorpusError("identity_mismatch", "Figure asset does not match a stored figure");
	if (
		![asset.width, asset.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= figureLimits.longestSide) ||
		asset.base64.length > figureLimits.base64Bytes ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)
	)
		throw new CorpusError("resource_limit", "Invalid figure image bounds or encoding");
	const bytes = Buffer.from(asset.base64, "base64");
	const dimensions = encodedDimensions(bytes, asset.mimeType);
	if (
		dimensions?.[0] !== asset.width ||
		dimensions?.[1] !== asset.height ||
		!bytes.length ||
		sha256(bytes) !== asset.assetHash ||
		!(asset.mimeType === "image/png"
			? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
			: asset.mimeType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) ||
		!asset.notice ||
		typeof asset.reducedResolution !== "boolean"
	)
		throw new CorpusError("unsupported_asset", "Invalid stored figure image");
	return Object.freeze(structuredClone(asset));
}
interface RenderInput {
	readonly booksFigureRender: true;
	readonly bytes: Uint8Array;
	readonly figure: Figure;
}

/** One isolated page/crop, one image. Re-hash the original before every render;
 * after publication readers use this stored asset, not a deleted original. */
export async function renderFigure(source: SourceVersion, figure: Figure): Promise<FigureAsset> {
	defineFigure(figure, source);
	const bytes = verifiedSourceBytes(source);
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL(import.meta.url), {
			workerData: { booksFigureRender: true, bytes, figure } satisfies RenderInput,
			execArgv: [],
			resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
			stdout: true,
			stderr: true,
		});
		let settled = false;
		const finish = (error: CorpusError | null, asset?: FigureAsset) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			if (error) reject(error);
			else if (asset) {
				try {
					resolve(validateFigureAsset(asset, source, [figure]));
				} catch (failure) {
					reject(failure);
				}
			}
		};
		const timer = setTimeout(
			() => finish(new CorpusError("resource_limit", "Figure rendering exceeded time budget")),
			figureLimits.milliseconds,
		);
		worker.stdout?.on("data", () =>
			finish(new CorpusError("unsupported_asset", "Figure decoder emitted a diagnostic")),
		);
		worker.stderr?.on("data", () =>
			finish(new CorpusError("unsupported_asset", "Figure decoder emitted a diagnostic")),
		);
		worker.on("message", (message: { asset?: FigureAsset; reason?: RenderFailureReason }) => {
			if (message.asset) finish(null, message.asset);
			else {
				const reason =
					message.reason && Object.hasOwn(renderFailureMessages, message.reason) ? message.reason : "decoder_failure";
				finish(
					reason === "no_render_operators"
						? new UnsupportedFigureRender(reason)
						: new CorpusError(
								"unsupported_asset",
								`Figure on PDF page ${figure.location.pageNumber} could not be rendered safely: ${renderFailureMessages[reason]} (${reason})`,
							),
				);
			}
		});
		worker.on("error", () => finish(new CorpusError("resource_limit", "Figure worker failed or exhausted its heap")));
		worker.on("exit", () => {
			if (!settled) finish(new CorpusError("unsupported_asset", "Figure decoder exited without an image"));
		});
	});
}
async function render(input: RenderInput): Promise<FigureAsset> {
	let decoderDiagnostic = false;
	// PDF.js recovery warnings must not become a successful blank/partial image.
	console.log =
		console.warn =
		console.error =
			() => {
				decoderDiagnostic = true;
				throw new RenderFailure("decoder_diagnostic");
			};
	const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
	const assets = (name: string) => join(root, name) + sep;
	const task = getDocument({
		data: new Uint8Array(input.bytes),
		useSystemFonts: false,
		useWorkerFetch: false,
		cMapUrl: assets("cmaps"),
		cMapPacked: true,
		standardFontDataUrl: assets("standard_fonts"),
		wasmUrl: assets("wasm"),
		stopAtErrors: true,
		maxImageSize: 16000000,
		canvasMaxAreaInBytes: 64000000,
		isOffscreenCanvasSupported: false,
		isImageDecoderSupported: false,
		disableFontFace: true,
	});
	try {
		const doc = await task.promise;
		const page = await doc.getPage(input.figure.location.pageNumber);
		const base = page.getViewport({ scale: 1 });
		if (
			base.width !== input.figure.location.pageWidth ||
			base.height !== input.figure.location.pageHeight ||
			![base.width, base.height].every((n) => Number.isFinite(n) && n > 0 && n <= 100000)
		)
			throw new RenderFailure("geometry_mismatch");
		const [x0, y0, x1, y1] =
			input.figure.rendering.kind === "crop" ? input.figure.rendering.bounds : [0, 0, base.width, base.height];
		const width = x1 - x0;
		const height = y1 - y0;
		let scale = Math.min(2, figureLimits.longestSide / Math.max(width, height));
		for (let attempt = 0; attempt < 4; attempt++) {
			const w = Math.max(1, Math.floor(width * scale));
			const h = Math.max(1, Math.floor(height * scale));
			const canvas = createCanvas(w, h);
			const viewport = page.getViewport({ scale });
			const operators = await page.getOperatorList();
			if (!operators.fnArray.length) throw new RenderFailure("no_render_operators");
			await page.render({
				canvas: canvas as unknown as HTMLCanvasElement,
				viewport,
				transform: [1, 0, 0, 1, -x0 * scale, -y0 * scale],
				background: "white",
			}).promise;
			for (const mimeType of ["image/png", "image/jpeg"] as const) {
				const encoded = mimeType === "image/png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg", 80);
				const base64 = encoded.toString("base64");
				if (base64.length <= figureLimits.base64Bytes)
					return {
						bookId: input.figure.bookId,
						versionId: input.figure.versionId,
						sourceHash: input.figure.sourceHash,
						figureId: input.figure.id,
						mimeType,
						base64,
						width: w,
						height: h,
						assetHash: sha256(encoded),
						framing: input.figure.rendering,
						reducedResolution: scale < 2 || mimeType === "image/jpeg",
						notice: `${input.figure.rendering.kind}; ${scale < 2 || mimeType === "image/jpeg" ? "reduced resolution/lossy image; " : ""}legibility not assessed; no diagram text was interpreted. Original may be unavailable after ingestion.`,
					};
			}
			scale *= 0.7;
		}
		throw new RenderFailure("image_budget");
	} catch (error) {
		if (decoderDiagnostic) throw new RenderFailure("decoder_diagnostic");
		throw error;
	} finally {
		await task.destroy();
	}
}
if (!isMainThread && (workerData as Partial<RenderInput> | null)?.booksFigureRender === true) {
	try {
		parentPort?.postMessage({ asset: await render(workerData as RenderInput) });
	} catch (error) {
		parentPort?.postMessage({ reason: error instanceof RenderFailure ? error.reason : "decoder_failure" });
	}
}
