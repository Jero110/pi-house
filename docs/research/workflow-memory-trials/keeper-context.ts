// Deterministic context-size prototype; no model, packages, or network.
const runCounts = [1, 5, 20];
const instructions =
	"Keeper: report pending count; digest only on request; read raw packages once; persist digest before marking processed; never delete; propose edits for approval.";
const workflowMemory =
	"## Workflow memory\nPrefer concise plans, explicit file lists, and tests. Keep project-specific conventions separate.";

for (const count of runCounts) {
	const runs = Array.from({ length: count }, (_, i) => ({
		id: `run-${String(i + 1).padStart(2, "0")}`,
		title: `Fake workflow task ${i + 1}`,
		transcript:
			`User requested task ${i + 1}. Agent inspected files, made a focused change, ran checks, and reported outcome. `.repeat(
				2,
			),
	}));
	const indexSlice = runs
		.slice(-20)
		.map(({ id, title }) => `- ${id}: ${title}`)
		.join("\n");
	const pendingCount = runs.length;
	const bootstrap = `${instructions}\n\n${workflowMemory}\n\n## Index\n${indexSlice}\n\nPending runs: ${pendingCount}`;
	const digestContext = `${instructions}\n\n## Batch (${pendingCount})\n${runs.map(({ id, transcript }) => `### ${id}\n${transcript}`).join("\n")}`;
	console.log(
		JSON.stringify({
			runs: count,
			bootstrapChars: bootstrap.length,
			bootstrapCharsDiv4: (bootstrap.length / 4).toFixed(2),
			digestChars: digestContext.length,
			digestCharsDiv4: (digestContext.length / 4).toFixed(2),
		}),
	);
}
