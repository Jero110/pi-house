import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { cleanupAdapter, commitDigest } from "./cleanup.ts";
import type { DigestIdentity } from "./digest-contract.ts";
import { type DispatchInput, dispatchCleanup, dispatchJobs, enqueueJob, isQuiescent } from "./jobs.ts";
import { runSelfLearning, type SelfLearningOptions } from "./learning-review.ts";
import { migrateLegacyStore } from "./migration.ts";
import type { WorkerJob, WorkerResult } from "./worker-adapter.ts";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

export interface RuntimeCandidate extends DispatchInput {
	runId: string;
	project: string;
	expectedFiles: string[];
	inputFingerprint: string;
	inputBytes: number;
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
	let aggregateBytes = 0;
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
			const rootStat = lstatSync(root);
			const packageStat = lstatSync(packagePath);
			const transcriptStat = lstatSync(transcripts);
			if (
				rootStat.isSymbolicLink() ||
				!rootStat.isDirectory() ||
				packageStat.isSymbolicLink() ||
				!packageStat.isFile() ||
				transcriptStat.isSymbolicLink() ||
				!transcriptStat.isDirectory()
			)
				throw new Error("unsafe owned input path");
			const info: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
			if (typeof info !== "object" || info === null || Array.isArray(info)) throw new Error("invalid package");
			const pkg = info as Record<string, unknown>;
			if (
				pkg.id !== runId ||
				pkg.fingerprint !== row.source_hash ||
				!Array.isArray(pkg.agents) ||
				pkg.agents.length === 0
			)
				throw new Error("incomplete package");
			const realRoot = realpathSync(options.ownedRoot);
			const realRun = realpathSync(root);
			const realTranscripts = realpathSync(transcripts);
			if (!realRun.startsWith(`${realRoot}/`) || !realTranscripts.startsWith(`${realRun}/`))
				throw new Error("owned path escaped");
			const files = readdirSync(transcripts).sort();
			if (
				files.length === 0 ||
				files.some(
					(name) =>
						!/^[a-z0-9][a-z0-9._-]*\.(json|jsonl)$/i.test(name) ||
						!lstatSync(join(transcripts, name)).isFile() ||
						lstatSync(join(transcripts, name)).isSymbolicLink(),
				)
			)
				throw new Error("retained transcript package is missing or unsafe");
			const packageBytes = readFileSync(packagePath);
			const sourceBytes = files.map((name) => [name, readFileSync(join(transcripts, name))] as const);
			const inputBytes = packageBytes.length + sourceBytes.reduce((sum, [, bytes]) => sum + bytes.length, 0);
			if (inputBytes > 2_000_000 || aggregateBytes + inputBytes > 2_000_000)
				throw new Error("aggregate input budget exceeded");
			const packageFingerprint = sha256(JSON.stringify({ package: packageBytes, files: sourceBytes }));
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
			aggregateBytes += inputBytes;
			candidates.push({
				id,
				revision,
				runId,
				project,
				fingerprint: String(row.source_hash),
				evidencePath: resolve(root),
				expectedFiles: files,
				inputFingerprint: packageFingerprint,
				inputBytes,
			});
		} catch {
			deferred.push({ revision, reason: "retained run package is missing or incomplete" });
		}
	}
	return { candidates, deferred };
}

export async function executeDigest(
	options: RuntimeOptions & {
		digestRoot: string;
		outputPath: (candidate: RuntimeCandidate) => string;
		cwd: string;
		invocation: string;
		now: () => number;
		worker: (job: WorkerJob) => Promise<WorkerResult>;
	},
	candidates: RuntimeCandidate[],
): Promise<Array<{ revision: string; status: string; path?: string }>> {
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const dispatched = await dispatchJobs(options.db, candidates, {
		invocation: options.invocation,
		now: options.now,
		leaseMs: 120_000,
		maxJobs: 2,
		maxAttempts: 2,
		adapter: async ({ id, revision, evidencePath }) => {
			const candidate = byId.get(id);
			if (!candidate || options.currentFingerprint(revision) !== candidate.fingerprint) return { status: "failure" };
			const outputPath = options.outputPath(candidate);
			const outcome = await options.worker({
				stage: "digest",
				id,
				revision,
				inputPath: evidencePath,
				outputPath,
				cwd: options.cwd,
				project: candidate.project,
				maxOutputBytes: 12_000,
			});
			if (outcome.status !== "success") return { status: outcome.status === "cancelled" ? "cancelled" : "failure" };
			const packagePath = join(options.ownedRoot, "runs", candidate.runId, "run.json");
			const transcriptDir = join(options.ownedRoot, "runs", candidate.runId, "transcripts");
			const names = candidate.expectedFiles;
			const bytes = readFileSync(packagePath);
			const inputs = names.map((name) => [name, readFileSync(join(transcriptDir, name))] as const);
			if (sha256(JSON.stringify({ package: bytes, files: inputs })) !== candidate.inputFingerprint)
				return { status: "failure" };
			const identity: DigestIdentity = { runId: candidate.runId, project: candidate.project, revision };
			const committed = commitDigest(options.db, {
				ownedRoot: options.ownedRoot,
				digestRoot: options.digestRoot,
				identity,
				digest: { text: readFileSync(outcome.outputPath, "utf8"), finish: "stop" },
				currentFingerprint: options.currentFingerprint(revision) ?? "",
				expectedFiles: names,
			});
			return committed.status === "committed"
				? { status: "success", artifactPath: committed.path, fingerprint: candidate.fingerprint }
				: { status: "failure" };
		},
	});
	const results: Array<{ revision: string; status: string; path?: string }> = [];
	for (const result of dispatched) {
		const candidate = candidates.find((item) => item.id === result.id);
		if (!candidate || result.status !== "generated") {
			if (candidate) results.push({ revision: candidate.revision, status: result.status });
			continue;
		}
		const freshState = options.operationalState(candidate.runId);
		const freshFingerprint = options.currentFingerprint(candidate.revision);
		if (!isQuiescent(freshState) || freshFingerprint !== candidate.fingerprint) {
			results.push({ revision: candidate.revision, status: "deferred" });
			continue;
		}
		const cleanup = await dispatchCleanup(options.db, candidate.id, {
			invocation: options.invocation,
			now: options.now,
			leaseMs: 30_000,
			adapter: cleanupAdapter(options.db, {
				ownedRoot: options.ownedRoot,
				currentFingerprint: options.currentFingerprint,
			}),
		});
		results.push({ revision: candidate.revision, status: cleanup.status, path: result.path });
	}
	return results;
}

/** Runtime coordinator port; public command integration and review dispatch remain separate. */
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
