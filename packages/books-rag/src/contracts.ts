// Local contracts only: importing this workspace never loads a parser or model.
export type BookId = `book_${string}`;
export type VersionId = `version_${string}`;
export type PassageId = `passage_${string}`;
export type FigureId = `figure_${string}`;
export type SectionId = `section_${string}`;
export type BlockId = `block_${string}`;
export type Sha256 = `sha256:${string}`;

export interface SourceIdentity {
	readonly bookId: BookId;
	readonly versionId: VersionId;
	readonly sourceHash: Sha256;
}

export interface PdfLocation {
	readonly kind: "pdf";
	// One-based physical page in this exact PDF; never inferred printed pagination.
	readonly pageNumber: number;
	readonly printedLabel: string | null;
	readonly coordinateSystem: "pdf-points-top-left";
	readonly pageWidth: number;
	readonly pageHeight: number;
	readonly bounds: readonly [number, number, number, number] | null; // x0, y0, x1, y1
}

export interface MetadataEvidence<T> {
	readonly origin: "file-metadata" | "title-page" | "operator-override";
	readonly value: T;
	readonly location: PdfLocation | null;
}

export interface MetadataField<T> {
	readonly value: T | null;
	readonly evidence: readonly MetadataEvidence<T>[];
	readonly resolution: "unknown" | "agreed" | "conflict" | "override";
}

export interface BookMetadata {
	readonly title: MetadataField<string>;
	readonly authors: MetadataField<readonly string[]>;
	readonly publisher: MetadataField<string>;
	readonly edition: MetadataField<string>;
	readonly publicationDate: MetadataField<string>;
}

export type ErrorCode =
	| "unsupported_format"
	| "unsupported_runtime"
	| "unsafe_path"
	| "malformed_pdf"
	| "encrypted_pdf"
	| "scanned_page"
	| "extraction_failed"
	| "uncertain_code"
	| "uncertain_table"
	| "uncertain_figure"
	| "unsupported_asset"
	| "resource_limit"
	| "source_missing"
	| "source_changed"
	| "stale_index"
	| "identity_mismatch"
	| "backend_unavailable"
	| "runtime_unavailable"
	| "model_mismatch"
	| "index_incomplete";

export interface Diagnostic {
	readonly code: ErrorCode;
	readonly message: string;
	readonly source: SourceIdentity | null;
	readonly location: PdfLocation | null;
	/** Repeated notices grouped by code/message. Location remains a first example. */
	readonly occurrences?: number;
	readonly pageCount?: number;
	readonly pageRanges?: readonly (readonly [number, number])[];
	readonly omittedPageCount?: number;
}

export interface Coverage {
	readonly totalPages: number;
	readonly extractedPages: readonly number[];
	readonly gaps: readonly {
		readonly pageNumber: number;
		readonly reason: ErrorCode;
	}[];
	readonly status: "complete" | "incomplete";
}

export interface SourceVersion extends SourceIdentity {
	readonly format: "pdf";
	readonly originalPath: string;
	readonly pageCount: number;
	readonly metadata: BookMetadata;
	readonly extractor: {
		readonly name: string;
		readonly version: string;
		readonly configurationHash: Sha256;
	};
	readonly coverage: Coverage;
	readonly diagnostics: readonly Diagnostic[];
}

export interface TextRange {
	readonly start: number;
	readonly end: number; // Half-open UTF-16 offsets, as used by String.slice.
}

export interface SourceSpan {
	readonly blockId: BlockId;
	readonly location: PdfLocation;
	readonly originalRange: TextRange;
}

export interface TextMapping {
	readonly originalRange: TextRange;
	readonly normalizedRange: TextRange;
	readonly kind: "literal" | "normalized" | "omitted";
}

export interface Heading {
	readonly sectionId: SectionId;
	readonly title: string;
	readonly location: PdfLocation;
}

export interface FigureLink {
	readonly figureId: FigureId;
	readonly evidence:
		| {
				readonly kind: "explicit-reference";
				readonly figureLabel: string;
				readonly referenceText: string;
				readonly location: PdfLocation;
		  }
		| {
				readonly kind: "caption-layout";
				readonly status: "uncertain";
				readonly reason: string;
				readonly location: PdfLocation;
		  };
}

export interface Passage extends SourceIdentity {
	readonly id: PassageId;
	readonly parentSectionId: SectionId;
	readonly headingPath: readonly Heading[];
	readonly originalText: string;
	readonly normalizedText: string;
	readonly mappings: readonly TextMapping[];
	readonly spans: readonly SourceSpan[];
	readonly neighbors: {
		readonly previous: PassageId | null;
		readonly next: PassageId | null;
	};
	readonly figures: readonly FigureLink[];
	readonly quality: readonly Diagnostic[];
	readonly indexConfigurationHash: Sha256;
}

export interface Figure extends SourceIdentity {
	readonly unavailable?: {
		readonly status: "unsupported";
		readonly reason: "no_render_operators";
	};
	readonly id: FigureId;
	readonly label: string | null;
	readonly caption: string | null;
	readonly location: PdfLocation;
	readonly rendering:
		| { readonly kind: "crop"; readonly bounds: readonly [number, number, number, number] }
		| { readonly kind: "full-page-fallback"; readonly reason: string };
	readonly linkingEvidence: readonly FigureLink[];
	readonly diagnostics: readonly Diagnostic[];
}

export interface SearchHit extends SourceIdentity {
	readonly passageId: PassageId;
	readonly excerpt: string;
	readonly locations: readonly PdfLocation[];
	readonly headingPath: readonly Heading[];
	readonly figures: readonly FigureLink[];
	// Ranking scores are not probabilities or factual confidence.
	readonly scores: { readonly dense: number | null; readonly lexical: number | null };
}

export type SearchStatus = "ok" | "insufficient_evidence" | "unavailable" | "incomplete_corpus";
export interface SearchAssessment {
	readonly backend: "available" | "unavailable";
	readonly corpus: "complete" | "incomplete";
	readonly evidence: "candidates" | "insufficient";
}
export interface SearchResult extends SearchAssessment {
	readonly status: SearchStatus;
	readonly hits: readonly SearchHit[];
	readonly coverage: readonly { readonly source: SourceIdentity; readonly coverage: Coverage }[];
	readonly diagnostics: readonly Diagnostic[];
	/** The relevance gate that produced this result, so an over-abstaining live install is attributable. */
	readonly gate?: { readonly version: string; readonly minimumScore: number; readonly maximumDrop: number };
}

function requireContract(condition: boolean, message: string): asserts condition {
	if (!condition) throw new TypeError(message);
}

function integer(value: number, minimum: number, maximum: number): boolean {
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function id(value: string, prefix: string): void {
	requireContract(new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value), `Invalid ${prefix} ID`);
}

function hash(value: Sha256): void {
	requireContract(/^sha256:[a-f0-9]{64}$/.test(value), "Invalid SHA-256");
}

export function assertSourceIdentity(value: SourceIdentity, expected?: SourceIdentity): void {
	id(value.bookId, "book");
	id(value.versionId, "version");
	hash(value.sourceHash);
	if (expected) {
		requireContract(
			value.bookId === expected.bookId &&
				value.versionId === expected.versionId &&
				value.sourceHash === expected.sourceHash,
			"Inconsistent source identity",
		);
	}
}

export function assertPdfLocation(value: PdfLocation, pageCount: number): void {
	requireContract(value.kind === "pdf", "Unsupported location format");
	requireContract(integer(pageCount, 1, 2000), "Invalid page count");
	requireContract(integer(value.pageNumber, 1, pageCount), "Invalid physical PDF page");
	requireContract(value.coordinateSystem === "pdf-points-top-left", "Unknown coordinate system");
	requireContract(
		Number.isFinite(value.pageWidth) &&
			value.pageWidth > 0 &&
			Number.isFinite(value.pageHeight) &&
			value.pageHeight > 0,
		"Invalid page dimensions",
	);
	requireContract(value.printedLabel === null || value.printedLabel.trim().length > 0, "Invalid printed label");
	if (value.bounds !== null) assertBounds(value.bounds, value);
}

function assertBounds(bounds: readonly number[], location: PdfLocation): void {
	const [x0, y0, x1, y1] = bounds;
	requireContract(
		bounds.length === 4 &&
			bounds.every(Number.isFinite) &&
			x0 !== undefined &&
			y0 !== undefined &&
			x1 !== undefined &&
			y1 !== undefined &&
			x0 >= 0 &&
			y0 >= 0 &&
			x1 > x0 &&
			y1 > y0 &&
			x1 <= location.pageWidth &&
			y1 <= location.pageHeight,
		"Invalid PDF bounds",
	);
}

export function assertCoverage(value: Coverage): void {
	requireContract(integer(value.totalPages, 1, 2000), "Invalid coverage page count");
	const extracted = new Set(value.extractedPages);
	const gaps = new Set(value.gaps.map((gap) => gap.pageNumber));
	requireContract(
		extracted.size === value.extractedPages.length && gaps.size === value.gaps.length,
		"Duplicate coverage page",
	);
	for (const page of [...extracted, ...gaps]) {
		requireContract(integer(page, 1, value.totalPages), "Invalid coverage page");
	}
	// A partially extracted page may be in both sets; every page must be accounted for.
	for (let page = 1; page <= value.totalPages; page++) {
		requireContract(extracted.has(page) || gaps.has(page), "Unaccounted coverage page");
	}
	requireContract(value.status === (gaps.size === 0 ? "complete" : "incomplete"), "Inconsistent coverage status");
}

function assertMetadata<T>(field: MetadataField<T>, pageCount: number): void {
	for (const evidence of field.evidence) {
		if (evidence.location) assertPdfLocation(evidence.location, pageCount);
	}
	const same = (a: T | null, b: T | null) => JSON.stringify(a) === JSON.stringify(b);
	const selected = field.evidence.some((evidence) => same(evidence.value, field.value));
	const conflicts = new Set(field.evidence.map((evidence) => JSON.stringify(evidence.value))).size > 1;
	if (field.resolution === "unknown") {
		requireContract(
			field.value === null && field.evidence.length === 0,
			"Unknown metadata must be null without evidence",
		);
	} else if (field.resolution === "agreed") {
		requireContract(field.value !== null && selected && !conflicts, "Metadata agreement lacks evidence");
	} else if (field.resolution === "conflict") {
		requireContract(conflicts && field.value === null, "Unresolved metadata conflict must remain null");
	} else {
		requireContract(
			field.resolution === "override" &&
				field.value !== null &&
				field.evidence.some((evidence) => evidence.origin === "operator-override" && same(evidence.value, field.value)),
			"Metadata override lacks explicit provenance",
		);
	}
}

function assertDiagnostic(value: Diagnostic, source: SourceVersion): void {
	if (value.source) assertSourceIdentity(value.source, source);
	if (value.location) assertPdfLocation(value.location, source.pageCount);
	requireContract(value.message.trim().length > 0, "Empty diagnostic");
	if (value.occurrences !== undefined)
		requireContract(integer(value.occurrences, 1, Number.MAX_SAFE_INTEGER), "Invalid diagnostic count");
	if (value.pageCount !== undefined || value.omittedPageCount !== undefined)
		requireContract(value.pageRanges !== undefined, "Diagnostic page summary lacks ranges");
	if (value.pageRanges !== undefined) {
		requireContract(value.pageRanges.length <= 32, "Diagnostic range budget exceeded");
		let previous = 0;
		let shown = 0;
		for (const [start, end] of value.pageRanges) {
			requireContract(
				integer(start, previous + 1, source.pageCount) && integer(end, start, source.pageCount),
				"Invalid diagnostic range",
			);
			previous = end;
			shown += end - start + 1;
		}
		requireContract(integer(value.pageCount ?? 0, shown, source.pageCount), "Invalid diagnostic page count");
		requireContract(value.omittedPageCount === (value.pageCount ?? 0) - shown, "Invalid omitted diagnostic pages");
		requireContract((value.occurrences ?? 0) >= (value.pageCount ?? 0), "Diagnostic count smaller than page count");
	}
}

// Problem: readonly types alone do not stop mutation through caller-owned arrays.
// Example: changing a source hash after validation invalidates every citation.
// Solution: validated constructors detach and recursively freeze plain contract data.
function immutable<T>(value: T): T {
	const copy: T = structuredClone(value);
	function freeze(item: unknown): void {
		if (item !== null && typeof item === "object") {
			for (const child of Object.values(item)) freeze(child);
			Object.freeze(item);
		}
	}
	freeze(copy);
	return copy;
}

export function defineSource(value: SourceVersion): SourceVersion {
	assertSourceIdentity(value);
	requireContract(value.format === "pdf", "Unsupported source format");
	requireContract(
		value.originalPath.startsWith("/") && !value.originalPath.includes("\0"),
		"Expected local absolute path",
	);
	requireContract(integer(value.pageCount, 1, 2000), "Invalid page count");
	hash(value.extractor.configurationHash);
	requireContract(
		value.extractor.name.trim().length > 0 && value.extractor.version.trim().length > 0,
		"Missing extractor identity",
	);
	assertCoverage(value.coverage);
	requireContract(value.coverage.totalPages === value.pageCount, "Coverage/source page mismatch");
	assertMetadata(value.metadata.title, value.pageCount);
	assertMetadata(value.metadata.authors, value.pageCount);
	assertMetadata(value.metadata.publisher, value.pageCount);
	assertMetadata(value.metadata.edition, value.pageCount);
	assertMetadata(value.metadata.publicationDate, value.pageCount);
	for (const diagnostic of value.diagnostics) assertDiagnostic(diagnostic, value);
	return immutable(value);
}

function assertRange(range: TextRange, text: string, allowEmpty = false): void {
	requireContract(
		integer(range.start, 0, text.length) && integer(range.end, range.start + (allowEmpty ? 0 : 1), text.length),
		"Invalid text range",
	);
	for (const offset of [range.start, range.end]) {
		const before = text.charCodeAt(offset - 1);
		const after = text.charCodeAt(offset);
		requireContract(
			!(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff),
			"Range splits Unicode scalar",
		);
	}
}

function assertHeadings(headings: readonly Heading[], source: SourceVersion): void {
	const ids = new Set<string>();
	for (const heading of headings) {
		id(heading.sectionId, "section");
		requireContract(!ids.has(heading.sectionId) && heading.title.trim().length > 0, "Invalid heading path");
		ids.add(heading.sectionId);
		assertPdfLocation(heading.location, source.pageCount);
	}
}

function assertLink(link: FigureLink, source: SourceVersion): void {
	id(link.figureId, "figure");
	assertPdfLocation(link.evidence.location, source.pageCount);
	if (link.evidence.kind === "explicit-reference") {
		requireContract(
			link.evidence.figureLabel.trim().length > 0 && link.evidence.referenceText.includes(link.evidence.figureLabel),
			"Figure reference lacks literal label evidence",
		);
	} else {
		requireContract(
			link.evidence.kind === "caption-layout" &&
				link.evidence.status === "uncertain" &&
				link.evidence.reason.trim().length > 0,
			"Layout figure links must remain uncertain",
		);
	}
}

export function definePassage(value: Passage, source: SourceVersion): Passage {
	assertSourceIdentity(value, source);
	id(value.id, "passage");
	id(value.parentSectionId, "section");
	hash(value.indexConfigurationHash);
	assertHeadings(value.headingPath, source);
	requireContract(
		value.headingPath.at(-1)?.sectionId === value.parentSectionId,
		"Parent section must end heading path",
	);
	requireContract(value.originalText.length > 0 && value.normalizedText.length > 0, "Empty passage text");
	let originalOffset = 0;
	let normalizedOffset = 0;
	for (const mapping of value.mappings) {
		assertRange(mapping.originalRange, value.originalText);
		assertRange(mapping.normalizedRange, value.normalizedText, mapping.kind === "omitted");
		requireContract(
			mapping.originalRange.start === originalOffset && mapping.normalizedRange.start === normalizedOffset,
			"Text mappings must cover both representations in order",
		);
		if (mapping.kind === "literal") {
			requireContract(
				value.originalText.slice(mapping.originalRange.start, mapping.originalRange.end) ===
					value.normalizedText.slice(mapping.normalizedRange.start, mapping.normalizedRange.end),
				"Literal mapping changes source text",
			);
		} else {
			requireContract(mapping.kind === "normalized" || mapping.kind === "omitted", "Invalid mapping kind");
			if (mapping.kind === "omitted") {
				requireContract(mapping.normalizedRange.start === mapping.normalizedRange.end, "Omitted mapping must be empty");
			}
		}
		originalOffset = mapping.originalRange.end;
		normalizedOffset = mapping.normalizedRange.end;
	}
	requireContract(
		originalOffset === value.originalText.length && normalizedOffset === value.normalizedText.length,
		"Incomplete text mappings",
	);
	let spanOffset = 0;
	let previousPage = 0;
	for (const span of value.spans) {
		id(span.blockId, "block");
		assertPdfLocation(span.location, source.pageCount);
		assertRange(span.originalRange, value.originalText);
		requireContract(
			span.originalRange.start === spanOffset && span.location.pageNumber >= previousPage,
			"Unordered source spans",
		);
		spanOffset = span.originalRange.end;
		previousPage = span.location.pageNumber;
	}
	requireContract(spanOffset === value.originalText.length, "Source spans must cover original text");
	for (const neighbor of [value.neighbors.previous, value.neighbors.next]) {
		if (neighbor !== null) {
			id(neighbor, "passage");
			requireContract(neighbor !== value.id, "Self-referencing passage neighbor");
		}
	}
	requireContract(
		value.neighbors.previous === null || value.neighbors.previous !== value.neighbors.next,
		"Duplicate passage neighbors",
	);
	for (const link of value.figures) assertLink(link, source);
	for (const diagnostic of value.quality) assertDiagnostic(diagnostic, source);
	return immutable(value);
}

export function defineFigure(value: Figure, source: SourceVersion): Figure {
	assertSourceIdentity(value, source);
	id(value.id, "figure");
	if (value.unavailable)
		requireContract(
			value.unavailable.status === "unsupported" && value.unavailable.reason === "no_render_operators",
			"Invalid unavailable figure reason",
		);
	assertPdfLocation(value.location, source.pageCount);
	if (value.rendering.kind === "crop") {
		assertBounds(value.rendering.bounds, value.location);
	} else {
		requireContract(
			value.rendering.kind === "full-page-fallback" && value.rendering.reason.trim().length > 0,
			"Missing full-page fallback explanation",
		);
	}
	for (const link of value.linkingEvidence) {
		requireContract(link.figureId === value.id, "Figure link identity mismatch");
		assertLink(link, source);
		if (link.evidence.kind === "explicit-reference") {
			requireContract(value.label === link.evidence.figureLabel, "Figure label mismatch");
		}
	}
	for (const diagnostic of value.diagnostics) assertDiagnostic(diagnostic, source);
	return immutable(value);
}

// Precedence: unavailable > incomplete_corpus > insufficient_evidence > ok.
// Corpus assessment refers to hosted publication/index completeness, not extraction.
// Extraction gaps remain explicit in coverage/diagnostics, even for ok/insufficient_evidence.
// A backend outage with useful local hits is still unavailable, not an absence claim.
// Independent assessment fields, coverage, hits and diagnostics survive precedence.
export function searchStatus(value: SearchAssessment): SearchStatus {
	if (value.backend === "unavailable") return "unavailable";
	if (value.corpus === "incomplete") return "incomplete_corpus";
	if (value.evidence === "insufficient") return "insufficient_evidence";
	return "ok";
}

export function defineSearchResult(value: Omit<SearchResult, "status">): SearchResult {
	requireContract(value.hits.length <= 5, "Too many search hits");
	requireContract(
		value.evidence === "candidates" ? value.hits.length > 0 : value.hits.length === 0,
		"Inconsistent evidence assessment",
	);
	const sources = new Map<VersionId, SourceIdentity>();
	for (const entry of value.coverage) {
		assertSourceIdentity(entry.source);
		assertCoverage(entry.coverage);
		requireContract(!sources.has(entry.source.versionId), "Duplicate coverage version");
		sources.set(entry.source.versionId, entry.source);
	}
	const ids = new Set<PassageId>();
	for (const hit of value.hits) {
		const source = sources.get(hit.versionId);
		requireContract(source !== undefined, "Search hit lacks source coverage");
		assertSourceIdentity(hit, source);
		id(hit.passageId, "passage");
		requireContract(!ids.has(hit.passageId), "Duplicate search hit");
		ids.add(hit.passageId);
		requireContract(hit.excerpt.length > 0 && hit.excerpt.length <= 800, "Invalid search excerpt budget");
		requireContract(hit.locations.length > 0, "Search hit lacks location");
		const pages = value.coverage.find((entry) => entry.source.versionId === hit.versionId)?.coverage.totalPages ?? 0;
		for (const location of hit.locations) assertPdfLocation(location, pages);
		for (const score of [hit.scores.dense, hit.scores.lexical]) {
			requireContract(score === null || Number.isFinite(score), "Invalid ranking score");
		}
	}
	for (const diagnostic of value.diagnostics) {
		requireContract(diagnostic.message.trim().length > 0, "Empty diagnostic");
		if (diagnostic.source) {
			const source = sources.get(diagnostic.source.versionId);
			requireContract(source !== undefined, "Diagnostic lacks source coverage");
			assertSourceIdentity(diagnostic.source, source);
		}
	}
	return immutable({ ...value, status: searchStatus(value) });
}
