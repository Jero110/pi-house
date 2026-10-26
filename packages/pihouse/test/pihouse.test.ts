import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Journal, readJournal } from "agent-link-core";
import type { TranscriptRoots } from "agent-transcripts";
import { answersText, pickedSkillsText, showPicker, skillPickerQuestion } from "../src/extensions/ask.ts";
import { askContext, latestReport, reviewFileName, reviewInstructions } from "../src/extensions/workflow.ts";
import { piCommand, runPihouse, withSkillsDir } from "../src/launcher.ts";
import { LOGO_WIDTH, logoLines } from "../src/logo.ts";
import { EXTENSIONS, PI_CLI, pihousePaths, SKILL_GROUP_DIRS, SKILLS_DIR, THEME } from "../src/paths.ts";
import { BRIDGE_SOURCE, ensureAgentDir, ensureBridge, readConfig, setup, writePihouseProfile } from "../src/setup.ts";
import { catalogReadme, readCatalog, skillPath } from "../src/workflow/catalog.ts";
import { renderReport } from "../src/workflow/report.ts";
import { briefOf, buildRun, pickRoot } from "../src/workflow/run.ts";

function tempHome(t: { after: (fn: () => void) => void }): { home: string; env: NodeJS.ProcessEnv } {
	const home = mkdtempSync(join(tmpdir(), "pihouse-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return { home, env: { HOME: home, PATH: "", AGENT_LINK_HOME: join(home, ".al") } };
}

test("the logo is the pihouse mark: 6 lines of the same width, a gray roof over a white π", () => {
	const lines = logoLines();
	assert.equal(lines.length, 6);
	for (const l of lines) assert.equal(visibleWidth(l), LOGO_WIDTH);
	const drawn = lines.join("");
	assert.ok(drawn.includes("\u001b[38;2;244;244;245m"), "the white of the π");
	assert.ok(drawn.includes("\u001b[38;2;139;139;146m"), "the gray of the roof");
});

test("the agent dir is made once from pi's login, with no default model, this checkout's skills and no stray extensions", (t) => {
	const { home, env } = tempHome(t);
	const pi = join(home, ".pi", "agent");
	mkdirSync(join(pi, "npm"), { recursive: true });
	writeFileSync(join(pi, "auth.json"), "{}");
	writeFileSync(join(pi, "settings.json"), JSON.stringify({ packages: ["npm:pi-claude-bridge"], theme: "x" }));
	const paths = pihousePaths(env, home);
	assert.deepEqual(ensureAgentDir(paths), { wrote: true, copied: ["auth.json", "npm"] });
	const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
	assert.equal(settings.defaultProvider, undefined, "the bridge is available, never the default");
	assert.equal(settings.defaultModel, undefined);
	assert.deepEqual(settings.packages, ["npm:pi-claude-bridge"]);
	assert.deepEqual(settings.skills, SKILL_GROUP_DIRS);
	assert.deepEqual(settings.extensions, ["!extensions/**"]);

	settings.theme = "mine";
	settings.skills = ["/old/checkout/skills/build", "/home/me/my-skills"];
	writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify(settings));
	assert.equal(ensureAgentDir(paths).wrote, false);
	const again = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
	assert.equal(again.theme, "mine", "the user's settings stay");
	assert.deepEqual(again.skills, [...SKILL_GROUP_DIRS, "/home/me/my-skills"], "skills follow the checkout");
});

test("without pi's bridge pihouse still sets no default provider", (t) => {
	const { home, env } = tempHome(t);
	const paths = pihousePaths(env, home);
	ensureAgentDir(paths);
	const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
	assert.equal(settings.defaultProvider, undefined);
	assert.equal(settings.defaultModel, undefined);
	assert.deepEqual(settings.packages, []);
});

test("setup leaves the Claude bridge out unless it is asked for", (t) => {
	const { home, env } = tempHome(t);
	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
	const withClaude = { ...env, PATH: bin };
	const runs: string[][] = [];
	const fake = (argv: string[]) => {
		runs.push(argv);
		return 1;
	};
	setup({ paths: pihousePaths(withClaude, home), backend: "tmux", home, env: withClaude, out: () => {}, run: fake });
	assert.equal(runs.length, 0, "Claude Code is on PATH, and the bridge still is not installed");
	setup({
		paths: pihousePaths(withClaude, home),
		backend: "tmux",
		home,
		env: withClaude,
		out: () => {},
		claudeBridge: true,
		run: fake,
	});
	assert.equal(runs.length, 1, "with the option, it is");
});

test("setup installs the Claude bridge with pi install when Claude Code is there and the bridge is not", (t) => {
	const { home, env } = tempHome(t);
	const paths = pihousePaths(env, home);
	ensureAgentDir(paths);
	const settingsFile = join(paths.agentDir, "settings.json");
	const runs: Array<{ argv: string[]; dir: string | undefined }> = [];
	// A fake pi install: what the real one leaves behind (the package folder and the settings entry).
	const fakePi = (argv: string[], e: NodeJS.ProcessEnv) => {
		runs.push({ argv, dir: e.PI_CODING_AGENT_DIR });
		mkdirSync(join(paths.agentDir, "npm", "node_modules", "pi-claude-bridge"), { recursive: true });
		const s = JSON.parse(readFileSync(settingsFile, "utf8"));
		s.packages = [...s.packages, BRIDGE_SOURCE];
		writeFileSync(settingsFile, JSON.stringify(s));
		return 0;
	};
	const lines: string[] = [];
	assert.equal(
		ensureBridge(paths, env, (l) => lines.push(l), fakePi),
		"skipped",
		"no claude on PATH",
	);
	assert.equal(runs.length, 0);
	assert.match(lines.join("\n"), /Claude Code \(claude\) is not on PATH/);

	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
	const withClaude = { ...env, PATH: bin };
	assert.equal(
		ensureBridge(paths, withClaude, () => {}, fakePi),
		"installed",
	);
	assert.deepEqual(runs[0]?.argv.slice(2), ["install", BRIDGE_SOURCE]);
	assert.equal(runs[0]?.dir, paths.agentDir, "into pihouse's agent dir, not pi's");
	assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).defaultProvider, undefined, "installed, not the default");

	assert.equal(
		ensureBridge(paths, withClaude, () => {}, fakePi),
		"present",
	);
	assert.equal(runs.length, 1, "installed once");
	assert.equal(
		ensureBridge(
			paths,
			withClaude,
			() => {},
			() => 1,
		),
		"present",
	);
});

test("setup: cmux adds the cmux MCP to pihouse and records the backend; tmux takes it out again", (t) => {
	const { home, env } = tempHome(t);
	const paths = pihousePaths(env, home);
	const lines: string[] = [];
	setup({ paths, backend: "cmux", home, env, out: (l) => lines.push(l) });
	const mcp = JSON.parse(readFileSync(join(paths.agentDir, "mcp.json"), "utf8"));
	assert.equal(mcp.mcpServers.cmux.exposure, "direct");
	assert.match(mcp.mcpServers.cmux.args[0], /cmux-mcp\/src\/cli\.ts$/);
	assert.deepEqual(readConfig(paths), { backend: "cmux" });
	const profile = JSON.parse(readFileSync(join(home, ".al", "profiles", "pihouse.json"), "utf8"));
	assert.equal(profile.adapter, "pi");
	assert.match(profile.command[1], /pihouse\/src\/cli\.ts$/);
	assert.ok(lines.some((l) => /claude: not found on PATH, skipped/.test(l)));

	setup({ paths, backend: "tmux", home, env, out: () => {} });
	assert.deepEqual(JSON.parse(readFileSync(join(paths.agentDir, "mcp.json"), "utf8")).mcpServers, {});
	assert.deepEqual(readConfig(paths), { backend: "tmux" });
});

test("as an agent (AGENT_LINK_AGENT set) pihouse runs pi with its config dir and extensions", async (t) => {
	const { home, env } = tempHome(t);
	const runs: string[][] = [];
	const code = await runPihouse({
		argv: ["-e", "/x/agent-link-ext.ts", "--model", "m"],
		env: { ...env, AGENT_LINK_AGENT: "pihouse-2" },
		home,
		cwd: home,
		err: () => {},
		run: async (cmd) => {
			runs.push(cmd.argv);
			assert.equal(cmd.env.PI_CODING_AGENT_DIR, join(home, ".pihouse", "agent"));
			return 0;
		},
		root: async () => assert.fail("an agent never registers again"),
	});
	assert.equal(code, 0);
	assert.deepEqual(runs[0], [
		process.execPath,
		PI_CLI,
		"--theme",
		THEME,
		...EXTENSIONS.flatMap((e) => ["-e", e]),
		"-e",
		"/x/agent-link-ext.ts",
		"--model",
		"m",
	]);
});

test("as a root pihouse registers with agent-link; when the hub cannot take it, it runs without agent-link", async (t) => {
	const { home, env } = tempHome(t);
	const registered: string[][] = [];
	const ok = await runPihouse({
		argv: ["hello"],
		env,
		home,
		cwd: home,
		err: () => {},
		run: async () => 3,
		root: async (o) => {
			registered.push([...o.argv]);
			return (o.run ?? (async () => 1))({ argv: ["pihouse-from-hub"], env: {}, cwd: home });
		},
	});
	assert.equal(ok, 3);
	assert.deepEqual(registered, [["pihouse", "hello"]]);
	assert.ok(existsSync(join(home, ".al", "profiles", "pihouse.json")), "the profile is there before the hub needs it");

	const errs: string[] = [];
	const ran: string[][] = [];
	const fallback = await runPihouse({
		argv: ["hello"],
		env,
		home,
		cwd: home,
		err: (l) => errs.push(l),
		run: async (cmd) => {
			ran.push(cmd.argv);
			return 0;
		},
		root: async (o) => {
			o.err?.("agent-link open: the agent-link hub is not reachable: boom");
			return 1;
		},
	});
	assert.equal(fallback, 0);
	assert.equal(ran[0]?.[1], PI_CLI);
	assert.ok(errs.some((l) => /running without agent-link/.test(l)));
	assert.ok(errs.some((l) => /not reachable: boom/.test(l)));
});

test("pihouse shares its skills folder with every worker, after any folders already shared", () => {
	assert.equal(withSkillsDir({}), SKILLS_DIR);
	assert.equal(withSkillsDir({ AGENT_LINK_READ_DIRS: "/refs" }), `/refs:${SKILLS_DIR}`);
	assert.equal(withSkillsDir({ AGENT_LINK_READ_DIRS: SKILLS_DIR }), SKILLS_DIR, "not added twice");
});

test("piCommand keeps the user's arguments last", () => {
	const paths = pihousePaths({ HOME: "/h" }, "/h");
	const cmd = piCommand(paths, ["--continue"], {}, "/w");
	assert.equal(cmd.argv.at(-1), "--continue");
	assert.equal(cmd.cwd, "/w");
});

test("writePihouseProfile carries a non-default PIHOUSE_HOME, so the pihouse workers the hub opens use it", (t) => {
	const { env } = tempHome(t);
	const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { env?: Record<string, string> };
	assert.equal(read(writePihouseProfile(env)).env, undefined);
	assert.deepEqual(read(writePihouseProfile({ ...env, PIHOUSE_HOME: "/sandbox/pihouse" })).env, {
		PIHOUSE_HOME: "/sandbox/pihouse",
	});
});

test("writePihouseProfile only rewrites when it changed", (t) => {
	const { env } = tempHome(t);
	const file = writePihouseProfile(env);
	const before = statSync(file).mtimeMs;
	writePihouseProfile(env);
	assert.equal(statSync(file).mtimeMs, before);
});

// ---------------------------------------------------------------------------------------------- skills

function skillFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) {
			if (existsSync(join(p, "SKILL.md"))) out.push(join(p, "SKILL.md"));
			else out.push(...skillFiles(p));
		}
	}
	return out;
}

test("the catalog and the skills on disk match, and skills/README.md is current", () => {
	const catalog = readCatalog();
	const onDisk = SKILL_GROUP_DIRS.flatMap(skillFiles).sort();
	const listed = catalog.skills
		.filter((s) => !s.external)
		.map((s) => skillPath(s))
		.sort();
	assert.deepEqual(listed, onDisk);
	for (const s of catalog.skills.filter((x) => !x.external)) {
		const text = readFileSync(skillPath(s), "utf8");
		assert.match(text, new RegExp(`^---\\nname: ${s.name}\\n`), `${s.name}: frontmatter name`);
		const manual = /^disable-model-invocation: true$/m.test(text);
		assert.equal(manual, s.author !== "pihouse", `${s.name}: only pihouse's own skills are model-invocable`);
	}
	assert.equal(readFileSync(join(SKILLS_DIR, "README.md"), "utf8"), `${catalogReadme(catalog)}\n`);
	const extras = catalog.skills.filter((s) => s.group === "extras").map((s) => `${s.name} (${s.author})`);
	assert.deepEqual(extras, [
		"api-and-interface-design (Addy)",
		"browser-testing-with-devtools (Addy)",
		"code-review-and-quality (Addy)",
		"debugging-and-error-recovery (Addy)",
		"code-simplification (Addy)",
		"impeccable (Paul Bakaus)",
	]);
	assert.ok(catalog.groups.filter((g) => g.manual).every((g) => g.id === "post-build" || g.id === "extras"));
});

test("pihouse's own skills fix no model and ask only through ask_user_question", () => {
	for (const name of ["pre-build/planner", "build/executor"]) {
		const text = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
		assert.doesNotMatch(text, /claude-(haiku|sonnet|opus)-\d|gpt-\d|glm-\d/, `${name} names a model`);
		assert.match(text, /ask_user_question/);
	}
});

// ---------------------------------------------------------------------------------------------- workflow

function fakeRun(t: { after: (fn: () => void) => void }) {
	const home = mkdtempSync(join(tmpdir(), "pihouse-run-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const roots: TranscriptRoots = {
		claude: join(home, "claude"),
		codex: join(home, "codex"),
		opencodeDb: join(home, "oc.db"),
		pi: join(home, "pi"),
		pihouse: join(home, "pihouse"),
	};
	const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, s)).toISOString();
	const piSession = (id: string, skill: string, out: number) => {
		mkdirSync(join(roots.pihouse, "--w--"), { recursive: true });
		writeFileSync(
			join(roots.pihouse, "--w--", `x_${id}.jsonl`),
			[
				{ type: "session", id, cwd: "/w", timestamp: at(0) },
				{ type: "message", id: `${id}u`, timestamp: at(1), message: { role: "user", content: "go" } },
				{
					type: "message",
					id: `${id}a`,
					timestamp: at(11),
					message: {
						role: "assistant",
						model: "claude-sonnet-5-5",
						content: [{ type: "toolCall", id: "k", name: "read", arguments: { path: `/s/${skill}/SKILL.md` } }],
						usage: { input: 10, output: out, cacheRead: 100, cacheWrite: 0 },
					},
				},
			]
				.map((o) => JSON.stringify(o))
				.join("\n"),
		);
	};
	piSession("p-1", "planner", 50);
	piSession("e-1", "executor", 30);
	mkdirSync(join(roots.claude, "-w"), { recursive: true });
	writeFileSync(
		join(roots.claude, "-w", "c-1.jsonl"),
		[
			{
				type: "user",
				sessionId: "c-1",
				timestamp: at(20),
				message: { content: "Task T1 of docs/plans/todo.md: add the list" },
			},
			{
				type: "assistant",
				timestamp: at(50),
				message: {
					id: "m",
					model: "claude-haiku-5-5",
					content: [
						{ type: "tool_use", id: "u", name: "Read", input: { file_path: "/s/test-driven-development/SKILL.md" } },
					],
					usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			},
		]
			.map((o) => JSON.stringify(o))
			.join("\n"),
	);
	const dir = join(home, "journal");
	const j = new Journal(dir);
	const base = { model: null, cwd: "/w", state: "exited" as const };
	j.create({
		...base,
		id: "a",
		name: "pihouse",
		parent: null,
		parentName: null,
		root: "a",
		harness: "pihouse",
		depth: 0,
		sessionId: "p-1",
		startedAt: at(0),
	});
	j.create({
		...base,
		id: "b",
		name: "executor",
		parent: "a",
		parentName: "pihouse",
		root: "a",
		harness: "pihouse",
		depth: 1,
		task: "Read /repo/skills/build/executor/SKILL.md and follow it.\nRun the plan /w/docs/plans/todo.md end to end.",
		sessionId: "e-1",
		startedAt: at(5),
	});
	j.create({
		...base,
		id: "c",
		name: "t1-list",
		parent: "b",
		parentName: "executor",
		root: "a",
		harness: "claude",
		depth: 2,
		task: "Task T1 of /w/docs/plans/todo.md: add the list\nSkills: test-driven-development\nRead and follow: /s/test-driven-development/SKILL.md",
		sessionId: "c-1",
		startedAt: at(19),
	});
	j.create({
		...base,
		id: "d",
		name: "t2-search",
		parent: "b",
		parentName: "executor",
		root: "a",
		harness: "opencode",
		depth: 2,
		task: "Task T2 of /w/docs/plans/todo.md: search the docs",
		sessionId: "ses_missing",
		startedAt: at(19),
	});
	return { records: readJournal(dir), roots };
}

test("a brief written to a file counts: its Task and Skills lines are read from it", (t) => {
	const { home } = tempHome(t);
	const dir = join(home, "docs", "plans", "x-briefs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "T2.md"), "Task T2 of docs/plans/x.md: load the CSV\nSkills: spec-driven-development\n");
	const brief = briefOf("Read and do the task in docs/plans/x-briefs/T2.md", home) ?? "";
	assert.match(brief, /Task T2 of docs\/plans\/x\.md: load the CSV/);
	assert.match(brief, /Skills: spec-driven-development/);
	assert.equal(briefOf("Task T1: inline", home), "Task T1: inline", "an inline brief is kept as it is");
	assert.equal(briefOf("Read docs/plans/gone-briefs/T9.md", home), "Read docs/plans/gone-briefs/T9.md");
});

test("a run is rebuilt from the journal and transcripts: roles, plan, tasks, skills, tokens, time", (t) => {
	const { records, roots } = fakeRun(t);
	const root = pickRoot(records, { sessionId: "c-1" });
	assert.equal(root?.id, "a", "any session of the tree finds its root");
	assert.equal(pickRoot(records, {})?.id, "a", "without a current session: the newest tree with an executor");
	if (!root) return;
	const run = buildRun(records, root, roots);
	assert.equal(run.plan, "docs/plans/todo.md");
	assert.deepEqual(
		run.agents.map((a) => [a.record.name, a.role]),
		[
			["pihouse", "planner"],
			["executor", "executor"],
			["t1-list", "worker"],
			["t2-search", "worker"],
		],
	);
	const t1 = run.agents[2];
	assert.equal(t1?.taskId, "T1");
	assert.deepEqual(t1?.assignedSkills, ["test-driven-development"]);
	assert.deepEqual(t1?.summary?.skills, ["test-driven-development"]);
	assert.equal(t1?.summary?.activeMs, 30_000);
	assert.match(run.agents[3]?.missing ?? "", /no transcript on disk/);

	const report = renderReport(run);
	assert.match(report, /^# Workflow review: docs\/plans\/todo\.md/);
	assert.match(report, /\| planner \| 1 \| pihouse \| 60 \| 10 \| 50 \| 0 \| 100 \| 1 \| 10s \|/, "new tokens first");
	assert.match(report, /New tokens \d+ \(.*\) · cache reads \d+/);
	assert.match(report, /\| worker \| 2 \| claude, opencode \|/);
	assert.match(report, /\| claude \| 1 \| claude-haiku-5-5 \|/);
	assert.match(
		report,
		/\| {5}t1-list \| worker \| claude · claude-haiku-5-5 \| T1: add the list \| test-driven-development \| test-driven-development \|/,
	);
	assert.match(report, /### t1-list \(worker, claude\)/);
	assert.match(report, /\| 1 \| 10:00:50 \| 30s \| 5 \| 7 \| 0 \| Read \| test-driven-development \|/);
	assert.match(reviewInstructions("/r.md", run.plan), /up to 5 recommendations/);
	assert.match(reviewInstructions("/r.md", run.plan), /saved at \/r\.md/);
	assert.match(reviewInstructions("/r.md", run.plan), /Your whole answer is the path of the report/);
	assert.match(
		reviewInstructions("/r.md", run.plan),
		/Append both to \/r\.md as "## Summary" and "## Recommendations"/,
	);
});

test("/workflow ask carries the architecture, the catalog, this machine and the question", (t) => {
	const { home, env } = tempHome(t);
	const text = askContext("how are my skills organized?", { ...env, PIHOUSE_HOME: join(home, ".pihouse") });
	assert.match(text, /## How pihouse works/);
	assert.match(text, /## Extras \(manual\)/);
	assert.match(text, /`grilling` \| Matt Pocock/);
	assert.match(text, /Backend: not set up/);
	assert.match(text, /# Question\n\nhow are my skills organized\?/);
	assert.match(text, /pi, which pihouse runs on: .*pi-coding-agent \(README\.md, docs\/, examples\/extensions\/\)/);
	assert.match(text, /Search the pi package above for its name/);
});

test("answers read as one line per question", () => {
	assert.equal(
		answersText({
			cancelled: false,
			answers: [
				{ header: "Start", picked: ["I have an idea or a path"] },
				{ header: "Skills", picked: ["test-driven-development", "spec-driven-development"] },
				{ header: "Name", picked: ["todo"], typed: "todo" },
			],
		}),
		"Start: I have an idea or a path\nSkills: test-driven-development, spec-driven-development\nName: user wrote: todo",
	);
	assert.match(answersText({ cancelled: true, answers: [] }), /closed the questions/);
});

// ---------------------------------------------------------------------------------------------- pick_skills

test("pick_skills lists every development skill, recommended first, plus the extras the user named", () => {
	const catalog = readCatalog();
	const dev = catalog.skills.filter((s) => s.group === "build" && s.name !== "executor").map((s) => s.name);
	const built = skillPickerQuestion(catalog, {
		recommended: [
			{ name: "spec-driven-development", why: "clear acceptance per task" },
			{ name: "incremental-implementation", why: "thin slices" },
		],
		notes: { "test-driven-development": "little to test in a static page" },
		include: ["impeccable"],
	});
	assert.ok("question" in built);
	assert.equal(built.question.multiSelect, true);
	// Every development skill is there, whatever the model recommended; the extra comes last.
	assert.deepEqual([...built.names].slice(0, dev.length).sort(), [...dev].sort());
	assert.deepEqual(built.names.slice(0, 2), ["spec-driven-development", "incremental-implementation"]);
	assert.equal(built.names.at(-1), "impeccable");
	const labels = built.question.options.map((o) => o.label);
	assert.equal(labels[0], "spec-driven-development (Recommended)");
	assert.equal(labels.at(-1), "impeccable (Paul Bakaus) (you asked for it)");
	assert.equal(labels.filter((l) => l.endsWith("(Recommended)")).length, 2);
	const tdd = built.question.options.find((o) => o.label === "test-driven-development");
	assert.equal(tdd?.description, "little to test in a static page");

	const bad = skillPickerQuestion(catalog, { recommended: [{ name: "impeccable", why: "x" }], include: ["planner"] });
	assert.ok("error" in bad);
	assert.match(bad.error, /not development skills: impeccable/);
	assert.match(bad.error, /cannot include: planner/);
	assert.match(bad.error, /development skills: .*test-driven-development/);
});

test("pick_skills returns only the picked skills, with their SKILL.md paths", () => {
	const catalog = readCatalog();
	const built = skillPickerQuestion(catalog, { recommended: [], include: ["impeccable"] });
	assert.ok("question" in built);
	const text = pickedSkillsText(
		{
			cancelled: false,
			answers: [
				{ header: "Skills", picked: ["test-driven-development", "impeccable (Paul Bakaus) (you asked for it)"] },
			],
		},
		built.names,
		catalog,
	);
	assert.match(text, /only these go into the plan/);
	assert.match(text, /- test-driven-development \(Addy\): .*skills\/build\/test-driven-development\/SKILL\.md/);
	assert.match(text, /- impeccable \(Paul Bakaus\): .*skills\/extras\/impeccable\/SKILL\.md/);
	assert.doesNotMatch(text, /spec-driven/);
	assert.match(
		pickedSkillsText({ cancelled: false, answers: [{ header: "Skills", picked: [] }] }, built.names, catalog),
		/picked no skills/,
	);
});

test("the picker shows a window of the rows that fits the terminal, and the cursor can reach the last one", () => {
	const options = Array.from({ length: 16 }, (_, i) => ({ label: `option ${i + 1}`, description: `why ${i + 1}` }));
	let component: { render(w: number): string[]; handleInput(d: string): void } | undefined;
	const tui = { terminal: { rows: 20 }, requestRender() {} };
	const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
	const ctx = {
		ui: {
			custom: (factory: (...a: unknown[]) => typeof component) => {
				component = factory(tui, theme, {}, () => {});
				return new Promise(() => {});
			},
		},
	};
	void showPicker(ctx as never, [{ header: "Pick", question: "Which?", options, multiSelect: true }]);
	assert.ok(component);
	assert.ok(component.render(80).length <= 20, "fits the terminal");
	for (let i = 0; i < 17; i++) component.handleInput("\u001b[B");
	const lines = component.render(80);
	assert.ok(lines.length <= 20, "still fits after moving down");
	assert.match(lines.join("\n"), /Done/, "the last row (Done) is reachable");
	assert.match(lines.join("\n"), /↑ \d+ more/);
});

test("a review report is named for its plan and its date, and the newest one is found by when it was written", (t) => {
	assert.equal(
		reviewFileName("japan-trip-map", new Date(2026, 9, 24, 4, 5)),
		"workflow-review-japan-trip-map-2026-10-24-0405.md",
	);
	const dir = mkdtempSync(join(tmpdir(), "pihouse-reports-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(latestReport(dir), undefined);
	// Names that do not sort in time order: the file's own time decides.
	writeFileSync(join(dir, "workflow-review-zzz-2026-10-24-0900.md"), "x");
	writeFileSync(join(dir, "workflow-review-aaa-2026-10-24-1000.md"), "x");
	writeFileSync(join(dir, "20261024T000000-old.md"), "x");
	for (const [name, secs] of [
		["workflow-review-zzz-2026-10-24-0900.md", 1000],
		["workflow-review-aaa-2026-10-24-1000.md", 2000],
		["20261024T000000-old.md", 500],
	] as const)
		utimesSync(join(dir, name), secs, secs);
	assert.equal(latestReport(dir), join(dir, "workflow-review-aaa-2026-10-24-1000.md"));
});
