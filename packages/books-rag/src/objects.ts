import { createHash, createHmac } from "node:crypto";
import type { HttpOptions } from "./config.ts";
import { AdapterError, BoundedQueue, boundedInteger, endpoint, requestBytes, VerificationCache } from "./config.ts";
import type { FigureId, Sha256, SourceIdentity } from "./contracts.ts";
import type { CorpusStore } from "./store.ts";

const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Uint8Array, value: string): Buffer => createHmac("sha256", key).update(value).digest();
const encode = (value: string): string =>
	encodeURIComponent(value).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export interface SigningInput {
	readonly method: string;
	readonly url: URL;
	readonly region: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly date: Date;
	readonly headers?: Readonly<Record<string, string>>;
	readonly payload?: Uint8Array;
	readonly service?: "s3" | "iam";
	/** S3 requires this; false is useful for the published IAM signing vector. */
	readonly contentHashHeader?: boolean;
}
/** SigV4 header signing only; no presigned/public URLs, ACLs or SDK dependency. */
export function signV4(input: SigningInput): {
	readonly headers: Record<string, string>;
	readonly canonicalRequest: string;
	readonly stringToSign: string;
	readonly signature: string;
} {
	const timestamp = input.date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
	const day = timestamp.slice(0, 8);
	const service = input.service ?? "s3";
	const payloadHash = hash(input.payload ?? new Uint8Array());
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(input.headers ?? {}))
		headers[key.toLowerCase()] = value.trim().replace(/\s+/gu, " ");
	headers.host = input.url.host;
	headers["x-amz-date"] = timestamp;
	if (input.contentHashHeader !== false) headers["x-amz-content-sha256"] = payloadHash;
	const names = Object.keys(headers).sort();
	const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
	const path = input.url.pathname
		.split("/")
		.map((part) => encode(decodeURIComponent(part)))
		.join("/");
	const query = [...input.url.searchParams]
		.map(([key, value]) => [encode(key), encode(value)] as const)
		.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const canonicalRequest = [input.method, path, query, canonicalHeaders, names.join(";"), payloadHash].join("\n");
	const scope = `${day}/${input.region}/${service}/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonicalRequest)}`;
	const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service), "aws4_request");
	const signature = hmac(key, stringToSign).toString("hex");
	headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
	return { headers, canonicalRequest, stringToSign, signature };
}
export interface ObjectOptions extends HttpOptions {
	readonly endpoint: string;
	readonly region: string;
	readonly bucket: string;
	readonly prefix: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	/** The operator must verify bucket privacy, plan and remaining allowances. */
	readonly privateBucketConfirmed: true;
	readonly privateProbeKey?: string;
	readonly maxRequests?: number;
	readonly maxUploadBytes?: number;
}
export interface ObjectReceipt {
	readonly key: string;
	readonly hash: Sha256;
	readonly bytes: number;
}
export class Objects {
	private options: ObjectOptions & { readonly privateProbeKey: string };
	private readonly base: URL;
	private readonly queue: BoundedQueue;
	private readonly verification: VerificationCache;
	private requests = 0;
	private uploaded = 0;
	constructor(options: ObjectOptions) {
		this.options = { ...options, privateProbeKey: options.privateProbeKey ?? `${options.prefix}_private-probe` };
		this.queue = new BoundedQueue(options.queueWaitMs);
		this.verification = new VerificationCache(options.verificationTtlMs);
		this.base = endpoint(options.endpoint);
		if (options.privateBucketConfirmed !== true)
			throw new AdapterError("configuration", "Operator must confirm a private bucket before object access");
		if (
			!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(options.bucket) ||
			options.bucket.includes("..") ||
			!/^[a-z0-9-]{1,64}$/u.test(options.region) ||
			!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/$/u.test(options.prefix) ||
			options.prefix.length > 256
		)
			throw new AdapterError("configuration", "Invalid S3 bucket, region or library prefix");
		for (const value of [options.accessKeyId, options.secretAccessKey]) {
			if (!value || /[\r\n\0]/u.test(value))
				throw new AdapterError("configuration", "Missing or invalid S3 credential");
			if (value.startsWith("sbp_"))
				throw new AdapterError("configuration", "S3 credentials cannot be Supabase personal access tokens");
		}
		boundedInteger(options.maxRequests ?? 100000, 1, 100000, "S3 run requests");
		boundedInteger(options.maxUploadBytes ?? 1073741824, 1, 1073741824, "S3 run upload bytes");
		this.key(this.options.privateProbeKey);
	}
	setAccounting(accounting: import("./capacity.ts").Accounting | undefined): void {
		this.options = { ...this.options, accounting };
	}
	libraryKey(name: string): string {
		const key = `${this.options.prefix}${name}`;
		this.key(key);
		return key;
	}
	/** Writer bootstrap: fixed non-sensitive bytes only, before any corpus upload.
	 * Readers never call this; they only perform the anonymous refusal probe. */
	async prepareWriter(): Promise<void> {
		const bytes = Buffer.from("books-rag private canary v1\n");
		await this.call(
			"PUT",
			this.options.privateProbeKey,
			{
				"content-type": "application/json",
				"x-amz-meta-sha256": hash(bytes),
			},
			bytes,
			true,
		);
		await this.verification.verify(() => this.verifyPrivate(), true);
	}
	/** Mutable catalog/lease discovery trusts the configured authenticated endpoint,
	 * not an external hash. Subsequent evidence reads use manifest-pinned hashes.
	 * Only a genuine 404 means absent; outages are never empty catalogs. */
	async discover(key: string): Promise<{ readonly bytes: Buffer; readonly hash: Sha256 } | null> {
		const result = await this.call("GET", key, {}, undefined, false, true);
		if (result.status === 404) return null;
		const digest = `sha256:${hash(result.bytes)}` as Sha256;
		if (`sha256:${result.headers.get("x-amz-meta-sha256")}` !== digest)
			throw new AdapterError("identity_mismatch", "Discovered object hash mismatch");
		return { bytes: result.bytes, hash: digest };
	}
	private key(key: string): URL {
		if (
			typeof key !== "string" ||
			!key.startsWith(this.options.prefix) ||
			key.length > 1024 ||
			!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(key) ||
			key.split("/").some((part) => part === "." || part === "..")
		)
			throw new AdapterError("configuration", "Object key must stay under the configured library prefix");
		const url = new URL(this.base);
		url.pathname = `${this.base.pathname.replace(/\/$/u, "")}/${encode(this.options.bucket)}/${key.split("/").map(encode).join("/")}`;
		return url;
	}
	private async verifyPrivate(): Promise<void> {
		const url = this.key(this.options.privateProbeKey);
		const response = await requestBytes(() => ({ url, init: { method: "GET" } }), 64 * 1024, this.options, {
			acceptedStatuses: [400, 401, 403],
		});
		if (response.status >= 200 && response.status < 300)
			throw new AdapterError("configuration", "Bucket appears public: unsigned object GET succeeded");
	}
	private async call(
		method: "PUT" | "GET" | "HEAD" | "DELETE",
		key: string,
		headers: Record<string, string>,
		bytes?: Buffer,
		bootstrap = false,
		allowMissing = false,
	): Promise<Awaited<ReturnType<typeof requestBytes>>> {
		const url = this.key(key);
		return this.queue.run(async () => {
			if (++this.requests > (this.options.maxRequests ?? 100000))
				throw new AdapterError("resource_limit", "S3 run request budget exhausted");
			if (!bootstrap) await this.verification.verify(() => this.verifyPrivate());
			try {
				return await requestBytes(
					() => ({
						url,
						init: {
							method,
							headers: signV4({
								method,
								url,
								region: this.options.region,
								accessKeyId: this.options.accessKeyId,
								secretAccessKey: this.options.secretAccessKey,
								date: new Date(),
								headers,
								...(bytes ? { payload: bytes } : {}),
							}).headers,
							...(bytes ? { body: new Uint8Array(bytes) } : {}),
						},
					}),
					2 * 1024 * 1024,
					this.options,
					allowMissing ? { acceptedStatuses: [404] } : {},
				);
			} catch (error) {
				return this.verification.recheck(error, () => this.verifyPrivate());
			}
		});
	}
	async put(
		key: string,
		bytes: Uint8Array,
		contentType: "image/png" | "image/jpeg" | "application/json",
	): Promise<ObjectReceipt> {
		this.key(key);
		const limit = contentType === "application/json" ? 1024 * 1024 : 2 * 1024 * 1024;
		boundedInteger(bytes.byteLength, 1, limit, "object size");
		if (!["image/png", "image/jpeg", "application/json"].includes(contentType))
			throw new AdapterError("configuration", "Unsupported object content type");
		if (this.uploaded + bytes.byteLength > (this.options.maxUploadBytes ?? 1073741824))
			throw new AdapterError("resource_limit", "S3 upload run budget exhausted");
		const copy = Buffer.from(bytes);
		const digest = hash(copy);
		this.uploaded += copy.length;
		await this.call("PUT", key, { "content-type": contentType, "x-amz-meta-sha256": digest }, copy);
		return { key, hash: `sha256:${digest}`, bytes: copy.length };
	}
	async putFigure(store: CorpusStore, source: SourceIdentity, id: FigureId): Promise<ObjectReceipt> {
		const asset = store.readFigureAsset(source, id);
		const result = await this.put(
			`${this.options.prefix}${source.versionId}/${id}`,
			Buffer.from(asset.base64, "base64"),
			asset.mimeType,
		);
		if (result.hash !== asset.assetHash) throw new AdapterError("identity_mismatch", "Stored figure hash mismatch");
		return result;
	}
	async get(key: string, expectedHash: Sha256): Promise<Buffer> {
		this.assertHash(expectedHash);
		const result = await this.call("GET", key, {});
		if (
			`sha256:${hash(result.bytes)}` !== expectedHash ||
			`sha256:${result.headers.get("x-amz-meta-sha256")}` !== expectedHash
		)
			throw new AdapterError("identity_mismatch", "Object content hash mismatch");
		return result.bytes;
	}
	async head(key: string, expectedHash: Sha256): Promise<ObjectReceipt> {
		this.assertHash(expectedHash);
		const result = await this.call("HEAD", key, {});
		const size = Number(result.headers.get("content-length"));
		boundedInteger(size, 1, 2 * 1024 * 1024, "object size");
		if (`sha256:${result.headers.get("x-amz-meta-sha256")}` !== expectedHash)
			throw new AdapterError("identity_mismatch", "Object metadata hash mismatch");
		return { key, hash: expectedHash, bytes: size };
	}
	private assertHash(value: Sha256): void {
		if (!/^sha256:[a-f0-9]{64}$/u.test(value))
			throw new AdapterError("configuration", "Expected pinned object SHA-256");
	}
	/** No bucket/prefix deletion, listing or public access/ACL operations exist. */
	async delete(key: string): Promise<void> {
		await this.call("DELETE", key, {});
	}
}
