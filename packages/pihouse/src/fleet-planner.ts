import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { shellQuote } from "agent-link-core";

export interface FleetPlanner {
	label: string;
	host: string;
	identityFile: string;
	knownHostsFile: string;
	node: string;
	entry: string;
}
export function validatePlanner(v: FleetPlanner): boolean {
	if (!v || typeof v.label !== "string" || !v.label.trim() || typeof v.host !== "string") return false;
	const parts = v.host.split("@");
	if (parts.length !== 2 || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(parts[0])) return false;
	const dns = /^[A-Za-z0-9][A-Za-z0-9.-]*\.ts\.net$/.test(parts[1]);
	const [first, second, ...rest] = parts[1].split(".");
	const ipv4 =
		first === "100" &&
		/^\d+$/.test(second) &&
		Number(second) >= 64 &&
		Number(second) <= 127 &&
		rest.length === 2 &&
		rest.every((n) => /^\d{1,3}$/.test(n) && Number(n) <= 255);
	return (
		(dns || ipv4) &&
		[v.identityFile, v.knownHostsFile, v.node, v.entry].every(
			(p) => typeof p === "string" && isAbsolute(p) && !/[\r\n\0]/.test(p),
		)
	);
}

async function transfer(
	file: string,
	args: string[],
	cwd: string,
	prompt: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const cp = spawn(file, args, {
		cwd,
		env,
		stdio: ["pipe", "pipe", "ignore"],
		timeout: 105_000,
		killSignal: "SIGKILL",
	});
	const exited = new Promise<number | null>((resolve) => {
		cp.once("error", () => resolve(null));
		cp.once("close", resolve);
	});
	cp.stdin.on("error", () => {});
	cp.stdin.end(prompt);
	let count = 0;
	for await (const data of cp.stdout) {
		count += data.length;
		if (count > 32 * 1024) {
			cp.kill("SIGKILL");
			throw new Error("Remote plan too large");
		}
		process.stdout.write(data);
	}
	const code = await exited;
	if (code !== 0 || !count) throw new Error("Remote planner unavailable");
}

async function main(arg: string | undefined) {
	if (!arg) throw new Error("Missing planner configuration");
	const data: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > 65536) throw new Error("Input too large");
		data.push(Buffer.from(chunk));
	}
	const prompt = Buffer.concat(data).toString("utf8");
	if (arg === "--worker") {
		const dir = mkdtempSync(join(tmpdir(), "pih-plan-"));
		try {
			await transfer(
				process.execPath,
				[join(import.meta.dirname, "fleet-sandbox.ts"), "codex"],
				dir,
				`Act as the planning assistant for the next agent. You have an empty disposable workspace and no project files. Give a brief practical suggestion for the latest request in the user's language, at most 100 words. Use no tools, make no changes and do not claim to have inspected the repository. Conversation follows.\n${prompt}`,
				{
					PATH: [dirname(process.execPath), "/opt/homebrew/bin", "/usr/bin", "/bin"].join(":"),
					HOME: process.env.HOME,
					TMPDIR: process.env.TMPDIR,
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		return;
	}
	const peer = JSON.parse(arg) as FleetPlanner;
	if (!validatePlanner(peer)) throw new Error("Invalid planner configuration");
	await transfer(
		"/usr/bin/ssh",
		[
			"-T",
			"-a",
			"-x",
			"-F",
			"/dev/null",
			"-o",
			"BatchMode=yes",
			"-o",
			"IdentitiesOnly=yes",
			"-o",
			"StrictHostKeyChecking=yes",
			"-o",
			"ClearAllForwardings=yes",
			"-o",
			"ConnectTimeout=5",
			"-o",
			`UserKnownHostsFile=${peer.knownHostsFile}`,
			"-i",
			peer.identityFile,
			"--",
			peer.host,
			`exec ${shellQuote(peer.node)} ${shellQuote(peer.entry)} --worker`,
		],
		tmpdir(),
		prompt,
		{ PATH: "/usr/bin:/bin", HOME: process.env.HOME },
	);
}
if (import.meta.main)
	main(process.argv[2]).catch(() => {
		process.stderr.write("Fleet sandbox: Remote planner unavailable.\n");
		process.exitCode = 1;
	});
