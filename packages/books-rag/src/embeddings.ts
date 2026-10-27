import { embeddingInputBound, passageEmbeddingInput } from "./chunks.ts";
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

export const embeddingIdentity = Object.freeze({
	runtime: "ollama",
	runtimeVersion: "0.40.11",
	model: "nomic-embed-text:v1.5",
	digest: "sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f",
	dimension: 768,
	context: 2048,
	documentPrefix: "search_document: ",
	queryPrefix: "search_query: ",
	truncate: false,
	budget: "utf8-nfd-lower-max-plus-32-v1",
} as const);
export type EmbeddingIdentity = typeof embeddingIdentity;
export function assertEmbeddingIdentity(value: unknown): asserts value is EmbeddingIdentity {
	if (
		!value ||
		JSON.stringify(Object.entries(record(value)).sort()) !== JSON.stringify(Object.entries(embeddingIdentity).sort())
	)
		throw new AdapterError(
			"identity_mismatch",
			"Embedding model/digest/dimension/configuration mismatch; compatible index required",
		);
}
export function validateVector(value: unknown): number[] {
	if (
		!Array.isArray(value) ||
		value.length !== 768 ||
		!value.every((n: unknown) => typeof n === "number" && Number.isFinite(n)) ||
		!value.some((n: number) => n !== 0)
	)
		throw new AdapterError("invalid_response", "Expected 768 finite nonzero embedding values");
	return [...value] as number[];
}
export interface EmbeddingOptions extends HttpOptions {
	readonly url: string;
	readonly model?: string;
	readonly identity?: unknown;
	readonly maxInputs?: number;
}
export class LocalEmbeddings {
	readonly identity = embeddingIdentity;
	private readonly base: URL;
	private readonly options: EmbeddingOptions;
	private readonly queue: BoundedQueue;
	private readonly verification: VerificationCache;
	private inputs = 0;
	constructor(options: EmbeddingOptions) {
		this.base = endpoint(options.url, true);
		if (this.base.pathname !== "/") throw new AdapterError("configuration", "Embedding endpoint must have no path");
		if (options.model !== undefined && options.model !== embeddingIdentity.model)
			throw new AdapterError("identity_mismatch", "Unsupported local embedding model");
		assertEmbeddingIdentity(options.identity ?? embeddingIdentity);
		boundedInteger(options.maxInputs ?? 20000, 1, 20000, "embedding run");
		this.options = { ...options };
		this.queue = new BoundedQueue(options.queueWaitMs);
		this.verification = new VerificationCache(options.verificationTtlMs);
	}
	private call(path: string, body?: unknown): Promise<unknown> {
		return requestJson(
			() => ({
				url: new URL(path, this.base),
				init:
					body === undefined
						? {}
						: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
			}),
			{ ...this.options, timeoutMs: this.options.timeoutMs ?? 60000 },
		);
	}
	private async verify(): Promise<void> {
		const version = record(await this.call("/api/version"));
		if (version.version !== embeddingIdentity.runtimeVersion)
			throw new AdapterError("identity_mismatch", "Local embedding runtime version mismatch");
		const tags = record(await this.call("/api/tags"));
		const models = tags.models;
		if (
			!Array.isArray(models) ||
			!models.some((item: unknown) => {
				const model = record(item);
				return (
					(model.name === embeddingIdentity.model || model.model === embeddingIdentity.model) &&
					typeof model.digest === "string" &&
					`sha256:${model.digest.replace(/^sha256:/u, "")}` === embeddingIdentity.digest
				);
			})
		)
			throw new AdapterError(
				"identity_mismatch",
				"Pinned embedding model/digest is not installed; operator setup required",
			);
		const show = record(await this.call("/api/show", { model: embeddingIdentity.model }));
		const info = record(show.model_info);
		if (
			info["general.architecture"] !== "nomic-bert" ||
			info["nomic-bert.embedding_length"] !== 768 ||
			info["nomic-bert.context_length"] !== 2048
		)
			throw new AdapterError("identity_mismatch", "Installed embedding architecture/dimension/context mismatch");
		if (typeof show.parameters === "string" && /(?:num_ctx|num_predict)\s/iu.test(show.parameters))
			throw new AdapterError("identity_mismatch", "Unsupported embedding model parameter override");
	}
	async doctor(): Promise<EmbeddingIdentity> {
		return this.queue.run(async () => {
			await this.verification.verify(() => this.verify(), true);
			return this.identity;
		});
	}
	async documents(
		passages: readonly Parameters<typeof passageEmbeddingInput>[0][],
		expected: unknown,
	): Promise<readonly number[][]> {
		boundedInteger(passages.length, 1, 8, "embedding batch");
		return this.embed(passages.map(passageEmbeddingInput), expected, true);
	}
	async query(text: string, expected: unknown): Promise<number[]> {
		if (!text.trim()) throw new AdapterError("resource_limit", "Empty embedding query");
		const vectors = await this.embed([`${embeddingIdentity.queryPrefix}${text}`], expected);
		const vector = vectors[0];
		if (!vector) throw new AdapterError("invalid_response", "Missing query embedding");
		return vector;
	}
	private async embed(inputs: readonly string[], expected: unknown, writeRun = false): Promise<readonly number[][]> {
		assertEmbeddingIdentity(expected);
		boundedInteger(inputs.length, 1, 8, "embedding batch");
		for (const input of inputs)
			if (Buffer.byteLength(input) > 2048 || embeddingInputBound(input) > 2048)
				throw new AdapterError(
					"resource_limit",
					"Embedding input exceeds conservative context bound; truncation forbidden",
				);
		return this.queue.run(async () => {
			if (this.inputs + inputs.length > (this.options.maxInputs ?? 20000))
				throw new AdapterError("resource_limit", "Embedding run budget exhausted");
			this.inputs += inputs.length;
			await this.verification.verify(() => this.verify(), writeRun);
			try {
				const result = record(
					await this.call("/api/embed", { model: embeddingIdentity.model, input: inputs, truncate: false }),
				);
				if (!Array.isArray(result.embeddings) || result.embeddings.length !== inputs.length)
					throw new AdapterError("invalid_response", "Embedding batch size mismatch");
				if (typeof result.prompt_eval_count === "number" && result.prompt_eval_count > inputs.length * 2048)
					throw new AdapterError("invalid_response", "Embedding context exceeded");
				return result.embeddings.map(validateVector);
			} catch (error) {
				return this.verification.recheck(error, () => this.verify());
			}
		});
	}
}
