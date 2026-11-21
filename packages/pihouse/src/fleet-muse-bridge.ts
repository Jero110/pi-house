import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { readKnowledgeSource } from "./fleet-knowledge-source.ts";

const requestName = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const maxRequestBytes = 1024;

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function requirePrivateDirectory(path: string, uid: number): void {
	const entry = lstatSync(path, { throwIfNoEntry: false });
	if (!entry?.isDirectory() || entry.uid !== uid || (entry.mode & 0o077) !== 0 || realpathSync(path) !== path) {
		throw Error("Expected a private canonical directory owned by the current user.");
	}
}

function exchangeDirectory(root: string, name: string, uid: number): string {
	const path = join(root, name);
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error;
	}
	requirePrivateDirectory(path, uid);
	return path;
}

function readUpTo(fd: number, limit: number): Buffer {
	const bytes = Buffer.alloc(limit);
	let length = 0;
	while (length < bytes.length) {
		const count = readSync(fd, bytes, length, bytes.length - length, null);
		if (count === 0) break;
		length += count;
	}
	return bytes.subarray(0, length);
}

function isReadRequest(path: string, id: string, uid: number): boolean {
	try {
		const entry = lstatSync(path);
		if (!entry.isFile() || entry.uid !== uid || entry.nlink !== 1) return false;
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = fstatSync(fd);
			if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1) return false;
			const bytes = readUpTo(fd, maxRequestBytes + 1);
			if (bytes.length > maxRequestBytes) return false;
			const request: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			return (
				typeof request === "object" &&
				request !== null &&
				Object.keys(request).length === 2 &&
				"id" in request &&
				request.id === id &&
				"op" in request &&
				request.op === "read_source"
			);
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

function withTemporaryFile(directory: string, contents: string | Buffer, publish: (temporary: string) => void): void {
	const temporary = join(directory, `.${randomUUID()}.partial`);
	const fd = openSync(temporary, "wx", 0o600);
	try {
		try {
			fchmodSync(fd, 0o600);
			writeFileSync(fd, contents);
		} finally {
			closeSync(fd);
		}
		publish(temporary);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function publishResponse(outbox: string, filename: string, response: object): void {
	withTemporaryFile(outbox, `${JSON.stringify(response)}\n`, (temporary) => {
		// The destination appears only when complete. An existing receipt, even a dangling symlink, wins.
		try {
			linkSync(temporary, join(outbox, filename));
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
	});
}

function responseFor(id: string, knowledgeRepo: string) {
	try {
		return { id, status: "completed", source: readKnowledgeSource(knowledgeRepo) };
	} catch {
		return { id, status: "failed", error: "source_unavailable" };
	}
}

function runOnce(root: string, knowledgeRepo: string, uid: number): void {
	const inbox = exchangeDirectory(root, "inbox", uid);
	const outbox = exchangeDirectory(root, "outbox", uid);
	for (const filename of readdirSync(inbox)) {
		const id = requestName.exec(filename)?.[1];
		if (!id) continue;
		try {
			if (lstatSync(join(outbox, filename), { throwIfNoEntry: false })) continue;
			if (!isReadRequest(join(inbox, filename), id, uid)) continue;
			publishResponse(outbox, filename, responseFor(id, knowledgeRepo));
		} catch {
			process.stderr.write(`Could not publish Muse response for ${id}.\n`);
			process.exitCode = 1;
		}
	}
}

function snapshotEntry(path: string, uid: number) {
	const entry = lstatSync(path, { throwIfNoEntry: false });
	if (entry && (!entry.isFile() || entry.uid !== uid || entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600)) {
		throw Error("Expected source.json to be a private regular file owned by the current user.");
	}
	return entry;
}

function publishSnapshot(root: string, knowledgeRepo: string, uid: number): void {
	const path = join(root, "source.json");
	snapshotEntry(path, uid);
	let contents: Buffer;
	try {
		contents = Buffer.from(`${JSON.stringify(readKnowledgeSource(knowledgeRepo))}\n`);
	} catch {
		// Retaining the previous projection would let Muse read a document the current commit no longer authorizes.
		if (snapshotEntry(path, uid)) unlinkSync(path);
		throw Error("Knowledge source unavailable.");
	}

	const previous = snapshotEntry(path, uid);
	if (previous?.size === contents.length) {
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = fstatSync(fd);
			if (opened.dev !== previous.dev || opened.ino !== previous.ino)
				throw Error("Snapshot changed during publication.");
			if (readUpTo(fd, contents.length + 1).equals(contents)) return;
		} finally {
			closeSync(fd);
		}
	}
	withTemporaryFile(root, contents, (temporary) => {
		snapshotEntry(path, uid);
		renameSync(temporary, path);
	});
}

if (import.meta.main) {
	try {
		const [action, root, knowledgeRepo, ...extra] = process.argv.slice(2);
		if ((action !== "once" && action !== "publish") || !root || !knowledgeRepo || extra.length) {
			throw Error("Usage: fleet-muse-bridge.ts once|publish <exchange-dir> <knowledge-repo>");
		}
		const uid = process.getuid?.();
		if (!isAbsolute(root) || uid === undefined)
			throw Error("Expected a private canonical directory owned by the current user.");
		requirePrivateDirectory(root, uid);
		if (action === "once") runOnce(root, knowledgeRepo, uid);
		else publishSnapshot(root, knowledgeRepo, uid);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "Muse exchange failed."}\n`);
		process.exitCode = 1;
	}
}
