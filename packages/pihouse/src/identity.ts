// Who is logged in and where the work is: the git branch of a folder and the email of an account, for the status bar.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Where Claude Code keeps the login it is using. */
export const CLAUDE_CODE_CONFIG = join(homedir(), ".claude.json");

/**
 * The branch checked out in `cwd` or any folder above it, `HEAD@1a2b3c4` when detached, or undefined outside a repo.
 *
 * Problem: running `git` on every redraw is slow, and a worktree has a `.git` file instead of a folder.
 * Example: in a worktree `.git` reads `gitdir: /repo/.git/worktrees/x`, and HEAD lives there.
 * Solution: read HEAD directly, following that pointer.
 */
export function gitBranch(cwd: string): string | undefined {
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		const dot = join(dir, ".git");
		if (existsSync(dot)) return readHead(dot, dir);
		if (dirname(dir) === dir) return undefined;
	}
}

function readHead(dot: string, dir: string): string | undefined {
	try {
		let gitDir = dot;
		if (statSync(dot).isFile()) {
			const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
			if (!target) return undefined;
			gitDir = isAbsolute(target) ? target : resolve(dir, target);
		}
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
		return ref ?? (/^[0-9a-f]{7,}$/.test(head) ? `HEAD@${head.slice(0, 7)}` : undefined);
	} catch {
		return undefined;
	}
}

/** The email of the login Claude Code (and so the Claude models here) uses, or undefined when it cannot be read. */
export function claudeEmail(file = CLAUDE_CODE_CONFIG): string | undefined {
	try {
		const config = JSON.parse(readFileSync(file, "utf8")) as { oauthAccount?: { emailAddress?: unknown } };
		const email = config.oauthAccount?.emailAddress;
		return typeof email === "string" && email ? email : undefined;
	} catch {
		return undefined;
	}
}

/** The email a ChatGPT token carries in its profile claim, or undefined. */
export function chatgptEmail(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		const profile = payload["https://api.openai.com/profile"];
		const email =
			typeof profile === "object" && profile !== null ? (profile as Record<string, unknown>).email : undefined;
		return typeof email === "string" && email ? email : typeof payload.email === "string" ? payload.email : undefined;
	} catch {
		return undefined;
	}
}
