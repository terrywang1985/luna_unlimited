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
    printf 'Usage: bash ./stop-server.sh [--quiet]\n'
    exit 0
    ;;
  *) luna_die "Unknown option: $1" ;;
esac

[[ "$(uname -s)" == "Linux" ]] || luna_die "stop-server.sh supports Linux only."
luna_control_lock
luna_stop_mcp_pid "$quiet"
[[ "$quiet" == "1" ]] || luna_log "Luna MCP server stopped without changing Tunnel state."
