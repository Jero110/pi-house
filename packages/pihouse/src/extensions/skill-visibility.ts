import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { type ExtensionAPI, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const SKILL_READ_TYPE = "pihouse-skill-read";
type SkillRead = { name: string; toolCallId: string };

function skillName(path: unknown, cwd: string): string | undefined {
	if (typeof path !== "string") return undefined;
	let input = path.startsWith("@") ? path.slice(1) : path;
	if (input === "~" || input.startsWith("~/")) input = homedir() + input.slice(1);
	try {
		const file = realpathSync(resolve(cwd, input));
		if (basename(file) !== "SKILL.md" || !statSync(file).isFile()) return undefined;
		const { frontmatter } = parseFrontmatter(readFileSync(file, "utf8"));
		const name = typeof frontmatter.name === "string" ? frontmatter.name : basename(dirname(file));
		if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) return undefined;
		return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

export default function skillVisibility(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<SkillRead>(SKILL_READ_TYPE, (entry, _options, theme) =>
		entry.data?.name ? new Text(theme.fg("dim", `Read skill: ${entry.data.name}`), 1, 0) : undefined,
	);
	const seen = new Set<string>();
	pi.on("session_start", () => {
		seen.clear();
	});
	pi.on("session_tree", () => {
		seen.clear();
	});
	pi.on("tool_result", (event, ctx) => {
		if (!ctx.hasUI || event.toolName !== "read" || event.isError || seen.has(event.toolCallId)) return;
		const name = skillName(event.input.path, ctx.cwd);
		if (!name) return;
		seen.add(event.toolCallId);
		// A custom entry is visible and persisted without adding a model message or starting another turn.
		pi.appendEntry<SkillRead>(SKILL_READ_TYPE, { name, toolCallId: event.toolCallId });
	});
}
