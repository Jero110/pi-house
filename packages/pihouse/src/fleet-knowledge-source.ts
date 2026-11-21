import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SOURCE_PATH = "FORMATO.md";
const SOURCE_MAX_BYTES = 32 * 1024;
const GIT_TIMEOUT_MS = 2_000;
const OBJECT_ID = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
const REGULAR_SOURCE_ENTRY = new RegExp(`^100(?:644|755) blob (${OBJECT_ID})\\t${SOURCE_PATH.replace(".", "\\.")}\\0$`);

export function readKnowledgeSource(repo: string): { path: string; revision: string; text: string } {
	// Git environment overrides can point Git at a different repository or object store.
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
	Object.assign(env, {
		GIT_ALLOW_PROTOCOL: "",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_NO_LAZY_FETCH: "1",
	});

	const gitDir = resolve(repo, ".git");
	const git = (...args: string[]): Buffer => {
		const result = spawnSync("git", ["--no-replace-objects", "--git-dir", gitDir, ...args], {
			env,
			killSignal: "SIGKILL",
			maxBuffer: SOURCE_MAX_BYTES,
			timeout: GIT_TIMEOUT_MS,
		});
		if (result.status !== 0 || result.error) {
			throw new Error(`Knowledge source ${SOURCE_PATH} is unavailable (${args[0]} failed)`);
		}
		return result.stdout;
	};

	// Pin the commit once so a concurrent update to HEAD cannot mix revisions.
	const revision = git("rev-parse", "--verify", "HEAD^{commit}").toString("ascii").trim();
	if (!new RegExp(`^${OBJECT_ID}$`).test(revision)) {
		throw new Error(`Knowledge source ${SOURCE_PATH} has an invalid revision`);
	}

	const entry = git("ls-tree", "-z", revision, "--", SOURCE_PATH).toString("ascii");
	const blob = REGULAR_SOURCE_ENTRY.exec(entry)?.[1];
	if (!blob) {
		throw new Error(`Knowledge source ${SOURCE_PATH} must be a committed regular file`);
	}

	const size = Number(git("cat-file", "-s", blob).toString("ascii").trim());
	if (!Number.isSafeInteger(size) || size < 0 || size > SOURCE_MAX_BYTES) {
		throw new Error(`Knowledge source ${SOURCE_PATH} exceeds the 32 KiB limit or has an invalid size`);
	}
	const data = git("cat-file", "blob", blob);
	if (data.length !== size) {
		throw new Error(`Knowledge source ${SOURCE_PATH} has an invalid size`);
	}
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
	return { path: SOURCE_PATH, revision, text };
}
