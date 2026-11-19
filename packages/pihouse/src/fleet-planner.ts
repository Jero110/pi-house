import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { shellQuote } from "agent-link-core";

export interface FleetPlanner {
	handle?: string;
	label: string;
	host: string;
	identityFile: string;
	knownHostsFile: string;
	node: string;
	entry: string;
}
const handle = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

export function validatePlanner(value: unknown): value is FleetPlanner {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<FleetPlanner>;
	if (typeof v.label !== "string" || !v.label.trim() || /[\r\n\t\0]/.test(v.label) || typeof v.host !== "string")
		return false;
	if (v.handle !== undefined && (typeof v.handle !== "string" || !handle.test(v.handle))) return false;
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

function plannerHandle(peer: FleetPlanner) {
	return (
		peer.handle ??
		peer.label.match(/\bM[1-9]\d*\b/i)?.[0] ??
		peer.label
			.trim()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-|-$/g, "")
	);
}

export function validatePlanners(value: unknown): value is FleetPlanner[] {
	if (!Array.isArray(value)) return false;
	const handles = new Set<string>();
	const hosts = new Set<string>();
	const labels = new Set<string>();
	for (const peer of value) {
		if (!validatePlanner(peer)) return false;
		const name = plannerHandle(peer).normalize("NFC").toLowerCase();
		const host = peer.host.split("@")[1].toLowerCase();
		const label = peer.label.trim().normalize("NFC").toLowerCase();
		if (!name || handles.has(name) || hosts.has(host) || labels.has(label)) return false;
		handles.add(name);
		hosts.add(host);
		labels.add(label);
	}
	return true;
}

export class FleetPlannerAddressError extends Error {
	override name = "FleetPlannerAddressError";
}

export function fleetPlannerAddress(input: string): string | undefined {
	return /^\s*@([\p{L}\p{N}][\p{L}\p{N}_-]*)(?=$|[\s,.:;!?])/u.exec(input)?.[1];
}

export function selectFleetPlanner(
	jobId: string,
	peers: readonly FleetPlanner[],
	input = "",
): FleetPlanner | undefined {
	const address = fleetPlannerAddress(input);
	if (address) {
		const named = peers.find(
			(peer) => plannerHandle(peer).normalize("NFC").toLowerCase() === address.normalize("NFC").toLowerCase(),
		);
		if (named) return named;
		const available = peers.map((peer) => `@${plannerHandle(peer)}`).join(", ");
		throw new FleetPlannerAddressError(
			`Unknown planner @${address}. ${available ? `Configured planners: ${available}.` : "No planning Mac is configured."}`,
		);
	}
	// Rendezvous hashing keeps the assignment stable across config reordering. Adding a Mac
	// only changes the threads on which its score beats the previous winner.
	let best: FleetPlanner | undefined;
	let high = "";
	for (const peer of peers) {
		const score = createHash("sha256").update(jobId).update("\0").update(peer.host.toLowerCase()).digest("hex");
		if (score > high) {
			high = score;
			best = peer;
		}
	}
	return best;
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
