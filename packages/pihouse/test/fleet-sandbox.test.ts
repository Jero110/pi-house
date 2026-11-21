import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codexPermissions } from "../src/fleet-sandbox.ts";

import { providerTunnel, seatbeltArgs } from "../src/fleet-seatbelt.ts";

const bootstrap = fileURLToPath(new URL("../src/fleet-sandbox-child.ts", import.meta.url));
test("Claude receives subscription input over its private consumed pipe, with file tools only", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-child-test-"));
	try {
		const fake = join(root, "native-cli");
		writeFileSync(
			fake,
			`#!${process.execPath}
const fs=require("node:fs");const token=fs.readFileSync(3,"utf8");
console.log(JSON.stringify({prompt:fs.readFileSync(0,"utf8"),same:token==="test-only",args:process.argv.slice(2),leaked:Object.values(process.env).includes(token)}));`,
			{ mode: 0o700 },
		);
		const r = spawnSync(process.execPath, [bootstrap, "claude", fake], {
			cwd: root,
			env: { HOME: root },
			input: JSON.stringify({ credential: "test-only", prompt: "@local file: preserve this literally" }),
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		const reply = JSON.parse(r.stdout);
		assert.equal(reply.same, true);
		assert.equal(reply.leaked, false);
		assert.equal(reply.prompt, "@local file: preserve this literally");
		assert.equal(reply.args.includes("test-only"), false);
		assert.equal(reply.args[reply.args.indexOf("--tools") + 1], "Read,Edit,Write,Glob,Grep");
		assert.ok(
			reply.args.includes("--restricted") &&
				reply.args.includes("--safe-mode") &&
				reply.args.includes("--strict-mcp-config"),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
const bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const codex = existsSync(bundledCodex)
	? bundledCodex
	: spawnSync("which", ["codex"], { encoding: "utf8" }).stdout?.trim();
test("macOS lets task descendants write their checkout and blocks sibling contents, host TCP and Unix sockets", {
	skip: process.platform !== "darwin" || !codex,
}, async () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "fleet-native-policy-")));
	const work = join(base, "checkout");
	mkdirSync(work);
	const home = join(base, "empty");
	mkdirSync(home);
	const canary = join(base, "private");
	writeFileSync(canary, "synthetic");
	symlinkSync(canary, join(work, "link"));
	const sock = join(base, "dummy.sock");
	const tcp = createServer(),
		unix = createServer();
	try {
		await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done));
		await new Promise<void>((done) => unix.listen(sock, done));
		const addr = tcp.address();
		assert.ok(addr && typeof addr !== "string");
		const script = `const fs=require("node:fs"),net=require("node:net");fs.writeFileSync("result","ok");
for(const path of [process.argv[1],"link"]){try {fs.readFileSync(path);process.exit(10)}catch(e){if(!["EPERM","EACCES"].includes(e.code))process.exit(11)}}
const check=opts=>new Promise(r=>{const s=net.connect(opts);s.on("connect",()=>process.exit(opts.port?21:22));s.on("error",e=>{if(!["EACCES","EPERM"].includes(e.code))process.exit(13);r()});});
Promise.all([check({port:Number(process.argv[2]),host:"127.0.0.1"}),check({path:process.argv[3]})]).then(()=>console.log("confined")); `;
		const tunnel = await providerTunnel("chatgpt.com");
		try {
			for (const [command, ...prefix] of [
				[codex, "sandbox", ...codexPermissions(work, home, [process.execPath]), "-P", "fleet", "-C", work],
				["/usr/bin/sandbox-exec", ...seatbeltArgs(work, home, [process.execPath], tunnel.port)],
			]) {
				const result: SpawnSyncReturns<string> = spawnSync(
					command,
					[...prefix, process.execPath, "-e", script, canary, String(addr.port), sock],
					{
						cwd: work,
						env: { HOME: home, TMPDIR: home, PATH: "/bin:/usr/bin", OPENSSL_CONF: "/dev/null" },
						encoding: "utf8",
						timeout: 12000,
					},
				);
				assert.equal(result.status, 0, result.stderr);
				assert.equal(result.stdout.trim(), "confined");
			}
		} finally {
			tunnel.close();
		}
		assert.ok(existsSync(join(work, "result")));
	} finally {
		tcp.close();
		unix.close();
		rmSync(base, { recursive: true, force: true });
	}
});

test("the provider tunnel refuses ordinary HTTP and CONNECT requests for other destinations", async () => {
	const tunnel = await providerTunnel("chatgpt.com");
	try {
		assert.equal((await fetch(tunnel.url)).status, 403);
		const blocked = await new Promise<boolean>((resolve) => {
			const req = request(tunnel.url, { method: "CONNECT", path: "localhost:22" });
			req.once("connect", (_res, socket) => {
				socket.destroy();
				resolve(false);
			});
			req.once("error", () => resolve(true));
			req.end();
		});
		assert.ok(blocked);
	} finally {
		tunnel.close();
	}
});
