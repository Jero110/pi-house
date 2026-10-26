// Which skills a message loaded. Harnesses load skills in different ways, so every way is checked:
// - a read of `<skill>/SKILL.md` (pi, pihouse, Codex, opencode, and any harness told a skill's path);
// - a skill tool call (Claude's Skill, opencode's skill);
// - a typed `/skill:<name>` (pi, pihouse), or the body Claude injects after `/<skill>` ("Base directory for this
//   skill: <dir>").

const SKILL_FILE = /(?:^|[/"'\s])([a-z0-9][a-z0-9-]{1,63})\/SKILL\.md\b/g;
const SLASH_SKILL = /(?:^|\s)\/skill:([a-z0-9][a-z0-9-]*)/g;
const CLAUDE_BODY = /^Base directory for this skill:\s*\S*?([A-Za-z0-9._-]+)\/?\s*$/m;
const PI_SKILL_BLOCK = /<skill name="([a-z0-9-]+)"/g;

/** Skill names as the Agent Skills spec allows them; anything else (a shell variable, a path piece) is noise. */
const VALID = /^[a-z0-9][a-z0-9-]{1,63}$/;

function unique(names: Iterable<string>): string[] {
	return [...new Set(names)].filter((n) => VALID.test(n));
}

export function skillsInText(text: string): string[] {
	const found: string[] = [];
	for (const m of text.matchAll(SLASH_SKILL)) if (m[1]) found.push(m[1]);
	for (const m of text.matchAll(PI_SKILL_BLOCK)) if (m[1]) found.push(m[1]);
	const body = CLAUDE_BODY.exec(text);
	if (body?.[1]) found.push(body[1]);
	return unique(found);
}

export function skillsInToolCall(tool: string, input: unknown): string[] {
	const found: string[] = [];
	if (/^skill$/i.test(tool) && typeof input === "object" && input !== null) {
		const o = input as Record<string, unknown>;
		const name = o.skill ?? o.name ?? o.command;
		if (typeof name === "string") found.push(name.replace(/^\//, "").split(/\s/)[0] ?? "");
	}
	const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
	for (const m of text.matchAll(SKILL_FILE)) if (m[1]) found.push(m[1]);
	return unique(found);
}
