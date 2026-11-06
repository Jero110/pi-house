import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { askContext } from "../src/extensions/workflow.ts";
import { buildAskContext } from "../src/workflow/ask-context.ts";
import { evidenceFingerprint, persistEvidence } from "../src/workflow/evidence-store.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import type { WorkflowEvidence } from "../src/workflow/report.ts";
import { recordCompact } from "../src/workflow/run-stages.ts";
import { openOperationalStore } from "../src/workflow/storage.ts";

function evidence(project: string, lineage: string, tokens: number, skill: string): WorkflowEvidence {
	return {
		lineage,
		title: lineage,
		project,
		plan: null,
		cursor: {},
		metrics: { newTokens: tokens, cacheRead: null, activeMs: 5, wallMs: null, agents: 1, messages: null },
		participants: [
			{
				id: `${lineage}-worker`,
				parent: null,
				role: "worker",
				harness: "pi",
				model: "fixture",
				taskId: null,
				taskTitle: null,
				assignedSkills: [skill],
				loadedSkills: [skill],
				usage: { input: tokens },
				activeMs: null,
				messages: null,
				missing: null,
				summary: null,
			},
		],
	};
}

test("ask scopes latest retained snapshots per project after captured-copy cleanup", () => {
	const root = mkdtempSync(join(tmpdir(), "ask-scoped-"));
	const memory = join(root, "memory");
	try {
		migrateLegacyStore(memory);
		const store = openOperationalStore(join(memory, "memory.sqlite"), { fts: false, legacy: true });
		try {
			for (const [run, project, count, skill, stamp] of [
				["a", "/project-a", 50, "skill-a", "2026-01-05T00:00:00.000Z"],
				["b", "/project-b", 900, "secret-skill", "2026-01-06T00:00:00.000Z"],
			] as const) {
				const record = evidence(project, run, count, skill);
				persistEvidence(store.db, {
					runId: run,
					revision: 1,
					fingerprint: evidenceFingerprint(record),
					evidence: record,
					capturedAt: stamp,
				});
			}
		} finally {
			store.close();
		}
		const repo = join(root, "repo");
		mkdirSync(join(repo, "docs", "specs", "self-learning"), { recursive: true });
		writeFileSync(join(repo, "docs", "architecture.md"), "# General\nUnrelated architecture text.");
		writeFileSync(
			join(repo, "docs", "specs", "self-learning", "memory-access.md"),
			"# Metrics\nMetric evidence is retained.",
		);
		writeFileSync(join(repo, "docs", "specs", "self-learning", "run-evidence.md"), "# Other\nUnrelated evidence text.");
		const skills = join(root, "skills");
		mkdirSync(join(skills, "build", "skill-a"), { recursive: true });
		writeFileSync(
			join(skills, "catalog.json"),
			JSON.stringify({
				groups: [{ id: "build", title: "Build", purpose: "Build", manual: false }],
				skills: [
					{ name: "skill-a", group: "build", author: "fixture", source: "fixture", license: "MIT", summary: "fixture" },
					{
						name: "secret-skill",
						group: "build",
						author: "fixture",
						source: "fixture",
						license: "MIT",
						summary: "fixture",
					},
				],
			}),
		);
		writeFileSync(join(skills, "build", "skill-a", "SKILL.md"), "Skill A description.");
		const captured = join(memory, "conversations", "a", "transcripts");
		mkdirSync(captured, { recursive: true });
		writeFileSync(join(captured, "captured.json"), "PRIVATE CONVERSATION");
		rmSync(captured, { recursive: true, force: true });
		const text = buildAskContext({
			memoryDir: memory,
			project: "/project-a",
			question: "metrics skill-a",
			repoRoot: repo,
			skillsDir: skills,
			now: new Date("2026-01-31T00:00:00Z"),
		});
		assert.match(text, /newTokens=50/);
		assert.match(text, /latest retained revisions per run: 1/);
		assert.match(text, /skill-a=1/);
		assert.doesNotMatch(text, /900|secret-skill|project-b|PRIVATE CONVERSATION/);
		assert.match(text, /cacheRead|Price and quality\/validation: unknown/);
		assert.doesNotMatch(text, /Unrelated architecture text|Unrelated evidence text/);
		assert.match(text, /Skill A description/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ask reports unknown legacy metric coverage without reading native session files", () => {
	const root = mkdtempSync(join(tmpdir(), "ask-legacy-"));
	try {
		const repo = join(root, "repo");
		const skills = join(root, "skills");
		mkdirSync(join(repo, "docs", "specs", "self-learning"), { recursive: true });
		mkdirSync(skills, { recursive: true });
		writeFileSync(join(skills, "catalog.json"), JSON.stringify({ groups: [], skills: [] }));
		writeFileSync(join(repo, "docs", "architecture.md"), "# Architecture\nOnly docs are read.");
		writeFileSync(join(repo, "docs", "specs", "self-learning", "memory-access.md"), "# Contract\nSelective access.");
		writeFileSync(
			join(repo, "docs", "specs", "self-learning", "run-evidence.md"),
			"# Contract\nUnknown data remains unknown.",
		);
		const text = buildAskContext({
			memoryDir: join(root, "memory"),
			project: "p",
			question: "tokens",
			repoRoot: repo,
			skillsDir: skills,
			now: new Date("2026-01-31T00:00:00Z"),
		});
		assert.match(text, /legacy metric coverage unknown/);
		assert.match(text, /Price and quality\/validation: unknown/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/** An activated store with two saved runs of /project-a, one of /project-b, and a repo and skills folder to read. */
function askFixture() {
	const root = mkdtempSync(join(tmpdir(), "ask-offer-"));
	const memory = join(root, "memory");
	migrateLegacyStore(memory);
	const store = openOperationalStore(join(memory, "memory.sqlite"), { fts: false, legacy: true });
	for (const [run, project] of [
		["a1", "/project-a"],
		["a2", "/project-a"],
		["b1", "/project-b"],
	] as const) {
		const record = evidence(project, run, 10, "skill-a");
		persistEvidence(store.db, {
			runId: run,
			revision: 1,
			fingerprint: evidenceFingerprint(record),
			evidence: record,
			capturedAt: "2026-01-05T00:00:00.000Z",
		});
	}
	const repo = join(root, "repo");
	const skills = join(root, "skills");
	mkdirSync(join(repo, "docs"), { recursive: true });
	mkdirSync(skills, { recursive: true });
	writeFileSync(join(skills, "catalog.json"), JSON.stringify({ groups: [], skills: [] }));
	const options = (extra: Partial<Parameters<typeof buildAskContext>[0]> = {}) => ({
		memoryDir: memory,
		project: "project-a",
		projectPath: "/project-a",
		question: "what did we do",
		repoRoot: repo,
		skillsDir: skills,
		now: new Date("2026-01-31T00:00:00Z"),
		...extra,
	});
	return {
		root,
		memory,
		store,
		options,
		cleanup: () => {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("ask with uncompacted runs of this project offers to compact them, with the count and the tool name", () => {
	const f = askFixture();
	try {
		const text = buildAskContext(f.options());
		assert.match(text, /2 saved runs of this project are not compacted/);
		assert.match(text, /ask_user_question/);
		assert.match(text, /workflow_compact/);
		assert.match(text, /once/i);
		assert.doesNotMatch(text, /b1|project-b/, "another project's runs are not counted or named");
	} finally {
		f.cleanup();
	}
});

test("ask without uncompacted runs, or while the runs are active, does not make the offer", () => {
	const f = askFixture();
	try {
		assert.doesNotMatch(buildAskContext(f.options({ projectPath: "/project-none" })), /workflow_compact/);
		assert.doesNotMatch(buildAskContext(f.options({ isActive: () => true })), /workflow_compact/);
		assert.doesNotMatch(
			buildAskContext(f.options({ memoryDir: join(f.root, "nothing-here") })),
			/workflow_compact/,
			"no store, no offer",
		);
	} finally {
		f.cleanup();
	}
});

test("ask answers from compacts: a compact is a hit, and its run is no longer offered", () => {
	const f = askFixture();
	try {
		const rel = "workflow/compact/a1.r1.md";
		mkdirSync(join(f.memory, "workflow", "compact"), { recursive: true });
		const body = "The run a1 chose a zebra-striped layout for the login page.";
		writeFileSync(join(f.memory, ...rel.split("/")), body);
		const source = f.store.db.prepare("SELECT source_hash FROM revisions WHERE id = 'a1.r1'").get();
		recordCompact(f.store.db, {
			revisionId: "a1.r1",
			compactPath: rel,
			compactHash: createHash("sha256").update(body).digest("hex"),
			compactFingerprint: String(source?.source_hash),
			compactedBy: "ask",
			compactedAt: "2026-01-06T00:00:00.000Z",
		});
		const text = buildAskContext(f.options({ question: "zebra layout" }));
		assert.match(text, /compact:a1\.r1.*zebra/s);
		assert.match(text, /1 saved run of this project is not compacted/);
	} finally {
		f.cleanup();
	}
});

test("ask context stays within 80,000 characters with three large sources and never holds a transcript", async () => {
	const f = askFixture();
	try {
		const captured = join(f.memory, "conversations", "a1", "transcripts");
		mkdirSync(captured, { recursive: true });
		writeFileSync(join(captured, "agent.jsonl"), "PRIVATE TRANSCRIPT TEXT");
		const big = "lorem ipsum dolor ".repeat(20_000);
		const text = await askContext(
			`${"why ".repeat(5_000)} https://a.example/1 https://a.example/2 https://a.example/3`,
			{ PIHOUSE_HOME: f.root },
			{
				memoryDir: f.memory,
				cwd: "/project-a",
				isActive: () => false,
				fetchSource: async () => ({
					ok: true,
					text: big,
					meta: { kind: "web", method: "fetch", fetchedAt: "2026-01-01T00:00:00Z" },
				}),
			},
		);
		assert.ok(text.length <= 80_000, `${text.length} characters`);
		assert.doesNotMatch(text, /PRIVATE TRANSCRIPT TEXT/);
		assert.match(text, /workflow_compact/, "the offer survives the cap");
	} finally {
		f.cleanup();
	}
});
