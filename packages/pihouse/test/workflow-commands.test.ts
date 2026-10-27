// The /workflow command family against temp stores, a temp repo and a fake pi. No model, no network: a command
// that would start a model turn would show up as a sendMessage or sendUserMessage call.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import workflow, { proposalCommand, USAGE, WORKFLOW_COMMANDS } from "../src/extensions/workflow.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import { approveProposal, createProposal, getProposal } from "../src/workflow/proposals.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

/** A temp home whose workflow memory is an activated (empty) store, and a temp repo with a one-skill catalog. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "workflow-commands-"));
	const memory = join(root, "memory");
	migrateLegacyStore(memory);
	return { root, memory, repoRoot: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function openStore(memory: string) {
	return openOperationalStore(join(memory, "memory.sqlite"), { fts: false, legacy: true });
}

function writeSkill(repoRoot: string, content: string): string {
	const dir = join(repoRoot, "skills", "build", "sample");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(repoRoot, "skills", "catalog.json"),
		JSON.stringify({ groups: [{ id: "build" }], skills: [{ name: "sample", group: "build" }] }),
	);
	writeFileSync(join(dir, "SKILL.md"), content);
	return join(dir, "SKILL.md");
}

function fakePi() {
	const commands = new Map<string, { handler: (raw: string, ctx: ExtensionCommandContext) => Promise<void> | void }>();
	const sent: unknown[] = [];
	const users: unknown[] = [];
	const pi = {
		on: () => {},
		registerCommand: (
			name: string,
			spec: { handler: (raw: string, ctx: ExtensionCommandContext) => Promise<void> | void },
		) => commands.set(name, spec),
		sendMessage: (...args: unknown[]) => sent.push(args),
		sendUserMessage: (...args: unknown[]) => users.push(args),
		getSessionName: () => undefined,
		setSessionName: () => {},
	} as unknown as ExtensionAPI;
	return { pi, commands, sent, users };
}

test("without an activated store the proposal commands say so, change nothing and migrate nothing", async () => {
	const root = mkdtempSync(join(tmpdir(), "workflow-inactive-"));
	const memory = join(root, "memory");
	try {
		for (const [command, args] of [
			["proposals", []],
			["approve", ["abc"]],
			["reject", ["abc", "no"]],
		] as const) {
			const result = await proposalCommand(command, [...args], { memory, repoRoot: root });
			assert.equal(result.level, "warning");
			assert.match(result.text, /not active yet, so nothing changed/);
		}
		assert.equal(existsSync(join(memory, "memory.sqlite")), false, "no store is created");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("proposals lists each one with its id prefix, kind, scope, target, state, runs and next action; legacy ones are marked", async () => {
	const f = fixture();
	try {
		const db = openStore(f.memory);
		createProposal(db.db, {
			id: "p-skill",
			target: "skill:sample",
			before: "a",
			after: "b",
			evidence: ["r1", "r2", "r1"],
		});
		createProposal(db.db, { id: "p-legacy", target: "(new)", before: "", after: "z", evidence: ["r4"] });
		db.close();

		const result = await proposalCommand("proposals", [], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(result.level, "info");
		const lines = result.text.split("\n");
		const skill = lines.find((l) => l.includes("p-skill"));
		assert.match(skill ?? "", /skill:sample.*open.*2 runs.*next: approve or reject/);
		const legacy = lines.find((l) => l.includes("p-legacy"));
		assert.match(legacy ?? "", /legacy hypothesis/);
		assert.ok(lines.length <= 52, "the list is bounded");
	} finally {
		f.cleanup();
	}
});

test("approve applies a memory proposal through the scoped target, records a receipt and says so", async () => {
	const f = fixture();
	try {
		const recordPath = join(f.memory, "approved-records", "preference", "tests.md");
		mkdirSync(join(f.memory, "approved-records", "preference"), { recursive: true });
		writeFileSync(recordPath, "x");
		const db = openStore(f.memory);
		createProposal(db.db, {
			id: "p-mem",
			target: "memory:preference/tests",
			before: "x",
			after: "y",
			evidence: ["r3"],
		});
		db.close();

		const result = await proposalCommand("approve", ["p-mem"], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(result.level, "info");
		assert.match(result.text, /^Applied p-mem to memory:preference\/tests\. Receipt recorded/);
		assert.equal(readFileSync(recordPath, "utf8"), "y");

		const after = openStore(f.memory);
		try {
			assert.equal(getProposal(after.db, "p-mem").state, "applied");
			assert.ok(
				after.db.prepare("SELECT 1 AS hit FROM receipts WHERE proposal_id = ? AND kind = 'application'").get("p-mem"),
			);
		} finally {
			after.close();
		}
	} finally {
		f.cleanup();
	}
});

test("approve applies a skill proposal inside the repo's skills folder and names the validation it ran", async () => {
	const f = fixture();
	try {
		const before = "---\nname: sample\n---\nold\n";
		const file = writeSkill(f.repoRoot, before);
		const db = openStore(f.memory);
		createProposal(db.db, {
			id: "p-skill",
			target: "skill:sample",
			before,
			after: "---\nname: sample\n---\nnew\n",
			evidence: ["r1"],
		});
		db.close();

		const result = await proposalCommand("approve", ["p-skill"], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(result.level, "info");
		assert.match(result.text, /frontmatter and catalog checks/);
		assert.equal(readFileSync(file, "utf8"), "---\nname: sample\n---\nnew\n");
	} finally {
		f.cleanup();
	}
});

test("approve reports a stale target as not applied, with the stored reason, and never says applied", async () => {
	const f = fixture();
	try {
		mkdirSync(join(f.memory, "approved-records", "preference"), { recursive: true });
		writeFileSync(join(f.memory, "approved-records", "preference", "tests.md"), "edited by someone else");
		const db = openStore(f.memory);
		createProposal(db.db, {
			id: "p-stale",
			target: "memory:preference/tests",
			before: "x",
			after: "y",
			evidence: ["r3"],
		});
		db.close();

		const result = await proposalCommand("approve", ["p-stale"], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(result.level, "warning");
		assert.match(result.text, /^Not applied: p-stale is failed: .*Target changed since approval/);
		assert.doesNotMatch(result.text, /Applied/);
		const after = openStore(f.memory);
		try {
			assert.equal(getProposal(after.db, "p-stale").state, "failed");
		} finally {
			after.close();
		}
	} finally {
		f.cleanup();
	}
});

test("approve of a legacy hypothesis ends failed with its stored reason, never applied", async () => {
	const f = fixture();
	try {
		const db = openStore(f.memory);
		createProposal(db.db, { id: "p-legacy", target: "(new)", before: "", after: "z", evidence: ["r4"] });
		db.close();

		const result = await proposalCommand("approve", ["p-legacy"], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(result.level, "warning");
		assert.match(result.text, /Legacy hypothesis has no verified before-state/);
	} finally {
		f.cleanup();
	}
});

test("an approved proposal is applied by approve without approving it again", async () => {
	const f = fixture();
	try {
		mkdirSync(join(f.memory, "approved-records", "preference"), { recursive: true });
		const recordPath = join(f.memory, "approved-records", "preference", "tests.md");
		writeFileSync(recordPath, "x");
		const db = openStore(f.memory);
		const proposal = createProposal(db.db, {
			id: "p-ok",
			target: "memory:preference/tests",
			before: "x",
			after: "y",
			evidence: ["r3"],
		});
		approveProposal(db.db, proposal.id, proposal.version);
		db.close();

		const result = await proposalCommand("approve", ["p-ok"], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(result.level, "info");
		assert.equal(readFileSync(recordPath, "utf8"), "y");
	} finally {
		f.cleanup();
	}
});

test("approve with an unknown or ambiguous prefix changes nothing and names at most the matches", async () => {
	const f = fixture();
	try {
		const db = openStore(f.memory);
		createProposal(db.db, { id: "p-aa1", target: "memory:preference/a", before: "x", after: "y", evidence: ["r1"] });
		createProposal(db.db, { id: "p-aa2", target: "memory:preference/b", before: "x", after: "y", evidence: ["r1"] });
		db.close();

		const none = await proposalCommand("approve", ["zzz"], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(none.level, "warning");
		assert.match(none.text, /No proposal matches "zzz"/);

		const ambiguous = await proposalCommand("approve", ["p-aa"], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(ambiguous.level, "warning");
		assert.match(ambiguous.text, /matches p-aa1, p-aa2/);

		const check = openStore(f.memory);
		try {
			assert.equal(getProposal(check.db, "p-aa1").state, "open");
			assert.equal(getProposal(check.db, "p-aa2").state, "open");
		} finally {
			check.close();
		}
	} finally {
		f.cleanup();
	}
});

test("reject persists the reason, and a reject without one still records that none was given", async () => {
	const f = fixture();
	try {
		const db = openStore(f.memory);
		createProposal(db.db, { id: "p-rej", target: "memory:preference/a", before: "x", after: "y", evidence: ["r1"] });
		createProposal(db.db, { id: "p-bare", target: "memory:preference/b", before: "x", after: "y", evidence: ["r1"] });
		db.close();

		const reasoned = await proposalCommand("reject", ["p-re", "not", "for", "me"], {
			memory: f.memory,
			repoRoot: f.repoRoot,
		});
		assert.equal(reasoned.level, "info");
		const bare = await proposalCommand("reject", ["p-bare"], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(bare.level, "info");

		const check = openStore(f.memory);
		try {
			assert.equal(getProposal(check.db, "p-rej").state, "rejected");
			assert.equal(getProposal(check.db, "p-rej").reason, "not for me");
			assert.equal(getProposal(check.db, "p-bare").reason, "No reason given");
		} finally {
			check.close();
		}
	} finally {
		f.cleanup();
	}
});

test("the proposal commands never start a model turn", async () => {
	const f = fixture();
	const previous = process.env.PIHOUSE_HOME;
	process.env.PIHOUSE_HOME = f.root;
	try {
		const db = openStore(f.memory);
		createProposal(db.db, { id: "p-quiet", target: "memory:preference/a", before: "x", after: "y", evidence: ["r1"] });
		db.close();
		const { pi, commands, sent, users } = fakePi();
		const notes: string[] = [];
		const ctx = {
			ui: { notify: (message: string) => notes.push(message) },
			sessionManager: { getSessionId: () => "s" },
			cwd: f.root,
		} as unknown as ExtensionCommandContext;
		workflow(pi);
		const handler = commands.get("workflow")?.handler;
		assert.ok(handler);
		await handler("proposals", ctx);
		await handler("reject p-quiet not now", ctx);
		await handler("approve p-quiet", ctx);
		assert.equal(sent.length, 0, "no sendMessage");
		assert.equal(users.length, 0, "no sendUserMessage");
		assert.equal(notes.length, 3);
	} finally {
		if (previous === undefined) delete process.env.PIHOUSE_HOME;
		else process.env.PIHOUSE_HOME = previous;
		f.cleanup();
	}
});

test("help and completion list exactly the commands in the table, and nothing removed or unbuilt", () => {
	const { pi, commands } = fakePi();
	workflow(pi);
	const spec = commands.get("workflow") as
		| { description?: string; getArgumentCompletions?: (prefix: string) => { value: string }[] | null }
		| undefined;
	const values = spec?.getArgumentCompletions?.("")?.map((c) => c.value) ?? [];
	assert.deepEqual(
		values,
		WORKFLOW_COMMANDS.flatMap((c) => [...c.completions]),
	);
	for (const c of WORKFLOW_COMMANDS) assert.ok(USAGE.includes(`/workflow ${c.usage}`), `usage lists ${c.usage}`);
	const shown = `${USAGE} ${String(spec?.description)} ${values.join(" ")}`;
	for (const word of ["review", "digest", "self-learning", "keeper"]) {
		assert.doesNotMatch(shown, new RegExp(word), `${word} is not offered`);
	}
});

test("removed and not-yet-built invocations start nothing and say what to use instead", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "workflow-removed-"));
	const previous = process.env.PIHOUSE_HOME;
	process.env.PIHOUSE_HOME = home;
	t.after(() => {
		if (previous === undefined) delete process.env.PIHOUSE_HOME;
		else process.env.PIHOUSE_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	});
	const { pi, commands, sent, users } = fakePi();
	const notes: { text: string; level: string }[] = [];
	const ctx = {
		ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
		sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined },
		cwd: home,
	} as unknown as ExtensionCommandContext;
	workflow(pi);
	const handler = commands.get("workflow")?.handler;
	const keeper = commands.get("keeper")?.handler;
	assert.ok(handler && keeper);

	await handler("review --last", ctx);
	await handler("digest", ctx);
	await handler("self-learning", ctx);
	await keeper("summarize", ctx);
	await keeper("", ctx);

	assert.deepEqual(
		notes.map((n) => n.level),
		["warning", "warning", "warning", "warning", "warning"],
	);
	assert.match(notes[0]?.text ?? "", /\/workflow review was removed.*\/workflow report/);
	assert.match(notes[1]?.text ?? "", /^usage: \/workflow/);
	assert.match(notes[2]?.text ?? "", /^usage: \/workflow/);
	assert.match(notes[3]?.text ?? "", /The keeper was retired.*\/workflow proposals/);
	assert.match(notes[4]?.text ?? "", /The keeper was retired/);
	assert.equal(sent.length, 0, "no sendMessage");
	assert.equal(users.length, 0, "no sendUserMessage");
	assert.equal(existsSync(join(home, "reports")), false, "no report is written");
});

test("approve on an interrupted application recovers it to failed and leaves the target alone", async () => {
	const f = fixture();
	try {
		mkdirSync(join(f.memory, "approved-records", "preference"), { recursive: true });
		const recordPath = join(f.memory, "approved-records", "preference", "tests.md");
		writeFileSync(recordPath, "x");
		const db = openStore(f.memory);
		const proposal = createProposal(db.db, {
			id: "p-int",
			target: "memory:preference/tests",
			before: "x",
			after: "y",
			evidence: ["r3"],
		});
		approveProposal(db.db, proposal.id, proposal.version);
		db.db
			.prepare("UPDATE proposals SET state = 'applying', payload = ? WHERE id = ?")
			.run(JSON.stringify({ ...getProposal(db.db, "p-int"), state: "applying" }), "p-int");
		db.close();

		const result = await proposalCommand("approve", ["p-int"], { memory: f.memory, repoRoot: f.repoRoot });
		assert.equal(result.level, "warning");
		assert.match(
			result.text,
			/^Not applied: p-int is failed: Recovered interrupted application; observed target state: before/,
		);
		assert.equal(readFileSync(recordPath, "utf8"), "x", "the target is not touched");
	} finally {
		f.cleanup();
	}
});
