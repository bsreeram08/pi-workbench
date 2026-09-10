#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Install Sreeram's Pi Workbench.

Usage: ./install.sh [--full] [--strict]

  --full    Opt into the custom startup header, Ember theme, Grok-first model
            defaults, preference baseline, status line, and trusted skill-evolution
            profile. Existing JSON values win except active model/thinking defaults
            become xAI Grok 4.6/high and the active theme becomes Ember.
  --strict  Require Bun and TypeScript and run every development check.
  --help    Show this help.

The default installation links Workbench, the cmux companion, the framed editor,
and the Ember file, but preserves the active theme and does not merge preferences,
companion packages, or skill-evolution settings.
EOF
}

FULL=0
STRICT=0
while (($# > 0)); do
  case "$1" in
    --full) FULL=1 ;;
    --strict) STRICT=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'error: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CANONICAL_AGENT_DIR=""
TARGET_EXTENSION="$AGENT_DIR/extensions/pi-workbench"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_ROOT="$AGENT_DIR/backups/pi-workbench/$STAMP"
PI_BIN=""
BUN_BIN=""
TSC_BIN=""
COMMITTING=0
ROLLBACK_TARGETS=()
ROLLBACK_BACKUPS=()
TEMP_FILES=()

realpath_portable() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

# Keep install targets in the exact user-selected location, but give child
# validation commands a canonical path so macOS /tmp and /var aliases do not
# fail Workbench's no-symlink coordination checks.
CANONICAL_AGENT_DIR="$(realpath_portable "$AGENT_DIR")"

rollback_links() {
  local index target backup
  for ((index=${#ROLLBACK_TARGETS[@]}-1; index>=0; index--)); do
    target="${ROLLBACK_TARGETS[$index]}"
    backup="${ROLLBACK_BACKUPS[$index]}"
    if [[ -L "$target" ]]; then
      rm -- "$target"
    elif [[ -e "$target" ]]; then
      printf 'warning: rollback left an unexpected non-symlink at %s; backup remains at %s\n' "$target" "$backup" >&2
      continue
    fi
    if [[ -n "$backup" && ( -e "$backup" || -L "$backup" ) ]]; then
      mkdir -p "$(dirname "$target")"
      mv -- "$backup" "$target"
    fi
  done
}

on_exit() {
  local status="$1"
  if ((status != 0 && COMMITTING == 1)); then
    printf 'installation failed; restoring replaced links\n' >&2
    rollback_links || true
  fi
  if ((${#TEMP_FILES[@]} > 0)); then
    rm -f -- "${TEMP_FILES[@]}"
  fi
  return "$status"
}
trap 'on_exit "$?"' EXIT
trap 'exit 130' HUP INT TERM

for command in git node python3 pi; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'error: required command not found: %s\n' "$command" >&2
    exit 1
  fi
done
PI_BIN="$(command -v pi)"
BUN_BIN="$(command -v bun 2>/dev/null || true)"
TSC_BIN="$(command -v tsc 2>/dev/null || true)"
if ((STRICT == 1)) && [[ -z "$BUN_BIN" || -z "$TSC_BIN" ]]; then
  printf 'error: --strict requires bun and tsc on PATH\n' >&2
  exit 1
fi

CLEAN_ENV=(env -i "HOME=$HOME" "PATH=$PATH" "TMPDIR=${TMPDIR:-/tmp}" "PI_CODING_AGENT_DIR=$CANONICAL_AGENT_DIR" "NO_COLOR=1")

for required in "$ROOT/reprompter/SKILL.md" "$ROOT/reprompter/LICENSE"; do
  if [[ ! -f "$required" ]]; then
    printf 'error: required RePrompter submodule file is missing: %s\n' "$required" >&2
    printf 'clone with --recurse-submodules or run: git submodule update --init --recursive\n' >&2
    exit 1
  fi
done

CONFIG_ARGS=(--agent-dir "$AGENT_DIR" --root "$ROOT")
if ((FULL == 1)); then CONFIG_ARGS+=(--full); fi
if python3 "$ROOT/scripts/install-config.py" relationship \
  --agent-dir "$AGENT_DIR" --root "$ROOT" --target-extension "$TARGET_EXTENSION"; then
  :
else
  relationship_status=$?
  if ((relationship_status == 3)); then
    printf 'error: refusing to replace the primary Pi Workbench checkout from one of its linked worktrees; switch the primary checkout to this branch and run the installer there\n' >&2
  fi
  exit "$relationship_status"
fi
python3 "$ROOT/scripts/install-config.py" preflight "${CONFIG_ARGS[@]}"

if ((STRICT == 1)); then
  (cd "$ROOT" && "${CLEAN_ENV[@]}" "$BUN_BIN" test --timeout=60000 tests)
  (cd "$ROOT" && "${CLEAN_ENV[@]}" node scripts/typecheck.mjs)
else
  printf 'Runtime installation: development checks are reserved for --strict; no checkout node_modules required.\n'
fi

SMOKE_OUT="$(mktemp)"
SMOKE_ERR="$(mktemp)"
CHILD_SMOKE_OUT="$(mktemp)"
CHILD_SMOKE_ERR="$(mktemp)"
CHILD_SMOKE_MARKER="$(mktemp)"
TEMP_FILES+=("$SMOKE_OUT" "$SMOKE_ERR" "$CHILD_SMOKE_OUT" "$CHILD_SMOKE_ERR" "$CHILD_SMOKE_MARKER")

set +e
printf '%s\n' '{"type":"get_commands","id":"commands"}' \
  | "${CLEAN_ENV[@]}" PI_OFFLINE=1 "$PI_BIN" --mode rpc --no-session --no-extensions --extension "$ROOT/index.ts" \
    >"$SMOKE_OUT" 2>"$SMOKE_ERR"
SMOKE_STATUS=$?
set -e
if ((SMOKE_STATUS != 0)); then
  cat "$SMOKE_ERR" >&2 || true
  printf 'error: Pi Workbench extension smoke process failed\n' >&2
  exit 1
fi
if grep -q 'extension_error' "$SMOKE_OUT" "$SMOKE_ERR"; then
  cat "$SMOKE_ERR" >&2
  printf 'error: Pi Workbench extension smoke test failed\n' >&2
  exit 1
fi

python3 - "$SMOKE_OUT" <<'PY'
import json
import sys

responses = []
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        try:
            responses.append(json.loads(line))
        except json.JSONDecodeError:
            pass
command_response = next(
    (item for item in responses if item.get("type") == "response" and item.get("command") == "get_commands"),
    None,
)
if not command_response or not command_response.get("success"):
    raise SystemExit("error: Pi Workbench command discovery failed")
names = {item.get("name") for item in command_response.get("data", {}).get("commands", [])}
required = {"plan", "start-work", "autopilot", "delegate", "workflow-status", "memory", "workbench-update", "enhance", "improveprompt", "reprompt", "prompt-use"}
forbidden = {"prometheus", "ulw", "ultrawork", "discipline", "discipline-status", "planner", "workflow"}
missing = sorted(required - names)
unexpected = sorted(forbidden & names)
if missing or unexpected:
    raise SystemExit(f"error: invalid Workbench command set; missing={missing}, unexpected={unexpected}")
PY

set +e
printf '%s\n' '{"type":"get_state","id":"state"}' \
  | "${CLEAN_ENV[@]}" PI_OFFLINE=1 PI_WORKBENCH_AGENT=installer-smoke PI_WORKBENCH_PROJECT_ROOT="$ROOT" \
    PI_WORKBENCH_CHILD_SMOKE_FILE="$CHILD_SMOKE_MARKER" "$PI_BIN" --mode rpc --no-session --no-extensions \
      --extension "$ROOT/child-tools.ts" --tools workbench_memory,qmd_search \
      >"$CHILD_SMOKE_OUT" 2>"$CHILD_SMOKE_ERR"
CHILD_SMOKE_STATUS=$?
set -e
if ((CHILD_SMOKE_STATUS != 0)); then
  cat "$CHILD_SMOKE_ERR" >&2 || true
  printf 'error: Pi Workbench child memory/tool smoke process failed\n' >&2
  exit 1
fi
if grep -q 'extension_error' "$CHILD_SMOKE_OUT" "$CHILD_SMOKE_ERR"; then
  cat "$CHILD_SMOKE_ERR" >&2
  printf 'error: Pi Workbench child memory/tool smoke test failed\n' >&2
  exit 1
fi
python3 - "$CHILD_SMOKE_OUT" "$CHILD_SMOKE_MARKER" <<'PY'
import json
import sys

responses = []
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        try:
            responses.append(json.loads(line))
        except json.JSONDecodeError:
            pass
state = next(
    (item for item in responses if item.get("type") == "response" and item.get("command") == "get_state"),
    None,
)
if not state or not state.get("success"):
    raise SystemExit("error: Pi Workbench child memory/tool RPC smoke did not return a successful state response")
try:
    with open(sys.argv[2], encoding="utf-8") as handle:
        marker = json.load(handle)
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"error: Pi Workbench child tool registration marker is invalid: {error}") from error
required_tools = {"workbench_memory", "qmd_search"}
all_tools = set(marker.get("allTools", []))
active_tools = set(marker.get("activeTools", []))
if not required_tools <= all_tools or not required_tools <= active_tools:
    raise SystemExit(
        f"error: child tool registration failed; missing_all={sorted(required_tools - all_tools)}, "
        f"missing_active={sorted(required_tools - active_tools)}"
    )
if marker.get("agentId") != "installer-smoke":
    raise SystemExit(f"error: child source-agent attribution failed: {marker.get('agentId')!r}")
PY

backup_and_link() {
  local source="$1"
  local target="$2"
  local backup=""
  mkdir -p "$(dirname "$target")"

  if [[ -e "$target" || -L "$target" ]]; then
    if [[ "$(realpath_portable "$source")" == "$(realpath_portable "$target")" ]]; then
      printf 'already linked: %s\n' "$target"
      return
    fi
    backup="$BACKUP_ROOT/resources/$(basename "$target")"
    mkdir -p "$(dirname "$backup")"
    chmod 700 "$BACKUP_ROOT"
    mv -- "$target" "$backup"
    printf 'backed up: %s -> %s\n' "$target" "$backup"
  fi

  ROLLBACK_TARGETS+=("$target")
  ROLLBACK_BACKUPS+=("$backup")
  ln -s "$source" "$target"
  printf 'linked: %s -> %s\n' "$target" "$source"
}

COMMITTING=1
mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/themes"
if [[ "$(realpath_portable "$ROOT")" != "$(realpath_portable "$TARGET_EXTENSION")" ]]; then
  backup_and_link "$ROOT" "$TARGET_EXTENSION"
fi
backup_and_link "$ROOT/setup/cmux-workbench.ts" "$AGENT_DIR/extensions/cmux-workbench.ts"
backup_and_link "$ROOT/setup/pi-look" "$AGENT_DIR/extensions/pi-look"
backup_and_link "$ROOT/setup/themes/ember.json" "$AGENT_DIR/themes/ember.json"
if ((FULL == 1)); then
  backup_and_link "$ROOT/startup-header.ts" "$AGENT_DIR/extensions/startup-header.ts"
fi
# Check normal user-profile discovery, not only an explicitly loaded source file.
# Run away from project-local extensions, with skills/templates excluded.
python3 "$ROOT/scripts/check-installed-commands.py" --pi "$PI_BIN" --agent-dir "$CANONICAL_AGENT_DIR" --root "$ROOT"
python3 "$ROOT/scripts/install-config.py" apply "${CONFIG_ARGS[@]}" --backup-root "$BACKUP_ROOT"
COMMITTING=0

printf "\nSreeram's Pi Workbench installed in %s\n" "$AGENT_DIR"
printf 'Source checkout: %s\n' "$ROOT"
printf 'Verified native Pi commands: /enhance /improveprompt /reprompt /prompt-use\n'
if ((FULL == 1)); then
  printf 'Opinionated profile enabled. Existing JSON values were preserved except active model/thinking defaults and theme.\n'
else
  printf 'Safe default profile used; existing settings, preferences, and active theme were preserved.\n'
fi
if [[ -d "$BACKUP_ROOT" ]]; then
  printf 'Backups: %s\n' "$BACKUP_ROOT"
fi
printf 'Run /reload in a Pi session using this same agent directory, or restart Pi.\n'
printf 'Skills are separate: --full configures trusted sources but does not download your personal skills. Run /skills-evolve to fetch the configured sources.\n'
