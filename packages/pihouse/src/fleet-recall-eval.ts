import { randomUUID } from "node:crypto";
import {
	FLEET_RETRIEVAL_REVISION,
	type FleetMemoryProfile,
	type FleetMemorySource,
	searchFleetMemory,
} from "./fleet-memory.ts";

const protocol = "thread-holdout-v1";
export const maxFeedback = 96;
export type RecallExample = { query: string; chatId: string; holdout: boolean; protocol?: string };
type Comparison = { total: number; incumbent: number; candidate: number };
type RecallTrial = {
	previous: FleetMemoryProfile;
	next: FleetMemoryProfile;
	outcome: string;
	examples: number;
	at: number;
	train: number;
	heldout: number;
	incumbent?: FleetMemoryProfile;
	candidate?: FleetMemoryProfile;
	training?: Comparison;
	holdout?: Comparison;
	id?: string;
	protocol?: string;
	revision?: number;
	evidence?: string;
	retrievalRevision?: string;
	trainingThreads?: string[];
	holdoutThreads?: string[];
	evaluatedIn?: string;
	approvedIn?: string;
	approvedAt?: number;
	holdoutCases?: { query: string; chatId: string; incumbentHit: boolean; candidateHit: boolean }[];
};
export interface RecallEvaluation {
	profile: FleetMemoryProfile;
	examples: RecallExample[];
	trials: RecallTrial[];
	revision: number;
	lastTrial: number;
}

function split(state: RecallEvaluation) {
	const spent = new Set(state.trials.flatMap((t) => t.holdoutThreads ?? []));
	const reserved = new Set(state.examples.filter((e) => e.holdout).map((e) => e.chatId));
	// Old trials did not record which threads were exposed. Conservatively quarantine every legacy holdout.
	for (const e of state.examples) if (e.holdout && e.protocol !== protocol) spent.add(e.chatId);
	return {
		train: state.examples.filter((e) => !reserved.has(e.chatId)),
		holdout: state.examples.filter((e) => reserved.has(e.chatId) && !spent.has(e.chatId)),
		spent,
	};
}
const threads = (examples: RecallExample[]) => [...new Set(examples.map((e) => e.chatId))];
export function feedbackStatus(state: RecallEvaluation) {
	const { train, holdout } = split(state);
	const last = state.trials.at(-1);
	const pending =
		last?.outcome === "eligible" && last.revision === state.revision
			? ` · pending owner decision: memory promote ${last.id}`
			: "";
	return `Manual evaluation · ${threads(train).length} training threads · ${threads(holdout).length} fresh holdout threads · ${state.examples.length}/${maxFeedback} feedback slots${pending}.`;
}
export function addFeedback(state: RecallEvaluation, chatId: string, query: string) {
	const existing = state.examples.find((e) => e.chatId === chatId);
	if (split(state).spent.has(chatId))
		return "This holdout thread has already been exposed. Add feedback in a fresh source thread.";
	if (state.examples.length >= maxFeedback)
		return `Evaluation capacity reached (${maxFeedback} examples). Existing labels were retained.`;
	const holdout = existing?.holdout ?? threads(state.examples).length % 3 === 2;
	state.examples.push({ query, chatId, holdout, protocol });
	state.revision++;
	return `Feedback recorded for ${holdout ? "holdout" : "training"}. Run memory tune to evaluate.`;
}

function scores(source: FleetMemorySource, project: string, profile: FleetMemoryProfile, examples: RecallExample[]) {
	return examples.map((e) => searchFleetMemory(source, project, e.query, profile).hits[0]?.chatId === e.chatId);
}
const correct = (scores: boolean[]) => scores.filter(Boolean).length;
export function evaluateRecall(
	state: RecallEvaluation,
	project: string,
	chatId: string,
	getSource: () => FleetMemorySource,
) {
	const { train, holdout } = split(state);
	const trainingThreads = threads(train);
	const holdoutThreads = threads(holdout);
	if (trainingThreads.length < 4 || holdoutThreads.length < 2)
		return `Evaluation requires four independent training threads and two fresh holdout threads. ${feedbackStatus(state)}`;
	const source = getSource();
	const evidence = source.evidenceDigest?.(project);
	if (!evidence) return "A verified project evidence snapshot is required for a trial.";
	const incumbent = state.profile;
	const baseTrain = correct(scores(source, project, incumbent, train));
	const candidates = (["balanced", "title", "evidence"] as const)
		.filter((p) => p !== incumbent)
		.map((p) => ({ profile: p, score: correct(scores(source, project, p, train)) }))
		.sort((a, b) => b.score - a.score);
	const { profile: candidate, score: trainBest } = candidates[0];
	const before = scores(source, project, incumbent, holdout);
	const after = scores(source, project, candidate, holdout);
	const training = { total: train.length, incumbent: baseTrain, candidate: trainBest };
	const comparison = { total: holdout.length, incumbent: correct(before), candidate: correct(after) };
	const eligible =
		trainBest > baseTrain && comparison.candidate > comparison.incumbent && before.every((hit, i) => !hit || after[i]);
	const id = randomUUID();
	state.trials.push({
		id,
		protocol,
		revision: state.revision,
		evidence,
		evaluatedIn: chatId,
		holdoutCases: holdout.map(({ query, chatId }, i) => ({
			query,
			chatId,
			incumbentHit: before[i],
			candidateHit: after[i],
		})),
		retrievalRevision: FLEET_RETRIEVAL_REVISION,
		trainingThreads,
		holdoutThreads,
		previous: incumbent,
		next: incumbent,
		outcome: eligible ? "eligible" : "retained",
		examples: state.examples.length,
		at: Date.now(),
		train: Math.max(baseTrain, trainBest),
		heldout: trainBest > baseTrain ? comparison.candidate : comparison.incumbent,
		incumbent,
		candidate,
		training,
		holdout: comparison,
	});
	state.lastTrial = state.revision;
	return `Trial ${id}. Active profile: ${incumbent}. Training (${trainingThreads.length} threads): ${incumbent} ${baseTrain}/${train.length}, ${candidate} ${trainBest}/${train.length}. Held out (${holdoutThreads.length} fresh threads): ${incumbent} ${comparison.incumbent}/${holdout.length}, ${candidate} ${comparison.candidate}/${holdout.length}. ${eligible ? `To apply this result, send memory promote ${id}.` : "The incumbent was retained."}`;
}
export function promoteRecall(
	state: RecallEvaluation,
	project: string,
	chatId: string,
	id: string,
	getSource: () => FleetMemorySource,
) {
	const trial = state.trials.at(-1);
	if (!id || !trial?.id || trial.id !== id || trial.protocol !== protocol)
		return "Use the exact ID of the latest eligible manual trial.";
	if (trial.outcome === "promoted" && state.profile === trial.candidate) return `Already promoted ${state.profile}.`;
	if (trial.outcome !== "eligible" || !trial.candidate) return "This trial is ineligible for promotion.";
	if (
		trial.revision !== state.revision ||
		trial.incumbent !== state.profile ||
		!trial.evidence ||
		trial.retrievalRevision !== FLEET_RETRIEVAL_REVISION ||
		trial.evidence !== getSource().evidenceDigest?.(project)
	)
		return "Project feedback, evidence or active profile changed. Run a new trial with fresh holdout threads.";
	state.profile = trial.candidate;
	trial.outcome = "promoted";
	trial.approvedIn = chatId;
	trial.approvedAt = Date.now();
	trial.next = state.profile;
	return `Promoted ${state.profile} from trial ${id}.`;
}
