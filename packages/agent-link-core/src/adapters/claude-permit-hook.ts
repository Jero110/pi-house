// Claude Code PermissionRequest hook for workers: `node claude-permit-hook.ts <socket>` hands the request to the
// claude adapter over a Unix socket and prints the decision the parent picked with permit().
//
// Problem: a Claude worker that needed a permission mid-turn showed its dialog in the pane, and only a person
// there could answer it; reading the dialog from the screen breaks in narrow panes. Solution: Claude asks this
// hook first (with the tool, its input and the permission suggestions as JSON); the adapter reports it to the
// parent and writes back the decision. No answer within the wait, or no adapter: print nothing, and Claude
// shows its own dialog in the pane as before.
import { connect } from "node:net";

/** How long the hook waits for the parent before Claude falls back to its own dialog. */
export const PERMIT_WAIT_MS = 10 * 60_000;

if (import.meta.main) {
	const path = process.argv[2] ?? "";
	const wait = Number(process.env.AGENT_LINK_PERMIT_WAIT_MS) || PERMIT_WAIT_MS;
	let raw = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (d: string) => {
		raw += d;
	});
	process.stdin.on("end", () => {
		const done = (out: string) => {
			if (out) process.stdout.write(out);
			process.exit(0);
		};
		if (!path) return done("");
		const timer = setTimeout(() => done(""), wait);
		const sock = connect(path);
		let reply = "";
		sock.setEncoding("utf8");
		sock.on("error", () => done(""));
		sock.on("connect", () => sock.write(`${raw.replace(/\n/g, " ")}\n`));
		sock.on("data", (d: string) => {
			reply += d;
			const end = reply.indexOf("\n");
			if (end < 0) return;
			clearTimeout(timer);
			done(reply.slice(0, end));
		});
		sock.on("close", () => done(""));
	});
}
