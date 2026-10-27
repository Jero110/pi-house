import type { ChunkStructure } from "./chunks.ts";
import type { HttpOptions } from "./config.ts";
import {
	AdapterError,
	BoundedQueue,
	boundedInteger,
	endpoint,
	record,
	requestJson,
	VerificationCache,
} from "./config.ts";
import type { Passage, PdfLocation, TextRange } from "./contracts.ts";
import { assertSourceIdentity } from "./contracts.ts";
import { assertEmbeddingIdentity, validateVector } from "./embeddings.ts";

export type PineconeMetadata = Record<string, string | number | boolean | string[]>;
export interface PineconeRecord {
	readonly id: string;
	readonly values: readonly number[];
	readonly metadata: PineconeMetadata;
}
export function assertPassageId(id: string): void {
	if (!/^passage_[a-f0-9]{32}$/u.test(id)) throw new AdapterError("configuration", "Expected opaque passage ID");
}
const location = (l: PdfLocation) => ({
	kind: l.kind,
	pageNumber: l.pageNumber,
	printedLabel: l.printedLabel,
	coordinateSystem: l.coordinateSystem,
	pageWidth: l.pageWidth,
	pageHeight: l.pageHeight,
	bounds: l.bounds === null ? null : [...l.bounds],
});
const range = (r: TextRange) => ({ start: r.start, end: r.end });
const metadataKeys = new Set([
	"schema",
	"bookId",
	"versionId",
	"sourceHash",
	"indexConfigurationHash",
	"generation",
	"originalText",
	"normalizedText",
	"parentSectionId",
	"headingPath",
	"spans",
	"mappings",
	"neighbors",
	"figures",
	"figureIds",
	"qualityCodes",
	"structure",
]);
function hostedMetadata(value: PineconeMetadata): void {
	validateMetadata(value);
	if (
		Object.keys(value).some((key) => !metadataKeys.has(key)) ||
		value.schema !== 1 ||
		typeof value.generation !== "string" ||
		typeof value.originalText !== "string" ||
		typeof value.normalizedText !== "string"
	)
		throw new AdapterError("configuration", "Only allowlisted hosted passage metadata is permitted");
	assertGeneration(value.generation);
}
/** Flat Pinecone types, with structured citation fields encoded as JSON strings.
 * Only explicit fields cross the boundary, never a SourceVersion/originalPath or
 * an arbitrary caller object. Oversized records fail instead of losing evidence. */
export function passageRecord(
	passage: Passage & { readonly structure?: ChunkStructure },
	vector: readonly number[],
	generation: string,
): PineconeRecord {
	assertSourceIdentity(passage);
	assertPassageId(passage.id);
	assertGeneration(generation);
	const metadata: PineconeMetadata = {
		schema: 1,
		bookId: passage.bookId,
		versionId: passage.versionId,
		sourceHash: passage.sourceHash,
		indexConfigurationHash: passage.indexConfigurationHash,
		generation,
		originalText: passage.originalText,
		normalizedText: passage.normalizedText,
		parentSectionId: passage.parentSectionId,
		headingPath: JSON.stringify(
			passage.headingPath.map((h) => ({ sectionId: h.sectionId, title: h.title, location: location(h.location) })),
		),
		spans: JSON.stringify(
			passage.spans.map((s) => ({
				blockId: s.blockId,
				location: location(s.location),
				originalRange: range(s.originalRange),
			})),
		),
		mappings: JSON.stringify(
			passage.mappings.map((m) => ({
				kind: m.kind,
				originalRange: range(m.originalRange),
				normalizedRange: range(m.normalizedRange),
			})),
		),
		neighbors: JSON.stringify({ previous: passage.neighbors.previous, next: passage.neighbors.next }),
		figures: JSON.stringify(
			passage.figures.map((f) => ({
				figureId: f.figureId,
				evidence:
					f.evidence.kind === "explicit-reference"
						? {
								kind: f.evidence.kind,
								figureLabel: f.evidence.figureLabel,
								referenceText: f.evidence.referenceText,
								location: location(f.evidence.location),
							}
						: {
								kind: f.evidence.kind,
								status: f.evidence.status,
								reason: f.evidence.reason,
								location: location(f.evidence.location),
							},
			})),
		),
		figureIds: passage.figures.map((f) => f.figureId),
		qualityCodes: passage.quality.map((d) => d.code),
	};
	if (passage.structure) {
		const s = passage.structure;
		metadata.structure = JSON.stringify({
			kind: s.kind,
			groupId: s.groupId,
			part: s.part,
			totalParts: s.totalParts,
			sharedHeader:
				s.sharedHeader === null
					? null
					: { text: s.sharedHeader.text, blockId: s.sharedHeader.blockId, location: location(s.sharedHeader.location) },
			sourceSlices: s.sourceSlices.map((slice) => ({
				blockId: slice.blockId,
				originalRange: range(slice.originalRange),
				normalizedRange: range(slice.normalizedRange),
			})),
		});
	}
	validateMetadata(metadata);
	return { id: passage.id, values: validateVector(vector), metadata };
}
function assertGeneration(value: string): void {
	if (!/^[a-f0-9]{32}$/u.test(value)) throw new AdapterError("configuration", "Expected opaque index generation");
}
export function validateMetadata(value: PineconeMetadata): void {
	for (const item of Object.values(value)) {
		if (
			!(
				typeof item === "string" ||
				typeof item === "boolean" ||
				(typeof item === "number" && Number.isFinite(item)) ||
				(Array.isArray(item) && item.every((s: unknown) => typeof s === "string"))
			)
		)
			throw new AdapterError("resource_limit", "Pinecone metadata must be flat, finite, non-null allowed types");
	}
	if (Buffer.byteLength(JSON.stringify(value)) > 40 * 1024)
		throw new AdapterError("resource_limit", "Pinecone metadata exceeds 40 KB; evidence was not truncated");
}
export interface PineconeOptions extends HttpOptions {
	readonly apiKey: string;
	readonly indexName: string;
	readonly host: string;
	readonly namespace: string;
	/** Explicit transport override for a fake control plane on literal loopback. */
	readonly controlUrl?: string;
	readonly maxVectors?: number;
	readonly maxRequests?: number;
	readonly maxWriteBytes?: number;
	readonly minimumWriteIntervalMs?: number;
	readonly minimumQueryIntervalMs?: number;
}
export interface PineconeMatch {
	readonly id: string;
	readonly score: number;
	readonly metadata: PineconeMetadata;
}
export class Pinecone {
	private readonly options: PineconeOptions;
	private readonly host: URL;
	private readonly control: URL;
	private readonly queue: BoundedQueue;
	private readonly verification: VerificationCache;
	private written = 0;
	private requests = 0;
	private bytes = 0;
	private lastWrite = 0;
	private lastQuery = 0;
	constructor(options: PineconeOptions) {
		this.options = { ...options };
		this.queue = new BoundedQueue(options.queueWaitMs);
		this.verification = new VerificationCache(options.verificationTtlMs);
		this.host = endpoint(options.host.includes("://") ? options.host : `https://${options.host}`);
		this.control = endpoint(options.controlUrl ?? "https://api.pinecone.io");
		if (options.controlUrl && !["127.0.0.1", "[::1]"].includes(this.control.hostname))
			throw new AdapterError("configuration", "Control override is only for loopback tests");
		if (
			this.host.pathname !== "/" ||
			this.control.pathname !== "/" ||
			!/^[a-z0-9][a-z0-9-]{0,44}$/u.test(options.indexName) ||
			!/^[A-Za-z0-9_-]{1,128}$/u.test(options.namespace) ||
			!options.apiKey ||
			/[\r\n\0]/u.test(options.apiKey)
		)
			throw new AdapterError("configuration", "Invalid Pinecone configuration");
		boundedInteger(options.maxVectors ?? 20000, 1, 20000, "Pinecone run vectors");
		boundedInteger(options.maxRequests ?? 10000, 1, 10000, "Pinecone run requests");
		boundedInteger(options.maxWriteBytes ?? 100000000, 1, 100000000, "Pinecone run bytes");
		boundedInteger(options.minimumWriteIntervalMs ?? 1000, 0, 60000, "write interval");
		boundedInteger(options.minimumQueryIntervalMs ?? 500, 0, 60000, "query interval");
		if (
			this.host.protocol === "https:" &&
			((options.minimumWriteIntervalMs ?? 1000) < 1000 ||
				(options.minimumQueryIntervalMs ?? 500) < 500 ||
				(options.retryDelayMs ?? 1000) < 1000)
		)
			throw new AdapterError("configuration", "Cloud rate bounds cannot be relaxed");
	}
	private call(base: URL, path: string, body?: unknown): Promise<unknown> {
		return requestJson(
			() => ({
				url: new URL(path, base),
				init: {
					method: body === undefined ? "GET" : "POST",
					headers: {
						"Api-Key": this.options.apiKey,
						"X-Pinecone-Api-Version": "2025-10",
						"Content-Type": "application/json",
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				},
			}),
			{ ...this.options, retryDelayMs: this.options.retryDelayMs ?? 1000 },
		);
	}
	private verify(force = false): Promise<void> {
		return this.verification.verify(() => this.probe(), force);
	}
	private async probe(): Promise<void> {
		const index = record(await this.call(this.control, `/indexes/${this.options.indexName}`));
		const spec = record(index.spec);
		const status = record(index.status);
		const describedHost =
			typeof index.host === "string"
				? endpoint(index.host.includes("://") ? index.host : `https://${index.host}`)
				: null;
		if (
			index.name !== this.options.indexName ||
			index.dimension !== 768 ||
			index.metric !== "cosine" ||
			index.vector_type !== "dense" ||
			!spec.serverless ||
			spec.pod ||
			index.embed ||
			status.ready !== true ||
			describedHost?.href !== this.host.href
		)
			throw new AdapterError(
				"identity_mismatch",
				"Pinecone must be ready serverless dense cosine 768 with the exact configured host and no integrated embeddings",
			);
		const serverless = record(spec.serverless);
		if (typeof serverless.cloud !== "string" || typeof serverless.region !== "string")
			throw new AdapterError("identity_mismatch", "Missing Pinecone serverless placement");
	}
	async doctor(): Promise<void> {
		await this.exclusive(async () => {
			await this.verify(true);
		});
	}
	private async exclusive<T>(work: () => Promise<T>): Promise<T> {
		return this.queue.run(async () => {
			if (++this.requests > (this.options.maxRequests ?? 10000))
				throw new AdapterError("resource_limit", "Pinecone run request budget exhausted");
			try {
				return await work();
			} catch (error) {
				return this.verification.recheck(error, () => this.probe());
			}
		});
	}
	private async throttle(kind: "write" | "query"): Promise<void> {
		const interval =
			kind === "write" ? (this.options.minimumWriteIntervalMs ?? 1000) : (this.options.minimumQueryIntervalMs ?? 500);
		const last = kind === "write" ? this.lastWrite : this.lastQuery;
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, last + interval - Date.now())));
		if (kind === "write") this.lastWrite = Date.now();
		else this.lastQuery = Date.now();
	}
	async upsert(vectors: readonly PineconeRecord[], expected: unknown): Promise<void> {
		assertEmbeddingIdentity(expected);
		boundedInteger(vectors.length, 1, 50, "Pinecone upsert batch");
		const detached = structuredClone(vectors);
		for (const vector of detached) {
			assertPassageId(vector.id);
			validateVector(vector.values);
			hostedMetadata(vector.metadata);
		}
		const body = { namespace: this.options.namespace, vectors: detached };
		const encoded = JSON.stringify(body);
		if (encoded.includes(this.options.apiKey))
			throw new AdapterError("configuration", "Credential found in hosted payload; write refused");
		const size = Buffer.byteLength(encoded);
		if (
			size > 1000000 ||
			this.written + vectors.length > (this.options.maxVectors ?? 20000) ||
			this.bytes + size > (this.options.maxWriteBytes ?? 100000000)
		)
			throw new AdapterError("resource_limit", "Pinecone batch/run budget exhausted");
		await this.exclusive(async () => {
			await this.verify(true);
			if (
				this.written + detached.length > (this.options.maxVectors ?? 20000) ||
				this.bytes + size > (this.options.maxWriteBytes ?? 100000000)
			)
				throw new AdapterError("resource_limit", "Pinecone batch/run budget exhausted");
			this.written += detached.length;
			this.bytes += size;
			await this.throttle("write");
			const result = record(await this.call(this.host, "/vectors/upsert", body));
			if (result.upsertedCount !== detached.length)
				throw new AdapterError("invalid_response", "Pinecone upsert acknowledgement mismatch");
		});
	}
	async query(
		vector: readonly number[],
		expected: unknown,
		inputOptions: { readonly generation: string; readonly topK?: number; readonly versionIds?: readonly string[] },
	): Promise<readonly PineconeMatch[]> {
		assertEmbeddingIdentity(expected);
		const options = {
			...inputOptions,
			...(inputOptions.versionIds ? { versionIds: [...inputOptions.versionIds] } : {}),
		};
		assertGeneration(options.generation);
		const values = validateVector(vector);
		const topK = boundedInteger(options.topK ?? 20, 1, 20, "Pinecone topK");
		if (
			options.versionIds &&
			(options.versionIds.length > 20 || options.versionIds.some((v) => !/^version_[a-f0-9]{32}$/u.test(v)))
		)
			throw new AdapterError("configuration", "Invalid version filter");
		return this.exclusive(async () => {
			await this.verify();
			await this.throttle("query");
			const result = record(
				await this.call(this.host, "/query", {
					namespace: this.options.namespace,
					vector: values,
					topK,
					includeValues: false,
					includeMetadata: true,
					filter: {
						generation: { $eq: options.generation },
						...(options.versionIds ? { versionId: { $in: [...options.versionIds] } } : {}),
					},
				}),
			);
			if (
				!Array.isArray(result.matches) ||
				result.matches.length > topK ||
				(result.namespace !== undefined && result.namespace !== this.options.namespace)
			)
				throw new AdapterError("invalid_response", "Invalid Pinecone query response");
			return result.matches.map((item: unknown) => {
				const match = record(item);
				if (typeof match.id !== "string" || typeof match.score !== "number" || !Number.isFinite(match.score))
					throw new AdapterError("invalid_response", "Invalid Pinecone match");
				assertPassageId(match.id);
				const metadata = record(match.metadata) as PineconeMetadata;
				hostedMetadata(metadata);
				// Candidate identity is checked against the committed manifest by
				// search, so one stale candidate is dropped with diagnostics rather
				// than hiding valid evidence behind a whole-query failure.
				return { id: match.id, score: match.score, metadata };
			});
		});
	}
	/** Exact-ID reads support hosted resolution and bounded visibility checks.
	 * Missing IDs are explicit omissions (eventual consistency), never fabricated. */
	async fetch(ids: readonly string[], expected: unknown): Promise<readonly PineconeMatch[]> {
		assertEmbeddingIdentity(expected);
		boundedInteger(ids.length, 1, 8, "Pinecone fetch batch");
		const requested = [...ids];
		requested.forEach(assertPassageId);
		return this.exclusive(async () => {
			await this.verify();
			await this.throttle("query");
			const query = new URLSearchParams({ namespace: this.options.namespace });
			for (const id of requested) query.append("ids", id);
			const result = record(await this.call(this.host, `/vectors/fetch?${query}`));
			if (result.namespace !== this.options.namespace)
				throw new AdapterError("identity_mismatch", "Pinecone fetch namespace mismatch");
			const vectors = record(result.vectors);
			if (Object.keys(vectors).some((id) => !requested.includes(id)))
				throw new AdapterError("identity_mismatch", "Pinecone fetch returned an unrequested ID");
			return Object.entries(vectors).map(([id, value]) => {
				const vector = record(value);
				if (vector.id !== id) throw new AdapterError("identity_mismatch", "Pinecone fetch ID mismatch");
				const metadata = record(vector.metadata) as PineconeMetadata;
				hostedMetadata(metadata);
				return { id, score: 0, metadata };
			});
		});
	}
	/** Explicit opaque IDs only; never deleteAll, filter deletes, or namespace deletion. */
	async delete(ids: readonly string[]): Promise<void> {
		boundedInteger(ids.length, 1, 50, "Pinecone delete batch");
		ids.forEach(assertPassageId);
		const body = { namespace: this.options.namespace, ids: [...ids] };
		const size = Buffer.byteLength(JSON.stringify(body));
		if (
			this.written + ids.length > (this.options.maxVectors ?? 20000) ||
			this.bytes + size > (this.options.maxWriteBytes ?? 100000000)
		)
			throw new AdapterError("resource_limit", "Pinecone delete run budget exhausted");
		await this.exclusive(async () => {
			await this.verify(true);
			if (
				this.written + body.ids.length > (this.options.maxVectors ?? 20000) ||
				this.bytes + size > (this.options.maxWriteBytes ?? 100000000)
			)
				throw new AdapterError("resource_limit", "Pinecone delete run budget exhausted");
			this.written += body.ids.length;
			this.bytes += size;
			await this.throttle("write");
			await this.call(this.host, "/vectors/delete", body);
		});
	}
}
