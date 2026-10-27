import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertCoverage,
	assertPdfLocation,
	assertSourceIdentity,
	defineFigure,
	definePassage,
	defineSearchResult,
	defineSource,
	type Figure,
	type FigureLink,
	type MetadataField,
	type Passage,
	type PdfLocation,
	type SearchAssessment,
	type SearchHit,
	type SourceVersion,
	searchStatus,
} from "../src/contracts.ts";

const identity = {
	bookId: `book_${"a".repeat(32)}`,
	versionId: `version_${"b".repeat(32)}`,
	sourceHash: `sha256:${"c".repeat(64)}`,
} as const;
const sectionId = `section_${"d".repeat(32)}` as const;
const passageId = `passage_${"e".repeat(32)}` as const;
const figureId = `figure_${"f".repeat(32)}` as const;
const configurationHash = `sha256:${"0".repeat(64)}` as const;
const unknown = <T>(): MetadataField<T> => ({ value: null, evidence: [], resolution: "unknown" });
const location = (pageNumber = 1): PdfLocation => ({
	kind: "pdf",
	pageNumber,
	printedLabel: null,
	coordinateSystem: "pdf-points-top-left",
	pageWidth: 600,
	pageHeight: 800,
	bounds: [20, 30, 580, 100],
});

function source(): SourceVersion {
	return {
		...identity,
		format: "pdf",
		originalPath: "/synthetic/private/book.pdf",
		pageCount: 2,
		metadata: {
			title: unknown(),
			authors: unknown(),
			publisher: unknown(),
			edition: unknown(),
			publicationDate: unknown(),
		},
		extractor: { name: "synthetic", version: "1", configurationHash },
		coverage: { totalPages: 2, extractedPages: [1, 2], gaps: [], status: "complete" },
		diagnostics: [],
	};
}

const link: FigureLink = {
	figureId,
	evidence: {
		kind: "explicit-reference",
		figureLabel: "Figure 1-2",
		referenceText: "See Figure 1-2.",
		location: location(1),
	},
};

function passage(): Passage {
	return {
		...identity,
		id: passageId,
		parentSectionId: sectionId,
		headingPath: [{ sectionId, title: "Synthetic section", location: location() }],
		originalText: "a  b",
		normalizedText: "a b",
		mappings: [
			{ kind: "literal", originalRange: { start: 0, end: 1 }, normalizedRange: { start: 0, end: 1 } },
			{ kind: "normalized", originalRange: { start: 1, end: 3 }, normalizedRange: { start: 1, end: 2 } },
			{ kind: "literal", originalRange: { start: 3, end: 4 }, normalizedRange: { start: 2, end: 3 } },
		],
		spans: [
			{ blockId: `block_${"1".repeat(32)}`, location: location(), originalRange: { start: 0, end: 2 } },
			{ blockId: `block_${"2".repeat(32)}`, location: location(2), originalRange: { start: 2, end: 4 } },
		],
		neighbors: { previous: null, next: null },
		figures: [link],
		quality: [],
		indexConfigurationHash: configurationHash,
	};
}

function figure(): Figure {
	return {
		...identity,
		id: figureId,
		label: "Figure 1-2",
		caption: null,
		location: location(2),
		rendering: { kind: "full-page-fallback", reason: "Crop bounds unknown" },
		linkingEvidence: [link],
		diagnostics: [],
	};
}

function hit(): SearchHit {
	return {
		...identity,
		passageId,
		excerpt: "a  b",
		locations: [location()],
		headingPath: passage().headingPath,
		figures: [link],
		scores: { dense: 0.8, lexical: null },
	};
}

function search(assessment: SearchAssessment) {
	return {
		...assessment,
		hits: assessment.evidence === "candidates" ? [hit()] : [],
		coverage: [{ source: identity, coverage: source().coverage }],
		diagnostics: [
			{ code: "backend_unavailable", message: "Synthetic partial diagnostic", source: null, location: null },
		] as const,
	};
}

test("optional source contracts preserve unknown metadata and detached immutable identities", () => {
	const input = source();
	const result = defineSource(input);
	assert.equal(result.metadata.edition.value, null);
	assert.equal(result.metadata.authors.value, null);
	assert.notEqual(result, input);
	assert.ok(Object.isFrozen(result));
	assert.ok(Object.isFrozen(result.coverage.extractedPages));
	assert.throws(() => Object.assign(result, { sourceHash: configurationHash }), TypeError);
	assert.throws(() => Object.assign(result.coverage.extractedPages, { 0: 2 }), TypeError);
	Object.assign(input, { originalPath: "/different.pdf" });
	assert.equal(result.originalPath, "/synthetic/private/book.pdf");
});

test("metadata conflicts retain both provenance sources until an explicit override", () => {
	const input = source();
	const authors: MetadataField<readonly string[]> = {
		value: null,
		resolution: "conflict",
		evidence: [
			{ origin: "file-metadata", value: ["Synthetic First"], location: null },
			{ origin: "title-page", value: ["Synthetic First", "Synthetic Second"], location: location() },
		],
	};
	const withAuthors = (field: MetadataField<readonly string[]>) => ({
		...input,
		metadata: { ...input.metadata, authors: field },
	});
	assert.equal(defineSource(withAuthors(authors)).metadata.authors.evidence.length, 2);
	assert.throws(() => defineSource(withAuthors({ ...authors, value: ["Synthetic First"] })), /conflict/);
	assert.throws(
		() => defineSource(withAuthors({ ...authors, resolution: "agreed", value: ["Synthetic First"] })),
		/agreement/,
	);
	assert.throws(
		() => defineSource(withAuthors({ ...authors, resolution: "override", value: ["Synthetic First"] })),
		/provenance/,
	);
	const overridden = defineSource(
		withAuthors({
			...authors,
			resolution: "override",
			value: ["Synthetic First", "Synthetic Second"],
			evidence: [
				...authors.evidence,
				{ origin: "operator-override", value: ["Synthetic First", "Synthetic Second"], location: null },
			],
		}),
	);
	assert.equal(overridden.metadata.authors.evidence.length, 3);
	assert.throws(
		() =>
			defineSource({ ...input, metadata: { ...input.metadata, title: { ...unknown<string>(), value: "Guessed" } } }),
		/Unknown metadata/,
	);
});

test("PDF locations reject impossible physical pages, coordinate systems and geometry", () => {
	for (const page of [0, -1, 3, 1.5, NaN, Infinity]) {
		assert.throws(() => assertPdfLocation(location(page), 2), /physical PDF page/);
	}
	for (const bounds of [
		[-1, 0, 1, 2],
		[0, 0, 601, 10],
		[0, 0, 10, 801],
		[10, 10, 9, 20],
		[0, 0, 0, 0],
		[0, 0, NaN, 2],
	] as const) {
		assert.throws(() => assertPdfLocation({ ...location(), bounds }, 2), /bounds/);
	}
	assert.throws(() => assertPdfLocation({ ...location(), pageWidth: Infinity }, 2), /dimensions/);
	assert.throws(
		() => assertPdfLocation({ ...location(), coordinateSystem: "unknown" as PdfLocation["coordinateSystem"] }, 2),
		/coordinate/,
	);
	assert.doesNotThrow(() => assertPdfLocation({ ...location(), bounds: null, printedLabel: "xii" }, 2));
	assert.equal(location().printedLabel, null);
});

test("source identity, format, coverage and extractor inconsistencies fail closed", () => {
	const input = source();
	for (const changed of [
		{ ...identity, bookId: `book_${"0".repeat(32)}` as const },
		{ ...identity, versionId: `version_${"0".repeat(32)}` as const },
		{ ...identity, sourceHash: configurationHash },
	]) {
		assert.throws(() => assertSourceIdentity(changed, identity), /Inconsistent/);
		assert.throws(() => definePassage({ ...passage(), ...changed }, input), /Inconsistent/);
		assert.throws(() => defineFigure({ ...figure(), ...changed }, input), /Inconsistent/);
	}
	assert.throws(() => defineSource({ ...input, bookId: "book_../../outside" }), /ID/);
	assert.throws(() => defineSource({ ...input, sourceHash: "sha256:bad" }), /SHA-256/);
	assert.throws(() => defineSource({ ...input, format: "other" as "pdf" }), /format/);
	assert.throws(
		() => defineSource({ ...input, coverage: { ...input.coverage, totalPages: 3, extractedPages: [1, 2, 3] } }),
		/mismatch/,
	);
	assert.throws(() => defineSource({ ...input, extractor: { ...input.extractor, version: "" } }), /extractor/);
	assert.throws(() => defineSource({ ...input, originalPath: "relative.pdf" }), /absolute path/);
});

test("coverage distinguishes scanned, partial and complete pages without hiding gaps", () => {
	const coverage = {
		totalPages: 2,
		extractedPages: [1],
		gaps: [{ pageNumber: 2, reason: "scanned_page" }],
		status: "incomplete",
	} as const;
	assert.doesNotThrow(() => assertCoverage(coverage));
	assert.doesNotThrow(() => assertCoverage({ ...coverage, extractedPages: [1, 2] }));
	assert.throws(() => assertCoverage({ ...coverage, status: "complete" }), /status/);
	assert.throws(() => assertCoverage({ ...coverage, gaps: [] }), /Unaccounted/);
	assert.throws(() => assertCoverage({ ...coverage, extractedPages: [1, 1] }), /Duplicate/);
	assert.throws(() => assertCoverage({ ...coverage, gaps: [{ pageNumber: 3, reason: "scanned_page" }] }), /page/);
});

test("passages preserve distinct original/normalized text, ordered spans, headings and cross-page links", () => {
	const result = definePassage(passage(), source());
	assert.equal(result.originalText, "a  b");
	assert.equal(result.normalizedText, "a b");
	assert.deepEqual(
		result.spans.map((span) => span.location.pageNumber),
		[1, 2],
	);
	assert.equal(result.headingPath[0]?.title, "Synthetic section");
	assert.equal(result.figures[0]?.evidence.location.pageNumber, 1);
	assert.ok(Object.isFrozen(result.mappings[0]?.originalRange));
	assert.throws(() => definePassage({ ...passage(), mappings: [] }, source()), /Incomplete/);
	assert.throws(
		() =>
			definePassage(
				{
					...passage(),
					mappings: [{ kind: "literal", originalRange: { start: 0, end: 4 }, normalizedRange: { start: 0, end: 3 } }],
				},
				source(),
			),
		/Literal/,
	);
	assert.throws(() => definePassage({ ...passage(), spans: [...passage().spans].reverse() }, source()), /Unordered/);
	assert.throws(() => definePassage({ ...passage(), headingPath: [] }, source()), /Parent section/);
	assert.throws(
		() => definePassage({ ...passage(), neighbors: { previous: passageId, next: null } }, source()),
		/Self-referencing/,
	);
	assert.throws(
		() =>
			definePassage(
				{
					...passage(),
					mappings: [
						{ kind: "normalized", originalRange: { start: 0, end: 5 }, normalizedRange: { start: 0, end: 3 } },
					],
				},
				source(),
			),
		/range/,
	);
});

test("text mappings represent omissions explicitly and reject splitting Unicode scalars", () => {
	const input = passage();
	assert.doesNotThrow(() =>
		definePassage(
			{
				...input,
				originalText: "a b",
				normalizedText: "ab",
				mappings: [
					{ kind: "literal", originalRange: { start: 0, end: 1 }, normalizedRange: { start: 0, end: 1 } },
					{ kind: "omitted", originalRange: { start: 1, end: 2 }, normalizedRange: { start: 1, end: 1 } },
					{ kind: "literal", originalRange: { start: 2, end: 3 }, normalizedRange: { start: 1, end: 2 } },
				],
				spans: [{ blockId: `block_${"1".repeat(32)}`, location: location(), originalRange: { start: 0, end: 3 } }],
			},
			source(),
		),
	);
	assert.throws(() => definePassage({ ...input, originalText: "a\u{1f600}b" }, source()), /Unicode scalar/);
});

test("figure records require supported bounds or an explicit full-page fallback and honest linking evidence", () => {
	const result = defineFigure(figure(), source());
	assert.equal(result.location.pageNumber, 2);
	assert.equal(result.linkingEvidence[0]?.evidence.location.pageNumber, 1);
	assert.equal(result.caption, null);
	assert.equal(result.rendering.kind, "full-page-fallback");
	assert.throws(
		() => defineFigure({ ...figure(), rendering: { kind: "crop", bounds: [0, 0, 601, 800] } }, source()),
		/bounds/,
	);
	assert.throws(
		() => defineFigure({ ...figure(), rendering: { kind: "full-page-fallback", reason: "" } }, source()),
		/fallback/,
	);
	assert.throws(() => defineFigure({ ...figure(), label: "Different figure" }, source()), /label mismatch/);
	const uncertain: FigureLink = {
		figureId,
		evidence: { kind: "caption-layout", status: "uncertain", reason: "Nearby caption only", location: location() },
	};
	assert.doesNotThrow(() => defineFigure({ ...figure(), linkingEvidence: [uncertain] }, source()));
	assert.throws(
		() =>
			defineFigure(
				{ ...figure(), linkingEvidence: [{ ...uncertain, figureId: `figure_${"0".repeat(32)}` }] },
				source(),
			),
		/identity mismatch/,
	);
	assert.throws(
		() =>
			definePassage(
				{
					...passage(),
					figures: [
						{
							figureId,
							evidence: {
								...link.evidence,
								kind: "explicit-reference",
								figureLabel: "Absent label",
								referenceText: "No explicit reference",
							},
						},
					],
				},
				source(),
			),
		/literal label/,
	);
});

test("all eight status combinations obey explicit precedence and retain partial diagnostics", () => {
	for (const backend of ["available", "unavailable"] as const) {
		for (const corpus of ["complete", "incomplete"] as const) {
			for (const evidence of ["candidates", "insufficient"] as const) {
				const assessment = { backend, corpus, evidence };
				const expected =
					backend === "unavailable"
						? "unavailable"
						: corpus === "incomplete"
							? "incomplete_corpus"
							: evidence === "insufficient"
								? "insufficient_evidence"
								: "ok";
				assert.equal(searchStatus(assessment), expected);
				const input = search(assessment);
				const result = defineSearchResult(input);
				assert.equal(result.status, expected);
				assert.deepEqual(result.hits, input.hits);
				assert.deepEqual(result.diagnostics, input.diagnostics);
				assert.deepEqual(result.coverage, input.coverage);
				assert.equal(result.evidence, evidence);
				assert.ok(Object.isFrozen(result.diagnostics));
			}
		}
	}
});

test("search rejects missing coverage, inconsistent identities, impossible locations and invalid scores", () => {
	const input = search({ backend: "available", corpus: "complete", evidence: "candidates" });
	assert.throws(() => defineSearchResult({ ...input, coverage: [] }), /coverage/);
	assert.throws(
		() => defineSearchResult({ ...input, hits: [{ ...hit(), sourceHash: configurationHash }] }),
		/identity/,
	);
	assert.throws(() => defineSearchResult({ ...input, hits: [{ ...hit(), locations: [location(3)] }] }), /page/);
	assert.throws(
		() => defineSearchResult({ ...input, hits: [{ ...hit(), scores: { dense: NaN, lexical: null } }] }),
		/score/,
	);
	assert.throws(() => defineSearchResult({ ...input, evidence: "insufficient" }), /evidence/);
	assert.throws(() => defineSearchResult({ ...input, hits: [hit(), hit()] }), /Duplicate/);
	assert.throws(() => defineSearchResult({ ...input, hits: [{ ...hit(), excerpt: "x".repeat(801) }] }), /budget/);
	assert.throws(() => defineSearchResult({ ...input, hits: Array.from({ length: 6 }, hit) }), /Too many/);
	assert.throws(
		() =>
			defineSearchResult({
				...input,
				coverage: [
					{
						source: identity,
						coverage: {
							...source().coverage,
							status: "incomplete",
							gaps: [{ pageNumber: 2, reason: "uncertain_table" }],
						},
					},
				],
			}),
		/Incomplete coverage/,
	);
});
