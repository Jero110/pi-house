# pihouse Agent installer for Windows.
#
#   irm https://raw.githubusercontent.com/Jero110/pi-house/main/install.ps1 | iex
#
# pihouse needs a Unix shell, Unix sockets and tmux, so on Windows it runs inside WSL2 (Ubuntu). This script:
#   1. installs WSL2 with Ubuntu when it is missing (Windows asks for administrator rights and a restart; run the
#      script again afterwards);
#   2. inside Ubuntu, installs git, tmux and Node.js 24, then pihouse with the tmux backend (install.sh --deps);
#   3. with -WithHarnesses, also installs Claude Code, Codex and opencode inside Ubuntu.
#
# With options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Jero110/pi-house/main/install.ps1))) -WithHarnesses
# Options: -Distro <name> (default Ubuntu), -WithHarnesses, -Ref <branch or tag> (default main).
param(
	[string]$Distro = "Ubuntu",
	[switch]$WithHarnesses,
	[string]$Ref = "main"
)

$ErrorActionPreference = "Stop"

function Say([string]$Text) { Write-Host $Text -ForegroundColor Cyan }
function Fail([string]$Text) {
	Write-Host "pih install: $Text" -ForegroundColor Red
	exit 1
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
	Fail "WSL is not available. pihouse on Windows needs WSL2: Windows 10 version 2004 or newer, or Windows 11."
}

# wsl.exe prints UTF-16, which arrives with NUL characters in Windows PowerShell 5.
$distros = @(wsl.exe --list --quiet 2>$null | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ })

# An Ubuntu that is already there (e.g. "Ubuntu-24.04") is used rather than installing another one.
if ($Distro -eq "Ubuntu" -and $distros -notcontains $Distro) {
	$existing = $distros | Where-Object { $_ -like "Ubuntu*" } | Select-Object -First 1
	if ($existing) { $Distro = $existing }
}

if ($distros -notcontains $Distro) {
	Say "Installing WSL2 with $Distro. Windows may ask for administrator rights and a restart."
	wsl.exe --install -d $Distro
	if ($LASTEXITCODE -ne 0) { Fail "wsl --install failed. Open PowerShell as administrator and run this again." }
	Write-Host ""
	Write-Host "Next:"
	Write-Host "  1. Restart Windows if it asks you to."
	Write-Host "  2. Open '$Distro' from the Start menu once and create your Linux user."
	Write-Host "  3. Run this installer again."
	exit 0
}

$flags = "--backend tmux --deps"
if ($WithHarnesses) { $flags += " --with-harnesses" }
$url = "https://raw.githubusercontent.com/Jero110/pi-house/$Ref/install.sh"
# The script runs from a file inside WSL, so no quotes cross from PowerShell to wsl.exe (Windows PowerShell 5 passes
# embedded double quotes unescaped) and the installer keeps the terminal as stdin for apt's password prompt.
$script = @(
	"set -e",
	"export PIHOUSE_REF='$Ref'",
	"curl -fsSL '$url' -o /tmp/pihouse-install.sh",
	"bash /tmp/pihouse-install.sh $flags",
	"rm -f /tmp/pihouse-install.sh",
	'# ~/.local/bin holds pihouse, agent-link and the harnesses; new Ubuntu shells get it on PATH.',
	'grep -qs "HOME/.local/bin" ~/.bashrc || echo ''export PATH="$HOME/.local/bin:$PATH"'' >> ~/.bashrc'
) -join "`n"
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))

Say "Installing pihouse inside $Distro. apt may ask for your Linux password."
wsl.exe -d $Distro -- bash -lc "echo $encoded | base64 -d > /tmp/pihouse-setup.sh && bash /tmp/pihouse-setup.sh; status=`$?; rm -f /tmp/pihouse-setup.sh; exit `$status"
if ($LASTEXITCODE -ne 0) { Fail "the install inside $Distro failed; see the messages above." }

Write-Host ""
Say "pihouse is installed in $Distro."
Write-Host "Open '$Distro' (or run: wsl -d $Distro), then:"
Write-Host "  tmux"
Write-Host "  cd ~/your-project"
Write-Host "  pihouse"
Write-Host "Keep projects in the Linux home (~/), not under /mnt/c: file access there is much faster."
if (-not $WithHarnesses) {
	Write-Host "Install the harnesses you want pihouse to use inside $Distro, or run this again with -WithHarnesses."
}
