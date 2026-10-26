#!/usr/bin/env bash
# pihouse installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Jero110/pihouse/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Jero110/pihouse/main/install.sh | bash -s -- --backend tmux
#
# What is missing is installed first: Node.js 24, git, and tmux when you choose tmux (Homebrew on macOS, installing
# Homebrew itself when needed; apt on Ubuntu, Debian and WSL). --no-deps skips that. --backend cmux|tmux skips the
# question. --with-harnesses also installs Claude Code, Codex and opencode with npm into ~/.local.
# --claude-bridge adds the Claude models on your Claude Code login (off by default; never the default model).
# On Windows, use install.ps1: it sets up WSL2 and runs this script inside it.
#
# It puts the code in ~/.pihouse/src (or uses the checkout it runs from), installs its npm dependencies, links
# `pih` and `agent-link` into ~/.local/bin, asks whether you work in cmux or tmux, and registers the MCP
# servers for that choice with every harness it finds (Claude Code, Codex, opencode, pi, pihouse).
# Environment: PIHOUSE_DIR (code), PIHOUSE_BIN_DIR (links), PIHOUSE_REPO (git URL), PIHOUSE_REF (branch or tag),
# PIHOUSE_HARNESS_PREFIX (npm prefix for --with-harnesses, default ~/.local).
set -euo pipefail

REPO="${PIHOUSE_REPO:-https://github.com/Jero110/pihouse.git}"
REF="${PIHOUSE_REF:-main}"
BIN_DIR="${PIHOUSE_BIN_DIR:-$HOME/.local/bin}"
ORIG_PATH="$PATH"
BACKEND=""
DEPS=yes
HARNESSES=no
BRIDGE=no
HARNESS_PREFIX="${PIHOUSE_HARNESS_PREFIX:-$HOME/.local}"

while [ $# -gt 0 ]; do
	case "$1" in
	--backend) BACKEND="${2:-}"; shift 2 ;;
	--backend=*) BACKEND="${1#*=}"; shift ;;
	--deps) DEPS=yes; shift ;;
	--no-deps) DEPS=no; shift ;;
	--with-harnesses) HARNESSES=yes; shift ;;
	--claude-bridge) BRIDGE=yes; shift ;;
	-h | --help) sed -n '2,19p' "$0" 2>/dev/null || true; exit 0 ;;
	*) echo "pih install: unknown option $1" >&2; exit 2 ;;
	esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'pih install: %s\n' "$*" >&2; exit 1; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# 1. cmux or tmux.
has() { command -v "$1" >/dev/null 2>&1; }
HAS_CMUX=no; { has cmux || [ -d /Applications/cmux.app ]; } && HAS_CMUX=yes
HAS_TMUX=no; has tmux && HAS_TMUX=yes
if [ -z "$BACKEND" ]; then
	DEFAULT=cmux
	[ "$HAS_CMUX" = no ] && [ "$HAS_TMUX" = yes ] && DEFAULT=tmux
	if [ -r /dev/tty ] && [ -w /dev/tty ]; then
		{
			echo
			echo "Where will you run your agents?"
			echo "  1) cmux  (recommended: agent sessions, panes, workspaces and a browser through the cmux MCP)$([ "$HAS_CMUX" = no ] && echo '  [not found]')"
			echo "  2) tmux$([ "$HAS_TMUX" = no ] && echo '  [not found]')"
			printf "Choose 1 or 2 [%s]: " "$([ "$DEFAULT" = cmux ] && echo 1 || echo 2)"
		} >/dev/tty
		read -r ANSWER </dev/tty || ANSWER=""
		case "$ANSWER" in
		1 | cmux) BACKEND=cmux ;;
		2 | tmux) BACKEND=tmux ;;
		*) BACKEND="$DEFAULT" ;;
		esac
	else
		BACKEND="$DEFAULT"
	fi
fi
case "$BACKEND" in cmux | tmux) ;; *) fail "--backend must be cmux or tmux" ;; esac
[ "$BACKEND" = cmux ] && [ "$HAS_CMUX" = no ] && echo "note: cmux was not found; install it from https://cmux.com before you start pihouse"

# 2. What is missing: Node.js 24, git, and tmux for the tmux backend.
git_ok() { git --version >/dev/null 2>&1; }
node_ok() { has node && has npm && [ "$(node_major)" -ge 24 ]; }
MISSING=""
git_ok || MISSING="$MISSING git"
node_ok || MISSING="$MISSING node"
[ "$BACKEND" = tmux ] && ! has tmux && MISSING="$MISSING tmux"
MISSING="${MISSING# }"
if [ -n "$MISSING" ] && [ "$DEPS" = yes ]; then
	case "$(uname -s)" in
	Darwin)
		brew_env() { for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && return 0; done; return 1; }
		has brew || brew_env || true
		if ! has brew; then
			say "Installing Homebrew, which then installs: $MISSING (it may ask for your password)"
			BREW_SH="$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
			if [ -r /dev/tty ]; then /bin/bash -c "$BREW_SH" </dev/tty; else NONINTERACTIVE=1 /bin/bash -c "$BREW_SH"; fi
			brew_env || fail "Homebrew did not install; install $MISSING by hand and run this again"
		fi
		say "Installing $MISSING with Homebrew"
		# shellcheck disable=SC2086 # one formula per word
		brew install $MISSING
		;;
	Linux)
		command -v apt-get >/dev/null || fail "missing: $MISSING. Install them with your package manager and run this again"
		if [ "$(id -u)" -eq 0 ]; then root() { "$@"; }; else root() { sudo "$@"; }; fi
		APT="curl ca-certificates"
		case " $MISSING " in *" git "*) APT="$APT git" ;; esac
		case " $MISSING " in *" tmux "*) APT="$APT tmux" ;; esac
		say "Installing $MISSING with apt (it may ask for your password)"
		root apt-get update -qq
		# shellcheck disable=SC2086 # one package per word
		root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $APT >/dev/null
		if ! node_ok; then
			say "Installing Node.js 24 from NodeSource"
			curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
			root bash /tmp/nodesource_setup.sh >/dev/null
			root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
			rm -f /tmp/nodesource_setup.sh
		fi
		;;
	*) fail "missing: $MISSING. Install them and run this again" ;;
	esac
	hash -r
fi

# 3. Requirements.
git_ok || fail "git is required"
has node || fail "Node.js 24 or newer is required (https://nodejs.org)"
has npm || fail "npm is required"
[ "$(node_major)" -ge 24 ] ||
	fail "Node.js 24 or newer is required, but $(command -v node) is $(node -v). Remove it or put the newer one first on PATH."
[ "$BACKEND" = tmux ] && ! has tmux && fail "tmux is required for the tmux backend"

# 4. The code: the checkout this script lives in, else a clone in ~/.pihouse/src.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
	SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/packages/pihouse/src/cli.ts" ] && [ -z "${PIHOUSE_DIR:-}" ]; then
	DIR="$SELF_DIR"
	say "Using the checkout in $DIR"
else
	DIR="${PIHOUSE_DIR:-$HOME/.pihouse/src}"
	if [ -d "$DIR/.git" ]; then
		say "Updating $DIR"
		git -C "$DIR" fetch --quiet origin "$REF"
		git -C "$DIR" checkout --quiet "$REF"
		git -C "$DIR" pull --quiet --ff-only origin "$REF"
	else
		say "Downloading pihouse into $DIR"
		mkdir -p "$(dirname "$DIR")"
		git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
	fi
fi

# 5. Dependencies, exactly as locked, without install scripts.
say "Installing dependencies"
(cd "$DIR" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error)

# 6. Commands on PATH.
mkdir -p "$BIN_DIR"
link() {
	cat >"$BIN_DIR/$1" <<EOF
#!/bin/sh
exec node "$DIR/$2" "\$@"
EOF
	chmod +x "$BIN_DIR/$1"
}
link pih packages/pihouse/src/cli.ts
link pihouse packages/pihouse/src/cli.ts
link agent-link packages/agent-link/src/cli.ts
export PATH="$BIN_DIR:$HARNESS_PREFIX/bin:$PATH"

# 6b. The harnesses, with --with-harnesses, before setup so it registers the MCP servers with them.
if [ "$HARNESSES" = yes ]; then
	say "Installing Claude Code, Codex and opencode into $HARNESS_PREFIX"
	npm install -g --prefix "$HARNESS_PREFIX" --no-audit --no-fund --no-update-notifier --loglevel=error \
		@anthropic-ai/claude-code @openai/codex opencode-ai
fi

# 7. MCP servers, pihouse's settings and its agent-link profile.
say "Setting up pihouse for $BACKEND"
SETUP_ARGS=(--backend "$BACKEND")
[ "$BRIDGE" = yes ] && SETUP_ARGS+=(--claude-bridge)
node "$DIR/packages/pihouse/src/cli.ts" setup "${SETUP_ARGS[@]}"

echo
say "pihouse is installed."
if [ "$BACKEND" = cmux ]; then
	echo "Open a terminal in cmux, cd into a project and run: pih"
else
	echo "Start tmux, cd into a project and run: pih"
fi
echo "Then try: /skill:planner <what you want to build>"

# Last, so it is the line people see: the command that puts pihouse on PATH, ready to paste.
case ":$ORIG_PATH:" in
*":$BIN_DIR:"*) ;;
*)
	RC="$HOME/.zshrc"
	[ "${SHELL##*/}" = bash ] && RC="$HOME/.bashrc"
	ADD="$BIN_DIR"
	[ "$HARNESSES" = yes ] && [ "$HARNESS_PREFIX/bin" != "$BIN_DIR" ] && ADD="$BIN_DIR:$HARNESS_PREFIX/bin"
	echo
	say "One more step: put pihouse on your PATH. Run:"
	echo
	echo "  echo 'export PATH=\"$ADD:\$PATH\"' >> $RC && source $RC"
	echo
	;;
esac
