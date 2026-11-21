// A child process pins the checkout directory as its kernel cwd. A worker cannot
// redirect a parent-directory lookup to private host files during the walk.
import { createHash } from "node:crypto";
import {
	type BigIntStats,
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	readlinkSync,
	readSync,
	statSync,
	symlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const snapshotLimit = 16 * 1024 ** 3;
const maxFiles = 250000,
	chunkSize = 1024 ** 2;
export const chatId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stats = { bigint: true } as const;
const identity = (s: BigIntStats) => `${s.dev}:${s.ino}`;
const version = (s: BigIntStats) => `${identity(s)}:${s.size}:${s.ctimeNs}:${s.mtimeNs}:${s.nlink}`;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function timeLeft(deadline: number) {
	const left = deadline - Date.now();
	if (left < 1) throw Error("Snapshot deadline exceeded.");
	return left;
}

type Item = { path: string; kind: "dir" | "file" | "link"; mode: number; size: number; digest: string; target: string };
function checkPath(p: string) {
	if (["jobs.sqlite", "slack.sqlite", "memory.bundle", "checkouts"].includes(p)) return;
	const parts = p.split("/");
	if (
		parts[0] !== "checkouts" ||
		!chatId.test(parts[1]) ||
		parts.some((x) => !x || x === "." || x === ".." || x.includes("\0")) ||
		p.length > 4096
	)
		throw Error("Invalid snapshot member path.");
}
function linkSafe(path: string, target: string) {
	const root = path.split("/").slice(0, 2).join("/");
	const end = posix.normalize(posix.join(dirname(path), target));
	// A symlink followed by ".." can escape even when lexical normalization stays
	// inside. Allow leading parent components only, before dereferencing any name.
	let named = false;
	for (const part of target.split("/")) {
		if (part === ".." && named) return false;
		if (part && part !== "." && part !== "..") named = true;
	}
	return (
		target.length > 0 &&
		!target.includes("\0") &&
		!posix.isAbsolute(target) &&
		(end === root || end.startsWith(`${root}/`))
	);
}
export function initPackage(db: DatabaseSync) {
	db.exec(
		"CREATE TABLE items(path TEXT PRIMARY KEY,kind TEXT NOT NULL, mode INTEGER NOT NULL,size INTEGER NOT NULL,digest TEXT NOT NULL,target TEXT NOT NULL); CREATE TABLE chunks(path TEXT NOT NULL,seq INTEGER NOT NULL,data BLOB NOT NULL,UNIQUE(path,seq)); CREATE TABLE header(payload TEXT NOT NULL,digest TEXT NOT NULL);",
	);
}
export function packFiles(db: DatabaseSync, scratch: string, state: string, checkouts: string[], deadline: number) {
	const original = process.cwd(),
		item = db.prepare("INSERT INTO items VALUES(?,?,?,?,?,?)"),
		chunk = db.prepare("INSERT INTO chunks VALUES(?,?,?)");
	let total = 0,
		count = 0;
	function add(path: string, kind: Item["kind"], mode: number, size: number, digest: string, target = "") {
		checkPath(path);
		if (++count > maxFiles) throw Error("Snapshot file count exceeded.");
		item.run(path, kind, mode, size, digest, target);
	}
	function walk(name: string, path: string, dev?: bigint) {
		timeLeft(deadline);
		const entry = lstatSync(name, stats),
			mode = Number(entry.mode & 0o777n);
		if (dev !== undefined && entry.dev !== dev) throw Error("Mounted checkout entries cannot be snapshotted.");
		if (entry.isDirectory()) {
			add(path, "dir", mode, 0, "");
			const parent = identity(statSync(".", stats));
			process.chdir(name);
			if (identity(statSync(".", stats)) !== identity(entry)) throw Error("Checkout directory changed.");
			const stream = opendirSync(".");
			try {
				for (let child = stream.readSync(); child; child = stream.readSync())
					walk(child.name, `${path}/${child.name}`, entry.dev);
			} finally {
				stream.closeSync();
			}
			if (version(statSync(".", stats)) !== version(entry)) throw Error("Checkout directory changed while copying.");
			process.chdir("..");
			if (identity(statSync(".", stats)) !== parent) throw Error("Checkout ancestry changed.");
		} else if (entry.isSymbolicLink()) {
			const target = readlinkSync(name);
			if (!linkSafe(path, target)) throw Error("Checkout contains an external symbolic link.");
			add(path, "link", mode, Buffer.byteLength(target), hash(target), target);
		} else {
			if (!entry.isFile() || entry.nlink !== 1n) throw Error("Snapshot refuses linked or special files.");
			const size = Number(entry.size);
			total += size;
			if (total > snapshotLimit) throw Error("Snapshot byte limit exceeded.");
			const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const digest = createHash("sha256");
			try {
				if (version(fstatSync(fd, stats)) !== version(entry)) throw Error("Checkout file changed.");
				const buf = Buffer.alloc(Math.min(chunkSize, size));
				let offset = 0,
					seq = 0;
				while (offset < size) {
					timeLeft(deadline);
					const n = readSync(fd, buf, 0, Math.min(buf.length, size - offset), offset);
					if (!n) throw Error("Snapshot file was truncated.");
					const bytes = buf.subarray(0, n);
					digest.update(bytes);
					chunk.run(path, seq++, bytes);
					offset += n;
				}
				if (version(fstatSync(fd, stats)) !== version(entry)) throw Error("Checkout file changed during capture.");
			} finally {
				closeSync(fd);
			}
			add(path, "file", mode, size, digest.digest("hex"));
		}
		if (version(lstatSync(name, stats)) !== version(entry)) throw Error("Checkout entry changed during capture.");
	}
	try {
		process.chdir(scratch);
		for (const name of ["jobs.sqlite", "slack.sqlite", "memory.bundle"])
			if (lstatSync(name, { throwIfNoEntry: false })) walk(name, name);
		add("checkouts", "dir", 0o700, 0, "");
		process.chdir(join(state, "checkouts"));
		for (const id of checkouts) {
			if (!chatId.test(id) || !lstatSync(id).isDirectory()) throw Error("Invalid checkout root.");
			walk(id, `checkouts/${id}`);
		}
	} finally {
		process.chdir(original);
	}
}
export function manifestHash(db: DatabaseSync, payload: string) {
	const digest = createHash("sha256").update(payload).update("\n");
	for (const row of db.prepare("SELECT path,kind,mode,size,digest,target FROM items ORDER BY path").iterate())
		digest.update(JSON.stringify(row)).update("\n");
	return digest.digest("hex");
}
export function unpackFiles(db: DatabaseSync, stage: string, deadline: number) {
	const dirs = new Set<string>(["."]),
		dirModes: { path: string; mode: number }[] = [];
	let total = 0,
		count = 0,
		nChunks = 0;
	for (const raw of db.prepare("SELECT path,kind,mode,size,digest,target FROM items ORDER BY path").iterate()) {
		const row = raw as unknown as Item;
		timeLeft(deadline);
		checkPath(row.path);
		total += row.size;
		if (
			++count > maxFiles ||
			total > snapshotLimit ||
			!Number.isSafeInteger(row.size) ||
			row.size < 0 ||
			!Number.isInteger(row.mode) ||
			row.mode < 0 ||
			row.mode > 511 ||
			!dirs.has(dirname(row.path))
		)
			throw Error("Invalid snapshot member.");
		const path = join(stage, row.path);
		const parts = row.path.split("/");
		if (
			(parts[0] === "checkouts" && parts.length <= 2 && row.kind !== "dir") ||
			(parts[0] !== "checkouts" && row.kind !== "file")
		)
			throw Error("Invalid snapshot root member.");
		if (row.kind === "dir") {
			if (row.size !== 0 || row.digest || row.target) throw Error("Invalid snapshot directory.");
			mkdirSync(path, { mode: 0o700 });
			dirs.add(row.path);
			dirModes.push({ path, mode: row.mode });
		} else if (row.kind === "link") {
			if (
				!linkSafe(row.path, row.target) ||
				hash(row.target) !== row.digest ||
				Buffer.byteLength(row.target) !== row.size
			)
				throw Error("Invalid snapshot link.");
			symlinkSync(row.target, path);
		} else if (row.kind === "file") {
			if (row.target || !/^[a-f0-9]{64}$/.test(row.digest)) throw Error("Invalid snapshot digest.");
			const fd = openSync(path, "wx", 0o600),
				digest = createHash("sha256");
			let size = 0,
				seq = 0;
			try {
				for (const c of db.prepare("SELECT seq,data FROM chunks WHERE path=? ORDER BY seq").iterate(row.path)) {
					timeLeft(deadline);
					const data = c.data as Uint8Array;
					if (
						c.seq !== seq++ ||
						!(data instanceof Uint8Array) ||
						!data.length ||
						data.length > chunkSize ||
						size + data.length > row.size
					)
						throw Error("Invalid snapshot chunk.");
					nChunks++;
					size += data.length;
					digest.update(data);
					let offset = 0;
					while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
				}
			} finally {
				closeSync(fd);
			}
			if (size !== row.size || digest.digest("hex") !== row.digest) throw Error("Snapshot file checksum mismatch.");
			chmodSync(path, parts[0] === "checkouts" ? row.mode : 0o600);
		} else throw Error("Invalid snapshot entry type.");
	}
	if (Number(db.prepare("SELECT count(*) AS n FROM chunks").get()?.n) !== nChunks)
		throw Error("Unreferenced snapshot chunks.");
	for (const d of dirModes.reverse()) chmodSync(d.path, d.mode);
	return count;
}
