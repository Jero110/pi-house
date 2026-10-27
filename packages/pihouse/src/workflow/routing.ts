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
	windows?: { name: string; remaining?: number; used?: number }[];
};
type Failure = { provider: string; account: string; kind: "exhausted" | "auth" | "network" | "rate" };
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
		else if (!resolution?.credentials) reason = "credentials-unavailable";
		else if (!resolution.modelAvailable) reason = "model-unavailable";
		if (reason) {
			reasons.push({ candidate, reason });
			continue;
		}
		const failure = input.failures?.find(
			(item) => item.provider === candidate.provider && item.account === candidate.account,
		);
		const observation = input.observations
			.filter((item) => item.provider === candidate.provider && item.account === candidate.account)
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

// The caller shares this state across consumers; no model call is made by this policy.
export function pollAccount(
	state: PollState,
	provider: string,
	account: string,
	now: number,
	fetch: () => Promise<Observation>,
): Promise<PollResult> {
	const key = JSON.stringify([provider, account]);
	const entry = state.get(key) ?? { failures: 0, nextAt: 0 };
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
			entry.failures = observation.state === "available" ? 0 : Math.min(entry.failures + 1, 6);
			entry.nextAt = now + (entry.failures ? Math.min(60_000, 1_000 * 2 ** (entry.failures - 1)) : 1_000);
			delete entry.pending;
			return { status: "observed", observation } as const;
		});
	entry.pending = pending;
	return pending;
}
