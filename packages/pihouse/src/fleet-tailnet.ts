import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:https";
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { createFleetJobs } from "./fleet-jobs.ts";
import type { FleetConfig } from "./fleet-web.ts";
import { fleetHandler } from "./fleet-web.ts";

const run = promisify(execFile);
const cli = process.platform === "darwin" ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : "tailscale";
const ts = async (args: string[]) =>
	(
		await run(cli, args, {
			env: { ...process.env, TAILSCALE_BE_CLI: "1" },
			timeout: args[0] === "cert" ? 180_000 : 10_000,
			maxBuffer: 2 * 1024 * 1024,
		})
	).stdout;
export function tailAddress(ip: string): boolean {
	return isIPv4(ip)
		? ip.startsWith("100.") && Number(ip.split(".")[1]) >= 64 && Number(ip.split(".")[1]) <= 127
		: isIPv6(ip) && ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
export function allowPeer(
	login: string,
	lookup: (addr: string) => Promise<string> = (addr) => ts(["whois", "--json", addr]),
) {
	const cache = new WeakMap<IncomingMessage["socket"], { at: number; allowed: Promise<boolean> }>();
	return async (req: IncomingMessage) => {
		const { remoteAddress: ip, remotePort: port } = req.socket;
		if (!ip || !port || !tailAddress(ip)) return false;
		const last = cache.get(req.socket);
		if (last && Date.now() - last.at < 5000) return last.allowed;
		const addr = isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
		const allowed = lookup(addr)
			.then((raw) => {
				const v = JSON.parse(raw);
				return !!v.Node && !v.Node.Tags?.length && v.UserProfile?.LoginName === login;
			})
			.catch(() => false);
		cache.set(req.socket, { at: Date.now(), allowed });
		return allowed;
	};
}
export async function serveFleet(c: FleetConfig, jobs: ReturnType<typeof createFleetJobs>) {
	const status = JSON.parse(await ts(["status", "--json"]));
	const origin = new URL(c.origin);
	if (
		status.BackendState !== "Running" ||
		status.Self?.DNSName?.replace(/\.$/, "") !== origin.hostname ||
		status.User?.[status.Self.UserID]?.LoginName !== c.login ||
		status.Self.Tags?.length
	)
		throw new Error("This Mac must belong to the configured tailnet user and DNS name.");
	const ips: string[] = status.Self.TailscaleIPs;
	if (!ips?.length || !ips.every(tailAddress)) throw new Error("Missing tailnet interface addresses");
	const cert = join(c.stateDir, "server.crt"),
		key = join(c.stateDir, "server.key");
	async function credentials() {
		await ts(["cert", "--min-validity=168h", `--cert-file=${cert}`, `--key-file=${key}`, origin.hostname]);
		return { cert: readFileSync(cert), key: readFileSync(key) };
	}
	const tls = await credentials();
	const handler = fleetHandler(c, () => jobs, allowPeer(c.login));
	const servers = ips.map(() =>
		createServer(
			{ ...tls, minVersion: "TLSv1.2", maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 },
			handler,
		),
	);
	let renew: NodeJS.Timeout | undefined;
	const stop = () => {
		clearInterval(renew);
		for (const s of servers) {
			s.close();
			s.closeAllConnections();
		}
	};
	try {
		for (const [n, s] of servers.entries()) {
			s.maxConnections = 32;
			s.setTimeout(20_000, (socket) => socket.destroy());
			await new Promise<void>((resolve, reject) => {
				s.once("error", reject);
				s.listen(Number(origin.port || 443), ips[n], () => {
					s.off("error", reject);
					resolve();
				});
			});
		}
		renew = setInterval(() => {
			credentials()
				.then((opts) => {
					for (const s of servers) s.setSecureContext({ ...opts, minVersion: "TLSv1.2" });
				})
				.catch(() => process.stderr.write("Fleet TLS renewal failed; check tailscale cert.\n"));
		}, 24 * 3600_000);
		process.stdout.write(`Fleet listening on ${c.origin}\n`);
		await new Promise<void>((resolve) => {
			const end = () => {
				process.off("SIGTERM", end);
				process.off("SIGINT", end);
				resolve();
			};
			process.once("SIGTERM", end);
			process.once("SIGINT", end);
		});
	} finally {
		stop();
	}
}
