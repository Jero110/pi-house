import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	createReadStream,
	createWriteStream,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const snapshotCLI = fileURLToPath(new URL("./fleet-backup.ts", import.meta.url));
const namePattern = /^replica-[0-9T.Z-]+-[0-9a-f-]{36}\.snapshot$/;
function ensurePrivate(path: string) {
	if (!isAbsolute(path)) throw Error("The replica directory must have an absolute path.");
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const st = lstatSync(path);
	if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & 0o077 || realpathSync(path) !== resolve(path))
		throw Error("The replica directory must be private and canonical.");
}
/** Only publish an image after independent verification on the destination. An interrupted transfer retains the previous recovery point. */
export async function receiveReplica(
	directory: string,
	download: (path: string) => Promise<void>,
	verify: (path: string) => Promise<void>,
	startedAt = Date.now(),
) {
	ensurePrivate(directory);
	const file = `replica-${new Date(startedAt).toISOString().replaceAll(":", "-")}-${randomUUID()}.snapshot`;
	const staging = join(directory, `${file}.partial`);
	const lockPath = join(directory, "replica-lock.sqlite");
	const lock = new DatabaseSync(lockPath);
	try {
		chmodSync(lockPath, 0o600);
		lock.exec("BEGIN EXCLUSIVE");
		for (const orphan of readdirSync(directory)) {
			const base = orphan.replace(/(?:\.receipt)?\.partial$/, "");
			if (base !== orphan && namePattern.test(base)) rmSync(join(directory, orphan));
		}
		writeFileSync(staging, "", { flag: "wx", mode: 0o600 });
		await download(staging);
		await verify(staging);
		const receipt = { file, startedAt, verifiedAt: Date.now(), bytes: statSync(staging).size };
		renameSync(staging, join(directory, file));
		const ticket = join(directory, `${file}.receipt.partial`);
		try {
			writeFileSync(ticket, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
			renameSync(ticket, join(directory, "last-success.json"));
		} finally {
			rmSync(ticket, { force: true });
		}
		for (const old of readdirSync(directory)
			.filter((f) => namePattern.test(f))
			.sort()
			.slice(0, -3))
			rmSync(join(directory, old));
		return receipt;
	} finally {
		try {
			rmSync(staging, { force: true });
		} finally {
			lock.close();
		}
	}
}
async function send(configFile: string) {
	const { stateDir } = JSON.parse(readFileSync(configFile, "utf8"));
	const { stdout } = await exec(process.execPath, [snapshotCLI, "snapshot", configFile], {
		timeout: 360000,
		maxBuffer: 8192,
	});
	const path = stdout.trim();
	if (
		!isAbsolute(path) ||
		dirname(path) !== join(stateDir, "recovery") ||
		!/^[\w.-]+\.snapshot$/.test(basename(path)) ||
		realpathSync(path) !== path
	)
		throw Error("Unexpected snapshot path from the coordinator.");
	try {
		await pipeline(createReadStream(path), process.stdout);
	} finally {
		rmSync(path, { force: true });
	}
}
async function pull(configFile: string) {
	const stat = lstatSync(configFile);
	if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
		throw Error("Use an owner-only replica configuration file.");
	const { directory, sshConfig, host } = JSON.parse(readFileSync(configFile, "utf8"));
	if (
		typeof host !== "string" ||
		!/^[A-Za-z0-9][\w.-]{0,63}$/.test(host) ||
		typeof sshConfig !== "string" ||
		!isAbsolute(sshConfig)
	)
		throw Error("Invalid replica SSH configuration.");
	const result = await receiveReplica(
		directory,
		async (temp) => {
			const child = spawn(
				"/usr/bin/ssh",
				[
					"-F",
					sshConfig,
					"-o",
					"BatchMode=yes",
					"-o",
					"StrictHostKeyChecking=yes",
					"-o",
					"ClearAllForwardings=yes",
					"-T",
					host,
					"snapshot",
				],
				{ stdio: ["ignore", "pipe", "inherit"], timeout: 420000 },
			);
			const done = new Promise<void>((ok, fail) => {
				child.once("error", fail);
				child.once("close", (code) => (code === 0 ? ok() : fail(Error("Snapshot transport failed."))));
			});
			try {
				await Promise.all([done, pipeline(child.stdout, createWriteStream(temp, { flags: "r+" }))]);
			} finally {
				child.kill();
			}
		},
		async (temp) => {
			await exec(process.execPath, [snapshotCLI, "verify", temp], { timeout: 360000, maxBuffer: 4 * 1024 * 1024 });
		},
	);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (import.meta.main) {
	process.umask(0o077);
	try {
		const [action, path, ...extra] = process.argv.slice(2);
		if (extra.length || !path) throw Error("Expected send|pull and an operator configuration file.");
		if (action === "send") await send(path);
		else if (action === "pull") await pull(path);
		else if (action === "status") {
			const { directory } = JSON.parse(readFileSync(path, "utf8"));
			ensurePrivate(directory);
			const last = JSON.parse(readFileSync(join(directory, "last-success.json"), "utf8"));
			const ageSeconds = (Date.now() - last.startedAt) / 1000;
			const stale = ageSeconds > 900 || !namePattern.test(last.file) || !statSync(join(directory, last.file)).isFile();
			process.stdout.write(`${JSON.stringify({ ...last, ageSeconds, stale })}\n`);
			if (stale) process.exitCode = 2;
		} else throw Error("Unknown replica operation.");
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : "Replica failed"}\n`);
		process.exitCode = 1;
	}
}
