// The keeper: the one durable pihouse agent that keeps the workflow memory (started by `pih keeper`).
// It does nothing unless PIHOUSE_KEEPER=1. On start it says how many runs are pending; on "summarize" it digests the
// batch in a fresh session (workflow/digest.ts), then shows the summary and the proposals; only approved proposals
// are applied. Its cost per turn stays flat: a bounded bootstrap plus the messages after the last boundary.
// Spec: docs/specs/workflow-memory.md, "The keeper (T6)"; choices: ADR-001 (D1, D2).
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionRecord } from "agent-link-core";
import { agentLinkHome, hubPaths, readJournal } from "agent-link-core";
import { pihousePaths } from "../paths.ts";
import { sweepFlagged } from "../workflow/capture.ts";
import { type Catalog, readCatalog } from "../workflow/catalog.ts";
import {
	applyProposal,
	type Complete,
	cap,
	type DigestResult,
	digestPending,
	prune,
	readProposal,
} from "../workflow/digest.ts";
import { LIMITS, type MemoryStore, openMemory } from "../workflow/memory.ts";

export const BOUNDARY = "keeper-boundary";
export const MESSAGE_TYPE = "keeper";
export const USAGE =
	"usage: /keeper | /keeper summarize | /keeper proposals | /keeper approve <id> | /keeper reject <id> [why] | /keeper prune | /keeper new";

/** "summarize", "summarize them", "digest": the plain words that mean `/keeper summarize`. */
const PLAIN_SUMMARIZE = /^\s*(?:summari[sz]e|digest)(?:\s+(?:them|it|all|the\s+(?:runs|batch)))?\s*[.!]?\s*$/i;

export const isSummarizeWords = (text: string): boolean => PLAIN_SUMMARIZE.test(text);

export const pendingText = (n: number): string => `${n} run${n === 1 ? "" : "s"} pending`;

const INSTRUCTIONS = [
	"You are the keeper of the user's workflow memory in pihouse. You read no run yourself: runs are digested by code",
	"on /keeper summarize, and what you know is the memory and the index below.",
	"- Say how many runs are pending when asked. Answer questions about the user's workflow from the memory and index.",
	"- Digests come from /keeper summarize (also the words 'summarize them'). Proposals are listed with /keeper proposals;",
	"  /keeper approve <id> and /keeper reject <id> decide them. Never apply a change that is not approved.",
	"- Never delete anything: unused memory is archived, and only an approved delete-raw proposal removes raw copies.",
].join("\n");

/**
 * What every model request of the keeper sees besides the conversation: instructions, the workflow memory, a slice
 * of the index and the pending count. Problem: a keeper that has seen 200 runs must not cost more per turn than
 * one that has seen 2. Solution: every part is capped, so the size depends on LIMITS, not on how many runs there are.
 */
export function keeperBootstrap(store: MemoryStore): string {
	return cap(
		[
			INSTRUCTIONS,
			"",
			"## Workflow memory",
			store.readWorkflowMemory().trim() || "(empty: no run digested yet)",
			"",
			"## Index (newest entries)",
			store.indexSlice({ limit: 30, maxChars: 6000 }) || "(empty)",
			"",
			`## Now: ${pendingText(store.pendingCount())}`,
		].join("\n"),
		LIMITS.keeperBootstrap,
	);
}

type AgentMessage = ContextEvent["messages"][number];
/** The context pi hands to withSession (the package does not export its name). */
type ReplacedSessionContext = Parameters<
	NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>
>[0];

const isBoundary = (m: AgentMessage): boolean => m.role === "custom" && m.customType === BOUNDARY;

/**
 * Only the messages after the last boundary. The older ones stay in the session file and never reach the model.
 * Problem: the conversation grows with every job and each turn pays for all of it. Example: after three digests the
 * keeper's turn would carry three summaries and every chat around them. Solution: a boundary message after each job.
 */
export function afterBoundary(messages: AgentMessage[]): AgentMessage[] {
	const i = messages.findLastIndex(isBoundary);
	return i < 0 ? messages : messages.slice(i + 1);
}

/** The batch summary and the proposals it made, as the keeper shows them. */
export function renderDigest(r: DigestResult): string {
	const lines = [
		`## Batch ${r.batchId}: ${r.runIds.length} run${r.runIds.length === 1 ? "" : "s"} digested`,
		"",
		r.summary,
	];
	if (r.proposals.length) {
		lines.push("", "## New proposals", "");
		for (const p of r.proposals) lines.push(`- ${p.id} · ${p.title}`);
		lines.push("", "Decide with /keeper approve <id> or /keeper reject <id> [why].");
	} else lines.push("", "No new proposals.");
	if (r.archived.length) lines.push("", `Archived (unused for 90 days, nothing deleted): ${r.archived.length}.`);
	return lines.join("\n");
}

/** A proposal id typed by the user: the whole id or a prefix that matches one proposal. */
export function resolveProposal(store: MemoryStore, typed: string): string | undefined {
	const ids = store
		.readIndex()
		.filter((e) => e.kind === "proposal")
		.map((e) => e.id.slice("proposal:".length));
	const bare = typed.replace(/^proposal:/, "");
	if (ids.includes(bare)) return bare;
	const hits = ids.filter((id) => id.startsWith(bare));
	return bare && hits.length === 1 ? hits[0] : undefined;
}

export function listProposals(store: MemoryStore): string {
	const rows = store
		.readIndex()
		.filter((e) => e.kind === "proposal" && (e.status === "open" || e.status === "approved"))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.map((e) => `${e.id.slice("proposal:".length)} · ${e.status} · ${e.title}`);
	return rows.length ? rows.join("\n") : "No open proposals.";
}

export interface KeeperDeps {
	env: NodeJS.ProcessEnv;
	store: () => MemoryStore;
	records: () => SessionRecord[];
	catalog: () => Catalog;
	/** The nested model call with the keeper's current model. */
	complete: (ctx: Pick<ExtensionContext, "modelRegistry" | "model">) => Complete;
	now: () => Date;
}

/** The nested model call: one user message, the text of the answer. Tests replace it with a fake. */
export function modelComplete(ctx: Pick<ExtensionContext, "modelRegistry" | "model">): Complete {
	return async (prompt) => {
		const model = ctx.model;
		if (!model) throw new Error("The keeper has no model selected");
		const answer = await ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ cacheRetention: "none" },
		);
		if (answer.stopReason === "error" || answer.stopReason === "aborted")
			throw new Error(answer.errorMessage ?? `The model call ${answer.stopReason}`);
		return answer.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	};
}

const realDeps = (): KeeperDeps => ({
	env: process.env,
	store: () => openMemory(pihousePaths().memory),
	records: () => readJournal(hubPaths(agentLinkHome()).sessions),
	catalog: () => readCatalog(),
	complete: modelComplete,
	now: () => new Date(),
});

export function registerKeeper(pi: ExtensionAPI, deps: KeeperDeps): void {
	if (deps.env.PIHOUSE_KEEPER !== "1") return;
	/** Approved edit-skill and remove-skill proposals the model is applying now; marked applied when its turn ends. */
	const applying = new Set<string>();

	const sweptCount = (): number => {
		const store = deps.store();
		sweepFlagged(deps.records(), store);
		store.adoptIdeas();
		return store.pendingCount();
	};
	const showPending = (ctx: Pick<ExtensionContext, "ui">, notice: boolean): void => {
		const n = sweptCount();
		ctx.ui.setStatus("keeper", pendingText(n));
		if (notice) ctx.ui.notify(`${pendingText(n)}. Say "summarize them" to digest them.`, "info");
	};

	pi.on("session_start", (event, ctx) => {
		try {
			if (event.reason === "new") pi.setSessionName(`keeper · ${deps.now().toISOString().slice(0, 10)}`);
			showPending(ctx, true);
		} catch (e) {
			ctx.ui.notify(`keeper: ${e instanceof Error ? e.message : String(e)}`, "warning");
		}
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${keeperBootstrap(deps.store())}`,
	}));

	pi.on("context", (event) => ({ messages: afterBoundary(event.messages) }));

	pi.on("agent_end", (_event, ctx) => {
		if (applying.size) {
			const store = deps.store();
			for (const id of applying) store.markApplied(id);
			applying.clear();
		}
		showPending(ctx, false);
	});

	// Plain words run the command. Problem: ctx.newSession exists only in command handlers, and an input handler
	// has no command context. Solution: the words are handled here and sent back as the command, which pi dispatches
	// like typed text, so "summarize them" rotates the session exactly as /keeper summarize does.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || !ctx.isIdle() || !isSummarizeWords(event.text)) return { action: "continue" };
		setTimeout(() => pi.sendUserMessage("/keeper summarize", { expandPromptTemplates: true }), 0);
		return { action: "handled" };
	});

	/** The digest, run in the fresh session: summary and proposals shown with no turn, then a boundary. */
	const digestIn = async (rctx: ReplacedSessionContext): Promise<void> => {
		const store = deps.store();
		try {
			const result = await digestPending({
				store,
				complete: deps.complete(rctx),
				catalog: deps.catalog(),
				now: deps.now,
			});
			if (result) await rctx.sendMessage({ customType: MESSAGE_TYPE, content: renderDigest(result), display: true });
			else rctx.ui.notify("No runs pending.", "info");
		} catch (e) {
			rctx.ui.notify(
				`Digest failed: ${e instanceof Error ? e.message : String(e)}. The batch stays claimed; summarize again to resume it.`,
				"error",
			);
		}
		await rctx.sendMessage({
			customType: BOUNDARY,
			content: "Job done; earlier messages are not in context.",
			display: false,
		});
		showPending(rctx, false);
	};

	const summarize = async (ctx: ExtensionCommandContext): Promise<void> => {
		await ctx.waitForIdle();
		if (!ctx.model) {
			ctx.ui.notify("Select a model first: the digest needs one.", "error");
			return;
		}
		const store = deps.store();
		sweepFlagged(deps.records(), store);
		store.adoptIdeas();
		if (store.pendingCount() === 0) {
			ctx.ui.notify("No runs pending.", "info");
			return;
		}
		// The model is read before the switch: the old ctx is stale afterwards, and withSession's ctx has its own.
		const result = await ctx.newSession({ withSession: digestIn });
		if (result.cancelled) ctx.ui.notify("New session cancelled; nothing was digested.", "info");
	};

	const decide = async (kind: "approve" | "reject", args: string[], ctx: ExtensionCommandContext): Promise<void> => {
		const store = deps.store();
		const id = args[0] ? resolveProposal(store, args[0]) : undefined;
		if (!id) {
			ctx.ui.notify(`${kind}: no unique proposal matches "${args[0] ?? ""}". /keeper proposals lists them.`, "warning");
			return;
		}
		const p = readProposal(store, id);
		if (!p || (p.status !== "open" && !(kind === "approve" && p.status === "approved"))) {
			ctx.ui.notify(`Proposal ${id} is ${p?.status ?? "missing"}, not open.`, "warning");
			return;
		}
		if (kind === "reject") {
			store.decide(id, "rejected", args.slice(1).join(" ") || undefined);
			ctx.ui.notify(`Rejected ${id}. The same proposal will not be made again.`, "info");
			return;
		}
		if (p.status === "open") store.decide(id, "approved");
		try {
			const r = applyProposal(store, { ...p, status: "approved" });
			if (r.applied) {
				ctx.ui.notify(`Applied ${id}: ${r.note}.`, "info");
				return;
			}
			applying.add(id);
			pi.sendMessage({ customType: MESSAGE_TYPE, content: r.instruction, display: false }, { triggerTurn: true });
			ctx.ui.notify(`Approved ${id}; applying it now.`, "info");
		} catch (e) {
			ctx.ui.notify(
				`Approved ${id} but it could not be applied: ${e instanceof Error ? e.message : String(e)}`,
				"error",
			);
		}
	};

	pi.registerCommand("keeper", {
		description: "pending runs and proposals · summarize · proposals · approve <id> · reject <id> · prune · new",
		getArgumentCompletions: (prefix) =>
			["summarize", "proposals", "approve ", "reject ", "prune", "new"]
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c })),
		handler: async (raw, ctx) => {
			const [sub, ...rest] = raw.trim().split(/\s+/).filter(Boolean);
			if (sub === undefined) {
				const n = sweptCount();
				ctx.ui.setStatus("keeper", pendingText(n));
				ctx.ui.notify(`${pendingText(n)}\n${listProposals(deps.store())}`, "info");
				return;
			}
			if (sub === "summarize") return summarize(ctx);
			if (sub === "proposals") {
				ctx.ui.notify(listProposals(deps.store()), "info");
				return;
			}
			if (sub === "approve" || sub === "reject") return decide(sub, rest, ctx);
			if (sub === "prune") {
				const r = prune({ store: deps.store(), catalog: deps.catalog(), now: deps.now });
				ctx.ui.notify(
					`Archived ${r.archived.length} unused entr${r.archived.length === 1 ? "y" : "ies"} (nothing deleted); ${r.proposed.length} new proposal${r.proposed.length === 1 ? "" : "s"}.`,
					"info",
				);
				return;
			}
			if (sub === "new") {
				const r = await ctx.newSession();
				if (r.cancelled) ctx.ui.notify("New session cancelled.", "info");
				return;
			}
			ctx.ui.notify(USAGE, "info");
		},
	});
}

export default function keeper(pi: ExtensionAPI): void {
	registerKeeper(pi, realDeps());
}
