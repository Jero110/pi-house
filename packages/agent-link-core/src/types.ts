// The contract every agent-link piece shares: agents, the ACP-shaped adapter interface each harness implements,
// the pane backend interface cmux and tmux implement, and the identity env a spawned agent receives.
// docs/design.md explains how the pieces fit.

/** Harnesses with a native adapter. Other harnesses come in through a profile that uses the paste adapter. */
export type Harness = "claude" | "codex" | "opencode" | "pi";

export type AgentState = "starting" | "working" | "asking" | "done" | "error" | "exited";

export type BackendName = "cmux" | "tmux";

/** One agent in the hub's tree. The root of a tree has parent null. */
export interface AgentRecord {
	name: string;
	parent: string | null;
	/** Harness id: a Harness, or the profile name of a harness that uses the paste adapter. */
	harness: string;
	model: string | null;
	cwd: string;
	state: AgentState;
	/** Pane backend and pane ref, for agents in a pane. A root opened with `agent-link open` has none. */
	backend?: BackendName;
	pane?: string;
	/** Agents with no adapter (a harness opened without `agent-link open`) get their messages through inbox(). */
	pull: boolean;
	depth: number;
	startedAt: number;
}

// ---------------------------------------------------------------------------------------------------------
// Adapter interface. Its shape follows ACP (session/prompt, session/update, stopReason, session/cancel), so
// the queue, the states and the failures are written once in the hub. Each adapter talks to its harness by
// the harness's native path (Claude messaging socket, Codex app-server, opencode HTTP server, pi extension).
// ---------------------------------------------------------------------------------------------------------

/** ACP stop reasons, plus "error" for a turn the harness reported as failed. */
export type StopReason = "end_turn" | "max_tokens" | "refusal" | "cancelled" | "error";

/** A message for the agent (ACP session/prompt). */
export interface PromptRequest {
	/** Message id, unique; the hub dedupes on it. */
	id: string;
	/** Who sends it: an agent name, or "agent-link" for the hub itself (the first task). */
	from: string;
	/** The text as the agent should see it; the hub has already added who it comes from. */
	text: string;
}

/** ACP session/prompt response: how the turn that this prompt started ended, and its last agent text. */
export interface PromptResponse {
	stopReason: StopReason;
	text: string;
}

/** One question of a PendingAsk: what is asked and its options, in order. */
export interface AskQuestion {
	question: string;
	options: string[];
	/** Several options may be picked at once ("1,3"). */
	multiple?: boolean;
}

/**
 * A permission or question the harness waits on, read from the harness itself (its API, a hook), not from the
 * pane: the parent answers it with permit(). A permission is one question whose options are its answers.
 */
export interface PendingAsk {
	/** "permission" or "question", for the parent's notice. */
	kind: "permission" | "question";
	questions: AskQuestion[];
}

/** ACP session/update, reduced to what the hub uses. */
export type SessionUpdate =
	/**
	 * busy: a turn runs. idle: no turn runs. asking: the harness waits on the user (permission, dialog);
	 * `ask` when the adapter can say what is asked and answer it itself (AgentAdapter.answer).
	 */
	| { kind: "state"; state: "idle" | "busy" | "asking"; detail?: string; ask?: PendingAsk }
	| { kind: "agent_message"; text: string }
	| { kind: "tool_call"; title: string; status?: "pending" | "in_progress" | "completed" | "failed" }
	/**
	 * A turn that prompt() did not start ended, e.g. the user typed in the pane. Turns started by prompt()
	 * end through prompt()'s own promise and never through this update.
	 */
	| { kind: "turn_end"; stopReason: StopReason; text: string }
	/** The harness process is gone (pane closed, crash). */
	| { kind: "exited"; code?: number; detail?: string }
	/** The harness's own session, once the adapter knows it; the hub writes it to the session journal. */
	| { kind: "session"; sessionId?: string; transcript?: string }
	/** A model switch that setModel() answered "pending" now took effect: the model the agent runs. */
	| { kind: "model"; model: string }
	/** A pending model switch failed when it was due; the agent keeps the model it had. */
	| { kind: "model_error"; model: string; error: string };

/** What a pane runs. Paths are absolute. */
export interface PaneCommand {
	argv: string[];
	env: Record<string, string>;
	cwd: string;
}

/** Everything an adapter needs to start one agent. */
export interface LaunchSpec {
	name: string;
	parent: string | null;
	model: string | null;
	cwd: string;
	/** Private (0700) folder for this agent's sockets, ports and logs: ~/.agent-link/run/<name>. Removed on close. */
	runDir: string;
	/** Identity env (see IdentityEnv); the adapter passes it to the harness process. */
	env: Record<string, string>;
	/** How to start the agent-link MCP server, for harnesses where it must be passed by flag. */
	mcp: { command: string; args: string[] };
	profile: Profile;
	/** Folders outside cwd the harness may read without asking (READ_DIRS_ENV). */
	readDirs?: string[];
}

/** A pane an adapter may look at (dialogs) or type into (paste). */
export interface PaneHandle {
	backend: PaneBackend;
	ref: string;
}

export interface AgentAdapter {
	/** The pane command for a new agent. Called once, before the pane opens. */
	launch(spec: LaunchSpec): Promise<PaneCommand>;
	/**
	 * Connects to the harness's native path once its pane is open (pane given) or, for a root opened with `agent-link open`,
	 * once the harness runs in the user's terminal (no pane). Resolves when prompt() may be called.
	 */
	connect(pane?: PaneHandle): Promise<void>;
	/**
	 * Hands one message to the agent and resolves when the turn it started ends (ACP session/prompt).
	 * The hub calls it only while idle() is true and never twice at once.
	 */
	prompt(req: PromptRequest): Promise<PromptResponse>;
	/** True when no turn runs and the harness waits on nobody, so a new message gets a turn of its own. */
	idle(): boolean;
	/** Interrupts the running turn (ACP session/cancel); the pending prompt() resolves with "cancelled". */
	cancel(): Promise<void>;
	/** Releases sockets, servers and child processes. The hub closes the pane itself. Idempotent. */
	close(): Promise<void>;
	onUpdate(listener: (u: SessionUpdate) => void): void;
	/**
	 * Answers the PendingAsk the adapter last reported, through the harness's own path (API, hook), never the
	 * pane. `choice` is what the parent passed to permit(): option numbers or texts (see ask.ts).
	 */
	answer?(choice: string): Promise<{ answered: string } | { error: string }>;
	/**
	 * Switches the model the agent runs, through the harness's own documented path, never the pane. `model` is an
	 * exact `<provider>/<id>`. "applied": the agent runs it from now on. "pending": a turn runs, so the switch waits
	 * for a boundary (never overlapping the turn) and a `model` update follows. An error keeps the current model.
	 * Optional: an adapter without a documented switch leaves it out and the hub says so.
	 */
	setModel?(model: string): Promise<SetModelResult>;
}

export type SetModelResult = { status: "applied" | "pending"; model: string } | { error: string };

export type AdapterFactory = (deps: AdapterDeps) => AgentAdapter;

/** What the hub gives an adapter besides the launch spec. */
export interface AdapterDeps {
	/** Writes one line to the hub's event log for this agent (debugging, latency tables). */
	log: (kind: string, data?: Record<string, unknown>) => void;
	/** The guard verdict for a command a harness asks to run (permission requests the adapter sees). */
	guard: (command: string, depth: number) => GuardVerdict;
	depth: number;
}

export type GuardVerdict = { action: "allow" } | { action: "ask" | "block"; reason: string };

// ---------------------------------------------------------------------------------------------------------
// Pane backends: cmux and tmux only open, close, read and type into panes.
// ---------------------------------------------------------------------------------------------------------

/** Where the caller sits, so a new pane opens next to it. */
export interface PlaceHint {
	/** cmux: workspace and surface refs of the caller. tmux: the caller's pane id (%N) or target. */
	workspace?: string;
	surface?: string;
	tmuxPane?: string;
	/** tmux: the socket path of the caller's tmux server, which is the first field of $TMUX. */
	tmuxSocket?: string;
}

export interface PaneBackend {
	readonly name: BackendName;
	/** Opens a pane running cmd, titled, next to place. Returns the pane ref. Never steals focus. */
	open(cmd: PaneCommand, opts: { title: string; place?: PlaceHint }): Promise<string>;
	close(ref: string): Promise<void>;
	/** The pane's visible text, last `lines` lines. */
	read(ref: string, lines?: number): Promise<string>;
	/** Key names as cmux send-key takes them: "enter", "escape", "down", "up", "tab", "ctrl+c". */
	keys(ref: string, keys: readonly string[]): Promise<void>;
	/** Pastes text unchanged (bracketed paste), without pressing enter. */
	paste(ref: string, text: string): Promise<void>;
	alive(ref: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------------------
// Profiles (profiles/<harness>.json): which adapter, default model and startup dialogs.
// ---------------------------------------------------------------------------------------------------------

export interface DialogSpec {
	name: string;
	/** Phrases that must all be on screen; spaces and line breaks are ignored, since panes wrap mid-word. */
	match: readonly string[];
	/** The option to pick: its label (spaces ignored), its position, or literal keys. */
	choose: string | number | { keys: readonly string[] };
}

export interface Profile {
	harness: string;
	/** "claude" | "codex" | "opencode" | "pi" | "paste". */
	adapter: string;
	/** Display name for panes and status, e.g. "Claude". */
	label: string;
	defaultModel: string | null;
	dialogs: DialogSpec[];
	/** paste adapter only: the argv that opens the harness's TUI; {model} and {cwd} are replaced. */
	command?: string[];
	/** Extra env for the harness process, e.g. pihouse's PIHOUSE_HOME when it is not the default. */
	env?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------------------
// Identity: every agent's harness process gets these, and so does the agent-link MCP server it starts.
// ---------------------------------------------------------------------------------------------------------

export const IDENTITY_ENV = {
	agent: "AGENT_LINK_AGENT",
	hub: "AGENT_LINK_HUB",
	token: "AGENT_LINK_TOKEN",
	depth: "AGENT_LINK_DEPTH",
	/** The hub's folder, so a worker's MCP server and CLI find the same profiles and journal as the hub. */
	home: "AGENT_LINK_HOME",
} as const;

/**
 * Env that tells an MCP server where its caller's pane is (see placeFromEnv). Codex passes only listed vars to
 * its MCP servers, so these go in its env_vars next to IDENTITY_ENV.
 */
/**
 * Folders outside its own cwd that an agent's workers may read without a permission prompt, joined with ":".
 * Example: pihouse sets its skills folder, so an opencode worker can read the SKILL.md its brief names.
 * The client adds them to every spawn, and the hub hands them on to the worker, so they reach every depth.
 */
export const READ_DIRS_ENV = "AGENT_LINK_READ_DIRS";

/** The folders in READ_DIRS_ENV. */
export function readDirsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
	return (env[READ_DIRS_ENV] ?? "").split(":").filter((d) => d.trim() !== "");
}

export const PLACE_ENV = ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "TMUX", "TMUX_PANE"] as const;

export interface Identity {
	agent: string;
	/** Path of the hub's Unix socket. */
	hub: string;
	token: string;
	depth: number;
}
