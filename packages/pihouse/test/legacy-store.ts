// Test helper: a memory folder in the layout that existed before the vault, for the tests of the legacy migration.
// Problem: `openMemory` starts an empty folder as an active vault, so it can no longer produce a legacy JSON store, and
// the migration still has to be proven against one. Example: runs/<id>/ and ideas/ at the root, an index.json.
// Solution: seed an empty index.json so the store stays unmigrated, write through the store as usual, then move the
// folders back to their old names and rewrite the index paths. The assertions of the tests stay as they were.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type MemoryStore, openMemory } from "../src/workflow/memory.ts";

const MOVES: [string, string][] = [
	["conversations", "runs"],
	["ask/ideas", "ideas"],
	["ask/consulted", "consulted"],
	["workflow/proposals", "proposals"],
];

/** An unmigrated JSON store: a folder holding legacy content is never started as a fresh vault. */
export function openLegacyMemory(dir: string, opts: { now?: () => Date } = {}): MemoryStore {
	mkdirSync(dir, { recursive: true });
	const index = join(dir, "index.json");
	if (!existsSync(index)) writeFileSync(index, JSON.stringify({ schema: 1, entries: [], rejected: [] }));
	return openMemory(dir, opts);
}

/** Moves what a legacy store wrote back to the pre-vault folder names. Call it when the fixture is complete. */
export function toLegacyLayout(dir: string): void {
	for (const [from, to] of MOVES) {
		if (!existsSync(join(dir, from))) continue;
		renameSync(join(dir, from), join(dir, to));
	}
	for (const leftover of ["ask", "workflow"]) rmSync(join(dir, leftover), { recursive: true, force: true });
	const file = join(dir, "index.json");
	const index = JSON.parse(readFileSync(file, "utf8")) as { entries: { path: string }[] };
	for (const entry of index.entries) {
		for (const [from, to] of MOVES) {
			if (entry.path.startsWith(`${from}/`)) entry.path = `${to}/${entry.path.slice(from.length + 1)}`;
		}
	}
	writeFileSync(file, JSON.stringify(index, null, "\t"));
	mkdirSync(dirname(file), { recursive: true });
}
