import type { FleetJob, FleetJobSummary } from "./fleet-jobs.ts";

export type FleetMemorySource = {
	list(): FleetJobSummary[];
	get(id: string): (FleetJob & { sourceHost?: string }) | undefined;
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

function bestExcerpt(text: string, terms: Set<string>, phrase: string) {
	const normalized = fold(text);
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
	const excerpt =
		(bestStart ? "…" : "") +
		text
			.slice(bestStart, bestStart + 240)
			.replace(/\s+/g, " ")
			.trim() +
		(text.length > bestStart + 240 ? "…" : "");
	return { score: bestScore, excerpt };
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
	const ranked: { score: number; hit: FleetMemoryHit }[] = [];
	if (terms.size)
		for (const job of scopedJobs(source, project)) {
			let best: { score: number; hit: FleetMemoryHit } | undefined;
			const phrase = fold(query);
			function consider(kind: string, text: string, weight: number, artifactId?: string) {
				const evidence = bestExcerpt(text, terms, phrase);
				if (!evidence) return;
				const score = evidence.score + weight;
				if (best && best.score > score) return;
				best = {
					score,
					hit: {
						chatId: job.id,
						title: job.title,
						source: kind,
						excerpt: evidence.excerpt,
						updatedAt: job.updatedAt,
						...(artifactId && { artifactId }),
					},
				};
			}
			if (!administrative.test(job.title)) consider("Chat title", job.title, weight.title);
			let recallTurn = false;
			for (const message of job.messages) {
				if (message.role === "user") recallTurn = administrative.test(message.text.trim());
				if (recallTurn || message.kind === "memory" || message.text.startsWith("Project memory · ")) continue;
				if (message.actor) consider("Recorded actor", message.actor, 1);
				consider(
					message.actor || (message.role === "user" ? "User" : message.role === "assistant" ? job.agent : "Host"),
					message.text,
					message.role === "assistant" ? weight.message : 1,
				);
			}
			for (const file of job.artifacts ?? [])
				consider("Artifact", file.name, weight.artifact + (fold(file.name) === phrase ? 8 : 0), file.id);
			if (best) ranked.push(best);
		}
	ranked.sort(
		(a, b) => b.score - a.score || b.hit.updatedAt - a.hit.updatedAt || a.hit.chatId.localeCompare(b.hit.chatId),
	);
	return { project, query, hits: ranked.slice(0, 8).map((row) => row.hit) };
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
