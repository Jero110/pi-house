import { AdapterError, boundedInteger, defaultRelevanceGate, type RelevanceGate } from "./config.ts";
import type {
	BookId,
	Diagnostic,
	FigureId,
	Passage,
	PassageId,
	SearchHit,
	SearchResult,
	SourceIdentity,
} from "./contracts.ts";
import { defineSearchResult } from "./contracts.ts";
import type { LocalEmbeddings } from "./embeddings.ts";
import { embeddingIdentity } from "./embeddings.ts";
import { validateFigureAsset } from "./figures.ts";
import type { Catalog, HostedVersion } from "./indexing.ts";
import { loadCatalog, resolveHostedPassage, validationSource } from "./indexing.ts";
import type { Objects } from "./objects.ts";
import type { Pinecone, PineconeMatch } from "./pinecone.ts";
import { incompatibleSchemaMessage, recordSchema } from "./pinecone.ts";

/** Frozen synthetic cosine gate v1, evaluated in search.test.ts, not a promise
 * about live Nomic retrieval. Absolute floor 0.78 rejects evaluated unrelated
 * scores; a 0.08 band excludes weaker neighbors behind the strongest evidence.
 * No per-question tuning and no confidence/probability interpretation. T8 must
 * publish broader evaluation and keep real-model calibration explicitly pending. */
export const relevanceGate: RelevanceGate = defaultRelevanceGate;
/** The gate is configurable (BOOKS_RELEVANCE_FLOOR / BOOKS_RELEVANCE_MARGIN, validated in config.ts) and every
 * search result reports the version and numbers it used. */
export function gatedCandidates(
	matches: readonly PineconeMatch[],
	gate: RelevanceGate = relevanceGate,
): readonly PineconeMatch[] {
	const ordered = [...matches].sort((a, b) => b.score - a.score);
	const best = ordered[0]?.score ?? -Infinity;
	return ordered.filter(
		(m) => Number.isFinite(m.score) && m.score >= gate.minimumScore && best - m.score <= gate.maximumDrop,
	);
}
export interface SearchServices {
	readonly objects: Objects;
	readonly pinecone: Pick<Pinecone, "query" | "fetch">;
	readonly embeddings: Pick<LocalEmbeddings, "query">;
	/** Defaults to the frozen synthetic gate. */
	readonly gate?: RelevanceGate;
}
export interface SearchInput {
	readonly query: string;
	readonly bookIds?: readonly BookId[];
	readonly limit?: number;
}
const diagnostic = (code: Diagnostic["code"], message: string): Diagnostic => ({
	code,
	message,
	source: null,
	location: null,
});
function sourceIdentity(version: HostedVersion): SourceIdentity {
	const { bookId, versionId, sourceHash } = version.source;
	return { bookId, versionId, sourceHash };
}
function selected(catalog: Catalog | null, ids?: readonly BookId[]): readonly HostedVersion[] {
	return catalog?.versions.filter((v) => !ids || ids.includes(v.source.bookId)) ?? [];
}
function sliceLiteral(text: string, limit: number): string {
	let end = Math.min(limit, text.length);
	if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
	return text.slice(0, end);
}
/** Every query uses local embeddings only, with no translation/generation call.
 * Candidate errors retain diagnostics; service failure is never absence evidence. */
export async function searchBooks(services: SearchServices, input: SearchInput): Promise<SearchResult> {
	const limit = boundedInteger(input.limit ?? 5, 1, 5, "search results");
	if (
		typeof input.query !== "string" ||
		!input.query.trim() ||
		input.query.length > 1800 ||
		!input.query.isWellFormed()
	)
		throw new AdapterError("resource_limit", "Invalid bounded search query");
	if (input.bookIds && (input.bookIds.length > 20 || input.bookIds.some((id) => !/^book_[a-f0-9]{32}$/u.test(id))))
		throw new AdapterError("configuration", "Invalid book filter");
	const gate = services.gate ?? relevanceGate;
	const diagnostics: Diagnostic[] = [];
	const hits: SearchHit[] = [];
	let versions: readonly HostedVersion[] = [];
	let incomplete = false;
	let stage: "catalog" | "embedding" | "pinecone" = "catalog";
	try {
		const state = await loadCatalog(services.objects);
		versions = selected(state.catalog, input.bookIds);
		incomplete = state.incomplete || versions.some((v) => v.source.coverage.status === "incomplete");
		if (state.incomplete)
			diagnostics.push(
				diagnostic(
					"index_incomplete",
					"Hosted publication is incomplete; only committed compatible generations can supply evidence",
				),
			);
		if (versions.some((v) => v.source.coverage.status === "incomplete"))
			diagnostics.push(
				diagnostic("extraction_failed", "Selected corpus has extraction gaps; coverage is not complete"),
			);
		if (!state.catalog || !versions.length) return result();
		stage = "embedding";
		const vector = await services.embeddings.query(input.query, embeddingIdentity);
		stage = "pinecone";
		const verified: { match: PineconeMatch; passage: Passage }[] = [];
		const seen = new Set<string>();
		// Per-source generations prevent a partial update of one book from making
		// another book's records current. At most 20 manifest books / 20 candidates.
		for (const version of versions) {
			const candidates = await services.pinecone.query(vector, embeddingIdentity, {
				generation: version.generation,
				versionIds: [version.source.versionId],
				topK: 20,
			});
			for (const match of candidates) {
				if (match.metadata.schema !== recordSchema) {
					// Per candidate, like any stale record: valid schema-2 candidates still count.
					incomplete = true;
					const message = incompatibleSchemaMessage(match.metadata.schema);
					if (!diagnostics.some((d) => d.message === message))
						diagnostics.push(diagnostic("identity_mismatch", message));
					continue;
				}
				try {
					const passage = resolveHostedPassage(match.id, match.metadata, version);
					if (!seen.has(passage.id)) {
						verified.push({ match, passage });
						seen.add(passage.id);
					}
				} catch {
					incomplete = true;
					diagnostics.push(
						diagnostic(
							"stale_index",
							"Dropped candidate: source/hash/generation/configuration or hosted content differs from the committed manifest",
						),
					);
				}
			}
		}
		const accepted = new Set(
			gatedCandidates(
				verified.map((v) => v.match),
				gate,
			).map((m) => m.id),
		);
		for (const { match, passage } of verified.sort((a, b) => b.match.score - a.match.score)) {
			if (!accepted.has(match.id) || hits.length >= limit) continue;
			hits.push({
				bookId: passage.bookId,
				versionId: passage.versionId,
				sourceHash: passage.sourceHash,
				passageId: passage.id,
				excerpt: sliceLiteral(passage.originalText, 800),
				locations: passage.spans.map((s) => s.location),
				headingPath: passage.headingPath,
				figures: passage.figures,
				scores: { dense: match.score, lexical: null },
			});
		}
		// Detect publication changes during multi-request searches, including a
		// new pending writer. Never return evidence from a superseded snapshot.
		stage = "catalog";
		const after = await loadCatalog(services.objects);
		if (after.hash !== state.hash) {
			hits.length = 0;
			incomplete = true;
			diagnostics.push(
				diagnostic("stale_index", "Catalog changed during search; retry against the current generation"),
			);
		}
		if (after.incomplete) incomplete = true;
		return result();
	} catch (error) {
		if (error instanceof AdapterError && error.code === "identity_mismatch" && stage === "catalog") {
			incomplete = true;
			diagnostics.push(diagnostic("identity_mismatch", "Hosted catalog/source consistency check failed"));
			return result();
		}
		diagnostics.push(
			diagnostic(
				stage === "embedding"
					? error instanceof AdapterError && error.code === "identity_mismatch"
						? "model_mismatch"
						: "runtime_unavailable"
					: "backend_unavailable",
				`${stage === "embedding" ? "Local embedding runtime" : stage === "catalog" ? "Hosted object storage/catalog" : "Pinecone"} unavailable or incompatible; no absence-of-evidence claim`,
			),
		);
		return result("unavailable");
	}
	function result(backend: "available" | "unavailable" = "available"): SearchResult {
		return defineSearchResult({
			backend,
			corpus: incomplete ? "incomplete" : "complete",
			evidence: hits.length ? "candidates" : "insufficient",
			hits,
			coverage: versions.map((v) => ({ source: sourceIdentity(v), coverage: v.source.coverage })),
			diagnostics,
			gate: { version: gate.version, minimumScore: gate.minimumScore, maximumDrop: gate.maximumDrop },
		});
	}
}
async function currentVersion(
	objects: Objects,
	id: string,
	kind: "passage" | "figure",
): Promise<{ version: HostedVersion; catalogHash: string | null }> {
	if (!new RegExp(`^${kind}_[a-f0-9]{32}$`, "u").test(id))
		throw new AdapterError("configuration", "Invalid hosted evidence ID");
	const state = await loadCatalog(objects);
	const version = state.catalog?.versions.find((v) =>
		kind === "passage" ? Object.hasOwn(v.passages, id) : v.figures.some((f) => f.figure.id === id),
	);
	if (!version) throw new AdapterError("identity_mismatch", "Evidence is not in a committed current generation");
	return { version, catalogHash: state.hash };
}
export interface HostedRead {
	readonly source: SourceIdentity;
	readonly passageId: PassageId;
	readonly text: string;
	readonly headingPath: Passage["headingPath"];
	readonly locations: Passage["spans"];
	readonly figures: Passage["figures"];
	readonly nextOffset: number | null;
	readonly originalVerification: "recorded-ingestion-hash-only";
}
export async function readHostedPassage(
	services: Pick<SearchServices, "objects" | "pinecone">,
	id: PassageId,
	options: { readonly offset?: number; readonly limit?: number } = {},
): Promise<HostedRead> {
	const limit = boundedInteger(options.limit ?? 4000, 1, 8000, "read characters");
	const offset = boundedInteger(options.offset ?? 0, 0, 1000000, "read offset");
	const { version, catalogHash } = await currentVersion(services.objects, id, "passage");
	const record = (await services.pinecone.fetch([id], embeddingIdentity)).find((r) => r.id === id);
	if (!record) throw new AdapterError("unavailable", "Committed passage is not yet visible in Pinecone");
	const passage = resolveHostedPassage(id, record.metadata, version);
	if (
		offset > passage.originalText.length ||
		(offset > 0 && /[\uD800-\uDBFF]/u.test(passage.originalText[offset - 1] ?? ""))
	)
		throw new AdapterError("configuration", "Read offset is outside a Unicode scalar boundary");
	const text = sliceLiteral(passage.originalText.slice(offset), limit);
	if (!text.length && offset < passage.originalText.length)
		throw new AdapterError("resource_limit", "Read limit cannot hold the next Unicode scalar");
	if ((await loadCatalog(services.objects)).hash !== catalogHash)
		throw new AdapterError("identity_mismatch", "Catalog changed during evidence read");
	return {
		source: sourceIdentity(version),
		passageId: id,
		text,
		headingPath: passage.headingPath,
		locations: passage.spans,
		figures: passage.figures,
		nextOffset: offset + text.length < passage.originalText.length ? offset + text.length : null,
		originalVerification: "recorded-ingestion-hash-only",
	};
}
export async function fetchHostedFigure(
	objects: Objects,
	id: FigureId,
): Promise<{
	readonly figure: HostedVersion["figures"][number]["figure"];
	readonly asset: ReturnType<typeof validateFigureAsset>;
}> {
	const { version, catalogHash } = await currentVersion(objects, id, "figure");
	const item = version.figures.find((f) => f.figure.id === id);
	if (!item) throw new AdapterError("identity_mismatch", "Figure is not in the manifest");
	const bytes = await objects.get(item.object.key, item.object.hash);
	const asset = validateFigureAsset(
		{ ...item.asset, base64: bytes.toString("base64") },
		validationSource(version.source),
		[item.figure],
	);
	if ((await loadCatalog(objects)).hash !== catalogHash)
		throw new AdapterError("identity_mismatch", "Catalog changed during figure read");
	return { figure: item.figure, asset };
}
