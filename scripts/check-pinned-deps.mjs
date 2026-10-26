// Fails if any dependency in the repo is not pinned to an exact version.
import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const files = ["package.json", ...root.workspaces.map((w) => `${w}/package.json`)];
const exact = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const problems = [];

for (const file of files) {
	const pkg = JSON.parse(readFileSync(file, "utf8"));
	for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [name, range] of Object.entries(pkg[field] ?? {})) {
			if (!exact.test(range)) problems.push(`${file}: ${field}.${name} = "${range}"`);
		}
	}
}

if (problems.length) {
	console.error(`Dependencies must be pinned to exact versions:\n  ${problems.join("\n  ")}`);
	process.exit(1);
}
