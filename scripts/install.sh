#!/usr/bin/env bash
# cimiento installer, spec section 14. macOS, and Ubuntu, also under WSL on Windows. It installs
# only what is missing, so running it again is safe, and it ends with a table of every tool.
#
# Homebrew comes first: when it is missing it is installed, which asks for the password once. On
# Ubuntu the packages Homebrew needs come from apt first. Every tool then comes from Homebrew, or
# from npm on Homebrew's node.
#
# At the end, Claude Code is logged in, as a person step in English or Spanish (--lang es, or a
# Spanish LANG).
#
# Usage: bash install.sh [--lang en|es] [--dry-run]
# CIMIENTO_VERSION=0.4.1 pins the cimiento release; without it the latest is installed.

set -euo pipefail

ARGS="$*"
DRY_RUN=0
LANG_CODE="en"
case "${LC_ALL:-${LANG:-}}" in es*) LANG_CODE="es" ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --lang) LANG_CODE="${2:-en}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1. Usage: bash install.sh [--lang en|es] [--dry-run]" >&2; exit 1 ;;
  esac
done

OS="$(uname -s)"
ARCH="$(uname -m)"
ROWS=""

# The run log, spec section 7: one JSON line per thing shown, with a UTC timestamp.
RUNS_DIR="${CIMIENTO_RUNS_DIR:-$HOME/.cimiento/runs}"
mkdir -p "$RUNS_DIR" 2>/dev/null || true
RUN_LOG="$RUNS_DIR/$(date -u +%Y-%m-%dT%H-%M-%SZ)-install.jsonl"
json_string() { printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS="\\n"} {print}' | sed -e 's/\\n$//'; }
log_line() { printf '{"ts":"%s",%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$RUN_LOG" 2>/dev/null || true; }
say() { printf '%s\n' "$*"; log_line "\"type\":\"output\",\"stream\":\"stdout\",\"text\":\"$(json_string "$*")\""; }
row() {
  local how="$3"
  # A dry run installs nothing, so the table says what a real run would do.
  if [ "$DRY_RUN" = "1" ]; then how="$(printf '%s' "$how" | sed 's/^installed/would be installed/')"; fi
  set -- "$1" "$2" "$how"
  ROWS="${ROWS}$1|$2|$3"$'\n'
  log_line "\"type\":\"event\",\"event\":{\"event\":\"tool\",\"tool\":\"$(json_string "$1")\",\"version\":\"$(json_string "$2")\",\"how\":\"$(json_string "$3")\"}"
}
log_line "\"type\":\"start\",\"command\":\"install\",\"argv\":\"$(json_string "$ARGS")\""
trap 'log_line "\"type\":\"end\",\"exitCode\":$?"' EXIT
have() { command -v "$1" >/dev/null 2>&1; }
run() {
  if [ "$DRY_RUN" = "1" ]; then say "would run: $*"; return 0; fi
  "$@"
}
first_version() { "$@" 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true; }

# Ubuntu, and whether it runs under WSL. Tests point these at files of their own.
OS_RELEASE="${CIMIENTO_OS_RELEASE:-/etc/os-release}"
PROC_VERSION="${CIMIENTO_PROC_VERSION:-/proc/version}"
WSL=0
case "$OS" in
  Darwin)
    PLATFORM="macOS"
    DEFAULT_PROFILE="$HOME/.zprofile"
    DEFAULT_BREW="/opt/homebrew/bin/brew /usr/local/bin/brew"
    PASSWORD="your Mac password"
    MACHINE="Mac"
    ;;
  Linux)
    DISTRO="$(sed -n 's/^ID=//p' "$OS_RELEASE" 2>/dev/null | tr -d '"' | head -n 1)"
    if [ "$DISTRO" != "ubuntu" ]; then
      say "cimiento's installer supports macOS and Ubuntu, also under WSL on Windows. This Linux reports ${DISTRO:-no distribution}. Install node 22, pnpm, gh, vercel and supabase with your package manager, then npm install -g cimiento."
      exit 1
    fi
    if grep -qi microsoft "$PROC_VERSION" 2>/dev/null; then WSL=1; PLATFORM="Ubuntu on WSL"; else PLATFORM="Ubuntu"; fi
    DEFAULT_PROFILE="$HOME/.bashrc"
    DEFAULT_BREW="/home/linuxbrew/.linuxbrew/bin/brew $HOME/.linuxbrew/bin/brew"
    PASSWORD="your Ubuntu password (sudo)"
    MACHINE="computer"
    ;;
  *)
    say "cimiento's installer supports macOS and Ubuntu, also under WSL on Windows. On Windows, install Ubuntu with wsl --install in PowerShell, then run this installer inside Ubuntu."
    exit 1
    ;;
esac
case "$ARCH" in
  arm64|aarch64|x86_64) ;;
  *) say "This machine reports architecture $ARCH, which cimiento does not know."; exit 1 ;;
esac
PROFILE="${CIMIENTO_PROFILE:-$DEFAULT_PROFILE}"

BREW_CANDIDATES="${CIMIENTO_BREW_CANDIDATES:-$DEFAULT_BREW}"
for candidate in $BREW_CANDIDATES; do
  if ! have brew && [ -x "$candidate" ]; then eval "$("$candidate" shellenv)"; fi
done

brew_writable() {
  local prefix
  prefix="$(brew --prefix 2>/dev/null)" || return 1
  [ -w "$prefix/bin" ]
}

if have brew && ! brew_writable; then
  say "Homebrew on this $MACHINE belongs to another account, so this account cannot install with it. Run the installer from the account that installed Homebrew, which on a $MACHINE of your own is your usual account."
  exit 1
fi

say "Installing cimiento and the tools it uses, on $PLATFORM."

# On Ubuntu, what Homebrew needs to build and run, and libsecret-tools for cimiento's keychain
# secrets (secret-tool). Only the missing packages, in one apt install.
if [ "$OS" = "Linux" ]; then
  MISSING=""
  for pkg in build-essential procps curl file git libsecret-tools; do
    dpkg -s "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"
  done
  if [ -n "$MISSING" ]; then
    say "Installing with apt:$MISSING. It asks for $PASSWORD once."
    run sudo apt-get update
    run sudo apt-get install -y $MISSING
    row "apt packages" "-" "installed:$MISSING"
  else
    row "apt packages" "-" "already there"
  fi
fi

# Homebrew
if have brew; then
  row "Homebrew" "$(first_version brew --version)" "already there"
else
  say "Homebrew is not installed. It installs now and asks for $PASSWORD once."
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: the Homebrew installer from https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
  else
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  for candidate in $BREW_CANDIDATES; do
    if [ -x "$candidate" ]; then eval "$("$candidate" shellenv)"; fi
  done
  if [ "$DRY_RUN" != "1" ] && ! have brew; then
    say "Homebrew did not finish installing, so nothing else was installed. Run this installer again; it starts where it stopped."
    exit 1
  fi
  row "Homebrew" "$(first_version brew --version)" "installed"
fi

marker="# added by the cimiento installer"
if [ -f "$PROFILE" ] && grep -q "$marker" "$PROFILE"; then
  :
elif [ "$DRY_RUN" = "1" ]; then
  say "would add Homebrew to the PATH in $PROFILE"
else
  printf '\n%s\neval "$(%s/bin/brew shellenv)"\n' "$marker" "$(brew --prefix)" >> "$PROFILE"
fi

brew_tool() {
  local bin="$1" formula="$2" label="$3"
  if have "$bin"; then
    row "$label" "$(first_version "$bin" --version)" "already there"
  else
    run brew install "$formula"
    row "$label" "$(first_version "$bin" --version)" "installed with Homebrew"
  fi
}

npm_tool() {
  local bin="$1" pkg="$2" label="$3"
  if have "$bin"; then
    row "$label" "$(first_version "$bin" --version)" "already there"
  else
    run npm install -g "$pkg"
    row "$label" "$(first_version "$bin" --version)" "installed with npm"
  fi
}

brew_tool git git git

# node 22 or newer
node_major() { local v; v="$(first_version node --version)"; echo "${v%%.*}"; }
if have node && [ "$(node_major)" -ge 22 ] 2>/dev/null; then
  row "node" "$(first_version node --version)" "already there"
else
  run brew install node@22
  run brew link --overwrite --force node@22
  row "node" "$(first_version node --version)" "installed with Homebrew"
fi

npm_tool pnpm pnpm pnpm
brew_tool gh gh gh
npm_tool vercel vercel vercel
brew_tool supabase supabase/tap/supabase supabase
npm_tool claude @anthropic-ai/claude-code "Claude Code"

# cimiento itself, last.
# CIMIENTO_VERSION pins a release, such as 0.4.1; without it the latest one is installed.
WANT="${CIMIENTO_VERSION:-latest}"
HAVE="$(first_version cimiento --version)"
if have cimiento && [ "$HAVE" != "0.0.0" ] && { [ "$WANT" = "latest" ] || [ "$HAVE" = "$WANT" ]; }; then
  row "cimiento" "$HAVE" "already there"
else
  run npm install -g "cimiento@$WANT"
  row "cimiento" "$(first_version cimiento --version)" "installed with npm"
fi

# Claude Code needs a login before it can help with the project. The same person step as
# claudeLoginStep in src/core/person-steps.ts, checked against it by a test.
claude_logged_in() { claude auth status --json 2>/dev/null | grep -Eq '"loggedIn": *true'; }
interactive() { [ "${CIMIENTO_INTERACTIVE:-}" = "1" ] || [ -t 0 ]; }
if have claude && [ "$DRY_RUN" != "1" ] && ! claude_logged_in; then
  if [ "$LANG_CODE" = "es" ]; then
    T_TITLE="Inicia sesion en Claude Code. Necesita un plan Claude Pro o Max; el plan gratis no incluye Claude Code"
    T_OPEN="Abre:"; T_PATH="En el navegador, en este orden:"; T_FIELDS="En la pagina, en el orden en que aparecen:"
    T_P1="El instalador inicia claude auth login, que abre esta pagina"
    T_P2="Inicia sesion con la cuenta que tiene tu plan Pro o Max"
    T_P3="Claude pide permitir que Claude Code use tu cuenta"
    T_F1="Email (correo): el correo de tu cuenta Claude Pro o Max"
    T_BUTTON="Haz clic en: Authorize"
    T_SUCCESS="Cuando funciono: esta terminal dice que el inicio de sesion funciono, y claude auth status muestra loggedIn true"
    T_CHECKS="Luego cimiento lo comprueba."
    T_ENTER_OPEN="Pulsa Enter para abrirlo en tu navegador."
    T_ENTER_DONE="Pulsa Enter aqui cuando termines."
    T_LATER="Claude Code todavia no tiene sesion. Cuando quieras, ejecuta claude auth login en una terminal; necesita un plan Claude Pro o Max."
    T_FAILED="Claude Code sigue sin sesion. Ejecuta claude auth login en una terminal cuando tengas un plan Claude Pro o Max."
    T_WSL="En WSL, si el navegador no se abre solo, copia el enlace que muestra claude en el navegador de Windows."
  else
    T_TITLE="Log in to Claude Code. It needs a Claude Pro or Max plan; the free plan does not include Claude Code"
    T_OPEN="Open:"; T_PATH="In the browser, in this order:"; T_FIELDS="On the page, in the order it shows them:"
    T_P1="The installer starts claude auth login, which opens this page"
    T_P2="Sign in with the account that has your Pro or Max plan"
    T_P3="Claude asks to let Claude Code use your account"
    T_F1="Email: the email of your Claude Pro or Max account"
    T_BUTTON="Click: Authorize"
    T_SUCCESS="When it worked: this terminal says the login succeeded, and claude auth status shows loggedIn true"
    T_CHECKS="cimiento then checks it."
    T_ENTER_OPEN="Press Enter to open it in your browser."
    T_ENTER_DONE="Press Enter here when done."
    T_LATER="Claude Code is not logged in yet. When you are ready, run claude auth login in a terminal; it needs a Claude Pro or Max plan."
    T_FAILED="Claude Code is still not logged in. Run claude auth login in a terminal once you have a Claude Pro or Max plan."
    T_WSL="On WSL, if the browser does not open by itself, copy the link claude prints into your Windows browser."
  fi
  if interactive; then
    say ""
    say "$T_TITLE"
    say "$T_OPEN https://claude.ai/login"
    if [ "$WSL" = "1" ]; then say "$T_WSL"; fi
    say "$T_PATH"
    say "  1. $T_P1"
    say "  2. $T_P2"
    say "  3. $T_P3"
    say "$T_FIELDS"
    say "  $T_F1"
    say "$T_BUTTON"
    say "$T_SUCCESS"
    say "$T_CHECKS"
    printf '%s ' "$T_ENTER_OPEN"
    log_line "\"type\":\"prompt\",\"kind\":\"enter\",\"question\":\"$(json_string "$T_ENTER_OPEN")\""
    read -r _ || true
    log_line "\"type\":\"answer\",\"kind\":\"enter\",\"answer\":\"\""
    claude auth login --claudeai || true
    printf '%s ' "$T_ENTER_DONE"
    log_line "\"type\":\"prompt\",\"kind\":\"enter\",\"question\":\"$(json_string "$T_ENTER_DONE")\""
    read -r _ || true
    log_line "\"type\":\"answer\",\"kind\":\"enter\",\"answer\":\"\""
    if claude_logged_in; then
      row "Claude login" "-" "logged in"
    else
      say "$T_FAILED"
      row "Claude login" "-" "not logged in yet"
    fi
  else
    say "$T_LATER"
    row "Claude login" "-" "not logged in yet"
  fi
elif have claude && claude_logged_in; then
  row "Claude login" "-" "already logged in"
fi

say ""
printf '%-14s %-12s %s\n' "TOOL" "VERSION" "HOW"
printf '%s' "$ROWS" | while IFS='|' read -r name version how; do
  [ -n "$name" ] && printf '%-14s %-12s %s\n' "$name" "${version:--}" "$how"
done
say ""
if [ "$WSL" = "1" ]; then
  say "Done. Open a new Ubuntu window so the new PATH applies, then run: cimiento new my-app --guided"
else
  say "Done. Open a new Terminal window so the new PATH applies, then run: cimiento new my-app --guided"
fi
