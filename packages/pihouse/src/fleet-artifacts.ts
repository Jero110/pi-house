// Snapshots live in the host database. A download never opens an agent-controlled path.
import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	opendirSync,
	openSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

type ArtifactType = "text" | "image" | "file";
export type ArtifactSummary = { id: string; name: string; size: number; type: ArtifactType };
export type FleetArtifact = { bytes: Buffer; name: string; mime: string; type: ArtifactType };
type Entry = { name: string; hash: string; data?: string };
type Baseline = Map<string, string> | undefined;

const fileLimit = 4 * 1024 * 1024;
const turnLimit = 12 * 1024 * 1024;
const maxEntries = 64;
const statOptions = { bigint: true } as const;

function identity(s: BigIntStats) {
	return `${s.dev}:${s.ino}`;
}
function version(s: BigIntStats) {
	return `${identity(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.nlink}`;
}

function readPinnedDirectory(expected: string, hashOnly: boolean): Entry[] {
	const dir = statSync(".", statOptions);
	if (!dir.isDirectory() || identity(dir) !== expected) throw new Error("Changed directory.");
	const result: Entry[] = [];
	let total = 0;
	let count = 0;
	const stream = opendirSync(".");
	try {
		for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
			if (++count > maxEntries) throw new Error("Artifact directory exceeds its entry limit.");
			const name = entry.name;
			if (!/^[\p{L}\p{N}_-][\p{L}\p{N} _.-]{0,119}$/u.test(name)) continue;
			const before = lstatSync(name, statOptions);
			if (!before.isFile() || before.nlink !== 1n || before.dev !== dir.dev || before.size > BigInt(fileLimit))
				continue;
			total += Number(before.size);
			if (total > turnLimit) throw new Error("Artifact directory exceeds its size limit.");
			const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const pinned = fstatSync(fd, statOptions);
				if (!pinned.isFile() || version(pinned) !== version(before)) throw new Error("Changed artifact.");
				const data = Buffer.alloc(Number(pinned.size));
				let pos = 0;
				while (pos < data.length) {
					const n = readSync(fd, data, pos, data.length - pos, pos);
					if (!n) throw new Error("Changed artifact.");
					pos += n;
				}
				if (
					version(fstatSync(fd, statOptions)) !== version(pinned) ||
					version(lstatSync(name, statOptions)) !== version(pinned)
				)
					throw new Error("Changed artifact.");
				result.push({
					name,
					hash: createHash("sha256").update(data).digest("hex"),
					data: hashOnly ? undefined : data.toString("base64"),
				});
			} finally {
				closeSync(fd);
			}
		}
	} finally {
		stream.closeSync();
	}
	if (version(statSync(".", statOptions)) !== version(dir)) throw new Error("Changed artifact directory.");
	return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function scan(checkout: string, hashOnly: boolean): Entry[] | undefined {
	try {
		// The checkout's parent belongs to the host. Only artifacts/ and its entries can
		// be swapped by a worker. Pin the helper's cwd in the kernel, match its inode
		// to the lstat of the real directory, then use only single-component names.
		const root = lstatSync(checkout, statOptions);
		if (!root.isDirectory() || realpathSync(checkout) !== checkout) return;
		const path = join(checkout, "artifacts");
		const dir = lstatSync(path, { bigint: true, throwIfNoEntry: false });
		if (!dir) return [];
		if (!dir.isDirectory() || dir.dev !== root.dev) return;
		const raw = execFileSync(
			process.execPath,
			[fileURLToPath(import.meta.url), "scan", identity(dir), hashOnly ? "hash" : "bytes"],
			{
				cwd: path,
				env: {},
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 5000,
				maxBuffer: turnLimit * 2,
				encoding: "utf8",
			},
		);
		if (
			identity(lstatSync(checkout, statOptions)) !== identity(root) ||
			version(lstatSync(path, statOptions)) !== version(dir)
		)
			return;
		return JSON.parse(raw) as Entry[];
	} catch {
		return undefined;
	}
}

if (import.meta.main && process.argv[2] === "scan") {
	try {
		process.stdout.write(JSON.stringify(readPinnedDirectory(process.argv[3], process.argv[4] === "hash")));
	} catch {
		process.exitCode = 1;
	}
}

function classify(name: string, bytes: Buffer, previewDeadline: number): { type: ArtifactType; mime: string } {
	const ext = extname(name).toLowerCase();
	const isText = [".txt", ".md", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml"].includes(ext);
	if (isText && isUtf8(bytes) && !bytes.some((b) => (b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127))
		return { type: "text", mime: "text/plain; charset=utf-8" };
	const png = ext === ".png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
	const jpeg = [".jpg", ".jpeg"].includes(ext) && bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
	if ((png || jpeg) && process.platform === "darwin" && Date.now() < previewDeadline) {
		const dir = mkdtempSync(join(tmpdir(), "fleet-image-"));
		try {
			const path = join(dir, png ? "input.png" : "input.jpg");
			writeFileSync(path, bytes, { mode: 0o600 });
			const inspect = execFileSync("/usr/bin/sips", ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", path], {
				encoding: "utf8",
				timeout: Math.max(1, Math.min(2500, previewDeadline - Date.now())),
				cwd: dir,
				env: { HOME: dir, TMPDIR: dir, PATH: "/usr/bin:/bin" },
				maxBuffer: 65536,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const width = Number(/pixelWidth: (\d+)/.exec(inspect)?.[1]);
			const height = Number(/pixelHeight: (\d+)/.exec(inspect)?.[1]);
			if (
				inspect.includes(`format: ${png ? "png" : "jpeg"}`) &&
				width > 0 &&
				height > 0 &&
				width * height <= 12_000_000 &&
				Math.max(width, height) <= 8192
			) {
				// Verify the decoder can produce pixels before permitting inline presentation.
				execFileSync("/usr/bin/sips", ["-Z", "2", "-s", "format", "png", path, "--out", join(dir, "verified.png")], {
					timeout: Math.max(1, Math.min(3500, previewDeadline - Date.now())),
					cwd: dir,
					env: { HOME: dir, TMPDIR: dir, PATH: "/usr/bin:/bin" },
					stdio: "ignore",
				});
				if (statSync(join(dir, "verified.png")).size > 0)
					return { type: "image", mime: png ? "image/png" : "image/jpeg" };
			}
		} catch {
			/* Unsupported or malformed image bytes remain downloads. */
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	}
	return { type: "file", mime: "application/octet-stream" };
}

export function createArtifactStore(db: DatabaseSync) {
	db.exec(
		"CREATE TABLE IF NOT EXISTS fleet_artifacts(id TEXT PRIMARY KEY,chat TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,type TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL); CREATE INDEX IF NOT EXISTS fleet_artifacts_chat ON fleet_artifacts(chat)",
	);
	return {
		baseline(checkout: string): Baseline {
			const entries = scan(checkout, true);
			return entries && new Map(entries.map((e) => [e.name, e.hash]));
		},
		capture(chat: string, checkout: string, before: Baseline) {
			if (!before) return false;
			const entries = scan(checkout, false);
			if (!entries) return false;
			const changed = entries.filter((e) => e.hash !== before.get(e.name));
			const count = db
				.prepare("SELECT count(*) AS count,coalesce(sum(size),0) AS total FROM fleet_artifacts WHERE chat=?")
				.get(chat);
			const total = db.prepare("SELECT coalesce(sum(size),0) AS total FROM fleet_artifacts").get();
			const blobs = changed.map((e) => ({ name: e.name, bytes: Buffer.from(e.data ?? "", "base64") }));
			const size = blobs.reduce((sum, e) => sum + e.bytes.length, 0);
			if (
				Number(count?.count) + blobs.length > 64 ||
				Number(count?.total) + size > 32 * 1024 * 1024 ||
				Number(total?.total) + size > 256 * 1024 * 1024
			)
				return false;
			const insert = db.prepare("INSERT INTO fleet_artifacts(id,chat,name,size,type,mime,bytes) VALUES(?,?,?,?,?,?,?)");
			const previewDeadline = Date.now() + 5000;
			for (const { name, bytes } of blobs) {
				const { type, mime } = classify(name, bytes, previewDeadline);
				insert.run(randomUUID(), chat, name, bytes.length, type, mime, bytes);
			}
			return true;
		},
		list(chat: string): ArtifactSummary[] {
			return db
				.prepare("SELECT id,name,size,type FROM fleet_artifacts WHERE chat=? ORDER BY rowid")
				.all(chat) as unknown as ArtifactSummary[];
		},
		get(chat: string, id: string): FleetArtifact | undefined {
			const row = db.prepare("SELECT name,type,mime,bytes FROM fleet_artifacts WHERE chat=? AND id=?").get(chat, id);
			if (!row) return;
			return {
				name: String(row.name),
				type: row.type as ArtifactType,
				mime: String(row.mime),
				bytes: Buffer.from(row.bytes as Uint8Array),
			};
		},
	};
}
