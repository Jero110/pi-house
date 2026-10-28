// A saved startup model is a preference, not proof that its subscription can still run. This selector only
// compares exact, authenticated subscription models against account observations; it never falls back to API billing.
export type StartupUsageState = "available" | "exhausted" | "unknown";

export interface StartupModelCandidate<TModel = unknown> {
	provider: string;
	id: string;
	account: string;
	state: StartupUsageState;
	authenticated: boolean;
	model?: TModel;
}

export interface StartupModelPreference {
	provider: string;
	id: string;
}

export interface StartupModelChoice<TModel = unknown> {
	model: StartupModelCandidate<TModel>;
	uncertain: boolean;
}

/** Keep a usable preference; otherwise prefer known room, then an authenticated unknown with explicit uncertainty. */
export function chooseStartupModel<TModel>(
	candidates: readonly StartupModelCandidate<TModel>[],
	preference: StartupModelPreference | undefined,
): StartupModelChoice<TModel> | undefined {
	const authenticated = candidates.filter((candidate) => candidate.authenticated && candidate.model);
	const preferred = preference
		? authenticated.find((candidate) => candidate.provider === preference.provider && candidate.id === preference.id)
		: undefined;
	if (preferred?.state === "available") return { model: preferred, uncertain: false };
	const available = authenticated.find((candidate) => candidate.state === "available");
	if (available) return { model: available, uncertain: false };
	const uncertain =
		preferred?.state === "unknown" ? preferred : authenticated.find((candidate) => candidate.state === "unknown");
	return uncertain ? { model: uncertain, uncertain: true } : undefined;
}

/** CLI model selection is explicit even when pi's fuzzy resolver has not settled on its exact provider yet. */
export function hasExplicitModelArgument(argv: readonly string[]): boolean {
	return argv.some((arg, index) => (arg === "--model" && index + 1 < argv.length) || arg.startsWith("--model="));
}
