#!/usr/bin/env node
// cmux-mcp: the cmux MCP server over stdio. Harnesses start it as `node <this file>`.
import { cmuxRunner } from "./cmux.ts";
import { serveMcp } from "./server.ts";
import { cmuxTools, INSTRUCTIONS } from "./tools.ts";

export const SERVER_NAME = "cmux";

export function runCmuxMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	return serveMcp({
		name: SERVER_NAME,
		version: "0.1.0",
		instructions: INSTRUCTIONS,
		tools: cmuxTools({ run: cmuxRunner(env), env }),
	});
}

if (import.meta.main) await runCmuxMcp();
