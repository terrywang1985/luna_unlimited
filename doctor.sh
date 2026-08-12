#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LUNA_PROJECT_DIR="$PROJECT_DIR"
source "$PROJECT_DIR/scripts/linux-common.sh"

case "${1:-}" in
  "") ;;
  -h|--help)
    printf 'Usage: bash ./doctor.sh\n'
    exit 0
    ;;
  *) luna_die "Unknown option: $1" ;;
esac

[[ "$(uname -s)" == "Linux" ]] || luna_die "doctor.sh supports Linux only. Use doctor.ps1 on Windows."
luna_require_command node
luna_require_command curl
[[ -x "$PROJECT_DIR/tunnel-client" ]] || luna_die "Missing tunnel-client. Run 'bash ./install.sh' first."

luna_load_env
luna_validate_runtime_config

if curl --fail --silent --show-error --max-time 2 \
  "http://127.0.0.1:${LUNA_MCP_PORT}/healthz" >/dev/null 2>&1; then
  luna_log "Luna MCP health: ready on port $LUNA_MCP_PORT."
else
  luna_warn "Luna MCP is not reachable on port $LUNA_MCP_PORT."
fi

status_json="$(luna_tunnel runtimes status "$LUNA_RUNTIME_ALIAS" --json 2>/dev/null || true)"
if [[ -n "$status_json" ]] && luna_tunnel_status_ready "$status_json"; then
  luna_log "Tunnel runtime $LUNA_RUNTIME_ALIAS: running, healthy, ready."
else
  luna_warn "Tunnel runtime $LUNA_RUNTIME_ALIAS is not fully ready."
fi

LUNA_TUNNEL_INCLUDE_API_KEY=1
export LUNA_TUNNEL_INCLUDE_API_KEY
luna_tunnel doctor --explain
unset LUNA_TUNNEL_INCLUDE_API_KEY
