import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface ArtifactCommit {
	id: string;
	path: string;
	hash: string;
}

export function commitArtifact(input: { root: string; id: string; kind: string; content: string }): ArtifactCommit {
	const root = resolve(input.root);
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(input.id) || !/^[a-z][a-z0-9-]*$/i.test(input.kind))
		throw new Error("Invalid artifact identity");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	const path = join(root, `${input.kind}-${input.id}.md`);
	const hash = createHash("sha256").update(input.content).digest("hex");
	const manifest = join(root, `.commit-${input.id}.json`);
	const temp = join(root, `.${randomUUID()}.tmp`);
	const manifestTemp = join(root, `.${randomUUID()}.tmp`);
	writeFileSync(temp, input.content, { flag: "wx", mode: 0o600 });
	writeFileSync(manifestTemp, JSON.stringify({ id: input.id, path, hash, state: "prepared" }), {
		flag: "wx",
		mode: 0o600,
	});
	renameSync(manifestTemp, manifest);
	renameSync(temp, path);
	writeFileSync(manifestTemp, JSON.stringify({ id: input.id, path, hash, state: "committed" }), {
		flag: "wx",
		mode: 0o600,
	});
	renameSync(manifestTemp, manifest);
	return { id: input.id, path, hash };
}

export function recoverArtifactCommits(db: DatabaseSync, rootPath: string): string[] {
	const root = resolve(rootPath);
	if (!existsSync(root)) return [];
	const recovered: string[] = [];
	for (const name of readdirSync(root)) {
		if (!name.startsWith(".commit-") || !name.endsWith(".json")) continue;
		const manifest = JSON.parse(readFileSync(join(root, name), "utf8")) as {
			id: string;
			path: string;
			hash: string;
			state: string;
		};
		if (!resolve(manifest.path).startsWith(`${root}/`)) throw new Error("Artifact manifest path escapes private root");
		if (!existsSync(manifest.path)) continue;
		const hash = createHash("sha256").update(readFileSync(manifest.path)).digest("hex");
		if (hash !== manifest.hash) throw new Error(`Artifact corruption detected: ${manifest.id}`);
		db.prepare(
			"INSERT INTO artifact_commits(id,path,hash,state,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path, hash=excluded.hash, state=excluded.state",
		).run(manifest.id, manifest.path, hash, "committed", new Date().toISOString());
		recovered.push(manifest.id);
	}
	return recovered;
}
