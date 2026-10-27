import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type DispatchInput, enqueueJob, isQuiescent } from "./jobs.ts";
import { runSelfLearning, type SelfLearningOptions } from "./learning-review.ts";
import { migrateLegacyStore } from "./migration.ts";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

export interface RuntimeCandidate extends DispatchInput {
	runId: string;
	project: string;
	expectedFiles: string[];
}

export interface RuntimeOptions {
	storeDir: string;
	db: DatabaseSync;
	ownedRoot: string;
	/** Hub/journal facts are trusted only when observed for every participant. */
	operationalState: (runId: string) => {
		states: string[];
		deliveries: number | null;
		handoff: boolean | null;
		livenessKnown: boolean;
	};
	/** Independent current source hash; never a cached commit fingerprint. */
	currentFingerprint: (revision: string) => string | undefined;
}

/** Called only by explicit digest/self-learning entry points; migration is never performed during startup. */
export function activateLearningStore(options: RuntimeOptions): void {
	migrateLegacyStore(options.storeDir);
}

/** Select only safe, operational revisions with complete captured packages and known quiescence. */
export function produceDigestCandidates(options: RuntimeOptions): {
	candidates: RuntimeCandidate[];
	deferred: { revision: string; reason: string }[];
} {
	const candidates: RuntimeCandidate[] = [];
	const deferred: { revision: string; reason: string }[] = [];
	const rows = options.db
		.prepare(
			"SELECT r.id, r.run_id, r.source_hash FROM revisions r LEFT JOIN cleanup_manifests c ON c.id=r.id WHERE c.id IS NULL ORDER BY r.created_at, r.rowid",
		)
		.all();
	for (const row of rows) {
		const revision = String(row.id);
		const runId = String(row.run_id);
		if (!SAFE_ID.test(revision) || !SAFE_ID.test(runId) || typeof row.source_hash !== "string") {
			deferred.push({ revision, reason: "unsafe or incomplete revision identity" });
			continue;
		}
		const state = options.operationalState(runId);
		if (!isQuiescent(state)) {
			deferred.push({ revision, reason: "run is active or liveness/delivery status is unknown" });
			continue;
		}
		if (options.currentFingerprint(revision) !== row.source_hash) {
			deferred.push({ revision, reason: "source fingerprint is unavailable or changed" });
			continue;
		}
		const root = join(options.ownedRoot, "runs", runId);
		const packagePath = join(root, "run.json");
		const transcripts = join(root, "transcripts");
		try {
			const info: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
			if (typeof info !== "object" || info === null || Array.isArray(info)) throw new Error("invalid package");
			const pkg = info as Record<string, unknown>;
			if (pkg.id !== runId || !Array.isArray(pkg.agents) || pkg.agents.length === 0)
				throw new Error("incomplete package");
			const files = readdirSync(transcripts)
				.filter((name) => /^[a-z0-9][a-z0-9._-]*\.json$/i.test(name))
				.sort();
			if (files.length === 0 || files.some((name) => !statSync(join(transcripts, name)).isFile()))
				throw new Error("no retained transcript package");
			const packageFingerprint = sha256(
				JSON.stringify({
					package: readFileSync(packagePath),
					files: files.map((name) => [name, readFileSync(join(transcripts, name))]),
				}),
			);
			if (!packageFingerprint) throw new Error("package fingerprint unavailable");
			// Never infer completeness from a legacy processed flag; only current operational evidence gets a new job.
			const project = typeof pkg.project === "string" ? pkg.project : "";
			if (
				!project ||
				pkg.agents.some(
					(agent) => typeof agent !== "object" || agent === null || (agent as Record<string, unknown>).missing,
				)
			)
				throw new Error("retained package coverage is incomplete");
			const id = `digest-${revision}`;
			enqueueJob(options.db, id, revision, String(row.source_hash));
			candidates.push({
				id,
				revision,
				runId,
				project,
				fingerprint: String(row.source_hash),
				evidencePath: resolve(packagePath),
				expectedFiles: files,
			});
		} catch {
			deferred.push({ revision, reason: "retained run package is missing or incomplete" });
		}
	}
	return { candidates, deferred };
}

/** Runtime coordinator port; callers wire verified native worker adapters and commit/cleanup gates explicitly. */
export async function executeSelfLearning(
	db: DatabaseSync,
	options: SelfLearningOptions,
	authorize: boolean,
	storeDir: string,
) {
	if (!authorize) throw new Error("Learning execution requires an explicit digest or self-learning invocation");
	migrateLegacyStore(storeDir);
	return runSelfLearning(db, options);
}
