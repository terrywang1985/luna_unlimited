#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LUNA_PROJECT_DIR="$PROJECT_DIR"
source "$PROJECT_DIR/scripts/linux-common.sh"

quiet=0
case "${1:-}" in
  "") ;;
  --quiet) quiet=1 ;;
  -h|--help)
    printf 'Usage: bash ./stop-all.sh [--quiet]\n'
    exit 0
    ;;
  *) luna_die "Unknown option: $1" ;;
esac

[[ "$(uname -s)" == "Linux" ]] || luna_die "stop-all.sh supports Linux only. Use stop-all.ps1 on Windows."
luna_control_lock

if [[ -f "$PROJECT_DIR/.env" ]]; then
  luna_load_env
else
  LUNA_ENV=()
fi

LUNA_MCP_PORT="${LUNA_ENV[MCP_PORT]:-18765}"
LUNA_RUNTIME_ALIAS="${LUNA_ENV[LUNA_TUNNEL_RUNTIME_ALIAS]:-luna-unlimited}"
[[ "$LUNA_RUNTIME_ALIAS" =~ ^[A-Za-z0-9._-]+$ ]] ||
  luna_die "LUNA_TUNNEL_RUNTIME_ALIAS may contain only letters, numbers, dot, underscore, and hyphen."
default_state="${XDG_STATE_HOME:-$HOME/.local/state}/luna-unlimited"
LUNA_PRIVATE_STATE_DIR="${LUNA_ENV[LUNA_STATE_DIR]:-$default_state}"
if [[ "$LUNA_PRIVATE_STATE_DIR" != /* ]]; then
  LUNA_PRIVATE_STATE_DIR="$PROJECT_DIR/$LUNA_PRIVATE_STATE_DIR"
fi
LUNA_TUNNEL_CONFIG_HOME="$LUNA_PRIVATE_STATE_DIR/tunnel-client/config"
LUNA_TUNNEL_STATE_HOME="$LUNA_PRIVATE_STATE_DIR/tunnel-client/state"
LUNA_TUNNEL_PROFILE_DIR="$LUNA_TUNNEL_CONFIG_HOME/profiles"

if [[ -x "$PROJECT_DIR/tunnel-client" ]]; then
  if luna_tunnel runtimes stop "$LUNA_RUNTIME_ALIAS" --json >/dev/null 2>&1; then
    [[ "$quiet" == "1" ]] || luna_log "Stopped Tunnel managed runtime $LUNA_RUNTIME_ALIAS."
  fi
fi

luna_stop_mcp_pid "$quiet"
[[ "$quiet" == "1" ]] || luna_log "Luna Unlimited stopped."
