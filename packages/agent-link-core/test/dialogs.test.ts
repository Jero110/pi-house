import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dialogOptions, dialogText, keysForChoice, matchDialog, normalizeScreen } from "../src/dialogs.ts";
import type { DialogSpec } from "../src/types.ts";

const profile = (name: string): DialogSpec[] =>
	JSON.parse(readFileSync(new URL(`../profiles/${name}.json`, import.meta.url), "utf8")).dialogs;
const CLAUDE = profile("claude");
const CODEX = profile("codex");

// Screens read with cmux read-screen from real Claude Code 2.1.305 panes (docs/e2e/v2/interfaz/dialogos).
const CHANNELS_NARROW = `────────────────────
  WARNING: Loading
  development
  channels

  --dangerously-lo
  ad-development-c
  hannels is for
  local channel
  development
  only. Do not use
  this option to
  run channels you
  have downloaded
  off the
  internet.

  Please use
  --channels to
  run a list of
  approved
  channels.

  Channels:
  server:xi

  ❯ 1. I am using
       this for
       local
       development
    2. Exit

  Enter to confirm
  · Esc to cancel
`;

// A narrower pane, where Claude also splits words ("local deve / lopment") and the footer.
const CHANNELS_SPLIT_WORDS = `  WARNING:
  Loading
  development
  channels

  Channels:
  server:xi

  ❯ 1. I am using
       this for
       local deve
       lopment
    2. Exit

  Enter to
  confirm · Esc
  to cancel
`;

const CHANNELS_WIDE = `──────────────────────────────────────────────────────────────────────
  WARNING: Loading development channels

  --dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you
  have downloaded off the internet.

  Please use --channels to run a list of approved channels.

  Channels: server:xi

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel
`;

const TRUST = ` Accessing workspace:

 /private/tmp/scratchpad/perm-test

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project,
 or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 ⚠ This folder pre-approves 2 tool permissions in .claude/settings.json:
   Bash(ls *) and Bash(cat *)
 These will apply without asking. Only proceed if you trust this configuration.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

const WORKING = ` ▐▛███▛█   Claude Code v2.1.305
▝▜██████▀  Haiku 5.5 · Claude Pro
❯ Te lanzó el orquestador executor por encargo del usuario.
  Ran 1 shell command
───────────────────────────────────────────────────────────────────────────────
❯
───────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

test("a pane's text collapses to one line, wraps and box borders included", () => {
	assert.equal(
		normalizeScreen("│ I am using │\n│   this for  │\n  local\n development"),
		"I am using this for local development",
	);
});

test("the development channels warning is answered in a narrow pane, where its option wraps", () => {
	// A worker stayed on this screen: the old pattern needed "I am using this for local" on one line.
	assert.deepEqual(dialogOptions(CHANNELS_NARROW), [
		{ label: "I am using this for local development", selected: true },
		{ label: "Exit", selected: false },
	]);
	assert.deepEqual(matchDialog(CHANNELS_NARROW, CLAUDE), { kind: "known", name: "dev-channels", keys: ["enter"] });
	assert.deepEqual(matchDialog(CHANNELS_WIDE, CLAUDE), { kind: "known", name: "dev-channels", keys: ["enter"] });
	// Seen live: the pane split words in the warning, the option and the footer.
	assert.deepEqual(matchDialog(CHANNELS_SPLIT_WORDS, CLAUDE), { kind: "known", name: "dev-channels", keys: ["enter"] });
});

test("keys move from where the cursor is to the chosen option", () => {
	const onExit = CHANNELS_WIDE.replace("❯ 1. I am using", "  1. I am using").replace("    2. Exit", "  ❯ 2. Exit");
	assert.deepEqual(matchDialog(onExit, CLAUDE), { kind: "known", name: "dev-channels", keys: ["up", "enter"] });
	// The trust dialog also lists pre-approved tools; it is recognized as trust, and "Yes" is one down.
	assert.deepEqual(matchDialog(TRUST, CLAUDE), { kind: "known", name: "trust", keys: ["down", "enter"] });
});

test("a known dialog whose option is not on screen is unknown, so no key is sent blindly", () => {
	const cut = CHANNELS_WIDE.replace(/ {2}❯ 1\. I am using this for local development\n {4}2\. Exit\n/, "");
	const match = matchDialog(cut, CLAUDE);
	assert.equal(match.kind, "unknown");
});

test("an unknown dialog comes back with its text and options; a working session is none", () => {
	const other = " Do you want to enable telemetry?\n\n ❯ 1. Yes\n   2. No\n\n Enter to confirm · Esc to cancel\n";
	assert.deepEqual(matchDialog(other, CLAUDE), {
		kind: "unknown",
		text: "Do you want to enable telemetry? ❯ 1. Yes 2. No Enter to confirm · Esc to cancel",
		options: ["Yes", "No"],
	});
	assert.deepEqual(matchDialog(WORKING, CLAUDE), { kind: "none" });
	assert.deepEqual(matchDialog("", CLAUDE), { kind: "none" });
});

// Read with cmux read-screen from a real Claude Code 2.1.305 pane, 20 columns wide, started in a folder
// with a .mcp.json (docs/e2e/v2/dialogos). The shell command that started it is still on screen.
const MCP_NARROW = `cd /private/tmp/scratchpad/mcpdir && claude --model claude-haiku-5-5
Last login: Tue Oct 20 21:20:09 on ttys008
 ~/De/xi-/v2-dialogs    v2-dialogs
❯ cd /private/tmp/scratchpad/mcpdir && claude --model claude-haiku-5-5

────────────────────

────────────────────
  New MCP server
  found in this
  project: demo

  MCP servers may
  execute code or
  access system
  resources. All
  tool calls
  require
  approval. Learn
  more in the MCP
  documentation.

    Use this MCP
    server
    Use this and all
    future MCP
    servers in this
    project
  ❯ Continue without
    using this MCP
    server

  Enter to confirm
  · Esc to cancel
`;

// The same pane on the trust dialog: unnumbered options, and "Yes, I trust this folder" wraps.
const TRUST_NARROW = `────────────────────
 Accessing
 workspace:

 /private/tmp/claud
 e-503/mcpdir

 Quick safety
 check: Is this a
 project you
 created or one you
 trust? (Like your
 own code, a
 well-known open
 source project, or
 work from your
 team).

 Security guide

 ❯ No, exit
   Yes, I trust this
   folder

 Enter to confirm ·
 Esc to cancel
`;

// pi 1.3.0's project trust selector, drawn from its source (trust-selector.js): → marks the cursor,
// ✓ the saved choice, and the footer is "↑↓ navigate  enter save  esc cancel".
const PI_TRUST = `────────────────────────────────────────

 Project trust
 /work/repo

 Saved decision: none
 Current session: untrusted

 → Trust
   Trust (this session only)
   ✓ Do not trust

 ↑↓ navigate  enter save  esc cancel

────────────────────────────────────────
`;

test("an unknown dialog in a narrow pane keeps its wrapped options whole, and its text leaves out the shell", () => {
	const match = matchDialog(MCP_NARROW, CLAUDE);
	assert.equal(match.kind, "unknown");
	if (match.kind !== "unknown") return;
	assert.deepEqual(match.options, [
		"Use this MCP server",
		"Use this and all future MCP servers in this project",
		"Continue without using this MCP server",
	]);
	assert.match(match.text, /^New MCP server found in this project: demo MCP servers may execute code/);
	assert.doesNotMatch(match.text, /claude --model|Last login/);
});

test("the trust dialog is still known in a narrow pane, where its option wraps without a number", () => {
	assert.deepEqual(dialogOptions(TRUST_NARROW), [
		{ label: "No, exit", selected: true },
		{ label: "Yes, I trust this folder", selected: false },
	]);
	assert.deepEqual(matchDialog(TRUST_NARROW, CLAUDE), { kind: "known", name: "trust", keys: ["down", "enter"] });
});

test("pi's dialogs are recognized by their arrow cursor and footer, and none is answered by itself", () => {
	assert.deepEqual(profile("pi"), []);
	assert.deepEqual(matchDialog(PI_TRUST, profile("pi")), {
		kind: "unknown",
		text: "Project trust /work/repo Saved decision: none Current session: untrusted → Trust Trust (this session only) ✓ Do not trust ↑↓ navigate enter save esc cancel",
		options: ["Trust", "Trust (this session only)", "Do not trust"],
	});
});

test("a choice becomes keys from the cursor: by number as listed, or by the option's text", () => {
	assert.deepEqual(keysForChoice(MCP_NARROW, 1), {
		keys: ["up", "up", "enter"],
		option: "Use this MCP server",
		index: 0,
	});
	assert.deepEqual(keysForChoice(MCP_NARROW, "3"), {
		keys: ["enter"],
		option: "Continue without using this MCP server",
		index: 2,
	});
	assert.deepEqual(keysForChoice(PI_TRUST, "trust (THIS session only)"), {
		keys: ["down", "enter"],
		option: "Trust (this session only)",
		index: 1,
	});
	assert.deepEqual(keysForChoice(MCP_NARROW, 4), { error: "there is no option 4" });
	assert.deepEqual(keysForChoice(MCP_NARROW, "Maybe"), { error: 'there is no option "Maybe"' });
	assert.deepEqual(keysForChoice(WORKING, 1), { error: "no options with a cursor were found on screen" });
});

test("a dialog's text starts at the rule above it; without a rule it is the whole screen", () => {
	assert.match(dialogText(CHANNELS_WIDE), /^WARNING: Loading development channels/);
	assert.equal(dialogText("Pick one\n ❯ 1. A\n   2. B\n Enter to confirm"), "Pick one ❯ 1. A 2. B Enter to confirm");
});

// A real run's pane (docs/e2e/v2/dialogos/corrida-2/mcp-dialogo.txt): options wrap after full lines, and a
// continuation can start with a capital ("MCP servers"), so case alone splits them wrong.
const MCP_REAL = `─────────────────
  New MCP
  server found
  in this
  project: demo

  MCP servers
  may execute
  code or
  access system
  resources.
  All tool
  calls require
  approval.
  Learn more in
  the MCP docu
  mentation.

    Use this MCP
    server
    Use this and
    all future
    MCP servers
    in this
    project
  ❯ Continue
    without using
    this MCP
    server

  Enter to
  confirm · Esc
  to cancel
`;

test("in a 17-column pane a full line continues the option even when the next line starts with a capital", () => {
	const match = matchDialog(MCP_REAL, CLAUDE);
	assert.equal(match.kind, "unknown");
	if (match.kind === "unknown")
		assert.deepEqual(match.options, [
			"Use this MCP server",
			"Use this and all future MCP servers in this project",
			"Continue without using this MCP server",
		]);
	assert.deepEqual(keysForChoice(MCP_REAL, 3), {
		keys: ["enter"],
		option: "Continue without using this MCP server",
		index: 2,
	});
});

// The real run's pi pane (docs/e2e/v2/dialogos/corrida-2/pi-trust-dialogo.txt): pi uses the whole width and wraps
// an option to the left of where options start, so "Do not trust" after a full line is still an option.
const PI_TRUST_REAL = `─────────────────

 Trust project   
 folder?         
 /private/var/fo 
 lders/bd/9s56fd 
 mn7dq3gkp6r8f48 
 gzh0000gq/T/xi- 
 e2e-dialogs-XqI 
 2Bh/trust       
                 
 This allows pi  
 to load .pi     
 settings and    
 resources,      
 install missing 
 project         
 packages, and   
 execute project 
 extensions.     

 → Trust         
   Trust parent  
 folder          
 (/private/var/f 
 olders/bd/9s56f 
 dmn7dq3gkp6r8f4 
 8gzh0000gq/T/xi 
 -e2e-dialogs-Xq 
 I2Bh)           
   Trust (this   
 session only)   
   Do not trust  
   Do not trust  
 (this session   
 only)           

 ↑↓ navigate     
 enter select    
 escape/ctrl+c   
 cancel          

─────────────────
`;

test("in a narrow pi pane an option's wrapped lines are the ones left of where options start", () => {
	assert.deepEqual(
		dialogOptions(PI_TRUST_REAL).map((o) => o.label),
		[
			"Trust",
			"Trust parent folder (/private/var/f olders/bd/9s56f dmn7dq3gkp6r8f4 8gzh0000gq/T/xi -e2e-dialogs-Xq I2Bh)",
			"Trust (this session only)",
			"Do not trust",
			"Do not trust (this session only)",
		],
	);
	assert.deepEqual(keysForChoice(PI_TRUST_REAL, "Trust (this session only)"), {
		keys: ["down", "down", "enter"],
		option: "Trust (this session only)",
		index: 2,
	});
});

// A real run's pane (docs/e2e/v2/dialogos/corrida-3/mcp-dialogo.txt), 16 columns: "    Use this MCP"
// fills the rule's width, so Claude keeps no free columns on the right of its options.
const MCP_REAL_16 = `/bin/sh /var/folders/bd/9s56fdmn7dq3gkp6r8f48gzh0000gq/T/xi-launch/441e83c0383571a2.sh
Last login: Wed Oct 21 11:41:48 on ttys006
 ~/De/xi-/v2-dialogs    v2-dialogs !2 ?1  
❯ /bin/sh /var/folders/bd/9s56fdmn7dq3gkp6r8f48gzh0000gq/T/xi-launch/441e83c0383571a2.sh

────────────────
  New MCP
  server found
  in this
  project:
  demo

  MCP servers
  may execute
  code or
  access
  system
  resources.
  All tool
  calls
  require
  approval.
  Learn more
  in the MCP 
  documentatio
  n.

    Use this MCP
    server
    Use this and
    all future
    MCP servers
    in this
    project
  ❯ Continue
    without
    using this
    MCP server

  Enter to
  confirm ·
  Esc to
  cancel
`;

test("in a 16-column pane a short line is not full, so the next capital starts an option", () => {
	assert.deepEqual(
		dialogOptions(MCP_REAL_16).map((o) => o.label),
		[
			"Use this MCP server",
			"Use this and all future MCP servers in this project",
			"Continue without using this MCP server",
		],
	);
});

test("the Claude 2.1.309 trust dialog, with No first, is answered with down and enter", () => {
	const screen = readFileSync(new URL("./fixtures/claude-trust-2.1.309.txt", import.meta.url), "utf8");
	assert.deepEqual(matchDialog(screen, CLAUDE), { kind: "known", name: "trust", keys: ["down", "enter"] });
});

test("Codex's hooks review dialog is skipped with escape, its own skip key", () => {
	const screen = [
		"  Hooks need review",
		"  1 hook is new or changed.",
		"› 1. Review hooks",
		"  2. Trust all and continue",
		"  3. Continue without trusting",
		"     (hooks won't run)",
		"  enter confirm · esc skip",
	].join("\n");
	assert.deepEqual(matchDialog(screen, CODEX), { kind: "known", name: "hooks-review", keys: ["escape"] });
});
