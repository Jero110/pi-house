// account_usage: the usage of every logged-in account, for the model to read before it picks where to spawn.
//
// Problem: the status bar shows usage to the user only; an executor spawned workers on a spent account.
// Solution: one read-only tool, in every pihouse root and worker (it is in EXTENSIONS). It reads what the status bar
// reads (Claude Code's rate-limit files, the ChatGPT usage endpoint, response headers seen here) and makes no model
// call. The headers are remembered here, not shared with statusbar.ts, which is not touched.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAccountUsage, gatherAccountUsage, type SeenHeaders } from "../account-usage.ts";
import { windowsFromHeaders } from "../usage.ts";
import type { PollState } from "../workflow/routing.ts";

const Params = Type.Object(
	{
		account: Type.Optional(
			Type.String({ maxLength: 40, description: "Only this account, e.g. claude or openai. Default: all." }),
		),
	},
	{ additionalProperties: false },
);

export default function accountUsage(pi: ExtensionAPI): void {
	const headers: SeenHeaders = {};
	// One poll state for every call in this process: two reports at once cost one request to the usage endpoint.
	const poll: PollState = new Map();

	pi.on("after_provider_response", (event, ctx) => {
		const provider = ctx.model?.provider;
		if (!provider) return;
		const now = Date.now();
		const windows = windowsFromHeaders(event.headers, now);
		const account =
			provider.includes("claude") || provider === "anthropic"
				? "claude"
				: provider.startsWith("openai") || provider === "azure"
					? "openai"
					: provider;
		if (windows.length) headers[account] = { at: now, windows };
	});

	pi.registerTool({
		name: "account_usage",
		label: "Account usage",
		description:
			"Usage of each logged-in model account (claude, openai, ...): every window with percent used and reset time, how old the observation is, and a status: available, exhausted, stale or unknown. Call it before spawning agents and never spawn on an exhausted account. Stale or unknown is not proof of exhaustion. Cheap: no model call.",
		promptSnippet: "account_usage: which model accounts have usage left (call before spawning agents)",
		parameters: Params,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const now = Date.now();
			let providers: string[] = [];
			try {
				providers = ctx.modelRegistry.getAvailable().map((m) => m.provider);
			} catch {
				// Without a model list there is nothing to report; the answer says so.
			}
			const all = await gatherAccountUsage({
				now,
				providers,
				headers,
				poll,
				openaiToken: () =>
					providers.includes("openai-codex")
						? Promise.resolve(ctx.modelRegistry.getApiKeyForProvider("openai-codex"))
						: Promise.resolve(undefined),
			});
			const wanted = params.account?.trim().toLowerCase();
			const reports = wanted ? all.filter((r) => r.account === wanted) : all;
			const text =
				wanted && !reports.length
					? `No logged-in account named "${wanted.slice(0, 40)}".`
					: formatAccountUsage(reports, now);
			return { content: [{ type: "text", text }], details: { accounts: reports } };
		},
	});
}
