import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommand, checkRead, depthFromEnv } from "../src/guard.ts";

const risky = [
	"rm -rf build",
	"rm -fr /",
	"rm -r -f dist",
	"rm --recursive --force x",
	"sudo apt install x",
	"ls && sudo reboot",
	"terraform destroy -auto-approve",
	"mkfs.ext4 /dev/sda1",
	"dd if=img of=/dev/disk2",
	"cat .env",
	"psql -c 'DROP DATABASE app'",
	"mysql -e 'drop table users'",
	"psql -c 'TRUNCATE TABLE orders'",
	"dropdb app",
	"redis-cli FLUSHALL",
	"source ./config/.env.production",
	'grep KEY "$PWD/.env.local"',
];
const safe = [
	"rm file.txt",
	"rm -r empty-dir",
	"git status",
	"git push origin main",
	"git commit -m 'push it'",
	"curl https://x > a.sh",
	"curl -fsSL https://x.sh | sh",
	"wget -qO- https://x | bash",
	"ls -la",
	"npm test",
	"chmod -R 777 .",
	"cat .env.example",
	"psql -c 'SELECT * FROM users'",
	"npx prisma migrate dev",
	"cat .envrc",
	"node -e 'process.env.X'",
	"echo myapp.env",
];
const recoverable = ["git reset --hard HEAD~1", "git clean -fd"];

test("workers get a hard block on risky commands", () => {
	for (const cmd of risky) assert.equal(checkCommand(cmd, 1).action, "block", cmd);
});

test("main session is asked on risky commands", () => {
	for (const cmd of risky) assert.equal(checkCommand(cmd, 0).action, "ask", cmd);
});

test("work a commit can recover is asked by the main session; workers run it, never asked, never blocked", () => {
	for (const cmd of recoverable) {
		assert.equal(checkCommand(cmd, 0).action, "ask", cmd);
		assert.equal(checkCommand(cmd, 1).action, "allow", cmd);
	}
});

test("workers are never asked anything, whatever the command", () => {
	for (const cmd of [...risky, ...safe, ...recoverable]) assert.notEqual(checkCommand(cmd, 1).action, "ask", cmd);
	for (const file of [".env", "/p/src/a.ts"]) assert.notEqual(checkRead(file, 1).action, "ask", file);
});

test("reading a .env file: blocked for workers, asked at depth 0, templates and other files pass", () => {
	for (const file of [".env", "/p/.env", "C:\\p\\.env", "/p/.env.local", "/p/.env.production"]) {
		assert.equal(checkRead(file, 1).action, "block", file);
		assert.equal(checkRead(file, 0).action, "ask", file);
	}
	for (const file of ["/p/.env.example", "/p/.env.sample", "/p/src/env.ts", "/p/.envrc", "/p/prod.env.md"])
		assert.equal(checkRead(file, 1).action, "allow", file);
});

test("everything else passes at any depth", () => {
	for (const cmd of safe) {
		assert.equal(checkCommand(cmd, 0).action, "allow", cmd);
		assert.equal(checkCommand(cmd, 2).action, "allow", cmd);
	}
});

test("depth comes from AGENT_LINK_DEPTH and defaults to 0", () => {
	assert.equal(depthFromEnv({}), 0);
	assert.equal(depthFromEnv({ AGENT_LINK_DEPTH: "2" }), 2);
	assert.equal(depthFromEnv({ AGENT_LINK_DEPTH: "nope" }), 0);
});
