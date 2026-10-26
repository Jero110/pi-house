// `agent-link status`: the running hub's agents as trees. `agent-link stop`: ends the daemon and its agents.
import { createHubClient, hubPaths, readToken, socketAnswers, stopHub } from "agent-link-core";

type Listed = Awaited<ReturnType<ReturnType<typeof createHubClient>["agents"]>>["agents"][number];

/** One line per agent, indented by depth: name · harness · model · state, then pull, pane, queue. */
export function formatTree(agents: readonly Listed[]): string[] {
	return agents.map((a) => {
		const parts = [a.name, a.harness, ...(a.model ? [a.model] : []), a.state];
		if (a.pull) parts.push("pull (results wait for inbox)");
		if (a.backend && a.pane) parts.push(`${a.backend} ${a.pane}`);
		if (a.queued) parts.push(`${a.queued} queued`);
		return `${"  ".repeat(a.depth)}${a.depth ? "└ " : ""}${parts.join(" · ")}`;
	});
}

export async function status(home: string, out: (l: string) => void): Promise<number> {
	const paths = hubPaths(home);
	if (!(await socketAnswers(paths.socket))) {
		out(`no agent-link hub running (${paths.socket} does not answer)`);
		return 1;
	}
	const { agents } = await createHubClient({ socket: paths.socket, token: readToken(home) }).agents();
	const live = agents.filter((a) => a.state !== "exited").length;
	out(`agent-link hub on ${paths.socket}: ${agents.length} agents, ${live} not exited`);
	for (const line of formatTree(agents)) out(line);
	return 0;
}

export async function stop(home: string, out: (l: string) => void): Promise<number> {
	const paths = hubPaths(home);
	if (!(await socketAnswers(paths.socket))) {
		out("no agent-link hub running");
		return 1;
	}
	if (!(await stopHub(home))) {
		out(`the hub on ${paths.socket} did not stop (no pid file, or it did not exit within 10 s)`);
		return 1;
	}
	out("stopped the agent-link hub; its agents were closed with it");
	return 0;
}
