import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { embeddingIdentity } from "../src/embeddings.ts";
import { syntheticEmbedding } from "../src/evaluate.ts";
import type { PineconeRecord } from "../src/pinecone.ts";

export interface FakeServices {
	readonly url: string;
	readonly requests: string[];
	readonly vectors: Map<string, PineconeRecord>;
	readonly storage: Map<string, { bytes: Buffer; hash: string }>;
	/** Set a status to make every Pinecone upsert fail with it, then null to recover. */
	readonly faults: {
		upsertStatus: number | null;
		beforeObjectGet: ((path: string) => void) | null;
	};
	close(): Promise<void>;
}

/** One literal-loopback fake for Ollama, Pinecone and S3. It records every
 * request as "METHOD path" so tests can prove read-only behavior. Problem: a
 * test that only checks output cannot see an accidental write. Example: doctor
 * issuing a PUT. Solution: assert on the recorded methods. */
export async function fakeServices(options: { readonly publicProbe?: boolean } = {}): Promise<FakeServices> {
	const vectors = new Map<string, PineconeRecord>();
	const storage = new Map<string, { bytes: Buffer; hash: string }>();
	const requests: string[] = [];
	const faults: FakeServices["faults"] = { upsertStatus: null, beforeObjectGet: null };
	let url = "";
	const server: Server = createServer(async (req, res) => {
		const parsed = new URL(req.url ?? "/", url);
		const path = parsed.pathname;
		requests.push(`${req.method} ${path}`);
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
				if (options.publicProbe) {
					res.end("public");
					return;
				}
				res.statusCode = storage.has(path) ? 403 : 404;
				res.end();
				return;
			}
			if (req.method === "PUT") {
				storage.set(path, { bytes, hash: String(req.headers["x-amz-meta-sha256"]) });
				res.end();
				return;
			}
			if (req.method === "GET") faults.beforeObjectGet?.(path);
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
		if (path === "/vectors/upsert" && faults.upsertStatus !== null) {
			res.statusCode = faults.upsertStatus;
			res.end();
			return;
		}
		if (path === "/vectors/upsert") {
			const records = body().vectors as PineconeRecord[];
			for (const r of records) vectors.set(r.id, r);
			return reply({ upsertedCount: records.length });
		}
		if (path === "/vectors/delete") {
			const { ids, namespace } = body() as { ids: string[]; namespace: string };
			if (namespace === "synthetic") for (const id of ids) vectors.delete(id);
			return reply({});
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
	return {
		url,
		requests,
		vectors,
		storage,
		faults,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
