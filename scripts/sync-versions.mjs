// Copies the root version to every workspace package and to internal dependency references.
import { readFileSync, writeFileSync } from "node:fs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const files = root.workspaces.map((w) => `${w}/package.json`);
const pkgs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
const internal = new Set(pkgs.map((p) => p.name));

pkgs.forEach((pkg, i) => {
	pkg.version = root.version;
	for (const field of ["dependencies", "devDependencies"]) {
		for (const name of Object.keys(pkg[field] ?? {})) {
			if (internal.has(name)) pkg[field][name] = root.version;
		}
	}
	writeFileSync(files[i], `${JSON.stringify(pkg, null, "\t")}\n`);
});
console.log(`Synced ${files.length} packages to ${root.version}`);
