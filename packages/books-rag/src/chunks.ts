import type { BlockId, Figure, Heading, Passage, PdfLocation, TextMapping, TextRange } from "./contracts.ts";
import { definePassage } from "./contracts.ts";
import { linkFigures } from "./figures.ts";
import type { IngestBlock, PreparedIngest } from "./ingest.ts";
import { CorpusError, sha256 } from "./locations.ts";
import type { CorpusStore } from "./store.ts";

export const documentPrefix = "search_document: ";
/** Conservative WordPiece bound from T1 research; these units are NOT measured tokens. */
export function embeddingInputBound(input: string): number {
	if (!input.isWellFormed()) throw new CorpusError("resource_limit", "Embedding input contains unpaired surrogates");
	return Math.max(Buffer.byteLength(input), Buffer.byteLength(input.normalize("NFD").toLowerCase())) + 32;
}
export interface ChunkStructure {
	readonly kind: "text" | "code" | "table";
	readonly groupId: string;
	readonly part: number;
	readonly totalParts: number;
	/** First extracted row, NOT a verified semantic header. Never part of the quote
	 * unless it also appears literally in this chunk's source slices. */
	readonly sharedHeader: { readonly text: string; readonly blockId: BlockId; readonly location: PdfLocation } | null;
	readonly sourceSlices: readonly {
		readonly blockId: BlockId;
		readonly originalRange: TextRange;
		readonly normalizedRange: TextRange;
	}[];
}
export interface StructuralPassage extends Passage {
	readonly structure: ChunkStructure;
}
export function passageEmbeddingInput(
	passage: Pick<Passage, "headingPath" | "normalizedText"> & {
		readonly structure?: Pick<ChunkStructure, "sharedHeader">;
	},
): string {
	const header = passage.structure?.sharedHeader;
	return `${documentPrefix}${passage.headingPath.map((h) => h.title).join(" > ")}${header ? `\nFirst source row (unverified header): ${header.text}` : ""}\n\n${passage.normalizedText}`;
}
/** Production chunk bound in conservative units (UTF-8 bytes + 32 for the prefixed input; the model limit is
 * 2048, so this keeps about 12% headroom, roughly 400-450 English WordPiece tokens). Chosen with the compact
 * record schema so the largest measured hosted record stays under the 32 KB budget; see
 * docs/books-rag-evaluation.md. Not the synthetic 180/320 preference. */
export const productionTargetBound = 1800;
export interface ChunkOptions {
	/** Target in conservative bound units, including prefix, headings and allowance. */
	readonly targetBound?: number;
}
interface Piece {
	readonly block: IngestBlock;
	readonly original: string;
	readonly normalized: string;
	readonly mappings: readonly TextMapping[];
	readonly originalRange: TextRange;
	readonly normalizedRange: TextRange;
}
function whole(block: IngestBlock): Piece {
	return {
		block,
		original: block.originalText,
		normalized: block.normalizedText,
		mappings: block.mappings,
		originalRange: { start: 0, end: block.originalText.length },
		normalizedRange: { start: 0, end: block.normalizedText.length },
	};
}
function representation(
	pieces: readonly Piece[],
	headingPath: readonly Heading[],
	sharedHeader: ChunkStructure["sharedHeader"],
): string {
	return passageEmbeddingInput({
		headingPath,
		normalizedText: pieces.map((p) => p.normalized).join("\n"),
		structure: { sharedHeader },
	});
}

/** Split only at normalization/scalar boundaries, preferring whitespace for prose.
 * Example: a ligature expands to multiple searchable scalars; cutting the expansion
 * loses provenance. Slice the whole mapping, keep its block-relative offsets. */
function split(piece: Piece, fits: (candidate: Piece) => boolean): Piece[] {
	if (fits(piece)) return [piece];
	const result: Piece[] = [];
	let start = 0;
	while (start < piece.mappings.length) {
		let end = start;
		let accepted: Piece | null = null;
		let wordBoundary: { piece: Piece; end: number } | null = null;
		while (end < piece.mappings.length) {
			const first = piece.mappings[start];
			const last = piece.mappings[end];
			if (!first || !last) break;
			const os = first.originalRange.start;
			const ns = first.normalizedRange.start;
			const candidate: Piece = {
				block: piece.block,
				original: piece.original.slice(os, last.originalRange.end),
				normalized: piece.normalized.slice(ns, last.normalizedRange.end),
				originalRange: { start: os, end: last.originalRange.end },
				normalizedRange: { start: ns, end: last.normalizedRange.end },
				mappings: piece.mappings.slice(start, end + 1).map((m) => ({
					...m,
					originalRange: { start: m.originalRange.start - os, end: m.originalRange.end - os },
					normalizedRange: { start: m.normalizedRange.start - ns, end: m.normalizedRange.end - ns },
				})),
			};
			if (!fits(candidate)) break;
			accepted = candidate;
			end++;
			if (/\s$/u.test(candidate.original)) wordBoundary = { piece: candidate, end };
		}
		if (!accepted) throw new CorpusError("resource_limit", "Structural context leaves no room for a source scalar");
		if (end < piece.mappings.length && piece.block.kind === "text" && wordBoundary) {
			accepted = wordBoundary.piece;
			end = wordBoundary.end;
		}
		result.push(accepted);
		start = end;
	}
	return result;
}

export function chunkPreparedIngest(
	document: PreparedIngest,
	store: CorpusStore,
	figures: readonly Figure[] = [],
	options: ChunkOptions = {},
): readonly StructuralPassage[] {
	const target = options.targetBound ?? productionTargetBound;
	if (!Number.isSafeInteger(target) || target < 128 || target > 2048)
		throw new CorpusError("resource_limit", "Chunk bound must be between 128 and 2048");
	const root = document.sections[0];
	if (!root) throw new CorpusError("identity_mismatch", "Missing root section");
	const groups: { blocks: IngestBlock[]; path: readonly Heading[] }[] = [];
	let boundary = true;
	for (const block of document.blocks) {
		if (block.kind === "heading") {
			boundary = true;
			continue;
		}
		const path = block.headingPath.length
			? block.headingPath
			: [{ sectionId: root.id, title: "Unsectioned source", location: block.location }];
		const previous = groups.at(-1);
		if (
			!boundary &&
			previous?.blocks[0]?.kind === block.kind &&
			JSON.stringify(previous.path.map((h) => h.sectionId)) === JSON.stringify(path.map((h) => h.sectionId))
		)
			previous.blocks.push(block);
		else groups.push({ blocks: [block], path });
		boundary = false;
	}
	const drafts: StructuralPassage[] = [];
	for (const [groupIndex, group] of groups.entries()) {
		const first = group.blocks[0];
		if (!first || first.kind === "heading") continue;
		const sharedHeader =
			first.kind === "table" ? { text: first.normalizedText, blockId: first.id, location: first.location } : null;
		const parts: Piece[][] = [];
		let pending: Piece[] = [];
		for (const block of group.blocks) {
			for (const piece of split(
				whole(block),
				(p) => embeddingInputBound(representation([p], group.path, sharedHeader)) <= target,
			)) {
				if (
					pending.length &&
					embeddingInputBound(representation([...pending, piece], group.path, sharedHeader)) > target
				) {
					parts.push(pending);
					pending = [];
				}
				pending.push(piece);
			}
		}
		if (pending.length) parts.push(pending);
		for (const [part, pieces] of parts.entries()) {
			let originalText = "";
			let normalizedText = "";
			const mappings: TextMapping[] = [];
			const spans: Passage["spans"][number][] = [];
			for (const piece of pieces) {
				const o = originalText.length;
				const n = normalizedText.length;
				// Newlines are explicit extraction row separators, not guessed code repair.
				const separator = originalText.length ? "\n" : "";
				originalText += separator;
				normalizedText += separator;
				if (separator)
					mappings.push({
						originalRange: { start: o, end: o + 1 },
						normalizedRange: { start: n, end: n + 1 },
						kind: "literal",
					});
				for (const m of piece.mappings)
					mappings.push({
						...m,
						originalRange: {
							start: originalText.length + m.originalRange.start,
							end: originalText.length + m.originalRange.end,
						},
						normalizedRange: {
							start: normalizedText.length + m.normalizedRange.start,
							end: normalizedText.length + m.normalizedRange.end,
						},
					});
				originalText += piece.original;
				normalizedText += piece.normalized;
				spans.push({
					blockId: piece.block.id,
					location: piece.block.location,
					originalRange: { start: o, end: originalText.length },
				});
			}
			const quality = pieces.flatMap((p) => p.block.diagnostics);
			if (parts.length > 1)
				quality.push({
					code:
						first.kind === "table" ? "uncertain_table" : first.kind === "code" ? "uncertain_code" : "extraction_failed",
					message: `Oversized structural continuation ${part + 1}/${parts.length}; context shared separately from quote. Table header/cell relationships unverified; inspect source page. No code repair performed.`,
					source: {
						bookId: document.source.bookId,
						versionId: document.source.versionId,
						sourceHash: document.source.sourceHash,
					},
					location: pieces[0]?.block.location ?? null,
				});
			const id = store.recordId("passage", document.source, `chunk-${drafts.length}-${sha256(originalText)}`);
			const structure: ChunkStructure = {
				kind: first.kind,
				groupId: `group-${groupIndex}`,
				part: part + 1,
				totalParts: parts.length,
				sharedHeader,
				sourceSlices: pieces.map((p) => ({
					blockId: p.block.id,
					originalRange: p.originalRange,
					normalizedRange: p.normalizedRange,
				})),
			};
			drafts.push({
				bookId: document.source.bookId,
				versionId: document.source.versionId,
				sourceHash: document.source.sourceHash,
				id,
				parentSectionId: group.path.at(-1)?.sectionId ?? root.id,
				headingPath: group.path,
				originalText,
				normalizedText,
				mappings,
				spans,
				neighbors: { previous: null, next: null },
				figures: [],
				quality,
				indexConfigurationHash: document.indexConfigurationHash,
				structure,
			});
		}
	}
	return drafts.map((draft, index) => {
		const validated = definePassage(
			{
				...draft,
				neighbors: { previous: drafts[index - 1]?.id ?? null, next: drafts[index + 1]?.id ?? null },
				figures: linkFigures(draft, figures),
			},
			document.source,
		);
		// definePassage preserves and deep-freezes extra JSON fields, including this context.
		return validated as StructuralPassage;
	});
}
