import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { AdapterError, boundedInteger } from "./config.ts";
import { safePath } from "./locations.ts";

export const publicationLimits = Object.freeze({
	requests: 100000,
	writeBytes: 4 * 1024 ** 3,
	responseBytes: 8 * 1024 ** 3,
	vectors: 50000,
	inputs: 50000,
	uploadBytes: 1024 ** 3,
	pineconeBytes: 1024 ** 3,
	pineconeResponseBytes: 700000000,
	s3ResponseBytes: 4500000000,
});
export type Capacity = { -readonly [K in keyof typeof publicationLimits]: number };
export type Accounting = (writeBytes: number, responseLimit: number) => (actualResponseBytes: number) => void;
export function capacitySettings(env: Record<string, string | undefined>): Capacity {
	const result = { ...publicationLimits } as Capacity;
	for (const key of Object.keys(result) as (keyof Capacity)[]) {
		const name = `BOOKS_PUBLICATION_${key.replace(/[A-Z]/gu, (c) => `_${c}`).toUpperCase()}`;
		const raw = env[name];
		if (raw !== undefined) {
			if (!/^\d+$/u.test(raw)) throw new AdapterError("configuration", `Invalid ${name}`);
			result[key] = boundedInteger(Number(raw), 1, publicationLimits[key], name);
		}
	}
	return result;
}
/** Local writer lock protects this receipt. Reserve maximum response before dispatch:
 * a killed/ambiguous request is never free on restart. Successful reads settle to
 * actual body bytes; HTTP headers/provider metering are not payload accounting. */
export class PublicationBudget {
	private used: Capacity = {
		requests: 0,
		writeBytes: 0,
		responseBytes: 0,
		vectors: 0,
		inputs: 0,
		uploadBytes: 0,
		pineconeBytes: 0,
		pineconeResponseBytes: 0,
		s3ResponseBytes: 0,
	};
	private readonly path: string;
	readonly limits: Capacity;
	constructor(path: string, limits: Capacity) {
		this.path = path;
		this.limits = { ...limits };
		for (const key of Object.keys(limits) as (keyof Capacity)[])
			boundedInteger(limits[key], 1, publicationLimits[key], `publication ${key}`);
		safePath(path, true);
		if (existsSync(path)) {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 4096)
				throw new AdapterError("configuration", "Unsafe publication capacity receipt");
			const receipt = JSON.parse(readFileSync(path, "utf8"));
			if (receipt.schema !== 2)
				throw new AdapterError(
					"configuration",
					"Legacy publication accounting lacks provider egress; reconcile and archive with no active writer before a new accounting window",
				);
			for (const key of Object.keys(this.used) as (keyof Capacity)[])
				this.used[key] = boundedInteger(receipt.used?.[key], 0, Number.MAX_SAFE_INTEGER, `receipt ${key}`);
		}
	}
	remaining(): Capacity {
		return Object.fromEntries(
			Object.entries(this.limits).map(([key, value]) => [key, value - this.used[key as keyof Capacity]]),
		) as Capacity;
	}
	check(planned: Partial<Capacity>): void {
		const remaining = this.remaining();
		for (const [key, value] of Object.entries(planned)) {
			boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, `planned ${key}`);
			if (value > remaining[key as keyof Capacity])
				throw new AdapterError(
					"resource_limit",
					`Publication capacity insufficient: ${key} planned=${value} remaining=${remaining[key as keyof Capacity]} cap=${this.limits[key as keyof Capacity]}; no automatic budget reset`,
				);
		}
	}
	charge(planned: Partial<Capacity>): void {
		this.check(planned);
		for (const [key, value] of Object.entries(planned)) this.used[key as keyof Capacity] += value;
		this.save();
	}
	/** Reserve a conservative 8KiB HTTP/TLS envelope per physical attempt too.
	 * This is quota headroom, not a claim about provider billing measurements. */
	providerAccount(provider: "pinecone" | "s3"): Accounting {
		const key = provider === "pinecone" ? "pineconeResponseBytes" : "s3ResponseBytes";
		return (write, response) => {
			this.charge({ [key]: response + 8192 });
			const settle = this.account(write, response);
			return (actual) => {
				this.used[key] += actual - response;
				settle(actual);
				this.check({ [key]: 0 });
			};
		};
	}
	readonly account: Accounting = (writeBytes, responseBytes) => {
		this.charge({ requests: 1, writeBytes, responseBytes });
		return (actual) => {
			boundedInteger(actual, 0, Number.MAX_SAFE_INTEGER, "actual response bytes");
			this.used.responseBytes += actual - responseBytes;
			this.save();
			this.check({ responseBytes: 0 });
		};
	};
	private save(): void {
		const temporary = `${this.path}.tmp`;
		safePath(temporary, true);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(fd, JSON.stringify({ schema: 2, used: this.used }));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, this.path);
		const directory = openSync(dirname(this.path), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	}
}
