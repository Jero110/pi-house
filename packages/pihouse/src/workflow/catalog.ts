// The skills catalog (skills/catalog.json): every skill pihouse ships, its group, author and a one-line summary.
// The planner shows it to the user, /workflow ask answers from it, and a test keeps it in step with the
// SKILL.md files on disk.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_DIR } from "../paths.ts";

export type GroupId = "pre-build" | "build" | "post-build" | "extras";

export interface SkillGroup {
	id: GroupId;
	title: string;
	/** Who uses it and when. */
	purpose: string;
	/** Manual groups never run as part of the workflow; the user invokes them. */
	manual: boolean;
}

export interface CatalogSkill {
	name: string;
	group: GroupId;
	/** "pihouse", "Addy", "Matt Pocock", "Paul Bakaus". */
	author: string;
	/** Where it comes from: a repository path, or "this repository". */
	source: string;
	license: string;
	summary: string;
	/** Installed by its own installer instead of shipped in skills/. */
	external?: { install: string };
	/** For build skills: the planner offers it when the work fits. */
	offerWhen?: string;
}

export interface Catalog {
	groups: SkillGroup[];
	skills: CatalogSkill[];
}

export function readCatalog(dir: string = SKILLS_DIR): Catalog {
	return JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as Catalog;
}

/** Where a shipped skill's SKILL.md is. */
export function skillPath(s: CatalogSkill, dir: string = SKILLS_DIR): string {
	return join(dir, s.group, s.name, "SKILL.md");
}

/** The catalog as Markdown tables, one per group. */
export function catalogMarkdown(c: Catalog, dir: string = SKILLS_DIR): string {
	const out: string[] = [];
	for (const g of c.groups) {
		out.push(`## ${g.title}${g.manual ? " (manual)" : ""}`, "", g.purpose, "");
		out.push("| Skill | Author | Summary | Where |", "| --- | --- | --- | --- |");
		for (const s of c.skills.filter((x) => x.group === g.id))
			out.push(
				`| \`${s.name}\` | ${s.author} | ${s.summary} | ${s.external ? `install: \`${s.external.install}\`` : skillPath(s, dir)} |`,
			);
		out.push("");
	}
	return out.join("\n");
}

/** skills/README.md: the catalog for people, with links relative to the skills folder. */
export function catalogReadme(c: Catalog): string {
	const out: string[] = [
		"# Skills",
		"",
		"pihouse's skills, in four groups. `catalog.json` is the source of this page (`npm run skills` rewrites it); the",
		"planner reads the same file to offer the development skills. Third-party skills keep their licenses: see",
		"[LICENSES](LICENSES/README.md).",
		"",
	];
	for (const g of c.groups) {
		out.push(
			`## ${g.title}${g.manual ? " (manual)" : ""}`,
			"",
			g.purpose,
			"",
			"| Skill | Author | What it does |",
			"| --- | --- | --- |",
		);
		for (const s of c.skills.filter((x) => x.group === g.id)) {
			const link = s.external
				? `[\`${s.name}\`](https://github.com/${s.source})`
				: `[\`${s.name}\`](${s.group}/${s.name}/SKILL.md)`;
			const extra = s.external ? ` Install in a project with \`${s.external.install}\`.` : "";
			out.push(`| ${link} | ${s.author} | ${s.summary}${extra} |`);
		}
		out.push("");
	}
	return out.join("\n");
}
