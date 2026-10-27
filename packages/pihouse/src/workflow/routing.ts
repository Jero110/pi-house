export type Candidate = {
	harness: string;
	provider: string;
	model: string;
	account: string;
	billing: string;
	capabilities: string[];
};
export type Profile = {
	id: string;
	purpose: string;
	requiredCapabilities: string[];
	allowedBilling: string[];
	candidates: Candidate[];
};
export type Observation = {
	provider: string;
	account: string;
	state: "available" | "exhausted" | "unknown" | "auth" | "network" | "rate";
	observedAt: number;
	source: string;
	resetAt?: number;
	/** The usage windows the observation saw, the same shape for every source (see account-usage.ts). */
	windows?: { label: string; percent: number; resetsAt?: number }[];
};
export type Failure = { provider: string; account: string; kind: "exhausted" | "auth" | "network" | "rate" };
type Resolution = { candidate: Candidate; credentials: boolean; modelAvailable: boolean };
type Reason = { candidate: Candidate; reason: string };
type Input = {
	profile: Profile;
	resolved: Resolution[];
	observations: Observation[];
	now: number;
	maxAgeMs: number;
	failures?: Failure[];
	checkpoint?: string;
};
export type RoutingResult =
	| {
			status: "selected";
			profile: string;
			candidate: Candidate;
			reason: string;
			observation: Observation;
			ageMs: number;
	  }
	| { status: "paused"; profile: string; checkpoint?: string; reasons: Reason[] };

function sameCandidate(a: Candidate, b: Candidate): boolean {
	return (
		a.harness === b.harness &&
		a.provider === b.provider &&
		a.model === b.model &&
		a.account === b.account &&
		a.billing === b.billing
	);
}

export function route(input: Input): RoutingResult {
	const { profile, now, maxAgeMs } = input;
	const reasons: Reason[] = [];
	for (const candidate of profile.candidates) {
		let reason: string | undefined;
		const resolution = input.resolved.find((item) => sameCandidate(item.candidate, candidate));
		if (
			![
				profile.id,
				profile.purpose,
				candidate.harness,
				candidate.provider,
				candidate.model,
				candidate.account,
				candidate.billing,
			].every((value) => value.trim())
		)
			reason = "invalid-profile";
		else if (!profile.allowedBilling.includes(candidate.billing)) reason = "billing-not-authorized";
		else if (!profile.requiredCapabilities.every((capability) => candidate.capabilities.includes(capability)))
			reason = "incompatible";
		// The model must exist before its credentials mean anything: an unknown model has no key to check.
		else if (!resolution?.modelAvailable) reason = "model-unavailable";
		else if (!resolution.credentials) reason = "credentials-unavailable";
		if (reason) {
			reasons.push({ candidate, reason });
			continue;
		}
		// Quota and failures belong to the account: two providers behind one login (openai-codex and azure on
		// "openai") share one usage window, so matching on the provider too would leave the candidate unknown.
		const failure = input.failures?.find((item) => item.account === candidate.account);
		const observation = input.observations
			.filter((item) => item.account === candidate.account)
			.sort((a, b) => b.observedAt - a.observedAt)[0];
		const age = observation ? now - observation.observedAt : NaN;
		reason =
			failure?.kind ??
			(!observation
				? "unknown"
				: !Number.isFinite(age) || age < 0 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || age > maxAgeMs
					? "stale"
					: observation.state);
		if (reason === "available" && observation)
			return {
				status: "selected",
				profile: profile.id,
				candidate,
				reason: reasons.length ? "authorized alternative" : "available",
				observation,
				ageMs: age,
			};
		reasons.push({ candidate, reason });
		// A transient failure is not permission to abandon the configured account.
		// For example, a network outage may affect every provider; pause rather than spend elsewhere.
		if (reason !== "exhausted") break;
	}
	return { status: "paused", profile: profile.id, checkpoint: input.checkpoint, reasons };
}

type PollEntry = { failures: number; nextAt: number; pending?: Promise<PollResult> };
export type PollState = Map<string, PollEntry>;
export type PollResult = { status: "observed"; observation: Observation } | { status: "backoff"; retryAt: number };
/** Accounts kept in one PollState. The oldest idle entry goes first, so the state cannot grow with every account seen. */
export const MAX_POLL_ACCOUNTS = 64;

// The caller shares this state across consumers; no model call is made by this policy.
// Problem: every caller that asked for usage hit the endpoint again, and a refused login was retried on each call.
// Example: two status bar redraws in the same second must share one request; a 401 must wait out its backoff.
// Solution: one in-flight request per account (its promise is shared), and a backoff that grows only on failures.
// An exhausted answer is a successful answer: the endpoint worked, the account is simply full.
export function pollAccount(
	state: PollState,
	provider: string,
	account: string,
	now: number,
	fetch: () => Promise<Observation>,
): Promise<PollResult> {
	const key = JSON.stringify([provider, account]);
	const known = state.get(key);
	if (!known && state.size >= MAX_POLL_ACCOUNTS) {
		const idle = [...state.keys()].find((k) => !state.get(k)?.pending);
		if (idle !== undefined) state.delete(idle);
	}
	const entry = known ?? { failures: 0, nextAt: 0 };
	state.set(key, entry);
	if (entry.pending) return entry.pending;
	if (now < entry.nextAt) return Promise.resolve({ status: "backoff", retryAt: entry.nextAt });
	const pending = Promise.resolve()
		.then(fetch)
		.then((observation) => {
			if (observation.provider !== provider || observation.account !== account)
				throw new Error("Observation account mismatch");
			return observation;
		})
		.catch((): Observation => ({ provider, account, state: "network", observedAt: now, source: "poll-error" }))
		.then((observation) => {
			const answered = observation.state === "available" || observation.state === "exhausted";
			entry.failures = answered ? 0 : Math.min(entry.failures + 1, 6);
			entry.nextAt = now + (entry.failures ? Math.min(60_000, 1_000 * 2 ** (entry.failures - 1)) : 1_000);
			delete entry.pending;
			return { status: "observed", observation } as const;
		});
	entry.pending = pending;
	return pending;
}
