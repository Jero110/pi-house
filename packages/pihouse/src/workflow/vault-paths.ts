// The one module that knows the layout of the memory vault. Spec: docs/specs/self-learning/vault-review.md,
// "Project structure". ADR-004.
//
// Problem: the vault is divided by where things come from (conversations, workflow, ask), and about 40 places used to
// build paths such as `runs/<id>` with string literals. Example: moving the captured runs to `conversations/<id>` would
// mean finding every one of them, and missing one silently splits the vault in two. Solution: every path comes from
// the functions below; a test greps the source for any other place that builds one.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Ids become folder and file names; this keeps them inside the vault. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function id(value: string): string {
	if (!SAFE_ID.test(value)) throw new Error(`Unsafe vault id: ${JSON.stringify(value)}`);
	return value;
}

const CONVERSATIONS = "conversations";
const COMPACT = "workflow/compact";
const REVIEWS = "workflow/reviews";
const PROPOSALS = "workflow/proposals";
const APPROVED = "workflow/approved-records";
const IDEAS = "ask/ideas";
const CONSULTED = "ask/consulted";
/** Folders that exist in the fresh layout, in the order the README lists them. */
const LAYOUT = [CONVERSATIONS, COMPACT, REVIEWS, PROPOSALS, APPROVED, IDEAS, CONSULTED] as const;

/** Places of the layout before the vault: still read by the legacy migration, and by the retired digest code. */
const LEGACY = {
	runs: "runs",
	digests: "digests",
	batches: "batches",
	consulted: "consulted",
	ideas: "ideas",
	proposals: "proposals",
	archive: "archive",
} as const;
export const LEGACY_DIRS: readonly string[] = Object.values(LEGACY);
export const LEGACY_FILES: readonly string[] = ["index.json", "flags.json", "workflow-memory.md"];

export const DATABASE_FILE = "memory.sqlite";

/** Paths relative to the vault root, with `/` separators: the form the index and `run_stages` store. */
export const vaultRel = {
	conversations: CONVERSATIONS,
	compactDir: COMPACT,
	reviewsDir: REVIEWS,
	ideasDir: IDEAS,
	consultedDir: CONSULTED,
	runDir: (run: string) => `${CONVERSATIONS}/${id(run)}`,
	runJson: (run: string) => `${CONVERSATIONS}/${id(run)}/run.json`,
	runReport: (run: string) => `${CONVERSATIONS}/${id(run)}/report.md`,
	transcripts: (run: string) => `${CONVERSATIONS}/${id(run)}/transcripts`,
	compactFile: (revision: string) => `${COMPACT}/${id(revision)}.md`,
	/** `stamp` is the UTC timestamp 20261105T143000Z. */
	reviewFile: (stamp: string) => `${REVIEWS}/review-${id(stamp)}.md`,
	proposalBackups: (proposal: string) => `${PROPOSALS}/${id(proposal)}`,
	/** The Markdown note the retired keeper flow wrote for a proposal. */
	proposalNote: (proposal: string) => `${PROPOSALS}/${id(proposal)}.md`,
	/** `key` is `<kind>/<name>`, already validated by the caller. */
	approvedRecord: (key: string) => `${APPROVED}/${key}.md`,
	idea: (name: string) => `${IDEAS}/${id(name)}.md`,
	consultedNote: (name: string) => `${CONSULTED}/${id(name)}.md`,
	consultedText: (name: string) => `${CONSULTED}/${id(name)}.txt`,
	// Retired digest and batch code still writes these; they keep their old places.
	digest: (run: string) => `${LEGACY.digests}/${id(run)}.md`,
	digestsDir: LEGACY.digests,
	batchesDir: LEGACY.batches,
	batchRecord: (batch: string) => `${LEGACY.batches}/${id(batch)}.json`,
	batchSummary: (batch: string) => `${LEGACY.batches}/${id(batch)}.md`,
	archived: (rel: string) => `${LEGACY.archive}/${rel}`,
	rawArchive: (run: string) => `${LEGACY.archive}/raw/${id(run)}`,
} as const;

/** Absolute paths inside one vault root. */
export function vaultPaths(root: string) {
	const at = (rel: string) => join(root, ...rel.split("/"));
	return {
		root,
		readme: at("README.md"),
		database: at(DATABASE_FILE),
		conversations: at(vaultRel.conversations),
		compactDir: at(vaultRel.compactDir),
		reviewsDir: at(vaultRel.reviewsDir),
		ideasDir: at(vaultRel.ideasDir),
		consultedDir: at(vaultRel.consultedDir),
		digestsDir: at(vaultRel.digestsDir),
		batchesDir: at(vaultRel.batchesDir),
		runDir: (run: string) => at(vaultRel.runDir(run)),
		runJson: (run: string) => at(vaultRel.runJson(run)),
		runReport: (run: string) => at(vaultRel.runReport(run)),
		transcripts: (run: string) => at(vaultRel.transcripts(run)),
		compactFile: (revision: string) => at(vaultRel.compactFile(revision)),
		reviewFile: (stamp: string) => at(vaultRel.reviewFile(stamp)),
		proposalBackups: (proposal: string) => at(vaultRel.proposalBackups(proposal)),
		digestsFile: (run: string) => at(vaultRel.digest(run)),
		rawArchive: (run: string) => at(vaultRel.rawArchive(run)),
		/** Any path relative to the vault root, as stored in the index. */
		resolve: at,
	};
}

/** Where a batch review (retired flow) is written below its review root. */
export function batchReviewFile(reviewRoot: string, batch: string): string {
	return join(reviewRoot, "reviews", `${id(batch)}.md`);
}

/** The root `README.md`: one line per folder, what it holds and whether it is temporary or permanent. */
const README = `# pi-house memory vault

Markdown files plus \`memory.sqlite\`. Written by pi-house; safe to read, search and back up.

- \`conversations/\` - FROM CONVERSATIONS. One folder per captured session: \`report.md\`, \`run.json\` and \`transcripts/\` (the full copy of the conversation). The \`transcripts/\` copy is temporary: it is deleted after the review that covered the run is done.
- \`workflow/\` - FROM THE WORKFLOW. Everything the compact and review steps derive. Permanent.
  - \`workflow/compact/\` - one compact version per run revision. Permanent.
  - \`workflow/reviews/\` - one review per \`/workflow review\`. Permanent.
  - \`workflow/proposals/\` - backups of files a proposal changed. Permanent.
  - \`workflow/approved-records/\` - records written by approved proposals. Permanent.
- \`ask/\` - FROM ASK. What \`/workflow ask\` brought in. Permanent.
  - \`ask/consulted/\` - sources fetched from links.
  - \`ask/ideas/\` - ideas written from them.
- \`migration-backup/\` - old backups from the legacy migration. Never touched.
- \`memory.sqlite\` - numbers, stages, jobs, proposals and receipts, never conversation text. Permanent.
`;

/**
 * Creates every folder of the layout and the root README. Idempotent, and it never rewrites a file that exists:
 * a second call changes nothing, not even the README's bytes, and a README the user edited stays as edited.
 */
export function initVault(root: string): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const paths = vaultPaths(root);
	for (const folder of LAYOUT) mkdirSync(paths.resolve(folder), { recursive: true, mode: 0o700 });
	if (!existsSync(paths.readme)) writeFileSync(paths.readme, README, { flag: "wx" });
}

/** True when the folder still holds the pre-vault layout, which the legacy migration must adopt, not a fresh start. */
export function hasLegacyContent(root: string): boolean {
	return [...LEGACY_FILES, ...LEGACY_DIRS].some((name) => existsSync(join(root, name)));
}
