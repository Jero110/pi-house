// A minimal MCP server over stdio: initialize, tools/list, tools/call and ping, one JSON object per line.
// No SDK on purpose: these four methods are all a tool server needs, and it keeps the package dependency-free.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface JsonSchema {
	type: "object";
	properties: Record<string, Record<string, unknown>>;
	required?: string[];
}

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
	content: Content[];
	isError?: boolean;
}

export interface Tool {
	name: string;
	description: string;
	inputSchema: JsonSchema;
	run(args: Record<string, unknown>): Promise<ToolResult>;
}

export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
export const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

export interface ServeOptions {
	name: string;
	version: string;
	instructions: string;
	tools: readonly Tool[];
	input?: Readable;
	output?: Writable;
}

type Json = Record<string, unknown>;

export function serveMcp(opts: ServeOptions): Promise<void> {
	const output = opts.output ?? process.stdout;
	const write = (msg: Json) => output.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
	const byName = new Map(opts.tools.map((t) => [t.name, t]));

	const handle = async (req: Json): Promise<void> => {
		const id = req.id;
		const method = req.method;
		if (id === undefined || id === null) return; // a notification
		if (method === "initialize") {
			const params = (req.params ?? {}) as Json;
			write({
				id,
				result: {
					protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: opts.name, version: opts.version },
					instructions: opts.instructions,
				},
			});
		} else if (method === "ping") {
			write({ id, result: {} });
		} else if (method === "tools/list") {
			write({
				id,
				result: {
					tools: opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
				},
			});
		} else if (method === "tools/call") {
			const params = (req.params ?? {}) as Json;
			const tool = byName.get(String(params.name));
			if (!tool) {
				write({ id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } });
				return;
			}
			const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Json;
			const result = await tool.run(args).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
			write({ id, result });
		} else {
			write({ id, error: { code: -32601, message: `method not found: ${String(method)}` } });
		}
	};

	return new Promise((resolve) => {
		const rl = createInterface({ input: opts.input ?? process.stdin });
		const pending = new Set<Promise<void>>();
		rl.on("line", (line) => {
			if (!line.trim()) return;
			let req: Json;
			try {
				req = JSON.parse(line) as Json;
			} catch {
				write({ id: null, error: { code: -32700, message: "parse error" } });
				return;
			}
			const p = handle(req).finally(() => pending.delete(p));
			pending.add(p);
		});
		rl.on("close", () => {
			void Promise.all(pending).then(() => resolve());
		});
	});
}
