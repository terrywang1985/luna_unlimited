#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LUNA_PROJECT_DIR="$PROJECT_DIR"
source "$PROJECT_DIR/scripts/linux-common.sh"

workspace=""
execution_profile=""
skip_install=0
open_browser=0
while (($#)); do
  case "$1" in
    --workspace)
      (($# >= 2)) || luna_die "--workspace requires a directory."
      workspace="$2"
      shift 2
      ;;
    --execution-profile)
      (($# >= 2)) || luna_die "--execution-profile requires restricted, user, container-root, or host-root."
      execution_profile="$2"
      shift 2
      ;;
    --skip-install) skip_install=1; shift ;;
    --open-browser) open_browser=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: bash ./start-server.sh [--workspace /absolute/path] [--execution-profile PROFILE] [--skip-install] [--open-browser]

Starts only the Luna MCP server. It does not require Tunnel credentials and
does not start, stop, or reconfigure tunnel-client.
EOF
      exit 0
      ;;
    *) luna_die "Unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || luna_die "start-server.sh supports Linux only. Use start-server.ps1 on Windows."
luna_require_command node
luna_require_command curl
luna_require_command realpath

if [[ "$skip_install" == "0" ]]; then
  luna_require_command npm
  if [[ -d "$PROJECT_DIR/node_modules" ]] && (cd "$PROJECT_DIR" && npm ls --depth=0 --silent >/dev/null 2>&1); then
    luna_log "npm dependencies are already installed."
  else
    luna_log "Installing locked npm dependencies with lifecycle scripts disabled..."
    (cd "$PROJECT_DIR" && npm ci --ignore-scripts --no-audit --no-fund)
  fi
fi

luna_load_env
luna_validate_mcp_config
luna_export_core_env
if [[ -n "$execution_profile" ]]; then
  export LUNA_EXECUTION_PROFILE="$execution_profile"
fi
luna_resolve_workspace "$workspace"
luna_control_lock

# Only the MCP PID is touched. A managed Tunnel runtime, if present, remains up.
luna_stop_mcp_pid 1
if luna_port_in_use; then
  luna_die "Port $LUNA_MCP_PORT is already in use. Choose another MCP_PORT above 10000."
fi

mkdir -p -- "$PROJECT_DIR/logs"
started=0
cleanup_on_failure() {
  local status=$?
  if (( status != 0 && started == 1 )); then
    luna_warn "MCP startup failed; stopping the partially started server."
    luna_stop_mcp_pid 1 || true
  fi
  exit "$status"
}
trap cleanup_on_failure EXIT

(
  luna_close_control_lock_for_child
  nohup node "$PROJECT_DIR/src/server.mjs" \
    >>"$PROJECT_DIR/logs/server-linux.out.log" \
    2>>"$PROJECT_DIR/logs/server-linux.err.log" \
    </dev/null &
  server_pid="$!"
  printf '%s' "$server_pid" > "$PROJECT_DIR/logs/mcp-linux.pid"
  disown "$server_pid" 2>/dev/null || true
)
started=1

if ! luna_wait_http "http://127.0.0.1:${LUNA_MCP_PORT}/healthz" 120; then
  luna_die "MCP server did not become ready. Check logs/server-linux.err.log."
fi

dashboard_url="http://127.0.0.1:${LUNA_MCP_PORT}/admin"
if [[ "$open_browser" == "1" ]]; then
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$dashboard_url" >/dev/null 2>&1 || luna_warn "Could not open the browser automatically."
  else
    luna_warn "xdg-open is unavailable; open $dashboard_url manually."
  fi
fi

trap - EXIT
luna_log "Luna MCP server started without changing Tunnel state."
printf 'MCP:        http://127.0.0.1:%s/mcp\n' "$LUNA_MCP_PORT"
printf 'Dashboard: %s\n' "$dashboard_url"
printf 'Workspace: %s\n' "$LUNA_WORKSPACE"
printf 'Execution: %s\n' "${LUNA_EXECUTION_PROFILE:-restricted}"
printf 'MCP PID:   %s\n' "$(cat "$PROJECT_DIR/logs/mcp-linux.pid")"
