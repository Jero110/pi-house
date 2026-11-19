import type { FleetJob, FleetJobSummary } from "./fleet-jobs.ts";

export const FLEET_RETRIEVAL_REVISION = "fleet-passages-v2";
export type FleetPassage = {
	kind: "title" | "actor" | "message" | "assistant" | "artifact";
	label: string;
	text: string;
	artifactId?: string;
};
export type FleetEvidence = { chatId: string; title: string; updatedAt: number; passage: FleetPassage };
export type FleetMemorySource = {
	matchingPassages?(project: string, terms: string[]): Iterable<FleetEvidence>;
	evidenceDigest?(project: string): string;
	list(): FleetJobSummary[];
	get(id: string): FleetJob | undefined;
};
export interface FleetMemoryHit {
	chatId: string;
	title: string;
	source: string;
	excerpt: string;
	updatedAt: number;
	artifactId?: string;
}
const command = /^\/?memory(?:\s+([\s\S]*))?$/i;
const administrative =
	/^(?:\/?(?:memory|omnimem)|\/(?:eval|feedback|remember|correct|review|promote|revert|calibrate))(?:\s|$)/i;
export function isFleetAdministrativeText(text: string) {
	return administrative.test(text.trim());
}

export function fleetPassages(job: FleetJob) {
	const passages: FleetPassage[] = [];
	if (!isFleetAdministrativeText(job.title)) passages.push({ kind: "title", label: "Chat title", text: job.title });
	let administrativeTurn = false;
	let latest = 0;
	for (const m of job.messages) {
		if (m.role === "user") administrativeTurn = isFleetAdministrativeText(m.text);
		if (administrativeTurn || m.kind === "memory" || m.text.startsWith("Project memory · ")) continue;
		latest = Math.max(latest, m.at ?? 0);
		if (m.actor) passages.push({ kind: "actor", label: "Recorded actor", text: m.actor });
		passages.push({
			kind: m.role === "assistant" ? "assistant" : "message",
			label: m.actor || (m.role === "user" ? "User" : m.role === "assistant" ? job.agent : "Host"),
			text: m.text,
		});
	}
	for (const f of job.artifacts ?? [])
		passages.push({ kind: "artifact", label: "Artifact", text: f.name, artifactId: f.id });
	// Legacy messages without dates retain a stable ID tie-break when administrative turns are appended.
	return { passages, updatedAt: latest };
}

export type FleetMemoryProfile = "balanced" | "title" | "evidence";
const weights = {
	balanced: { title: 2, message: 3, artifact: 3 },
	title: { title: 9, message: 1, artifact: 2 },
	evidence: { title: 0, message: 8, artifact: 8 },
};
const words = /[\p{L}\p{M}\p{N}_]+/gu;
const stop = new Set(
	"the and for what was were about with how did are have can de del una para por que las los con como cual sobre".split(
		" ",
	),
);
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function* scopedJobs(source: FleetMemorySource, project: string) {
	if (!project) return;
	for (const row of source.list()) {
		if (row.project !== project) continue;
		const job = source.get(row.id);
		if (job?.id === row.id && job.project === project) yield job;
	}
}

function excerptAt(text: string, start: number) {
	return (
		(start ? "…" : "") +
		text
			.slice(start, start + 240)
			.replace(/\s+/g, " ")
			.trim() +
		(text.length > start + 240 ? "…" : "")
	);
}
const wordChar = /[\p{L}\p{M}\p{N}_\uD800-\uDFFF]/u;

function bestExcerpt(text: string, terms: Set<string>, phrase: string) {
	const normalized = fold(text);
	const pos = normalized.indexOf(phrase);
	if (
		phrase.length <= 160 &&
		pos >= 0 &&
		normalized.length === text.length &&
		!wordChar.test(normalized[pos - 1] ?? "") &&
		!wordChar.test(normalized[pos + phrase.length] ?? "")
	) {
		return { score: terms.size * 10 + 4, excerpt: excerptAt(text, Math.max(0, pos - 45)) };
	}
	if (![...terms].some((term) => normalized.includes(term))) return;
	const window: { term: string; pos: number }[] = [];
	const counts = new Map<string, number>();
	let bestScore = 0;
	let bestStart = 0;
	for (const token of text.matchAll(words)) {
		const term = fold(token[0]);
		if (!terms.has(term)) continue;
		while (window.length && token.index - window[0].pos > 160) {
			const old = window.shift();
			if (!old) break;
			const left = (counts.get(old.term) ?? 1) - 1;
			if (left) counts.set(old.term, left);
			else counts.delete(old.term);
		}
		window.push({ term, pos: token.index });
		counts.set(term, (counts.get(term) ?? 0) + 1);
		const start = Math.max(0, window[0].pos - 45);
		const score = counts.size * 10 + (phrase && fold(text.slice(start, start + 240)).includes(phrase) ? 4 : 0);
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
		}
		if (bestScore === terms.size * 10 + 4) break;
	}
	if (!bestScore) return;
	return { score: bestScore, excerpt: excerptAt(text, bestStart) };
}

/** Fleet chats are the source of record for both transports. Explicit search reads only the chosen project.
 * Workflow compacts and their separate trust scope stay in the workflow memory store. */
export function searchFleetMemory(
	source: FleetMemorySource,
	project: string,
	input: string,
	profile: FleetMemoryProfile = "balanced",
) {
	const weight = weights[profile];
	const query = input.trim().slice(0, 512);
	const tokens = fold(query).match(words) ?? [];
	const terms = new Set(tokens.filter((word) => !stop.has(word)).slice(0, 16));
	const best = new Map<string, { score: number; hit: FleetMemoryHit }>();
	const phrase = fold(query);
	function* scan(): Iterable<FleetEvidence> {
		for (const job of scopedJobs(source, project)) {
			const { passages, updatedAt } = fleetPassages(job);
			for (const passage of passages) yield { chatId: job.id, title: job.title, updatedAt, passage };
		}
	}
	if (terms.size)
		for (const row of source.matchingPassages?.(project, [...terms]) ?? scan()) {
			const { chatId, title, updatedAt, passage } = row;
			const evidence = bestExcerpt(passage.text, terms, phrase);
			if (!evidence) continue;
			let bonus = 1;
			if (passage.kind === "title") bonus = weight.title;
			if (passage.kind === "assistant") bonus = weight.message;
			if (passage.kind === "artifact") bonus = weight.artifact + (fold(passage.text) === phrase ? 8 : 0);
			const score = evidence.score + bonus;
			if ((best.get(chatId)?.score ?? 0) > score) continue;
			best.set(chatId, {
				score,
				hit: {
					chatId,
					title,
					updatedAt,
					source: passage.label,
					excerpt: evidence.excerpt,
					...(passage.artifactId && { artifactId: passage.artifactId }),
				},
			});
		}
	const ranked = [...best.values()].sort(
		(a, b) => b.score - a.score || b.hit.updatedAt - a.hit.updatedAt || a.hit.chatId.localeCompare(b.hit.chatId),
	);
	return { project, query, hits: ranked.slice(0, 8).map((r) => r.hit) };
}

export function fleetProjectGraph(source: FleetMemorySource, project: string, host: string) {
	const threads = [];
	for (const job of scopedJobs(source, project)) {
		const owner = job.sourceHost || host;
		const machines = new Set<string>(owner ? [owner] : []);
		// Only structured actor labels and host-produced lifecycle events establish machine edges.
		for (const actor of [
			...job.messages.map((message) => message.actor),
			...(job.events ?? []).map((event) => event.text),
		]) {
			if (!actor) continue;
			const separator = actor.indexOf(" · ");
			if (separator > 0) machines.add(actor.slice(0, separator));
		}
		threads.push({
			id: job.id,
			title: job.title,
			updatedAt: job.updatedAt,
			machines: [...machines],
			artifacts: (job.artifacts ?? []).map(({ id, name }) => ({ id, name })),
		});
	}
	threads.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
	return { project, threads };
}

export function fleetMemoryReply(
	source: FleetMemorySource,
	project: string,
	input: string,
	origin?: string,
	profile: FleetMemoryProfile = "balanced",
): string | undefined {
	const match = command.exec(input.trim());
	if (!match) return;
	const query = match[1]?.trim();
	if (!query) return "Add search terms after /memory to find evidence in this project.";
	const { hits } = searchFleetMemory(source, project, query, profile);
	const heading = `Project memory · ${project}`;
	if (!hits.length) return `${heading}\nNo matching evidence in this project's chats or artifact names.`;
	return [
		heading,
		...hits.slice(0, 6).map((hit) => {
			const hash = new URLSearchParams({ chat: hit.chatId, ...(hit.artifactId && { artifact: hit.artifactId }) });
			return `${hit.title} · ${hit.source}\n${hit.excerpt}\n${origin ?? ""}/#${hash}`;
		}),
	].join("\n\n");
}
