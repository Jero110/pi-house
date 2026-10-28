import type { ChunkOptions } from "./chunks.ts";
import { chunkPreparedIngest } from "./chunks.ts";
import type {
	BlockId,
	BookId,
	BookMetadata,
	Diagnostic,
	Figure,
	Heading,
	MetadataEvidence,
	MetadataField,
	SectionId,
	Sha256,
	SourceSpan,
	SourceVersion,
} from "./contracts.ts";
import { assertPdfLocation, defineSource } from "./contracts.ts";
import type { FigureAsset } from "./figures.ts";
import { discoverFigures, renderFigure, UnsupportedFigureRender } from "./figures.ts";
import { assertId, CorpusError, readLocalPdf, sha256 } from "./locations.ts";
import type { PdfBlock, PdfExtraction, PdfLimits } from "./pdf.ts";
import { extractPdf, freezeExtraction, pdfExtractor, pdfLimits } from "./pdf.ts";
import type { CorpusStore } from "./store.ts";

export interface IngestOptions {
	readonly store: CorpusStore;
	readonly bookId: BookId;
	readonly input: string;
	readonly indexConfigurationHash: Sha256;
	readonly limits?: Partial<PdfLimits>;
	/** Explicit, externally verified evidence, not an automatic author/title guess.
	 * Title-page evidence must carry a physical PDF location. Overrides retain all evidence. */
	readonly metadataEvidence?: {
		readonly [Key in keyof BookMetadata]?: BookMetadata[Key]["evidence"];
	};
}

export interface IngestBlock extends PdfBlock {
	readonly id: BlockId;
	readonly headingPath: readonly Heading[];
	/** These offsets address this block's originalText, not a future passage. */
	readonly span: SourceSpan;
}

export interface IngestSection {
	readonly id: SectionId;
	readonly parentSectionId: SectionId | null;
	readonly heading: Heading | null;
	/** Half-open indices in PreparedIngest.blocks, including the heading block.
	 * Sections can start mid-page and continue across physical pages. */
	readonly blockRange: { readonly start: number; readonly end: number };
}

/** Extraction only: this immutable document is NOT a published corpus version.
 * coverage describes extraction, never durable ingestion/index completion.
 * Problem: publishing a source before chunking can advertise an empty complete book.
 * Example: a crash after extraction would make all passages disappear. Solution:
 * T5 chunks/renders this document and calls CorpusStore.import atomically, which
 * rechecks the original source hash before publication. No writes happen here. */
export interface PreparedIngest {
	readonly state: "prepared-unpublished";
	readonly source: SourceVersion;
	readonly indexConfigurationHash: Sha256;
	readonly extraction: PdfExtraction;
	readonly blocks: readonly IngestBlock[];
	readonly sections: readonly IngestSection[];
}

/** Complete T4 -> T5 boundary: nothing is visible until every bounded image and
 * chunk has succeeded and the original hash is rechecked at atomic publication.
 * Chunk settings must be included in the caller's indexConfigurationHash. */
export async function publishIngest(
	document: PreparedIngest,
	store: CorpusStore,
	options: ChunkOptions = {},
): Promise<{ readonly source: SourceVersion; readonly imported: boolean }> {
	const discovered = discoverFigures(document, store);
	const passages = chunkPreparedIngest(document, store, discovered, options);
	const figures: Figure[] = discovered.map((figure) => ({
		...figure,
		linkingEvidence: passages.flatMap((p) => p.figures.filter((link) => link.figureId === figure.id)),
	}));
	const figureAssets: FigureAsset[] = [];
	const published = store
		.listVersions(document.source.bookId)
		.some((source) => source.versionId === document.source.versionId);
	// Re-importing identical extraction reuses its immutable ingestion images;
	// never re-render at query time or silently overwrite a stored generation.
	// Resolve/validate a published version once, not once per figure: each stored
	// payload contains all images, so per-figure reads are quadratic in book size.
	const persisted = published
		? new Map(store.readFigureAssets(document.source).map((asset) => [asset.figureId, asset]))
		: null;
	for (const figure of figures) {
		if (persisted) {
			const asset = persisted.get(figure.id);
			if (!asset) {
				const stored = store.listFigures(document.source).find((f) => f.id === figure.id);
				if (!stored?.unavailable)
					throw new CorpusError("unsupported_asset", "No persisted image for this figure/version");
				figures[figures.indexOf(figure)] = { ...figure, unavailable: stored.unavailable };
			} else figureAssets.push(asset);
		} else {
			try {
				figureAssets.push(await renderFigure(document.source, figure));
			} catch (error) {
				if (!(error instanceof UnsupportedFigureRender)) throw error;
				figures[figures.indexOf(figure)] = { ...figure, unavailable: { status: "unsupported", reason: error.reason } };
			}
		}
	}
	return store.import({
		source: document.source,
		indexConfigurationHash: document.indexConfigurationHash,
		passages,
		figures,
		figureAssets,
	});
}

function field<T>(evidence: readonly MetadataEvidence<T>[]): MetadataField<T> {
	const override = evidence.filter((entry) => entry.origin === "operator-override");
	if (new Set(override.map((entry) => JSON.stringify(entry.value))).size > 1)
		throw new CorpusError("identity_mismatch", "Contradictory metadata overrides");
	const unique = new Set(evidence.map((entry) => JSON.stringify(entry.value)));
	return {
		value: override.at(-1)?.value ?? (unique.size === 1 ? (evidence[0]?.value ?? null) : null),
		evidence,
		resolution: override.length ? "override" : unique.size > 1 ? "conflict" : unique.size === 1 ? "agreed" : "unknown",
	};
}

function metadata(extraction: PdfExtraction, evidence: IngestOptions["metadataEvidence"]): BookMetadata {
	const file = <T>(value: T | null): MetadataEvidence<T>[] =>
		value === null ? [] : [{ origin: "file-metadata", value, location: null }];
	// The PDF Author string is opaque: splitting commas or guessing title-page names
	// can invent people. Caller-supplied verified title-page evidence exposes conflicts.
	const result: BookMetadata = {
		title: field([...file(extraction.metadata.title), ...(evidence?.title ?? [])]),
		authors: field<readonly string[]>([
			...file(extraction.metadata.author ? [extraction.metadata.author] : null),
			...(evidence?.authors ?? []),
		]),
		publisher: field(evidence?.publisher ?? []),
		edition: field(evidence?.edition ?? []),
		publicationDate: field(evidence?.publicationDate ?? []),
	};
	for (const entry of Object.values(result).flatMap((value) => value.evidence)) {
		if (entry.origin === "title-page" && entry.location === null)
			throw new CorpusError("identity_mismatch", "Title-page evidence requires a verified location");
		if (entry.location) assertPdfLocation(entry.location, extraction.pages);
	}
	return result;
}

/** Reads only local PDF bytes; never uploads, runs OCR/LLMs, or publishes records.
 * Reuse the same bookId and configuration to obtain an idempotent version identity. */
export async function ingestPdf(options: IngestOptions): Promise<PreparedIngest> {
	assertId(options.bookId, "book");
	const input = options.input; // readLocalPdf validates every component and opens a verified descriptor.
	const bytes = readLocalPdf(input, options.limits?.inputBytes ?? pdfLimits.inputBytes);
	const extraction = await extractPdf(bytes, options.limits);
	const bookMetadata = metadata(extraction, options.metadataEvidence);
	const extractor = {
		...pdfExtractor,
		configurationHash: sha256(
			JSON.stringify([pdfExtractor.configurationHash, { ...pdfLimits, ...options.limits }, bookMetadata]),
		),
	};
	const identity = {
		bookId: options.bookId,
		sourceHash: sha256(bytes),
		versionId: options.store.versionId(options.bookId, sha256(bytes), extractor, options.indexConfigurationHash),
	};
	const source = defineSource({
		...identity,
		format: "pdf",
		originalPath: input,
		pageCount: extraction.pages,
		metadata: bookMetadata,
		extractor,
		coverage: {
			totalPages: extraction.pages,
			extractedPages: extraction.extractedPages,
			gaps: extraction.gaps,
			status: extraction.gaps.length ? "incomplete" : "complete",
		},
		diagnostics: extraction.diagnostics.map((entry) => ({ ...entry, source: identity })),
	});
	const id = (kind: "section" | "block", key: string): string =>
		`${kind}_${sha256(JSON.stringify([source.versionId, kind, key])).slice(7, 39)}`;
	const headings = new Map(
		extraction.headings.map((heading) => [
			heading.key,
			{
				sectionId: id("section", heading.key) as SectionId,
				title: heading.title,
				location: heading.location,
			},
		]),
	);
	const blocks: IngestBlock[] = extraction.blocks.map((block) => {
		const blockId = id("block", block.key) as BlockId;
		return {
			...block,
			id: blockId,
			headingPath: block.headingKeys.map((key) => {
				const heading = headings.get(key);
				if (!heading) throw new CorpusError("identity_mismatch", "Missing extracted heading");
				return heading;
			}),
			span: { blockId, location: block.location, originalRange: { start: 0, end: block.originalText.length } },
			diagnostics: block.diagnostics.map((entry): Diagnostic => ({ ...entry, source: identity })),
		};
	});
	const rootId = id("section", "unsectioned-root") as SectionId;
	const sections: IngestSection[] = [
		{ id: rootId, parentSectionId: null, heading: null, blockRange: { start: 0, end: blocks.length } },
	];
	for (const heading of headings.values()) {
		const start = blocks.findIndex((block) => block.headingPath.at(-1)?.sectionId === heading.sectionId);
		if (start < 0) throw new CorpusError("identity_mismatch", "Heading has no source block");
		let end = start + 1;
		while (end < blocks.length && blocks[end]?.headingPath.some((entry) => entry.sectionId === heading.sectionId))
			end++;
		sections.push({
			id: heading.sectionId,
			parentSectionId: blocks[start]?.headingPath.at(-2)?.sectionId ?? rootId,
			heading,
			blockRange: { start, end },
		});
	}
	return freezeExtraction({
		state: "prepared-unpublished",
		source,
		indexConfigurationHash: options.indexConfigurationHash,
		extraction,
		blocks,
		sections,
	});
}
