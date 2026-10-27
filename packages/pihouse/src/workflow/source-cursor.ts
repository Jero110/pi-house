import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface JsonlSourceCursor {
	sourceKind: "jsonl";
	sourceId: string;
	byteOffset: number;
	prefixFingerprint: string;
	recordCount: number;
	forkedFrom: string | null;
}

export type JsonlCursorInspection =
	| { state: "verified"; cursor: JsonlSourceCursor; appendedRecordIds: string[] }
	| { state: "deferred"; reason: string };

const fingerprint = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function recordId(line: string): string | undefined {
	try {
		const value: unknown = JSON.parse(line);
		const id = value && typeof value === "object" ? Reflect.get(value, "id") : undefined;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Verifies an append-only JSONL prefix without retaining conversational record bodies.
 * Problem: journal timestamps can stay fixed while a session appends entries. Example: a saved pi run grows without
 * a journal patch, so updatedAt alone either misses work or guesses. Solution: fence by byte offset and prefix hash;
 * truncation, rotation and malformed suffixes defer without replacing retained evidence.
 */
export function inspectJsonlCursor(
	path: string,
	sourceId: string | undefined,
	previous: JsonlSourceCursor | null,
): JsonlCursorInspection {
	if (!sourceId) return { state: "deferred", reason: "source identity is unknown" };
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch {
		return { state: "deferred", reason: "source file is unavailable" };
	}
	if (!bytes.length) return { state: "deferred", reason: "source file is empty" };
	const text = bytes.toString("utf8");
	const lines = text.split("\n");
	const first = lines.find((line) => line.length > 0);
	let header: unknown;
	try {
		header = JSON.parse(first ?? "");
	} catch {
		return { state: "deferred", reason: "JSONL header is invalid" };
	}
	if (
		!header ||
		typeof header !== "object" ||
		Reflect.get(header, "type") !== "session" ||
		Reflect.get(header, "id") !== sourceId
	) {
		return { state: "deferred", reason: "source session identity does not match" };
	}
	const records: { line: string; start: number; end: number }[] = [];
	let offset = 0;
	for (const line of lines) {
		const length = Buffer.byteLength(line);
		if (line.length) records.push({ line, start: offset, end: offset + length });
		offset += length + 1;
	}
	const appendedRecordIds: string[] = [];
	if (previous) {
		if (previous.sourceKind !== "jsonl" || previous.sourceId !== sourceId)
			return { state: "deferred", reason: "stored cursor provenance does not match this source" };
		if (bytes.length < previous.byteOffset) return { state: "deferred", reason: "source was truncated or rotated" };
		if (fingerprint(bytes.subarray(0, previous.byteOffset)) !== previous.prefixFingerprint)
			return { state: "deferred", reason: "source prefix changed or was rotated" };
		if (
			previous.byteOffset > 0 &&
			bytes[previous.byteOffset - 1] !== 0x0a &&
			bytes[previous.byteOffset] !== 0x0a &&
			bytes.length > previous.byteOffset
		)
			return { state: "deferred", reason: "append is not at a JSONL record boundary" };
		const seenIds = new Set<string>();
		for (const record of records) {
			if (record.start < previous.byteOffset && record.end > previous.byteOffset)
				return { state: "deferred", reason: "stored cursor is not on a record boundary" };
			if (record.start < previous.byteOffset) {
				const id = recordId(record.line);
				if (id) seenIds.add(id);
				continue;
			}
			const id = recordId(record.line);
			if (id === undefined) return { state: "deferred", reason: "appended JSONL record is invalid" };
			if (id && !seenIds.has(id)) {
				appendedRecordIds.push(id);
				seenIds.add(id);
			}
		}
	} else {
		for (const record of records) {
			if (recordId(record.line) === undefined)
				return { state: "deferred", reason: "source contains an invalid JSONL record" };
		}
		for (const record of records.slice(1)) {
			const id = recordId(record.line);
			if (id && !appendedRecordIds.includes(id)) appendedRecordIds.push(id);
		}
	}
	return {
		state: "verified",
		cursor: {
			sourceKind: "jsonl",
			sourceId,
			byteOffset: bytes.length,
			prefixFingerprint: fingerprint(bytes),
			recordCount: records.length,
			forkedFrom:
				typeof Reflect.get(header, "parentSessionId") === "string"
					? Reflect.get(header, "parentSessionId")
					: typeof Reflect.get(header, "parentSession") === "string"
						? Reflect.get(header, "parentSession")
						: typeof Reflect.get(header, "forkedFrom") === "string"
							? Reflect.get(header, "forkedFrom")
							: null,
		},
		appendedRecordIds,
	};
}
