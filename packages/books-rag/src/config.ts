import { readFileSync } from "node:fs";

export class AdapterError extends Error {
	readonly code:
		| "configuration"
		| "identity_mismatch"
		| "resource_limit"
		| "unavailable"
		| "quota"
		| "invalid_response"
		| "busy";
	constructor(code: AdapterError["code"], message: string) {
		super(message);
		this.name = "AdapterError";
		this.code = code;
	}
}

/** Deliberately small dotenv grammar: errors name keys, never credential values. */
export function parseEnv(input: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const raw of input.split(/\r?\n/u)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/u.exec(line);
		if (colon) throw new AdapterError("configuration", `Use KEY=value for ${colon[1]}`);
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
		if (!match) throw new AdapterError("configuration", "Invalid environment assignment");
		const key = match[1];
		let value = match[2]?.trim() ?? "";
		if (!key) throw new AdapterError("configuration", "Invalid environment key");
		if (value.startsWith('"') || value.startsWith("'")) {
			if (value.at(-1) !== value[0] || value.length < 2)
				throw new AdapterError("configuration", `Unterminated quoted value for ${key}`);
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}
export interface BooksConfig {
	readonly dataDirectory: string;
	readonly ollamaUrl: string;
	readonly ollamaModel: string;
	readonly pinecone: {
		readonly apiKey: string;
		readonly indexName: string;
		readonly host: string;
		readonly namespace: string;
	};
	readonly objects: {
		readonly endpoint: string;
		readonly region: string;
		readonly bucket: string;
		readonly accessKeyId: string;
		readonly secretAccessKey: string;
		readonly prefix: string;
		readonly privateBucketConfirmed: true;
		readonly privateProbeKey: string;
	};
}
export function loadConfig(options: { readonly env?: NodeJS.ProcessEnv; readonly envFile?: string } = {}): BooksConfig {
	let file: Record<string, string> = {};
	if (options.envFile) {
		try {
			file = parseEnv(readFileSync(options.envFile, "utf8"));
		} catch (error) {
			if (error instanceof AdapterError) throw error;
			throw new AdapterError("configuration", "Cannot read configured environment file");
		}
	}
	const env = { ...file, ...(options.env ?? process.env) };
	const required = (key: string): string => {
		const value = env[key];
		if (!value?.trim() || /[\r\n\0]/u.test(value)) throw new AdapterError("configuration", `Missing or invalid ${key}`);
		return value;
	};
	const credential = (key: string): string => {
		const value = required(key);
		if (value.startsWith("sbp_"))
			throw new AdapterError("configuration", `${key} requires an S3 credential, not a Supabase personal access token`);
		return value;
	};
	if (env.S3_BUCKET_PRIVATE_CONFIRMED !== "true")
		throw new AdapterError("configuration", "S3_BUCKET_PRIVATE_CONFIRMED must be true after operator verification");
	return {
		dataDirectory: required("BOOKS_DATA_DIR"),
		ollamaUrl: env.OLLAMA_URL ?? "http://127.0.0.1:11434",
		ollamaModel: env.OLLAMA_MODEL ?? "nomic-embed-text:v1.5",
		pinecone: {
			apiKey: required("PINE_CONE_API"),
			indexName: required("PINECONE_INDEX_NAME"),
			host: required("PINECONE_HOST"),
			namespace: required("PINECONE_NAMESPACE"),
		},
		objects: {
			endpoint: required("S3_ENDPOINT"),
			region: required("S3_REGION"),
			bucket: required("S3_BUCKET"),
			accessKeyId: credential("S3_ACCESS_KEY_ID"),
			secretAccessKey: credential("S3_SECRET_ACCESS_KEY"),
			prefix: required("S3_LIBRARY_PREFIX"),
			privateBucketConfirmed: true,
			privateProbeKey: required("S3_PRIVATE_PROBE_KEY"),
		},
	};
}

export function endpoint(value: string, localOnly = false): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AdapterError("configuration", "Invalid service endpoint");
	}
	const authority = /^[a-z]+:\/\/([^/?#]+)/iu.exec(value)?.[1];
	const loopback = /^(?:127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(authority ?? "");
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(!loopback && (localOnly || url.protocol !== "https:")) ||
		(loopback && !["http:", "https:"].includes(url.protocol))
	)
		throw new AdapterError(
			"configuration",
			localOnly
				? "Embedding endpoint must be literal loopback"
				: "Service endpoint requires HTTPS (HTTP allowed only for literal loopback tests)",
		);
	return url;
}
export function boundedInteger(value: number, min: number, max: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new AdapterError("resource_limit", `Invalid ${label} bound`);
	return value;
}
export interface HttpOptions {
	readonly timeoutMs?: number;
	readonly retries?: number;
	readonly retryDelayMs?: number;
	readonly queueWaitMs?: number;
	readonly verificationTtlMs?: number;
}

/** One active operation, four FIFO waiters. Timeout removes the waiter rather
 * than leaving cancelled work to execute later or accumulating hidden promises. */
export class BoundedQueue {
	private active = false;
	private readonly waiting: {
		readonly resolve: () => void;
		readonly timer: ReturnType<typeof setTimeout>;
	}[] = [];
	private readonly waitMs: number;
	constructor(waitMs = 15000) {
		this.waitMs = boundedInteger(waitMs, 1, 60000, "queue wait");
	}
	private acquire(): Promise<void> {
		if (!this.active) {
			this.active = true;
			return Promise.resolve();
		}
		if (this.waiting.length >= 4)
			return Promise.reject(new AdapterError("busy", "Adapter busy: bounded queue is full"));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const index = this.waiting.findIndex((entry) => entry.timer === timer);
				if (index >= 0) this.waiting.splice(index, 1);
				reject(new AdapterError("busy", "Adapter busy: queue wait timed out"));
			}, this.waitMs);
			this.waiting.push({ resolve, timer });
		});
	}
	async run<T>(work: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await work();
		} finally {
			const next = this.waiting.shift();
			if (next) {
				clearTimeout(next.timer);
				next.resolve();
			} else this.active = false;
		}
	}
}

export class VerificationCache {
	private expires = 0;
	private readonly ttl: number;
	constructor(ttl = 600000) {
		this.ttl = boundedInteger(ttl, 1, 600000, "verification TTL");
	}
	async verify(probe: () => Promise<void>, force = false): Promise<void> {
		if (!force && Date.now() < this.expires) return;
		this.expires = 0;
		await probe();
		this.expires = Date.now() + this.ttl;
	}
	async recheck(error: unknown, probe: () => Promise<void>): Promise<never> {
		if (error instanceof AdapterError && ["identity_mismatch", "invalid_response"].includes(error.code)) {
			this.expires = 0;
			await this.verify(probe, true);
		}
		throw error;
	}
}
/** Shared bounded transport. Provider bodies and fetch causes never escape: both
 * can echo secrets. Adapters bound in-flight work and queue waits separately.
 * Each retry obtains a fresh signature from the caller. */
export async function requestBytes(
	make: () => { readonly url: URL; readonly init: RequestInit },
	limit: number,
	options: HttpOptions = {},
	responseOptions: { readonly acceptedStatuses?: readonly number[]; readonly statusOnly?: boolean } = {},
): Promise<{ readonly bytes: Buffer; readonly headers: Headers; readonly status: number }> {
	const timeout = boundedInteger(options.timeoutMs ?? 15000, 1, 60000, "timeout");
	const retries = boundedInteger(options.retries ?? 2, 0, 2, "retry");
	const delay = boundedInteger(options.retryDelayMs ?? 250, 0, 2000, "retry delay");
	for (let attempt = 0; ; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		let retryAfter = 0;
		try {
			const { url, init } = make();
			const response = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
			if (responseOptions.statusOnly && (response.ok || responseOptions.acceptedStatuses?.includes(response.status))) {
				await response.body?.cancel();
				return { bytes: Buffer.alloc(0), headers: response.headers, status: response.status };
			}
			const chunks: Uint8Array[] = [];
			let size = 0;
			if (response.body) {
				const reader = response.body.getReader();
				try {
					for (;;) {
						const next = await reader.read();
						if (next.done) break;
						size += next.value.byteLength;
						if (size > limit) {
							await reader.cancel();
							throw new AdapterError("resource_limit", "Service response exceeds byte limit");
						}
						chunks.push(next.value);
					}
				} finally {
					reader.releaseLock();
				}
			}
			const bytes = Buffer.concat(chunks);
			if (response.ok || responseOptions.acceptedStatuses?.includes(response.status))
				return { bytes, headers: response.headers, status: response.status };
			const body = bytes.toString("utf8");
			if (
				response.status === 402 ||
				(response.status === 429 && /quota|billing|payment|monthly|exhaust|upgrade|limit.*month/iu.test(body))
			)
				throw new AdapterError("quota", "Service quota or billing constraint; operator verification required");
			if (![408, 429, 500, 502, 503, 504].includes(response.status))
				throw new AdapterError("invalid_response", `Service rejected request (HTTP ${response.status})`);
			const retry = response.headers.get("retry-after");
			if (retry) {
				const milliseconds = /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
				if (!Number.isFinite(milliseconds) || milliseconds > 2000)
					throw new AdapterError("unavailable", "Service rate limit requires later operator retry");
				retryAfter = Math.max(0, milliseconds);
			}
		} catch (error) {
			if (error instanceof AdapterError) throw error;
			// Network errors/timeouts are transient; raw causes can contain URLs or keys.
		} finally {
			clearTimeout(timer);
		}
		if (attempt >= retries) throw new AdapterError("unavailable", "Service unavailable after bounded attempts");
		await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfter, Math.min(2000, delay * 2 ** attempt))));
	}
}
export async function requestJson(
	make: Parameters<typeof requestBytes>[0],
	options: HttpOptions = {},
): Promise<unknown> {
	const result = await requestBytes(make, 1024 * 1024, options);
	try {
		return JSON.parse(result.bytes.toString("utf8")) as unknown;
	} catch {
		throw new AdapterError("invalid_response", "Invalid service JSON response");
	}
}
export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new AdapterError("invalid_response", "Invalid service response shape");
	return value as Record<string, unknown>;
}
