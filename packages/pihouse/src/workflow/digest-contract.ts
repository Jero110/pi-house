export const DIGEST_SECTIONS = [
	"objective",
	"participants",
	"decisions",
	"failures",
	"validations",
	"artifacts",
	"limitations",
	"candidates",
] as const;
export const DEFAULT_DIGEST_MAX_CHARS = 12_000;

export type DigestIdentity = { runId: string; project: string; revision: string };
export type DigestArtifact = DigestIdentity & {
	schemaVersion: 1;
	sections: Record<(typeof DIGEST_SECTIONS)[number], string>;
};
export type DigestValidation = { ok: true; artifact: DigestArtifact } | { ok: false; reason: string };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate technical completeness only; callers must separately verify persistence and evidence stability. */
export function validateDigest(
	text: string,
	expected: DigestIdentity,
	finish: string,
	maxChars = DEFAULT_DIGEST_MAX_CHARS,
): DigestValidation {
	if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || text.length > maxChars)
		return { ok: false, reason: "output bound exceeded or invalid" };
	if (finish !== "stop") return { ok: false, reason: "generation did not finish normally" };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, reason: "invalid JSON" };
	}
	if (
		!record(value) ||
		value.schemaVersion !== 1 ||
		!["runId", "project", "revision"].every(
			(key) =>
				typeof value[key] === "string" && value[key] !== "" && value[key] === expected[key as keyof DigestIdentity],
		)
	) {
		return { ok: false, reason: "invalid schema or identity" };
	}
	const sections = value.sections;
	if (
		!record(sections) ||
		!DIGEST_SECTIONS.every((key) => typeof sections[key] === "string" && sections[key].trim().length > 0)
	) {
		return { ok: false, reason: "missing required section" };
	}
	return { ok: true, artifact: value as DigestArtifact };
}
