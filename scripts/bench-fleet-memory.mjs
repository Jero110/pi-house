// An isolated process measures both Git evidence lookup and retrieval. Fixture generation is outside the timing window.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = "synthetic-fleet",
	count = 10_000;
const targets = { coldMs: 2000, warmP95Ms: 250, rssIncreaseMiB: 256 };
const live = { list: () => [], get: () => undefined };
const sourceDir =
	process.env.FLEET_BENCH_MODULES || fileURLToPath(new URL("../packages/pihouse/src/", import.meta.url));
const { createMemoryRepository } = await import(pathToFileURL(join(sourceDir, "fleet-memory-repo.ts")));
const { searchFleetMemory } = await import(pathToFileURL(join(sourceDir, "fleet-memory.ts")));

function seed(dir) {
	if (existsSync(dir) && readdirSync(dir).length)
		throw new Error("The synthetic benchmark requires a new or empty directory.");
	createMemoryRepository(dir, live).close?.();
	const input = [];
	for (let i = 0; i < count; i++) {
		const id = `sample-${i}`,
			ticket = `ticket${i}`,
			topic = ["snapshot retention", "battery telemetry", "image pipeline", "network recovery", "release validation"][
				i % 5
			];
		const title = `Investigate ${topic} for operation ${i}`;
		const job = {
			id,
			project,
			title,
			agent: "codex",
			status: "completed",
			updatedAt: 1710000000000 + i,
			sourceHost: "Synthetic mini",
			messages: [
				{
					role: "user",
					at: 1710000000000 + i,
					text: `Review ${topic} for the simulated cohort and document the observed threshold for ${ticket}. Use the captured run as evidence; we need a reversible change before the next inspection.`,
				},
				{
					role: "assistant",
					kind: "plan",
					actor: "Synthetic planner · Planner",
					text: `Compare the current deployment configuration, the last two batch reports and the retry window before publishing the ${topic} findings.`,
				},
				{
					role: "assistant",
					actor: "Synthetic mini · Codex",
					text: `Synthetic observation ${ticket}: the maintenance batch used ${i % 107} workers across ${(i % 19) + 1} segments. We retained the verified manifest and recorded the audit trail for the next checkpoint. The rollout decision depends on the observed packet recovery and the integrity of each stored record.\n\nCheck the saved inspection file for the measured input and the follow-up schedule.`,
				},
			],
			events: [{ type: "finished", at: 1710000000000 + i, text: "Synthetic mini · Codex · Completed." }],
			artifacts: [{ id: `artifact-${i}`, name: `inspection-${i}.txt`, type: "text", size: 500 + (i % 400) }],
		};
		const json = JSON.stringify(job);
		const ref = createHash("sha256").update(id).digest("hex");
		input.push(
			`commit refs/heads/threads/${project}/${ref}\ncommitter Synthetic <bench@example.invalid> 1710000000 +0000\ndata 17\nSynthetic fixture\nM 100644 inline thread.json\ndata ${Buffer.byteLength(json)}\n${json}\n\n`,
		);
	}
	execFileSync("git", ["--git-dir", dir, "fast-import", "--quiet"], { input: input.join(""), maxBuffer: 1024 * 1024 });
	execFileSync("git", ["--git-dir", dir, "pack-refs", "--all"]);
}
function measure(dir) {
	const rssBefore = process.resourceUsage().maxRSS;
	const start = performance.now();
	const repo = createMemoryRepository(dir, live);
	function search(query) {
		return searchFleetMemory(repo.source(project), project, query).hits;
	}
	assert.equal(search("ticket9999")[0]?.chatId, "sample-9999");
	const coldMs = performance.now() - start;
	console.log(JSON.stringify({ coldMs }));
	const queries = Array.from(
		{ length: 20 },
		(_, i) =>
			[`ticket${i * 419}`, "battery telemetry", "packet recovery", `inspection-${i * 131}.txt`, "absent-rare-token"][
				i % 5
			],
	);
	const times = [];
	for (const query of queries) {
		const t = performance.now();
		const hits = search(query);
		times.push(performance.now() - t);
		if (query.startsWith("ticket")) assert.equal(hits[0]?.chatId, `sample-${query.slice(6)}`);
		else if (query.startsWith("inspection-"))
			assert.equal(hits[0]?.artifactId, query.replace("inspection-", "artifact-").replace(".txt", ""));
		else if (query === "absent-rare-token") assert.equal(hits.length, 0);
		else assert.equal(hits.length, 8);
	}
	repo.close?.();
	const ordered = times.sort((a, b) => a - b);
	const warmP95Ms = ordered[Math.ceil(ordered.length * 0.95) - 1],
		rssIncreaseMiB = (process.resourceUsage().maxRSS - rssBefore) / 1024;
	const pass = coldMs < targets.coldMs && warmP95Ms < targets.warmP95Ms && rssIncreaseMiB < targets.rssIncreaseMiB;
	if (!pass) process.exitCode = 1;
	console.log(
		JSON.stringify({
			threads: count,
			queries: queries.length,
			coldMs,
			warmP95Ms,
			rssIncreaseMiB,
			targets,
			pass,
		}),
	);
}
if (process.argv[2] === "measure") {
	measure(resolve(process.argv[3]));
} else if (process.argv[2] === "seed") {
	seed(resolve(process.argv[3]));
} else {
	const dir = mkdtempSync(join(realpathSync(tmpdir()), "pih-10k-"));
	try {
		seed(dir);
		execFileSync(process.execPath, [process.argv[1], "measure", dir], { stdio: "inherit", timeout: 120000 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
