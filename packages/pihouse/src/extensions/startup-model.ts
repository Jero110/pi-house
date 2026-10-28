// A saved default can be exhausted between sessions. On a fresh interactive start, select another authenticated
// subscription model only when its quota is confirmed available; stale/unknown data is never called available.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_AGE_MS } from "../account-usage.ts";
import { chooseStartupModel, hasExplicitModelArgument, type StartupModelCandidate } from "../startup-model.ts";
import { CLAUDE_CODE_RATE_LIMITS, pollChatGptUsage, readClaudeCodeObservation } from "../usage.ts";
import type { Observation, PollState } from "../workflow/routing.ts";

const SUBSCRIPTION_PROVIDERS = new Set(["claude-bridge", "openai-codex"]);

export interface StartupModelDependencies {
	argv?: () => readonly string[];
	isAgentLinked?: () => boolean;
	now?: () => number;
	readClaude?: (
		now: number,
	) => { windows: { label: string; percent: number; resetsAt?: number }[]; observedAt: number } | undefined;
	readOpenAi?: (ctx: ExtensionContext, poll: PollState, now: number) => Promise<Observation | undefined>;
}

function stateOf(observation: Observation | undefined, now: number): StartupModelCandidate["state"] {
	if (!observation || now - observation.observedAt < 0 || now - observation.observedAt > MAX_AGE_MS) return "unknown";
	return observation.state === "available" || observation.state === "exhausted" ? observation.state : "unknown";
}

function actionableMessage(reason: "no-login" | "exhausted"): string {
	return reason === "no-login"
		? "pih: no authenticated Claude or OpenAI subscription model is available; use /login, then /model."
		: "pih: all observed subscription accounts are exhausted; wait for a reset or use /login and /model to choose another authenticated account.";
}

async function readOpenAiUsage(ctx: ExtensionContext, poll: PollState, now: number): Promise<Observation | undefined> {
	const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex").catch(() => undefined);
	if (!token) return undefined;
	const result = await pollChatGptUsage(poll, token, now);
	return result.status === "observed" ? result.observation : undefined;
}

export function createStartupModelExtension(dependencies: StartupModelDependencies = {}) {
	const argv = dependencies.argv ?? (() => process.argv);
	const isAgentLinked = dependencies.isAgentLinked ?? (() => !!process.env.AGENT_LINK_AGENT);
	const nowFn = dependencies.now ?? Date.now;
	const readClaude =
		dependencies.readClaude ?? ((now: number) => readClaudeCodeObservation(CLAUDE_CODE_RATE_LIMITS, now));
	const poll: PollState = new Map();
	let attempted = false;
	return (pi: ExtensionAPI): void => {
		pi.on("session_start", async (event, ctx) => {
			if (
				attempted ||
				isAgentLinked() ||
				event.reason !== "startup" ||
				ctx.mode !== "tui" ||
				hasExplicitModelArgument(argv())
			)
				return;
			const branch = ctx.sessionManager.getBranch();
			const hasConversation = branch.some((entry) => entry.type === "message");
			const hasManualModelChange = branch.filter((entry) => entry.type === "model_change").length > 1;
			if (hasConversation || hasManualModelChange) return;
			attempted = true;

			const models = ctx.modelRegistry
				.getAvailable()
				.filter((model) => SUBSCRIPTION_PROVIDERS.has(model.provider))
				.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model) && ctx.modelRegistry.isUsingOAuth(model));
			if (!models.length) {
				ctx.ui.notify(actionableMessage("no-login"), "warning");
				return;
			}

			const now = nowFn();
			const observations = new Map<string, Observation>();
			const claude = readClaude(now);
			if (claude) {
				const windows = claude.windows.filter((window) => !window.resetsAt || window.resetsAt > now);
				const fresh = now - claude.observedAt >= 0 && now - claude.observedAt <= MAX_AGE_MS;
				observations.set("claude", {
					provider: "claude",
					account: "claude",
					state:
						!fresh || !windows.length
							? "unknown"
							: windows.some((window) => window.percent >= 100)
								? "exhausted"
								: "available",
					observedAt: claude.observedAt,
					source: "Claude Code rate limits",
					windows,
				});
			}
			if (models.some((model) => model.provider === "openai-codex")) {
				const openai = dependencies.readOpenAi
					? await dependencies.readOpenAi(ctx, poll, now)
					: await readOpenAiUsage(ctx, poll, now);
				if (openai) observations.set("openai", openai);
			}

			const candidates: StartupModelCandidate<(typeof models)[number]>[] = models.map((model) => {
				const account = model.provider === "claude-bridge" ? "claude" : "openai";
				return {
					provider: model.provider,
					id: model.id,
					account,
					state: stateOf(observations.get(account), now),
					authenticated: true,
					model,
				};
			});
			const preference = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
			const choice = chooseStartupModel(candidates, preference);
			if (!choice) {
				ctx.ui.notify(actionableMessage("exhausted"), "warning");
				return;
			}
			if (preference?.provider === choice.model.provider && preference.id === choice.model.id) {
				if (choice.uncertain)
					ctx.ui.notify(
						`pih: quota for ${choice.model.provider}/${choice.model.id} is unknown; keeping the saved preference.`,
						"warning",
					);
				return;
			}
			const selectedModel = choice.model.model;
			if (!selectedModel) {
				ctx.ui.notify(
					"pih: selected model is no longer available; use /model to choose an exact authenticated model.",
					"warning",
				);
				return;
			}
			const changed = await pi.setModel(selectedModel);
			if (!changed) {
				ctx.ui.notify("pih: could not select the authenticated subscription model; use /login and /model.", "warning");
				return;
			}
			ctx.ui.notify(
				choice.uncertain
					? `pih: selected ${choice.model.provider}/${choice.model.id}; subscription quota is unknown, so verify before use.`
					: `pih: selected ${choice.model.provider}/${choice.model.id}; its subscription quota is confirmed available.`,
				choice.uncertain ? "warning" : "info",
			);
		});
	};
}

export default function startupModel(pi: ExtensionAPI): void {
	createStartupModelExtension()(pi);
}
