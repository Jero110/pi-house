// `npm run skills`: keeps skills/ consistent after adding or updating a skill.
// - Third-party skills get `disable-model-invocation: true` (pihouse loads them only when a plan or the user names them).
// - skills/README.md is rewritten from skills/catalog.json.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogReadme } from "../packages/pihouse/src/workflow/catalog.ts";

const root = "skills";
const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));
let marked = 0;
for (const skill of catalog.skills) {
	if (skill.author === "pihouse" || skill.external) continue;
	const file = join(root, skill.group, skill.name, "SKILL.md");
	const text = readFileSync(file, "utf8");
	if (/^disable-model-invocation:/m.test(text)) continue;
	writeFileSync(file, text.replace(/^(---\nname: [^\n]+\n)/, "$1disable-model-invocation: true\n"));
	marked++;
}
writeFileSync(join(root, "README.md"), `${catalogReadme(catalog)}\n`);
const groups = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
console.log(
	`skills: ${catalog.skills.length} in the catalog, ${marked} newly marked manual, README rewritten (${groups.join(", ")})`,
);
