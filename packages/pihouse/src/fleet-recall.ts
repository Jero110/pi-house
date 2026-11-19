import { type FleetMemorySource, fleetMemoryReply, fleetPassages } from "./fleet-memory.ts";
import { createMemoryRepository } from "./fleet-memory-repo.ts";

import {
	addFeedback,
	evaluateRecall,
	feedbackStatus,
	promoteRecall,
	type RecallEvaluation,
} from "./fleet-recall-eval.ts";

type Fact = { key: string; value: string; chatId: string; version: number; retired?: boolean };
export type FleetMemoryRelation = {
	subject: string;
	predicate: string;
	object: string;
	chatId: string;
	version: number;
	retired?: boolean;
};
interface State extends RecallEvaluation {
	facts: Fact[];
	relations?: FleetMemoryRelation[];
}
const initial = (): State => ({
	profile: "balanced",
	facts: [],
	relations: [],
	examples: [],
	trials: [],
	revision: 0,
	lastTrial: 0,
});
const normalize = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
export const isFleetMemoryCommand = (s: string) => /^\/?memory(?:\s|$)/i.test(s.trim());
function describeRelation(edge: Pick<FleetMemoryRelation, "subject" | "predicate" | "object">) {
	return `${edge.subject} | ${edge.predicate} | ${edge.object}`;
}
const stopwords = new Set([
	"the",
	"this",
	"with",
	"que",
	"los",
	"las",
	"una",
	"del",
	"para",
	"from",
	"what",
	"was",
	"are",
	"como",
]);
export function matchingRelations(relations: FleetMemoryRelation[], input: string) {
	const words = (s: string) => normalize(s).match(/[\p{L}\p{N}]+/gu) ?? [];
	const query = new Set(words(input).filter((t) => !stopwords.has(t)));
	return relations
		.filter((r) => !r.retired)
		.map((r) => ({
			r,
			score: [r.subject, r.predicate, r.object].reduce((sum, field) => {
				const terms = words(field).filter((t) => !stopwords.has(t));
				const matched = terms.filter((t) => query.has(t)).length;
				return sum + matched + (matched && matched === terms.length ? 5 : 0);
			}, 0),
		}))
		.filter((row) => row.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 8)
		.map((row) => row.r);
}
function updateRelation(state: State, verb: string, input: string, chatId: string) {
	const parts = input.split("|").map((part) => part.trim().replace(/[ \t]+/g, " "));
	if (parts.length !== 3 || parts.some((part) => !part || part.length > 160 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(part)))
		return `Use memory ${verb} SUBJECT | RELATION | OBJECT (up to 160 characters each).`;
	const [subject, predicate, object] = parts;
	const key = (fields: string[]) => JSON.stringify(fields.map(normalize));
	const id = key(parts);
	const prior = state.relations?.find((r) => key([r.subject, r.predicate, r.object]) === id);
	if (verb === "unlink") {
		if (!prior || prior.retired) return "No active relation with that subject, relation, and object.";
		prior.retired = true;
		prior.chatId = chatId;
		prior.version++;
		return `Unlinked ${describeRelation(prior)} · v${prior.version}.`;
	}
	if (prior) {
		if (prior.retired) {
			delete prior.retired;
			prior.version++;
			prior.chatId = chatId;
		}
		return `Linked ${describeRelation(prior)} · v${prior.version}.`;
	}
	state.relations ??= [];
	if (state.relations.length >= 1024) return "Project relation capacity reached.";
	state.relations.push({ subject, predicate, object, chatId, version: 1 });
	return `Linked ${describeRelation({ subject, predicate, object })} · v1.`;
}
export function matchingFacts(facts: Fact[], input: string) {
	const normalized = normalize(input);
	const tokens = new Set(normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? []);
	return facts
		.filter((f) => !f.retired)
		.map((f) => ({
			f,
			score:
				(normalized.includes(normalize(f.key)) ? 10 : 0) +
				(normalize(`${f.key} ${f.value}`).match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(
					(t) => tokens.has(t) && !stopwords.has(t),
				).length,
		}))
		.filter((r) => r.score)
		.sort((a, b) => b.score - a.score)
		.map((r) => r.f)
		.slice(0, 8);
}
export function createFleetRecall(path: string, live: FleetMemorySource, origin?: string) {
	const repo = createMemoryRepository(path, live);
	const getState = (project: string) => repo.readState<State>(project) ?? initial();
	const facts = (project: string) => getState(project).facts.filter((f) => !f.retired);
	const relations = (project: string) => (getState(project).relations ?? []).filter((r) => !r.retired);
	return {
		close: repo.close,
		source: repo.source,
		capture: repo.capture,
		facts,
		relations,
		profile: (project: string) => getState(project).profile,
		context(project: string, input: string) {
			const state = getState(project);
			const savedFacts = matchingFacts(state.facts, input)
				.slice(0, 4)
				.map(({ key, value, version, chatId }) => ({ key, value, version, chatId }));
			const savedRelations = matchingRelations(state.relations ?? [], input).slice(0, 4);
			if (!savedFacts.length && !savedRelations.length) return "";
			const data = { facts: savedFacts, relations: savedRelations };
			while (JSON.stringify(data).length > 7000) {
				if (savedFacts.length >= savedRelations.length) savedFacts.pop();
				else savedRelations.pop();
			}
			return `Owner-confirmed project facts and relations, provided as reference data:\n${JSON.stringify(data)}`;
		},
		reply(project: string, chatId: string, input: string): string | undefined {
			if (!isFleetMemoryCommand(input)) return;
			const arg = input
				.trim()
				.replace(/^\/?memory\s*/i, "")
				.trim();
			const verb = arg.split(/\s+/)[0]?.toLowerCase();
			const rest = arg.slice(verb.length).trim();
			if (verb === "status") {
				const s = getState(project);
				return (
					"Project memory · " +
					project +
					"\nProfile: " +
					s.profile +
					" · " +
					s.examples.length +
					" examples · " +
					s.trials.length +
					" trials · " +
					s.facts.filter((f) => !f.retired).length +
					" active facts · " +
					(s.relations ?? []).filter((r) => !r.retired).length +
					" active relations.\n" +
					feedbackStatus(s)
				);
			}
			if (["save", "forget", "link", "unlink", "feedback", "tune", "promote", "revert"].includes(verb))
				return repo.updateState(project, initial, (state) => {
					if (verb === "link" || verb === "unlink") return updateRelation(state, verb, rest, chatId);
					if (verb === "save") {
						const m = /^([^=\n]{1,100})\s*=\s*([\s\S]{1,1000})$/.exec(rest);
						if (!m?.[1].trim() || !m[2].trim())
							return "Use memory save KEY = VALUE (up to 100 characters for the key and 1000 for the value).";
						const key = normalize(m[1]),
							value = m[2].trim();
						let f = state.facts.find((f) => normalize(f.key) === key);
						if (!f) {
							if (state.facts.length >= 512) return "Project fact capacity reached.";
							f = { key, value, chatId, version: 1 };
							state.facts.push(f);
						} else if (f.retired || f.value !== value) {
							f.value = value;
							f.version++;
							f.chatId = chatId;
							delete f.retired;
						}
						return `Saved ${f.key} · v${f.version}.`;
					}
					if (verb === "forget") {
						const f = state.facts.find((f) => normalize(f.key) === normalize(rest));
						if (!f || f.retired) return "No active fact with that key.";
						f.retired = true;
						f.version++;
						return `Retired ${f.key}.`;
					}
					if (verb === "tune") return evaluateRecall(state, project, chatId, () => repo.source(project));
					if (verb === "promote") return promoteRecall(state, project, chatId, rest, () => repo.source(project));
					if (verb === "revert") {
						const last = state.trials.findLast((t) => t.outcome === "promoted" || t.outcome === "reverted");
						if (last?.outcome !== "promoted") return "No active promotion to revert.";
						state.profile = last.previous;
						state.lastTrial = state.revision;
						state.trials.push({
							...last,
							previous: last.next,
							next: last.previous,
							outcome: "reverted",
							at: Date.now(),
						});
						return `Restored ${state.profile}.`;
					}
					const job = live.get(chatId);
					if (
						!job ||
						job.project !== project ||
						!fleetPassages(job).passages.some(
							(p) => p.kind === "assistant" || p.kind === "message" || p.kind === "artifact",
						)
					)
						return "Open the source chat and add feedback there.";
					if (rest.length < 3 || rest.length > 256)
						return "Use memory feedback followed by a question between 3 and 256 characters.";
					const present = state.examples.find((e) => normalize(e.query) === normalize(rest));
					if (present?.chatId === chatId) return "Feedback already recorded.";
					if (present) return "That question already has a source. Use a distinct question.";
					return addFeedback(state, chatId, rest);
				});
			if (!arg || verb === "help")
				return "Project memory: search with memory QUERY; save KEY = VALUE; forget KEY; link or unlink SUBJECT | RELATION | OBJECT; feedback QUESTION (in its source chat); status; tune; promote TRIAL_ID; revert.";
			const state = getState(project);
			const cite = (label: string, entry: { version: number; chatId: string }) =>
				`${label} (v${entry.version})\n${origin ?? ""}/#chat=${encodeURIComponent(entry.chatId)}`;
			const found = matchingFacts(state.facts, arg).map((f) => cite(`${f.key} = ${f.value}`, f));
			for (const edge of matchingRelations(state.relations ?? [], arg)) found.push(cite(describeRelation(edge), edge));
			const answer = fleetMemoryReply(repo.source(project), project, input, origin, state.profile);
			if (answer) found.push(answer);
			return found.join("\n\n");
		},
	};
}
