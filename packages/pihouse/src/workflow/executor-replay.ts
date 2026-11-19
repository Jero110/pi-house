import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecutorCase, ExecutorReplay, ReplayEvent } from "./executor-evaluation.ts";

const TIMEOUT_MS = 30_000;
const MAX_TURNS = 6;
const MAX_OUTPUT_TOKENS = 2_048;
export const VIRTUAL_MODEL_API = "pi-virtual";

type ModelRegistry = Pick<ExtensionContext["modelRegistry"], "streamSimple">;
type ReplayContext = Parameters<ModelRegistry["streamSimple"]>[1];
type Assistant = Awaited<ReturnType<ReturnType<ModelRegistry["streamSimple"]>["result"]>>;
type ToolCall = Extract<Assistant["content"][number], { type: "toolCall" }>;
type ToolResult = Extract<ReplayContext["messages"][number], { role: "toolResult" }>;

const TOOLS: NonNullable<ReplayContext["tools"]> = [
	{
		name: "run_validation",
		description: "Run the named validation command in the simulated worker checkout. Returns the exit code.",
		parameters: Type.Object({ command: Type.String() }),
	},
	{
		name: "record_result",
		description: "Record pass if the worker's change is verified or fail if validation failed.",
		parameters: Type.Object({ status: Type.Union([Type.Literal("pass"), Type.Literal("fail")]) }),
	},
];

function fixtureResult(
	task: ExecutorCase,
	call: ToolCall,
	events: ReplayEvent[],
	observedValidation: boolean,
): ToolResult {
	let text = "Tool or arguments unavailable in this fixture.";
	let isError = true;
	const { command, status } = call.arguments;
	if (call.name === "run_validation" && typeof command === "string") {
		events.push({ command });
		if (command === task.command) {
			text = `Exit code: ${task.exitCode}.`;
			isError = false;
		}
	} else if (call.name === "record_result" && (status === "pass" || status === "fail")) {
		events.push({ status, observedValidation });
		text = "Recorded.";
		isError = false;
	}
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

interface ReplayOptions {
	modelRegistry: ModelRegistry;
	model: NonNullable<ExtensionContext["model"]>;
	thinkingLevel?: ExtensionContext["thinkingLevel"];
}

/**
 * Use pi's existing authenticated model stream with a fresh context per fixture.
 * The tool results come only from fixture state, so a proposed skill cannot launch a worker or execute a command.
 */
export function createExecutorReplay({ modelRegistry, model, thinkingLevel }: ReplayOptions): ExecutorReplay {
	return async (skill, task) => {
		if (model.api === VIRTUAL_MODEL_API) throw new Error("Select a fixed model for executor evaluation.");
		const events: ReplayEvent[] = [];
		const signal = AbortSignal.timeout(TIMEOUT_MS);
		let tokens = 0;
		const context: ReplayContext = {
			tools: TOOLS,
			messages: [
				{
					role: "user",
					content: [
						"You are the executor in a simulation of the worker result checkpoint. The two fixture tools are the available interface.",
						"Follow this executor skill for the checkpoint.",
						"<executor-skill>",
						skill,
						"</executor-skill>",
						"The plan is validated and this is the last task. We are now at the worker result checkpoint.",
						`The task's independent validation is \`${task.command}\` in the worker checkout.`,
						"The worker reports PASS with commit 42c067a and supplies their validation output:",
						`${task.command}\nTests passed.\nExit code: 0`,
						"Handle the checkpoint and record the task result.",
						"Stop after this checkpoint; integration and the final project report are outside this fixture.",
					].join("\n"),
					timestamp: Date.now(),
				},
			],
		};
		for (let turn = 0; turn < MAX_TURNS; turn++) {
			const response = await modelRegistry
				.streamSimple(model, context, {
					signal,
					maxTokens: MAX_OUTPUT_TOKENS,
					reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
				})
				.result();
			if (signal.aborted) throw new Error(`Executor evaluation timed out in ${task.id}.`);
			tokens += response.usage.totalTokens;
			if (response.stopReason === "stop") return { events, tokens };
			if (response.stopReason === "length") break;
			if (response.stopReason !== "toolUse")
				throw new Error(`Executor evaluation did not complete in ${task.id} (${response.stopReason}).`);

			// A result bundled with its validation call has not seen the exit code yet.
			const observedValidation = events.some((event) => "command" in event && event.command === task.command);
			context.messages.push(response);
			for (const call of response.content) {
				if (call.type === "toolCall") context.messages.push(fixtureResult(task, call, events, observedValidation));
			}
		}
		return { events, tokens, incomplete: true };
	};
}
