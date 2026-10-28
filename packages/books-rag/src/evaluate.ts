import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerableCases, evaluationPdf, unrelatedCases } from "../test/evaluation-fixtures.ts";
import { embeddingIdentity, LocalEmbeddings } from "./embeddings.ts";
import { canonical, generationPassages, indexCorpus, loadCatalog } from "./indexing.ts";
import { ingestPdf, publishIngest } from "./ingest.ts";
import { sha256 } from "./locations.ts";
import { Objects } from "./objects.ts";
import { Pinecone, type PineconeRecord } from "./pinecone.ts";
import { fetchHostedFigure, readHostedPassage, relevanceGate, searchBooks } from "./search.ts";
import { CorpusStore } from "./store.ts";

/** Text-only hashed term frequencies. Problem: scripted scores can merely repeat
 * expected answers. Example: assigning a vector by query ID makes recall circular.
 * Solution: hash every non-stopword uniformly; neither labels nor expected spans
 * enter this function. This is NOT Nomic, despite emulated protocol probes. */
export function syntheticEmbedding(input: string): number[] {
	const vector = Array.from({ length: 768 }, () => 0);
	const stop = new Set([
		"a",
		"an",
		"and",
		"the",
		"to",
		"of",
		"in",
		"on",
		"from",
		"before",
		"through",
		"without",
		"how",
		"what",
		"does",
	]);
	const text = input.replace(/^search_(?:document|query):\s*/u, "");
	for (const token of text.toLowerCase().match(/[a-z0-9_]+/gu) ?? []) {
		if (stop.has(token)) continue;
		const hash = sha256(token).slice(7);
		const index = Number.parseInt(hash.slice(0, 8), 16) % 768;
		vector[index] = (vector[index] ?? 0) + 1;
	}
	const norm = Math.hypot(...vector);
	if (!norm) vector[0] = 1;
	return vector.map((n) => n / (norm || 1));
}
export interface EvaluationRun {
	readonly targetBound: number;
	readonly chunks: number;
	readonly recallAt5: number;
	readonly falseNegatives: readonly string[];
	readonly falsePositives: readonly string[];
	readonly citationFailures: readonly string[];
	readonly figureFailures: readonly string[];
	readonly unrelatedAbstentions: number;
	readonly unnecessaryCharacters: number;
	readonly redundantCharacters: number;
	readonly returnedCharacters: number;
	readonly provenanceChecks: number;
}

/** Reusable by evaluate --synthetic: ignores environment/configuration, creates
 * only literal 127.0.0.1 endpoints, removes all temporary PDFs/stores on exit. */
export async function evaluateSynthetic() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "books-evaluation-"));
	const pdf = evaluationPdf();
	const runs: EvaluationRun[] = [];
	try {
		for (const targetBound of [180, 320]) runs.push(await evaluateConfiguration(root, pdf, targetBound));
		return {
			kind: "synthetic-pipeline-only",
			corpusHash: sha256(pdf),
			embedding: "sha256-term-frequency-768-v1 (fake; NOT Nomic semantic quality)",
			emulatedIdentity: embeddingIdentity,
			tokenizer: "ASCII word/identifier regex; chunk budget uses utf8-nfd-lower-max-plus-32-v1, not measured tokens",
			gate: relevanceGate,
			answerable: answerableCases.length,
			unrelated: unrelatedCases.length,
			runs,
			passed: runs.every(
				(r) =>
					r.recallAt5 >= 0.9 &&
					!r.citationFailures.length &&
					!r.figureFailures.length &&
					r.unrelatedAbstentions === unrelatedCases.length,
			),
			liveEvaluation:
				"NOT RUN: synthetic evaluation does not check live Ollama/model/tokenizer, S3 credentials or allowed Pinecone/private bucket/pricing/remaining allowances; run separate operator checks",
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
async function evaluateConfiguration(root: string, pdf: Uint8Array, targetBound: number): Promise<EvaluationRun> {
	const vectors = new Map<string, PineconeRecord>();
	const storage = new Map<string, { bytes: Buffer; hash: string }>();
	let url = "";
	const server = createServer(async (req, res) => {
		const parsed = new URL(req.url ?? "/", url);
		const path = parsed.pathname;
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
		const bytes = Buffer.concat(chunks);
		const body = () => JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
		const reply = (value: unknown) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(value));
		};
		if (path.startsWith("/s3/")) {
			if (!req.headers.authorization) {
				res.statusCode = storage.has(path) ? 403 : 404;
				res.end();
				return;
			}
			if (req.method === "PUT") {
				storage.set(path, { bytes, hash: String(req.headers["x-amz-meta-sha256"]) });
				res.end();
				return;
			}
			const item = storage.get(path);
			if (!item) {
				res.statusCode = 404;
				res.end();
				return;
			}
			res.setHeader("x-amz-meta-sha256", item.hash);
			res.setHeader("content-length", item.bytes.length);
			res.end(req.method === "HEAD" ? undefined : item.bytes);
			return;
		}
		if (path === "/api/version") return reply({ version: embeddingIdentity.runtimeVersion });
		if (path === "/api/tags")
			return reply({ models: [{ name: embeddingIdentity.model, digest: embeddingIdentity.digest }] });
		if (path === "/api/show")
			return reply({
				model_info: {
					"general.architecture": "nomic-bert",
					"nomic-bert.embedding_length": 768,
					"nomic-bert.context_length": 2048,
				},
			});
		if (path === "/api/embed") return reply({ embeddings: (body().input as string[]).map(syntheticEmbedding) });
		if (path === "/indexes/books")
			return reply({
				name: "books",
				host: url,
				dimension: 768,
				metric: "cosine",
				vector_type: "dense",
				spec: { serverless: { cloud: "aws", region: "us-east-1" } },
				status: { ready: true },
			});
		if (path === "/vectors/upsert") {
			const records = body().vectors as PineconeRecord[];
			for (const r of records) vectors.set(r.id, r);
			return reply({ upsertedCount: records.length });
		}
		if (path === "/vectors/list") {
			const start = Number(parsed.searchParams.get("paginationToken") ?? 0);
			const ids = [...vectors.keys()].sort();
			return reply({
				namespace: "synthetic",
				vectors: ids.slice(start, start + 100).map((id) => ({ id })),
				...(ids.length > start + 100 ? { pagination: { next: String(start + 100) } } : {}),
			});
		}
		if (path === "/vectors/fetch")
			return reply({
				namespace: "synthetic",
				vectors: Object.fromEntries(
					parsed.searchParams.getAll("ids").flatMap((id) => (vectors.has(id) ? [[id, vectors.get(id)]] : [])),
				),
			});
		if (path === "/query") {
			const query = body() as {
				vector: number[];
				topK: number;
				filter: { generation: { $eq: string }; versionId: { $in: string[] } };
			};
			return reply({
				namespace: "synthetic",
				matches: [...vectors.values()]
					.filter(
						(r) =>
							r.metadata.generation === query.filter.generation.$eq &&
							query.filter.versionId.$in.includes(String(r.metadata.versionId)),
					)
					.map((r) => ({
						id: r.id,
						metadata: r.metadata,
						score: r.values.reduce((s, n, i) => s + n * (query.vector[i] ?? 0), 0),
					}))
					.sort((a, b) => b.score - a.score)
					.slice(0, query.topK),
			});
		}
		res.statusCode = 404;
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const store = new CorpusStore({ directory: join(root, `writer-${targetBound}`) });
		const input = join(root, `synthetic-${targetBound}.pdf`);
		writeFileSync(input, pdf);
		const prepared = await ingestPdf({
			store,
			input,
			bookId: store.newBookId(),
			indexConfigurationHash: sha256(`evaluation-v1-${targetBound}`),
		});
		await publishIngest(prepared, store, { targetBound });
		const objects = new Objects({
			endpoint: `${url}/s3`,
			bucket: "private-books",
			prefix: "library/",
			region: "us-east-1",
			accessKeyId: "synthetic-access",
			secretAccessKey: "synthetic-secret",
			privateBucketConfirmed: true,
			retries: 0,
		});
		const pinecone = new Pinecone({
			host: url,
			controlUrl: url,
			indexName: "books",
			namespace: "synthetic",
			apiKey: "synthetic-key",
			minimumWriteIntervalMs: 0,
			minimumQueryIntervalMs: 0,
			retries: 0,
		});
		const embeddings = new LocalEmbeddings({ url, retries: 0 });
		await indexCorpus({ store, objects, pinecone, embeddings, writerId: store.libraryId });
		rmSync(input);
		const reader = new CorpusStore({ directory: join(root, `empty-reader-${targetBound}`) });
		if (reader.listVersions().length) throw new Error("Reader must be empty");
		const services = { objects, pinecone, embeddings };
		const catalog = (await loadCatalog(objects)).catalog;
		if (!catalog) throw new Error("Missing catalog");
		const failures: string[] = [],
			citations: string[] = [],
			figures: string[] = [],
			falsePositives: string[] = [];
		let found = 0,
			unrelatedAbstentions = 0,
			unnecessaryCharacters = 0,
			redundantCharacters = 0,
			returnedCharacters = 0,
			provenanceChecks = 0;
		for (const fixture of answerableCases) {
			const result = await searchBooks(services, { query: fixture.query });
			let relevant = false;
			const seen = new Set<string>();
			for (const hit of result.hits) {
				const read = await readHostedPassage(services, hit.passageId);
				const expected = generationPassages(
					store.listPassages(prepared.source),
					catalog.versions[0]?.generation ?? "",
				).find((p) => p.id === hit.passageId);
				provenanceChecks++;
				if (
					!expected ||
					read.text !== expected.originalText ||
					hit.sourceHash !== sha256(pdf) ||
					read.source.versionId !== prepared.source.versionId ||
					canonical(read.locations) !== canonical(expected.spans) ||
					hit.excerpt !== read.text.slice(0, 800)
				)
					citations.push(fixture.id);
				const supports =
					read.text.includes(fixture.evidence) &&
					read.locations.some(
						(s) =>
							s.location.pageNumber === fixture.span.page &&
							fixture.span.topCoordinates.includes(s.location.bounds?.[1] ?? -1),
					);
				if (supports) {
					relevant = true;
					if (fixture.figure) {
						const link = hit.figures.find(
							(f) => f.evidence.kind === "explicit-reference" && f.evidence.figureLabel === fixture.figure,
						);
						// A split reference may be in the adjacent chunk: mandatory case
						// requires the supporting hit itself to retain the link.
						if (!link) figures.push(fixture.id);
						else {
							const image = await fetchHostedFigure(objects, link.figureId);
							if (
								!image.asset ||
								image.figure.label !== fixture.figure ||
								image.figure.location.pageNumber !== fixture.page + 1 ||
								image.asset.assetHash !== sha256(Buffer.from(image.asset.base64, "base64"))
							)
								figures.push(fixture.id);
						}
					}
				}
				returnedCharacters += read.text.length;
				unnecessaryCharacters += read.text.length;
				for (const row of read.text.split("\n")) {
					if (seen.has(row)) redundantCharacters += row.length;
					seen.add(row);
				}
			}
			if (relevant) unnecessaryCharacters -= fixture.evidence.length;
			if (relevant && result.status === "ok") found++;
			else failures.push(fixture.id);
		}
		for (const query of unrelatedCases) {
			const result = await searchBooks(services, { query });
			if (result.status === "insufficient_evidence" && !result.hits.length) unrelatedAbstentions++;
			else falsePositives.push(query);
		}
		return {
			targetBound,
			chunks: vectors.size,
			recallAt5: found / answerableCases.length,
			falseNegatives: failures,
			falsePositives,
			citationFailures: citations,
			figureFailures: figures,
			unrelatedAbstentions,
			unnecessaryCharacters,
			redundantCharacters,
			returnedCharacters,
			provenanceChecks,
		};
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}
