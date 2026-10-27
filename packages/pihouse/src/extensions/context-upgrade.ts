import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assess, parseProfile } from "../workflow/context-upgrade.ts";

const ENTRY = "context-upgrade";

export default function contextUpgrade(pi: ExtensionAPI) {
	const attempted = new Set<string>();
	const noticed = new Set<string>();
	// Problem: a user who sees "context upgrade" in the help may expect the session to switch models by itself.
	// Example: the session reaches its context limit, and nothing happens until the user runs the command.
	// Solution: the help says what the monitor does and what it never does. Automatic switching is not implemented: there
	// is no proven safe point to switch models in the middle of a session.
	pi.registerFlag("context-upgrade-profile", {
		type: "string",
		description:
			"Explicit JSON context upgrade profile. Opt-in: without it nothing is monitored. Reports a pending upgrade only; no automatic switching",
	});

	function snapshot(ctx: ExtensionContext) {
		const profile = parseProfile(pi.getFlag("context-upgrade-profile"));
		const target = profile ? ctx.modelRegistry.find(profile.provider, profile.target) : undefined;
		const session = ctx.sessionManager.getSessionId();
		const used =
			attempted.has(session) ||
			ctx.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === ENTRY &&
						typeof entry.data === "object" &&
						entry.data !== null &&
						"status" in entry.data &&
						entry.data.status === "attempt",
				);
		const usage = ctx.getContextUsage();
		const available =
			!!target &&
			ctx.modelRegistry.getAvailable().some((model) => model.provider === target.provider && model.id === target.id);
		return {
			profile,
			target,
			session,
			usage,
			result: assess({ profile, source: ctx.model, target, usage, available, attempted: used }),
		};
	}

	function record(ctx: ExtensionContext, status: string, reason: string, extra: object = {}) {
		pi.appendEntry(ENTRY, {
			status,
			reason,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			...extra,
		});
	}

	function monitor(ctx: ExtensionContext) {
		const s = snapshot(ctx);
		if (!s.profile || noticed.has(s.session)) return;
		// Only a target problem after the threshold is pressure worth a notice; an unknown usage or a
		// source that is not the profile's must stay silent, or every ordinary turn would warn.
		if (s.result.status === "paused" && s.result.reason.startsWith("target")) {
			noticed.add(s.session);
			record(ctx, "paused", s.result.reason, { profile: s.profile.id });
			if (ctx.hasUI) ctx.ui.notify(`Context upgrade paused: ${s.result.reason}.`, "warning");
			return;
		}
		if (s.result.status !== "pending") return;
		noticed.add(s.session);
		record(ctx, "pending", s.result.reason, {
			profile: s.profile.id,
			target: `${s.profile.provider}/${s.profile.target}`,
			tokens: s.usage?.tokens,
			contextWindow: s.usage?.contextWindow,
			threshold: s.profile.threshold,
			headroom: s.profile.headroom,
		});
		if (ctx.hasUI)
			ctx.ui.notify(
				`Context upgrade pending: ${s.profile.provider}/${s.profile.target}; use /context-upgrade apply when ready.`,
				"warning",
			);
	}
	pi.on("turn_end", (_event, ctx) => monitor(ctx));
	pi.on("session_before_compact", (_event, ctx) => {
		monitor(ctx);
	});
	pi.registerCommand("context-upgrade", {
		description: "Apply the configured pending context upgrade once, when you ask; no automatic switching",
		handler: async (args, ctx) => {
			if (args.trim() !== "apply") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /context-upgrade apply", "info");
				return;
			}
			await ctx.waitForIdle();
			const s = snapshot(ctx);
			if (!ctx.isIdle() || ctx.hasPendingMessages() || s.result.status !== "pending" || !s.target || !s.profile) {
				if (ctx.hasUI)
					ctx.ui.notify(
						`Context upgrade paused: ${!ctx.isIdle() || ctx.hasPendingMessages() ? "agent busy or queued" : s.result.reason}.`,
						"warning",
					);
				return;
			}
			// A failed native switch must not loop or silently spend elsewhere. Persist the attempt first.
			attempted.add(s.session);
			record(ctx, "attempt", s.result.reason, { profile: s.profile.id, target: `${s.target.provider}/${s.target.id}` });
			try {
				const success = await pi.setModel(s.target);
				const actual = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
				const switched = success && actual === `${s.target.provider}/${s.target.id}`;
				record(ctx, switched ? "switched" : "paused", switched ? "context pressure" : "native switch not confirmed", {
					profile: s.profile.id,
					actual,
				});
				if (ctx.hasUI)
					ctx.ui.notify(
						switched
							? `Context upgrade: ${actual} (context pressure).`
							: `Context upgrade paused: actual model ${actual}.`,
						switched ? "info" : "warning",
					);
			} catch {
				record(ctx, "paused", "native switch failed", { profile: s.profile.id });
				if (ctx.hasUI) ctx.ui.notify("Context upgrade paused: native switch failed.", "warning");
			}
		},
	});
}
