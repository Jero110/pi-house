export type Profile = {
	id: string;
	provider: string;
	source: string;
	target: string;
	account: string;
	billing: string;
	threshold: number;
	headroom: number;
};
type ModelInfo = { provider: string; id: string; api: string; input: readonly string[]; contextWindow: number };
type Usage = { tokens: number | null; contextWindow: number };
type Input = {
	profile?: Profile;
	source?: ModelInfo;
	target?: ModelInfo;
	usage?: Usage;
	available: boolean;
	attempted: boolean;
};
export type Assessment = { status: "disabled" | "below" | "paused" | "pending"; reason: string };

export function parseProfile(value: unknown): Profile | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const p: unknown = JSON.parse(value);
		if (!p || typeof p !== "object") return undefined;
		const v = p as Record<string, unknown>;
		if (
			!["id", "provider", "source", "target", "account", "billing"].every(
				(key) => typeof v[key] === "string" && (v[key] as string).trim().length > 0,
			)
		)
			return undefined;
		if (
			typeof v.threshold !== "number" ||
			!Number.isFinite(v.threshold) ||
			v.threshold <= 0 ||
			v.threshold > 1 ||
			typeof v.headroom !== "number" ||
			!Number.isSafeInteger(v.headroom) ||
			v.headroom < 0
		)
			return undefined;
		return v as Profile;
	} catch {
		return undefined;
	}
}

export function assess({ profile, source, target, usage, available, attempted }: Input): Assessment {
	if (!profile) return { status: "disabled", reason: "no explicit profile" };
	if (!parseProfile(JSON.stringify(profile))) return { status: "paused", reason: "invalid profile" };
	if (attempted) return { status: "paused", reason: "session attempt already used" };
	if (!source || source.provider !== profile.provider || source.id !== profile.source)
		return { status: "paused", reason: "source model changed" };
	if (
		!usage ||
		usage.tokens === null ||
		!Number.isFinite(usage.tokens) ||
		usage.tokens < 0 ||
		usage.contextWindow !== source.contextWindow ||
		!Number.isFinite(source.contextWindow) ||
		source.contextWindow <= 0
	)
		return { status: "paused", reason: "usage unknown or stale" };
	if (usage.tokens / usage.contextWindow < profile.threshold) return { status: "below", reason: "below threshold" };
	if (
		!target ||
		target.provider !== profile.provider ||
		target.id !== profile.target ||
		target.api !== source.api ||
		!source.input.every((kind) => target.input.includes(kind))
	)
		return { status: "paused", reason: "target incompatible" };
	if (
		!Number.isFinite(target.contextWindow) ||
		target.contextWindow <= source.contextWindow ||
		target.contextWindow - usage.tokens < profile.headroom
	)
		return { status: "paused", reason: "target lacks context headroom" };
	if (!available) return { status: "paused", reason: "target not locally available" };
	return { status: "pending", reason: "context pressure" };
}
