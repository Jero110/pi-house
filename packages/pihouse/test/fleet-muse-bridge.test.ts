import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/fleet-muse-bridge.ts", import.meta.url));
const validId = "feab1d56-cf84-4424-8cd7-eafb17f8e928";
const secondId = "dc55ffcb-3820-4343-bf0b-237ede23b250";
const thirdId = "65e9314d-4fed-4f75-9f09-325fb135e71b";

function exchangeFixture(t: TestContext) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "pih-muse-")));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const exchange = join(directory, "exchange");
	const inbox = join(exchange, "inbox");
	const outbox = join(exchange, "outbox");
	const repo = join(directory, "knowledge");
	mkdirSync(exchange, { mode: 0o700 });
	mkdirSync(inbox, { mode: 0o700 });
	mkdirSync(outbox, { mode: 0o700 });
	const run = (root = exchange) => spawnSync(process.execPath, [cli, "once", root, repo], { encoding: "utf8" });
	const publish = () => spawnSync(process.execPath, [cli, "publish", exchange, repo], { encoding: "utf8" });
	const request = (id: string, payload: unknown = { id, op: "read_source" }) =>
		writeFileSync(join(inbox, `${id}.json`), JSON.stringify(payload));
	return { directory, inbox, outbox, repo, run, request, publish, snapshot: join(exchange, "source.json") };
}

function knowledgeFixture(repo: string) {
	mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("init", "-q", "--template=");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	git("config", "commit.gpgsign", "false");
	git("config", "core.hooksPath", "/dev/null");
	const text = "# Source\nCommitted content.\n";
	const source = join(repo, "FORMATO.md");
	writeFileSync(source, text);
	git("add", "FORMATO.md");
	git("commit", "-qm", "Fixture");
	const revision = git("rev-parse", "HEAD");
	return { git, revision, source, text };
}

test("publishes the committed source once per request id across periodic invocations", (t) => {
	const exchange = exchangeFixture(t);
	const { git, revision, source, text } = knowledgeFixture(exchange.repo);
	writeFileSync(source, "Uncommitted content");
	exchange.request(validId);
	const first = exchange.run();
	assert.equal(first.status, 0, first.stderr);
	const receipt = join(exchange.outbox, `${validId}.json`);
	const payload = readFileSync(receipt, "utf8");
	assert.deepEqual(JSON.parse(payload), {
		id: validId,
		status: "completed",
		source: { path: "FORMATO.md", revision, text },
	});

	git("commit", "-qam", "Updated source");
	const repeated = exchange.run();
	assert.equal(repeated.status, 0, repeated.stderr);
	assert.equal(readFileSync(receipt, "utf8"), payload);
	assert.deepEqual(readdirSync(exchange.outbox), [`${validId}.json`]);
});

test("publishes a private snapshot and replaces only changed content", (t) => {
	const exchange = exchangeFixture(t);
	const { git, revision, source, text } = knowledgeFixture(exchange.repo);
	const first = exchange.publish();
	assert.equal(first.status, 0, first.stderr);
	const prior = lstatSync(exchange.snapshot);
	assert.equal(prior.mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(exchange.snapshot, "utf8")), { path: "FORMATO.md", revision, text });

	writeFileSync(source, "Changed content");
	const unchanged = exchange.publish();
	assert.equal(unchanged.status, 0, unchanged.stderr);
	assert.equal(lstatSync(exchange.snapshot).ino, prior.ino);
	assert.equal(lstatSync(exchange.snapshot).mtimeMs, prior.mtimeMs);

	git("commit", "-qam", "Updated source");
	const updated = exchange.publish();
	assert.equal(updated.status, 0, updated.stderr);
	assert.notEqual(lstatSync(exchange.snapshot).ino, prior.ino);
	assert.deepEqual(JSON.parse(readFileSync(exchange.snapshot, "utf8")), {
		path: "FORMATO.md",
		revision: git("rev-parse", "HEAD"),
		text: "Changed content",
	});

	git("rm", "FORMATO.md");
	git("commit", "-qm", "Removed source");
	const unavailable = exchange.publish();
	assert.equal(unavailable.status, 1);
	assert.match(unavailable.stderr, /source unavailable/i);
	assert.equal(lstatSync(exchange.snapshot, { throwIfNoEntry: false }), undefined);
});

test("rejects a symlink or directory at the snapshot destination", (t) => {
	const exchange = exchangeFixture(t);
	const target = join(exchange.directory, "target.json");
	writeFileSync(target, "Keep this content");
	symlinkSync(target, exchange.snapshot);
	const symlink = exchange.publish();
	assert.equal(symlink.status, 1);
	assert.match(symlink.stderr, /private regular file/i);
	assert.ok(lstatSync(exchange.snapshot).isSymbolicLink());
	assert.equal(readFileSync(target, "utf8"), "Keep this content");

	rmSync(exchange.snapshot);
	mkdirSync(exchange.snapshot);
	const directory = exchange.publish();
	assert.equal(directory.status, 1);
	assert.match(directory.stderr, /private regular file/i);
	assert.ok(lstatSync(exchange.snapshot).isDirectory());
});

test("isolates source errors and skips invalid requests without exposing source error details", (t) => {
	const exchange = exchangeFixture(t);
	exchange.request(validId);
	exchange.request(secondId, { id: secondId, op: "read_source", path: "/etc/passwd" });
	exchange.request(thirdId, { id: thirdId, op: "run_command" });
	exchange.request("not-a-uuid");
	const result = exchange.run();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(readdirSync(exchange.outbox), [`${validId}.json`]);
	assert.deepEqual(JSON.parse(readFileSync(join(exchange.outbox, `${validId}.json`), "utf8")), {
		id: validId,
		status: "failed",
		error: "source_unavailable",
	});
});

test("leaves existing outbox entries intact and never follows inbox or outbox symlinks", (t) => {
	const exchange = exchangeFixture(t);
	const target = join(exchange.directory, "target.json");
	const request = JSON.stringify({ id: secondId, op: "read_source" });
	writeFileSync(target, request);
	symlinkSync(target, join(exchange.inbox, `${secondId}.json`));
	exchange.request(validId);
	symlinkSync(target, join(exchange.outbox, `${validId}.json`));
	const result = exchange.run();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(readdirSync(exchange.outbox), [`${validId}.json`]);
	assert.equal(readFileSync(target, "utf8"), request);
});

test("rejects an exchange root addressed through a symlink", (t) => {
	const exchange = exchangeFixture(t);
	const alias = join(exchange.directory, "alias");
	symlinkSync(join(exchange.directory, "exchange"), alias);
	const result = exchange.run(alias);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /private canonical directory/);
});

test("rejects an exchange child directory accessible by other users", (t) => {
	const exchange = exchangeFixture(t);
	chmodSync(exchange.outbox, 0o755);
	const result = exchange.run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /private canonical directory/);
});
