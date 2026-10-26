// A fake adapter: the test decides when it is idle or busy, when a turn ends and which updates it sends.
// In auto mode (respond given) every prompt ends by itself with the text respond returns.
import type {
	AdapterDeps,
	AdapterFactory,
	AgentAdapter,
	LaunchSpec,
	PaneCommand,
	PaneHandle,
	PromptRequest,
	PromptResponse,
	SessionUpdate,
	StopReason,
} from "../../src/types.ts";

export type Responder = (req: PromptRequest, adapter: FakeAdapter) => PromptResponse | Promise<PromptResponse>;

export class FakeAdapter implements AgentAdapter {
	readonly deps: AdapterDeps;
	spec?: LaunchSpec;
	pane?: PaneHandle;
	connectedWithoutPane = false;
	readonly prompts: PromptRequest[] = [];
	/** Calls in order: launch, connect, prompt, cancel, close. */
	readonly calls: string[] = [];
	/** Scripted: the harness runs a turn the hub did not start (the user typed in the pane). */
	busy = false;
	respond?: Responder;
	/** How many prompt() calls ran at once at most; the hub must keep it at 1. */
	maxConcurrent = 0;
	private running = 0;
	private turn?: { req: PromptRequest; resolve: (r: PromptResponse) => void };
	private readonly listeners: Array<(u: SessionUpdate) => void> = [];
	private connectResult: Promise<void> = Promise.resolve();
	private releaseConnect?: () => void;
	private failConnect?: (e: Error) => void;
	launchError?: Error;
	/** What permit() passed to answer(), in order; answerResult is what answer() returns (default: answered). */
	readonly answers: string[] = [];
	answerResult?: { answered: string } | { error: string };

	constructor(deps: AdapterDeps, respond?: Responder) {
		this.deps = deps;
		this.respond = respond;
	}

	/** Makes connect() wait until connectNow() or connectFail(). Call before the hub connects. */
	holdConnect(): void {
		this.connectResult = new Promise<void>((resolve, reject) => {
			this.releaseConnect = resolve;
			this.failConnect = reject;
		});
	}

	connectNow(): void {
		this.releaseConnect?.();
	}

	connectFail(message: string): void {
		this.failConnect?.(new Error(message));
	}

	async answer(choice: string): Promise<{ answered: string } | { error: string }> {
		this.answers.push(choice);
		return this.answerResult ?? { answered: choice };
	}

	async launch(spec: LaunchSpec): Promise<PaneCommand> {
		this.calls.push("launch");
		this.spec = spec;
		if (this.launchError) throw this.launchError;
		return { argv: ["fake-harness", "--name", spec.name], env: spec.env, cwd: spec.cwd };
	}

	connect(pane?: PaneHandle): Promise<void> {
		this.calls.push("connect");
		this.pane = pane;
		this.connectedWithoutPane = pane === undefined;
		return this.connectResult;
	}

	async prompt(req: PromptRequest): Promise<PromptResponse> {
		this.calls.push("prompt");
		this.prompts.push(req);
		this.running++;
		this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
		try {
			if (this.respond) return await this.respond(req, this);
			return await new Promise<PromptResponse>((resolve) => {
				this.turn = { req, resolve };
			});
		} finally {
			this.running--;
		}
	}

	/** True while a prompt waits for finish(). */
	get inTurn(): boolean {
		return this.turn !== undefined;
	}

	/** Ends the running prompt() turn. */
	finish(text: string, stopReason: StopReason = "end_turn"): void {
		const turn = this.turn;
		if (!turn) throw new Error("no turn runs");
		this.turn = undefined;
		turn.resolve({ stopReason, text });
	}

	idle(): boolean {
		return !this.busy && !this.turn;
	}

	async cancel(): Promise<void> {
		this.calls.push("cancel");
		if (this.turn) this.finish("", "cancelled");
	}

	async close(): Promise<void> {
		this.calls.push("close");
	}

	onUpdate(listener: (u: SessionUpdate) => void): void {
		this.listeners.push(listener);
	}

	emit(u: SessionUpdate): void {
		for (const l of this.listeners) l(u);
	}
}

export interface FakeKit {
	factory: AdapterFactory;
	/** Every adapter the hub created, in order; `byName` once launch() or connect() named it. */
	all: FakeAdapter[];
	byName(name: string): FakeAdapter | undefined;
	/** Called on each new adapter before the hub uses it, e.g. to hold its connect. */
	onCreate?: (a: FakeAdapter) => void;
}

export function fakeAdapters(respond?: Responder): FakeKit {
	const kit: FakeKit = {
		all: [],
		byName: (name) => kit.all.find((a) => a.spec?.name === name),
		factory: (deps) => {
			const a = new FakeAdapter(deps, respond);
			kit.all.push(a);
			kit.onCreate?.(a);
			return a;
		},
	};
	return kit;
}

/** An auto responder: answers each message with "<agent> handled: <first line of its task or message>". */
export const echoResponder: Responder = (req, adapter) => {
	const lines = req.text.split("\n");
	const task = lines[lines.indexOf("Task:") + 1];
	const first = req.from === "agent-link" && task ? task : (lines[0] ?? "");
	return { stopReason: "end_turn", text: `${adapter.spec?.name ?? "?"} handled: ${first}` };
};
