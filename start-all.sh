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
Usage: bash ./start-all.sh [--workspace /absolute/path] [--execution-profile PROFILE] [--skip-install] [--open-browser]

Starts the Luna MCP server and an OpenAI tunnel-client managed runtime.
The default workspace is MCP_WORKSPACE_ROOT from .env, or ./workspace.
EOF
      exit 0
      ;;
    *) luna_die "Unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || luna_die "start-all.sh supports Linux only. Use start-all.ps1 on Windows."
if [[ "$skip_install" == "0" ]]; then
  bash "$PROJECT_DIR/install.sh"
fi

luna_require_command node
luna_require_command curl
luna_require_command realpath
[[ -x "$PROJECT_DIR/tunnel-client" ]] || luna_die "Missing tunnel-client. Run 'bash ./install.sh' first."

luna_load_env
luna_validate_runtime_config
luna_export_core_env
if [[ -n "$execution_profile" ]]; then
  export LUNA_EXECUTION_PROFILE="$execution_profile"
fi
luna_resolve_workspace "$workspace"
luna_control_lock

# Idempotency: stop only processes previously started and identified by Luna.
LUNA_CONTROL_LOCK_HELD=1 bash "$PROJECT_DIR/stop-all.sh" --quiet
if luna_port_in_use; then
  luna_die "Port $LUNA_MCP_PORT is already in use. Choose another MCP_PORT above 10000."
fi

mkdir -p -- "$PROJECT_DIR/logs"
started=0
cleanup_on_failure() {
  local status=$?
  if (( status != 0 && started == 1 )); then
    luna_warn "Startup failed; stopping the partially started Luna processes."
    LUNA_CONTROL_LOCK_HELD=1 bash "$PROJECT_DIR/stop-all.sh" --quiet || true
  fi
  exit "$status"
}
trap cleanup_on_failure EXIT

(
  # Do not let the long-lived server inherit and hold the lifecycle lock.
  luna_close_control_lock_for_child
  nohup node "$PROJECT_DIR/src/server.mjs" \
    >>"$PROJECT_DIR/logs/server-linux.out.log" \
    2>>"$PROJECT_DIR/logs/server-linux.err.log" \
    </dev/null &
  server_pid="$!"
  printf '%s' "$server_pid" > "$PROJECT_DIR/logs/mcp-linux.pid"
  # nohup does not need the launching subshell to remain attached to the child.
  disown "$server_pid" 2>/dev/null || true
)
started=1

if ! luna_wait_http "http://127.0.0.1:${LUNA_MCP_PORT}/healthz" 120; then
  luna_die "MCP server did not become ready. Check logs/server-linux.err.log."
fi

connect_log="$PROJECT_DIR/logs/tunnel-linux-connect.log"
if ! (
  # tunnel-client's supervised child must not inherit the lifecycle lock.
  luna_close_control_lock_for_child
  LUNA_TUNNEL_INCLUDE_API_KEY=1
  export LUNA_TUNNEL_INCLUDE_API_KEY
  luna_tunnel runtimes connect \
      --alias "$LUNA_RUNTIME_ALIAS" \
      --profile "$LUNA_RUNTIME_ALIAS" \
      --profile-dir "$LUNA_TUNNEL_PROFILE_DIR" \
      --tunnel-id "${LUNA_ENV[CONTROL_PLANE_TUNNEL_ID]}" \
      --mcp-server-url "$LUNA_MCP_TARGET" \
      --runtime-api-key env:CONTROL_PLANE_API_KEY \
      --tunnel-client-bin "$PROJECT_DIR/tunnel-client" \
      --json
) >"$connect_log" 2>&1; then
  tail -n 30 "$connect_log" >&2 || true
  luna_die "Tunnel managed runtime failed to start. Check logs/tunnel-linux-connect.log."
fi

tunnel_ready=0
status_json=""
for _ in {1..60}; do
  status_json="$(luna_tunnel runtimes status "$LUNA_RUNTIME_ALIAS" --json 2>/dev/null || true)"
  if [[ -n "$status_json" ]] && luna_tunnel_status_ready "$status_json"; then
    tunnel_ready=1
    break
  fi
  sleep 0.25
done
printf '%s\n' "$status_json" > "$PROJECT_DIR/logs/tunnel-linux-status.json"
(( tunnel_ready == 1 )) || luna_die "Tunnel runtime did not become ready. Check logs/tunnel-linux-connect.log and run 'bash ./doctor.sh'."

dashboard_url="http://127.0.0.1:${LUNA_MCP_PORT}/admin"
if [[ "$open_browser" == "1" ]]; then
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$dashboard_url" >/dev/null 2>&1 || luna_warn "Could not open the browser automatically."
  else
    luna_warn "xdg-open is unavailable; open $dashboard_url manually."
  fi
fi

trap - EXIT
luna_log "Luna Unlimited started."
printf 'MCP:        http://127.0.0.1:%s/mcp\n' "$LUNA_MCP_PORT"
printf 'Dashboard: %s\n' "$dashboard_url"
printf 'Workspace: %s\n' "$LUNA_WORKSPACE"
printf 'Execution: %s\n' "${LUNA_EXECUTION_PROFILE:-restricted}"
printf 'MCP PID:   %s\n' "$(cat "$PROJECT_DIR/logs/mcp-linux.pid")"
printf 'Tunnel:    managed runtime %s (running, healthy, ready)\n' "$LUNA_RUNTIME_ALIAS"
