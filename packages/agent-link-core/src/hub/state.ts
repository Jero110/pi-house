// Agent lifecycle: starting → working ⇄ asking → done | error | exited. The hub changes an agent's state
// only through next(); anything the table does not list is ignored and logged, never thrown.
// Ported from an earlier hub; the table is the same, the causes now come from adapters.
import type { AgentState, SessionUpdate, StopReason } from "../types.ts";

/**
 * What can move an agent:
 * - started: the adapter reported `state busy` (a turn runs).
 * - asking: the adapter reported `state asking`, or the agent asked its parent with send.
 * - done / error: a turn ended (prompt() resolved, or a turn_end update).
 * - exited: the harness process is gone, or the agent was cancelled.
 * - wake: the hub handed the agent a message (prompt()).
 * - connected: connect() resolved, the agent can take messages.
 * - dialog: its pane shows a dialog the hub cannot answer, and the parent was asked to pick an option.
 * - answered: that dialog left the pane.
 */
export type Cause = "started" | "asking" | "done" | "error" | "exited" | "wake" | "connected" | "dialog" | "answered";

/**
 * Every valid transition. A state missing a cause has no such transition.
 * - done/error accept started and wake: the worker took another turn (a new message, or the user typed in its pane).
 * - done/error reject done and error: a second turn end with no turn in between is a duplicate.
 * - done/error reject asking: Claude's Notification hook also fires when a finished session waits for input.
 * - exited accepts nothing: a cancelled worker's hooks (Stop, SessionEnd) keep firing while it shuts down.
 * - dialog leads to asking from any live state but done/error: a worker that ended its turn shows no dialog.
 * - answered leads only from asking back to working: the worker goes on past the dialog.
 */
export const TRANSITIONS: Readonly<Record<AgentState, Partial<Record<Cause, AgentState>>>> = {
	starting: {
		started: "working",
		connected: "working",
		// A message that reaches a worker still starting does not prove it runs yet.
		wake: "starting",
		asking: "asking",
		// A startup dialog the profile does not know, e.g. Claude's "New MCP server found in this project".
		dialog: "asking",
		done: "done",
		error: "error",
		exited: "exited",
	},
	working: {
		started: "working",
		connected: "working",
		wake: "working",
		asking: "asking",
		// A dialog in the middle of a turn, e.g. a permission prompt.
		dialog: "asking",
		done: "done",
		error: "error",
		exited: "exited",
	},
	asking: {
		// The worker kept going: a tool ran or an answer reached it.
		started: "working",
		wake: "working",
		connected: "asking",
		asking: "asking",
		dialog: "asking",
		answered: "working",
		done: "done",
		error: "error",
		exited: "exited",
	},
	done: { started: "working", wake: "working", connected: "done", exited: "exited" },
	error: { started: "working", wake: "working", connected: "error", exited: "exited" },
	exited: {},
};

/** The state after cause, or undefined when the table has no such transition. */
export function next(from: AgentState, cause: Cause): AgentState | undefined {
	return TRANSITIONS[from][cause];
}

/** The cause an adapter update stands for; undefined for updates that do not move the state. */
export function causeOf(update: SessionUpdate): Cause | undefined {
	switch (update.kind) {
		case "state":
			return update.state === "busy" ? "started" : update.state === "asking" ? "asking" : undefined;
		case "turn_end":
			return turnEndCause(update.stopReason);
		case "exited":
			return "exited";
		default:
			return undefined;
	}
}

/** A finished turn: error for a turn the harness reported as failed, done for every other stop reason. */
export function turnEndCause(stopReason: StopReason): Cause {
	return stopReason === "error" ? "error" : "done";
}
