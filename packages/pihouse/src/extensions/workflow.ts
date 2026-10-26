// /workflow review and /workflow ask: pihouse looking at its own workflow.
//
// review: rebuilds the last run from disk (agent-link journal + transcripts), writes a report of what ran,
//   with which skills, tokens and time by role, harness, agent and message, then asks the model in this
//   session for recommendations grounded in that report.
// ask: gives the model the architecture, the skills catalog and what is installed here, then the question.
// The report is computed, never guessed: the model only writes the recommendations and the answers.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { agentLinkHome, hubPaths, readJournal } from "agent-link-core";
import { PI_PACKAGE, pihousePaths, REPO_ROOT, SKILLS_DIR } from "../paths.ts";
import { readConfig } from "../setup.ts";
import { catalogMarkdown, readCatalog } from "../workflow/catalog.ts";
import { renderReport } from "../workflow/report.ts";
import { buildRun, pickRoot } from "../workflow/run.ts";

export const MESSAGE_TYPE = "pihouse-workflow";

export const USAGE = "usage: /workflow review [--last] | /workflow ask <question>";

export function reviewInstructions(reportFile: string, plan: string | undefined): string {
	return [
		`The report of the last run is saved at ${reportFile}: all the metrics, computed from the transcripts. It is not in this`,
		"message on purpose. Read the file, then:",
		"1. Summarize in 3-5 lines what this run did: tasks, which agent and harness did each, the skills used.",
		"   When you give token counts, use new tokens; name cache reads separately, as context read again, never as one sum.",
		"2. Write up to 5 recommendations to improve the workflow. Look at: skills that helped, were assigned but not loaded, or were missing;",
		"   task split and parallelism; harness and model per task; brief quality (questions back, retries, tool errors); time and token waste",
		"   (slow answers, large inputs, idle waits). For each: the change, the evidence (agent name and message #), and where to change it",
		`   (a skill under ${SKILLS_DIR}, the plan${plan ? ` ${plan}` : ""}, or the executor's choices).`,
		`3. Append both to ${reportFile} as "## Summary" and "## Recommendations", below the metrics. Edit no other file.`,
		"4. Print nothing else: do not repeat the metrics, the summary or the recommendations. Your whole answer is the path of the report.",
		`The skills catalog is ${join(SKILLS_DIR, "catalog.json")}; read a skill or the plan when a recommendation depends on it.`,
	].join("\n");
}

export const ARCHITECTURE = `## How pihouse works

- pihouse is pi (unmodified) with three extensions: the header, ask_user_question (questions in a picker) and /workflow.
- agent-link lets any agent launch, message and stop other agents (claude, codex, opencode, pihouse, pi), each in its own
  pane with its native UI. A hub daemon routes messages; results reach the parent by themselves.
- The hub journals every agent to ~/.agent-link/sessions/<id>.json (parent, task, pane, session id, transcript path), so
  sessions can be found and read after the hub or the agent stops.
- The cmux MCP (cmux only) lists agent sessions and reads their transcripts, arranges surfaces, panes and workspaces,
  and drives cmux's browser.
- The workflow: the planner skill (pre-build) takes the user from an idea to a validated plan in docs/plans/<slug>.md,
  asking only through ask_user_question; the user picks the build skills; grilling stress-tests the idea. On approval the
  planner launches an executor (a pihouse agent in its own pane) that runs the plan end to end with no questions to the user,
  dispatching tasks to workers on the harness and model the plan names. Post-build and Extras skills are manual.
- /workflow review reads a run back from the journal and transcripts: tokens, time per message, skills per agent.`;

function harnessesOnPath(env: NodeJS.ProcessEnv): string[] {
	const dirs = (env.PATH ?? "").split(":").filter(Boolean);
	return ["claude", "codex", "opencode", "pi", "tmux", "cmux"].filter((b) => dirs.some((d) => existsSync(join(d, b))));
}

/**
 * The newest report in `dir`, by when it was written.
 * Problem: it picked the last file name in order, which only worked while the date led the name. Solution: the file's
 * own time, so a name is free to start with what the review is about.
 */
export function latestReport(dir: string): string | undefined {
	try {
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => a.at - b.at || a.f.localeCompare(b.f));
		const last = files.at(-1);
		return last ? join(dir, last.f) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The name of a review report: what it is (workflow-review), which plan, and when, in the user's own time (2026-10-24-0415).
 * Problem: it was "20261024T041500-<plan>.md", the date run together and in UTC, which read as noise.
 */
export function reviewFileName(slug: string, when: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const date = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
	return `workflow-review-${slug}-${date}-${p(when.getHours())}${p(when.getMinutes())}.md`;
}

export function askContext(question: string, env: NodeJS.ProcessEnv = process.env): string {
	const paths = pihousePaths(env);
	const config = readConfig(paths);
	const report = latestReport(paths.reports);
	const reportHead = report ? readFileSync(report, "utf8").split("\n").slice(0, 40).join("\n") : undefined;
	return [
		"# pihouse workflow context",
		"",
		ARCHITECTURE,
		"",
		"## This machine",
		"",
		`- Backend: ${config?.backend ?? "not set up (run pih setup)"}; MCP servers: agent-link${config?.backend === "cmux" ? ", cmux" : ""}`,
		`- On PATH: ${harnessesOnPath(env).join(", ") || "none found"}`,
		`- Repository: ${REPO_ROOT}`,
		`- pi, which pihouse runs on: ${PI_PACKAGE} (README.md, docs/, examples/extensions/)`,
		report ? `- Last review report: ${report}` : "- No /workflow review report yet",
		"",
		"# Skills catalog",
		"",
		catalogMarkdown(readCatalog()),
		reportHead ? `# Last review (first lines)\n\n${reportHead}\n` : "",
		"# Question",
		"",
		question,
		"",
		"Answer from the context above and the files it names; say what you do not know. If the question names a tool, skill,",
		"repository or link you do not know, research it first. Search the pi package above for its name (grep -ril): pihouse",
		"is pi, so a pi extension or example is the cheapest way to add a tool. Then launch an opencode agent with agent-link",
		"spawn to search the web, or fetch the link. Then give one verdict: we already have something better (name it, say",
		"why), it is about the same as one of ours (name it), or it is worth trying (say exactly what to add or change, and on",
		"which past task to test it).",
	].join("\n");
}

async function review(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<void> {
	const records = readJournal(hubPaths(agentLinkHome()).sessions);
	const current = args.includes("--last")
		? {}
		: { sessionId: ctx.sessionManager.getSessionId(), agent: process.env.AGENT_LINK_AGENT };
	const root = pickRoot(records, current);
	if (!root) {
		ctx.ui.notify("No workflow run found in the agent-link journal yet. Run the planner first.", "warning");
		return;
	}
	const run = buildRun(records, root);
	const report = renderReport(run);
	const paths = pihousePaths();
	mkdirSync(paths.reports, { recursive: true });
	const slug = (run.plan?.split("/").pop()?.replace(/\.md$/, "") ?? root.name).replace(/[^\w-]+/g, "-");
	const file = join(paths.reports, reviewFileName(slug, new Date()));
	writeFileSync(file, `${report}\n`);
	// Problem: the report went into the session as a message, which filled the screen and spent tokens the model did not
	// need. Solution: the report stays in its file; the model gets only the path and writes its recommendations there.
	pi.sendMessage(
		{ customType: MESSAGE_TYPE, content: reviewInstructions(file, run.plan), display: false },
		{ triggerTurn: true },
	);
}

export default function workflow(pi: ExtensionAPI): void {
	pi.registerCommand("workflow", {
		description: "review: what the last run did and how to improve it · ask <question>: about your workflow and skills",
		getArgumentCompletions: (prefix) =>
			["review", "review --last", "ask "].filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c })),
		handler: async (raw, ctx) => {
			const [sub, ...rest] = raw.trim().split(/\s+/);
			if (sub === "review") return review(pi, rest, ctx);
			if (sub === "ask" && rest.join(" ").trim()) {
				pi.sendMessage(
					{ customType: MESSAGE_TYPE, content: askContext(rest.join(" ").trim()), display: false },
					{ triggerTurn: true },
				);
				return;
			}
			ctx.ui.notify(USAGE, "info");
		},
	});
}
