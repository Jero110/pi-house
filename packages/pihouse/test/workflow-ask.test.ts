import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAskContext } from "../src/workflow/ask-context.ts";
import { evidenceFingerprint, persistEvidence } from "../src/workflow/evidence-store.ts";
import { migrateLegacyStore } from "../src/workflow/migration.ts";
import type { WorkflowEvidence } from "../src/workflow/report.ts";
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
		const captured = join(memory, "runs", "a", "transcripts");
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
