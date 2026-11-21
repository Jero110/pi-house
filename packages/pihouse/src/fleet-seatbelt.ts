// Sandcastle's native macOS provider uses deny-default Seatbelt and parameterized
// paths. Fleet permits one loopback TLS tunnel; all Unix sockets stay denied.
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export async function providerTunnel(host: "chatgpt.com" | "api.anthropic.com") {
	const sockets = new Set<Duplex>();
	const server = createServer((_req, res) => {
		res.writeHead(403);
		res.end();
	});
	server.on("connection", (s) => {
		sockets.add(s);
		s.once("close", () => sockets.delete(s));
		s.on("error", () => {});
	});
	server.on("connect", (request, client, head) => {
		if (request.url !== `${host}:443`) {
			client.destroy();
			return;
		}
		const remote: Socket = connect(443, host);
		sockets.add(remote);
		remote.once("close", () => {
			sockets.delete(remote);
			client.destroy();
		});
		remote.on("error", () => client.destroy());
		client.once("close", () => remote.destroy());
		remote.once("connect", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) remote.write(head);
			client.pipe(remote);
			remote.pipe(client);
		});
	});
	await new Promise<void>((ok, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", ok);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No tunnel");
	return {
		port: address.port,
		url: `http://127.0.0.1:${address.port}`,
		close: () => {
			server.close();
			for (const s of sockets) s.destroy();
		},
	};
}
export function seatbeltArgs(task: string, scratch: string, reads: string[], port: number): string[] {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid tunnel port");
	const roots = [
		"/bin",
		"/usr/bin",
		"/usr/lib",
		"/usr/share",
		"/System/Library",
		"/System/Cryptexes",
		"/private/var/select",
		"/private/etc/ssl",
		"/private/etc/paths",
		...reads,
	];
	const params = ["-D", `TASK=${task}`, "-D", `SCRATCH=${scratch}`];
	const readable = roots
		.map((root, i) => {
			params.push("-D", `R${i}=${root}`);
			return `(subpath (param "R${i}"))`;
		})
		.join("\n");
	const policy = `(version 1)
(deny default)
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow process-exec process-fork)
(allow signal process-info* (target same-sandbox))
(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "kern.os") (sysctl-name-prefix "kern.max") (sysctl-name "kern.hostname") (sysctl-name "kern.argmax") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version") (sysctl-name "vm.loadavg") (sysctl-name "sysctl.proc_cputype"))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow file-read* file-map-executable ${readable})
(allow file-read* file-write* file-map-executable (subpath (param "TASK")) (subpath (param "SCRATCH")))
(deny file-write-unlink (literal (param "TASK")) (literal (param "SCRATCH")))
(allow file-read* file-write* file-ioctl (literal "/dev/null") (literal "/dev/zero") (subpath "/dev/fd"))
(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.logd"))
(allow network-outbound (remote tcp "localhost:${port}"))
(deny system-fcntl (fcntl-command 80 110))`;
	return [...params, "-p", policy];
}
