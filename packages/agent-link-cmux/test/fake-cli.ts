// A fake executable put first on PATH: it records its argv and prints scripted output.
// Responses live in <dir>/r: "<command>.<n>" answers the n-th call of that command, "<command>" every call;
// a ".err" suffix prints the file to stderr and exits 1. The command is the first argument after `skip` ones.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCli {
	dir: string;
	env: NodeJS.ProcessEnv;
	calls(): string[][];
	/** What the n-th (1-based) call of command read on stdin. */
	stdin(command: string, n: number): string;
}

export function fakeCli(name: string, responses: Record<string, string>, skip = 0): FakeCli {
	const dir = mkdtempSync(join(tmpdir(), `xi-fake-${name}-`));
	mkdirSync(join(dir, "r"));
	mkdirSync(join(dir, "bin"));
	for (const [k, v] of Object.entries(responses)) writeFileSync(join(dir, "r", k), v);
	const bin = join(dir, "bin", name);
	const script = `#!/bin/sh
D='${dir}'
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\036'; } >> "$D/log"
shift ${skip}
c="$1"
echo x >> "$D/n-$c"
n=$(wc -l < "$D/n-$c" | tr -d ' ')
if [ "$c" = load-buffer ]; then cat > "$D/stdin-$c-$n"; fi
for f in "$D/r/$c.$n" "$D/r/$c"; do
	if [ -f "$f.err" ]; then cat "$f.err" >&2; exit 1; fi
	if [ -f "$f" ]; then cat "$f"; exit 0; fi
done
exit 0
`;
	writeFileSync(bin, script);
	chmodSync(bin, 0o755);
	return {
		dir,
		env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
		calls: () => {
			const log = join(dir, "log");
			if (!existsSync(log)) return [];
			// A call still being written has no record separator yet: leave it for the next read.
			const text = readFileSync(log, "utf8");
			return text
				.slice(0, text.lastIndexOf("\x1e") + 1)
				.split("\x1e")
				.filter(Boolean)
				.map((l) => l.split("\x1f").slice(0, -1));
		},
		stdin: (command, n) => readFileSync(join(dir, `stdin-${command}-${n}`), "utf8"),
	};
}
