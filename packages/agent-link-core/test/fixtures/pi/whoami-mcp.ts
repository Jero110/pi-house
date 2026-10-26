// A stub MCP server for the dev scripts (try-pi.ts, try-codex.ts): one tool, whoami, that returns the agent-link
// identity env vars it inherited from its harness. It stands in for the real agent-link MCP server to check that a
// harness started by an adapter runs the MCP server it was given, with the agent's identity.
import { createInterface } from "node:readline";

const write = (m: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
	const m: unknown = JSON.parse(line);
	if (typeof m !== "object" || m === null || !("method" in m)) return;
	const { id, method } = m as { id?: number | string; method: string };
	if (method === "initialize") {
		write({
			id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "agent-link-stub", version: "0.0.1" },
			},
		});
	} else if (method === "tools/list") {
		write({
			id,
			result: {
				tools: [
					{
						name: "whoami",
						description: "Returns which agent-link agent this session is.",
						inputSchema: { type: "object", properties: {} },
					},
				],
			},
		});
	} else if (method === "tools/call") {
		const text = `agent=${process.env.AGENT_LINK_AGENT ?? "UNSET"} depth=${process.env.AGENT_LINK_DEPTH ?? "UNSET"}`;
		write({ id, result: { content: [{ type: "text", text }] } });
	} else if (id !== undefined) {
		write({ id, result: {} });
	}
});
