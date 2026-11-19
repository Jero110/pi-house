import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createExecutorReplay } from "../src/workflow/executor-replay.ts";

test("executor replay uses the configured pi model and sees only simulated tools and fresh fixture context", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pihouse-replay-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const requests: unknown[] = [];
	const server = createServer(async (req, res) => {
		const body: string[] = [];
		for await (const chunk of req) body.push(String(chunk));
		requests.push(JSON.parse(body.join("")));
		const invocation = requests.length;
		const changed = invocation > 3;
		const turn = changed ? invocation - 3 : invocation;
		const tool = (index: number, name: string, args: object) => ({
			index,
			id: `call_${invocation}_${index}`,
			type: "function",
			function: { name, arguments: JSON.stringify(args) },
		});
		const validation = tool(0, "run_validation", { command: "npm test" });
		const report = tool(changed ? 1 : 0, "record_result", { status: "fail" });
		const toolCalls =
			turn === 1 ? (changed ? [validation, report] : [validation]) : turn === 2 && !changed ? [report] : [];
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = {
			id: `response-${invocation}`,
			object: "chat.completion.chunk",
			created: 1,
			model: "fixture-model",
			choices: [
				{
					index: 0,
					delta: { role: "assistant", ...(toolCalls.length ? { tool_calls: toolCalls } : { content: "Done." }) },
					finish_reason: toolCalls.length ? "tool_calls" : "stop",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
		};
		res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const modelsPath = join(root, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
					apiKey: "fixture-key",
					api: "openai-completions",
					models: [{ id: "fixture-model" }],
				},
			},
		}),
	);
	const runtime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath,
		modelsStorePath: join(root, "models-store.json"),
		refreshOnCreate: false,
	});
	const modelRegistry = new ModelRegistry(runtime);
	const model = modelRegistry.find("fixture", "fixture-model");
	assert.ok(model);
	const replay = createExecutorReplay({ modelRegistry, model });
	const task = { id: "worker-pass-check-fails", command: "npm test", exitCode: 1 } as const;
	const before = await replay("Current instruction", task);
	const after = await replay("Candidate instruction", task);
	assert.deepEqual(before, {
		events: [{ command: "npm test" }, { status: "fail", observedValidation: true }],
		tokens: 36,
	});
	assert.deepEqual(after, {
		events: [{ command: "npm test" }, { status: "fail", observedValidation: false }],
		tokens: 24,
	});
	assert.equal(requests.length, 5);
	for (const request of requests) {
		const { tools } = request as { tools: { function: { name: string } }[] };
		assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ["record_result", "run_validation"]);
	}
	assert.match(JSON.stringify(requests[0]), /Current instruction/);
	assert.doesNotMatch(JSON.stringify(requests[0]), /Exit code: 1/);
	assert.match(JSON.stringify(requests[1]), /Exit code: 1/);
	assert.match(JSON.stringify(requests[3]), /Candidate instruction/);
	assert.doesNotMatch(JSON.stringify(requests[3]), /Current instruction|Exit code: 1/);
	for (const [index, instruction] of [
		[0, "Current instruction"],
		[3, "Candidate instruction"],
	] as const) {
		const { messages } = requests[index] as { messages: { role: string; content: unknown }[] };
		assert.match(JSON.stringify(messages.find((message) => message.role === "user")?.content), new RegExp(instruction));
	}

	const routedReplay = createExecutorReplay({ modelRegistry, model: { ...model, api: "pi-virtual" } });
	await assert.rejects(routedReplay("Candidate instruction", task), /fixed model/i);
	assert.equal(requests.length, 5);
});
