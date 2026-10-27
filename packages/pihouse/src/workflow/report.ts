// The /workflow review report: what ran, with which skills, how many tokens and how much time, by role, by
// harness, by agent and by message. Plain Markdown, so it reads the same in the session and in the file.
import type { Usage } from "agent-transcripts";
import type { Role, RunAgent, WorkflowRun } from "./run.ts";

export interface WorkflowEvidenceParticipant {
	id: string;
	parent: string | null;
	role: Role;
	harness: string;
	model: string;
	taskId: string | null;
	taskTitle: string | null;
	assignedSkills: string[];
	loadedSkills: string[];
	usage: Partial<Usage>;
	activeMs: number | null;
	messages: number | null;
	missing: string | null;
	summary: {
		assistantMessages?: number;
		slowestMs?: number;
		failedToolCalls?: number;
		toolCalls?: number;
	} | null;
}

export interface WorkflowEvidence {
	lineage: string;
	title: string;
	project: string;
	plan: string | null;
	participants: WorkflowEvidenceParticipant[];
	metrics: {
		newTokens: number | null;
		cacheRead: number | null;
		activeMs: number | null;
		wallMs: number | null;
		agents: number;
		messages: number | null;
	};
	cursor: Record<string, string>;
}

const ROLE_ORDER: Role[] = ["planner", "helper", "executor", "worker", "root"];

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function add(a: Usage, b: Usage | undefined): Usage {
	if (!b) return a;
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
	};
}

export function tokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Tokens the run processed for the first time: input, output and cache writes.
 * Problem: the report's headline summed cache reads too. Example: a 12-minute run showed 3.37M tokens, of which
 * 2.87M were cache reads (each answer re-reads its whole context, billed at about a tenth). Solution: the headline
 * and the main columns count new tokens; cache reads get their own column.
 */
export function newTokens(u: Usage): number {
	return u.input + u.output + u.cacheWrite;
}

const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, " ");
const row = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
const usageCells = (u: Usage) => [
	tokens(newTokens(u)),
	tokens(u.input),
	tokens(u.output),
	tokens(u.cacheWrite),
	tokens(u.cacheRead),
];
const USAGE_HEADERS = ["New tokens", "Input", "Output", "Cache write", "Cache read"];

interface Group {
	agents: RunAgent[];
	usage: Usage;
	activeMs: number;
	messages: number;
}

function group(agents: readonly RunAgent[], key: (a: RunAgent) => string): Map<string, Group> {
	const out = new Map<string, Group>();
	for (const a of agents) {
		const k = key(a);
		const g = out.get(k) ?? { agents: [], usage: zero(), activeMs: 0, messages: 0 };
		g.agents.push(a);
		g.usage = add(g.usage, a.summary?.usage);
		g.activeMs += a.summary?.activeMs ?? 0;
		g.messages += a.summary?.assistantMessages ?? 0;
		out.set(k, g);
	}
	return out;
}

function model(a: RunAgent): string {
	return a.summary?.models.join(", ") || a.record.model || "default";
}

function wall(run: WorkflowRun): number {
	const starts = run.agents.map((a) => a.transcript?.startedAt).filter((x): x is number => x !== undefined);
	const ends = run.agents.map((a) => a.transcript?.endedAt).filter((x): x is number => x !== undefined);
	return starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0;
}

function evidenceGroups<T>(
	participants: readonly WorkflowEvidenceParticipant[],
	key: (participant: WorkflowEvidenceParticipant) => T,
): Map<T, WorkflowEvidenceParticipant[]> {
	const groups = new Map<T, WorkflowEvidenceParticipant[]>();
	for (const participant of participants) {
		const group = groups.get(key(participant)) ?? [];
		group.push(participant);
		groups.set(key(participant), group);
	}
	return groups;
}

function evidenceGroupRow(
	label: string,
	participants: readonly WorkflowEvidenceParticipant[],
	harness = false,
): string {
	const known = participants.every((participant) =>
		["input", "output", "cacheRead", "cacheWrite"].every(
			(key) => typeof participant.usage[key as keyof Usage] === "number",
		),
	);
	const usage = participants.reduce<Usage>(
		(total, participant) => ({
			input: total.input + (participant.usage.input ?? 0),
			output: total.output + (participant.usage.output ?? 0),
			cacheRead: total.cacheRead + (participant.usage.cacheRead ?? 0),
			cacheWrite: total.cacheWrite + (participant.usage.cacheWrite ?? 0),
		}),
		zero(),
	);
	const names = [
		...new Set(participants.map((participant) => (harness ? participant.model || "default" : participant.harness))),
	].join(", ");
	const answersKnown = participants.every((participant) => participant.summary?.assistantMessages !== undefined);
	const answers = participants.reduce((sum, participant) => sum + (participant.summary?.assistantMessages ?? 0), 0);
	return row([
		label,
		String(participants.length),
		names,
		known ? tokens(newTokens(usage)) : "unknown",
		known ? tokens(usage.cacheRead) : "unknown",
		answersKnown ? String(answers) : "unknown",
		participants.every((participant) => participant.activeMs !== null)
			? duration(participants.reduce((sum, participant) => sum + (participant.activeMs ?? 0), 0))
			: "unknown",
	]);
}

/** Rebuilds the reportable metrics from durable structured evidence, without transcript or native-session reads. */
export function renderEvidenceReport(evidence: WorkflowEvidence): string {
	const knownUsage = evidence.participants.some((participant) =>
		Object.values(participant.usage).some((value) => typeof value === "number" && Number.isFinite(value)),
	);
	const completeUsage = evidence.participants.every((participant) =>
		["input", "output", "cacheRead", "cacheWrite"].every(
			(key) => typeof participant.usage[key as keyof Usage] === "number",
		),
	);
	const totals = evidence.participants.reduce<Usage>(
		(total, participant) => ({
			input: total.input + (participant.usage.input ?? 0),
			output: total.output + (participant.usage.output ?? 0),
			cacheRead: total.cacheRead + (participant.usage.cacheRead ?? 0),
			cacheWrite: total.cacheWrite + (participant.usage.cacheWrite ?? 0),
		}),
		zero(),
	);
	const name = evidence.plan ?? evidence.title;
	const out = [
		`# Workflow evidence: ${name}`,
		"",
		`Lineage ${evidence.lineage} · project ${evidence.project} · revision cursor ${Object.keys(evidence.cursor).length} participants`,
		knownUsage
			? `New tokens ${tokens(newTokens(totals))}${completeUsage ? "" : " (partial; some participants unavailable)"} (${tokens(totals.input)} input, ${tokens(totals.output)} output, ${tokens(totals.cacheWrite)} cache write) · cache reads ${tokens(totals.cacheRead)} · wall time ${evidence.metrics.wallMs === null ? "unknown" : duration(evidence.metrics.wallMs)}`
			: `Usage unavailable · wall time ${evidence.metrics.wallMs === null ? "unknown" : duration(evidence.metrics.wallMs)}`,
		"",
		knownUsage
			? "New tokens are input, output and cache writes; cache reads are reported separately. Missing participant usage is unknown, not zero."
			: "Usage measurements are unavailable, not zero.",
		"",
		"## By role",
		"",
		row(["Role", "Participants", "Harnesses", "New tokens", "Cache reads", "Answers", "Active time"]),
		row(Array(7).fill("---")),
	];
	for (const [role, participants] of evidenceGroups(evidence.participants, (participant) => participant.role)) {
		out.push(evidenceGroupRow(role, participants));
	}
	out.push(
		"",
		"## By harness",
		"",
		row(["Harness", "Participants", "Models", "New tokens", "Cache reads", "Answers", "Active time"]),
		row(Array(7).fill("---")),
	);
	for (const [harness, participants] of evidenceGroups(evidence.participants, (participant) => participant.harness)) {
		out.push(evidenceGroupRow(harness, participants, true));
	}
	out.push(
		"",
		"## Participants",
		"",
		row([
			"Participant",
			"Role",
			"Harness · model",
			"Task",
			"Skills assigned",
			"Skills loaded",
			"Answers",
			"New tokens",
			"Cache read",
			"Active",
			"Slowest",
			"Tool errors",
			"State",
		]),
		row(Array(13).fill("---")),
	);
	for (const participant of evidence.participants) {
		const participantUsageKnown = ["input", "output", "cacheRead", "cacheWrite"].every(
			(key) =>
				typeof participant.usage[key as keyof Usage] === "number" &&
				Number.isFinite(participant.usage[key as keyof Usage]),
		);
		const usage = {
			input: participant.usage.input ?? 0,
			output: participant.usage.output ?? 0,
			cacheRead: participant.usage.cacheRead ?? 0,
			cacheWrite: participant.usage.cacheWrite ?? 0,
		};
		out.push(
			row([
				participant.id,
				participant.role,
				`${participant.harness} · ${participant.model || "default"}`,
				[participant.taskId, participant.taskTitle].filter(Boolean).join(": ") || "-",
				participant.assignedSkills.join(", ") || "-",
				participant.loadedSkills.join(", ") || "-",
				participant.summary?.assistantMessages === undefined ? "-" : String(participant.summary.assistantMessages),
				participantUsageKnown ? tokens(newTokens(usage)) : "-",
				participantUsageKnown ? tokens(usage.cacheRead) : "-",
				participant.activeMs === null ? "unknown" : duration(participant.activeMs),
				participant.summary?.slowestMs === undefined ? "-" : duration(participant.summary.slowestMs),
				participant.summary?.failedToolCalls === undefined ? "-" : String(participant.summary.failedToolCalls),
				participant.missing ? `missing evidence: ${participant.missing}` : "captured metrics",
			]),
		);
	}
	return `${out.join("\n")}\n`;
}

export function renderReport(run: WorkflowRun, opts: { messages?: boolean } = {}): string {
	const all = run.agents;
	const total = all.reduce((u, a) => add(u, a.summary?.usage), zero());
	const hasUsage = all.some((a) => a.summary?.usage !== undefined);
	const partial = all.some((a) => a.record.state === "working" || a.record.state === "starting");
	const out: string[] = [];
	out.push(`# Workflow review: ${run.plan ?? run.root.name}`);
	if (partial) out.push("", "**PARTIAL:** one or more agents are active or their evidence is unavailable.");
	out.push("");
	out.push(
		`Root ${run.root.name} (${run.root.harness}) · ${all.length} agents · started ${run.root.startedAt}${run.plan ? ` · plan ${run.plan}` : ""}`,
	);
	out.push(
		hasUsage
			? `New tokens ${tokens(newTokens(total))} (${tokens(total.input)} input, ${tokens(total.output)} output, ${tokens(total.cacheWrite)} cache write) · cache reads ${tokens(total.cacheRead)} · wall time ${duration(wall(run))}`
			: `Usage unavailable · wall time ${duration(wall(run))}`,
		"",
		hasUsage
			? "New tokens are input, output and cache writes; cache reads are reported separately."
			: "Usage measurements are unavailable, not zero.",
	);

	out.push("", "## By role", "");
	out.push(row(["Role", "Agents", "Harnesses", ...USAGE_HEADERS, "Answers", "Active time"]));
	out.push(row(Array(10).fill("---")));
	const byRole = group(all, (a) => a.role);
	for (const role of ROLE_ORDER) {
		const g = byRole.get(role);
		if (!g) continue;
		const harnesses = [...new Set(g.agents.map((a) => a.record.harness))].join(", ");
		out.push(
			row([role, String(g.agents.length), harnesses, ...usageCells(g.usage), String(g.messages), duration(g.activeMs)]),
		);
	}

	out.push("", "## By harness", "");
	out.push(row(["Harness", "Agents", "Models", ...USAGE_HEADERS, "Answers", "Active time"]));
	out.push(row(Array(10).fill("---")));
	for (const [h, g] of group(all, (a) => a.record.harness)) {
		const models = [...new Set(g.agents.map(model))].join(", ");
		out.push(
			row([h, String(g.agents.length), models, ...usageCells(g.usage), String(g.messages), duration(g.activeMs)]),
		);
	}

	out.push("", "## Agents and tasks", "");
	out.push(
		row([
			"Agent",
			"Role",
			"Harness · model",
			"Task",
			"Skills assigned",
			"Skills loaded",
			"Answers",
			"New tokens",
			"Cache read",
			"Active",
			"Slowest",
			"Tool errors",
			"State",
		]),
	);
	out.push(row(Array(13).fill("---")));
	for (const a of all) {
		const s = a.summary;
		const task = a.taskId
			? `${a.taskId}: ${a.taskTitle ?? ""}`
			: a.record.task
				? (a.record.task.trim().split("\n")[0] ?? "").slice(0, 80)
				: "-";
		out.push(
			row([
				`${"  ".repeat(a.record.depth)}${a.record.name}`,
				a.role,
				`${a.record.harness} · ${model(a)}`,
				task,
				a.assignedSkills.join(", ") || "-",
				s?.skills.join(", ") || "-",
				s ? String(s.assistantMessages) : "-",
				s ? tokens(newTokens(s.usage)) : "-",
				s ? tokens(s.usage.cacheRead) : "-",
				s ? duration(s.activeMs) : "-",
				s ? duration(s.slowestMs) : "-",
				s ? String(s.failedToolCalls) : "-",
				a.missing ? `${a.record.state} (no transcript: ${a.missing})` : a.record.state,
			]),
		);
	}

	if (opts.messages !== false) {
		out.push("", "## Time and tokens per message", "");
		for (const a of all) {
			if (!a.transcript) continue;
			out.push(`### ${a.record.name} (${a.role}, ${a.record.harness})`, "");
			out.push(row(["#", "At", "Took", "Input", "Output", "Cache read", "Tools", "Skills", "Text"]));
			out.push(row(Array(9).fill("---")));
			for (const m of a.transcript.messages) {
				if (m.role === "user") {
					out.push(
						row([
							String(m.index),
							time(m.at),
							"",
							"",
							"",
							"",
							"",
							m.skills.join(", "),
							`${m.origin === "agent" ? "from agent" : "from user"}: ${m.text.slice(0, 70)}`,
						]),
					);
					continue;
				}
				const u = m.usage;
				out.push(
					row([
						String(m.index),
						time(m.at),
						m.durationMs !== undefined ? duration(m.durationMs) : "",
						u ? tokens(u.input + u.cacheWrite) : "",
						u ? tokens(u.output) : "",
						u ? tokens(u.cacheRead) : "",
						m.tools.map((t) => `${t.name}${t.ok === false ? " (failed)" : ""}`).join(", "),
						m.skills.join(", "),
						m.text.slice(0, 70),
					]),
				);
			}
			out.push("");
		}
	}
	return out.join("\n");
}

function time(at: number): string {
	return Number.isFinite(at) ? new Date(at).toISOString().slice(11, 19) : "";
}
