#!/usr/bin/env bash

# Shared helpers for Luna's Linux lifecycle scripts. This file is sourced by
# trusted scripts from the repository; .env itself is parsed as data and is
# never sourced or evaluated as shell code.

if [[ -z "${LUNA_PROJECT_DIR:-}" ]]; then
  printf 'LUNA_PROJECT_DIR must be set before loading linux-common.sh.\n' >&2
  exit 1
fi

declare -gA LUNA_ENV=()

luna_log() {
  printf '[luna] %s\n' "$*"
}

luna_warn() {
  printf '[luna] WARNING: %s\n' "$*" >&2
}

luna_die() {
  printf '[luna] ERROR: %s\n' "$*" >&2
  exit 1
}

luna_require_command() {
  command -v "$1" >/dev/null 2>&1 || luna_die "Required command '$1' was not found in PATH."
}

luna_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

luna_load_env() {
  local env_file="${1:-$LUNA_PROJECT_DIR/.env}"
  local line key value line_number=0

  [[ -f "$env_file" ]] || luna_die "Missing .env. Run 'bash ./install.sh' and configure it first."
  LUNA_ENV=()

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    [[ -z "$(luna_trim "$line")" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="$(luna_trim "${BASH_REMATCH[2]}")"
      if (( ${#value} >= 2 )); then
        if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] ||
           [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
          value="${value:1:${#value}-2}"
        fi
      fi
      LUNA_ENV["$key"]="$value"
    else
      luna_die "Invalid .env syntax at line $line_number. Use NAME=value without shell expressions."
    fi
  done < "$env_file"
}

luna_env_required() {
  local key="$1"
  local value="${LUNA_ENV[$key]:-}"
  [[ -n "$value" && "$value" != *replace_with_* ]] || luna_die "Configure $key in .env before starting Luna."
}

luna_validate_runtime_config() {
  luna_env_required CONTROL_PLANE_API_KEY
  luna_env_required CONTROL_PLANE_TUNNEL_ID
  luna_env_required MCP_SERVER_URL

  [[ "${LUNA_ENV[CONTROL_PLANE_TUNNEL_ID]}" =~ ^tunnel_[A-Za-z0-9_-]+$ ]] ||
    luna_die "CONTROL_PLANE_TUNNEL_ID does not look like a tunnel ID."

  LUNA_MCP_PORT="${LUNA_ENV[MCP_PORT]:-18765}"
  [[ "$LUNA_MCP_PORT" =~ ^[0-9]+$ ]] || luna_die "MCP_PORT must be an integer between 10001 and 65535."
  (( LUNA_MCP_PORT >= 10001 && LUNA_MCP_PORT <= 65535 )) ||
    luna_die "MCP_PORT must be an integer between 10001 and 65535."

  LUNA_MCP_HOST="${LUNA_ENV[MCP_HOST]:-127.0.0.1}"
  [[ "$LUNA_MCP_HOST" == "127.0.0.1" || "$LUNA_MCP_HOST" == "localhost" ]] ||
    luna_die "MCP_HOST must remain 127.0.0.1 or localhost when Secure MCP Tunnel is used."

  LUNA_MCP_TARGET="http://127.0.0.1:${LUNA_MCP_PORT}/mcp"
  local configured_target="${LUNA_ENV[MCP_SERVER_URL]}"
  local target_pattern='^url=http://(127\.0\.0\.1|localhost):([0-9]+)/mcp,channel=[A-Za-z0-9._-]+$'
  [[ "$configured_target" =~ $target_pattern ]] ||
    luna_die "MCP_SERVER_URL must use the local form url=http://127.0.0.1:<port>/mcp,channel=main."
  local configured_port="${BASH_REMATCH[2]}"
  [[ "$configured_port" == "$LUNA_MCP_PORT" ]] ||
    luna_die "MCP_SERVER_URL and MCP_PORT use different ports. Update both values together."

  LUNA_RUNTIME_ALIAS="${LUNA_ENV[LUNA_TUNNEL_RUNTIME_ALIAS]:-luna-unlimited}"
  [[ "$LUNA_RUNTIME_ALIAS" =~ ^[A-Za-z0-9._-]+$ ]] ||
    luna_die "LUNA_TUNNEL_RUNTIME_ALIAS may contain only letters, numbers, dot, underscore, and hyphen."

  local default_state="${XDG_STATE_HOME:-$HOME/.local/state}/luna-unlimited"
  LUNA_PRIVATE_STATE_DIR="${LUNA_ENV[LUNA_STATE_DIR]:-$default_state}"
  if [[ "$LUNA_PRIVATE_STATE_DIR" != /* ]]; then
    LUNA_PRIVATE_STATE_DIR="$LUNA_PROJECT_DIR/$LUNA_PRIVATE_STATE_DIR"
  fi
  mkdir -p -- "$LUNA_PRIVATE_STATE_DIR"
  LUNA_PRIVATE_STATE_DIR="$(realpath -e -- "$LUNA_PRIVATE_STATE_DIR")"
  chmod 700 "$LUNA_PRIVATE_STATE_DIR"
  LUNA_TUNNEL_CONFIG_HOME="$LUNA_PRIVATE_STATE_DIR/tunnel-client/config"
  LUNA_TUNNEL_STATE_HOME="$LUNA_PRIVATE_STATE_DIR/tunnel-client/state"
  LUNA_TUNNEL_PROFILE_DIR="$LUNA_TUNNEL_CONFIG_HOME/profiles"
  mkdir -p -- "$LUNA_TUNNEL_CONFIG_HOME" "$LUNA_TUNNEL_STATE_HOME" "$LUNA_TUNNEL_PROFILE_DIR"
}

luna_export_core_env() {
  local key
  for key in "${!LUNA_ENV[@]}"; do
    if [[ "$key" == MCP_* || "$key" == LUNA_* ]]; then
      export "$key=${LUNA_ENV[$key]}"
    fi
  done
  export MCP_HOST="$LUNA_MCP_HOST"
  export MCP_PORT="$LUNA_MCP_PORT"
  export LUNA_STATE_DIR="$LUNA_PRIVATE_STATE_DIR"
}

luna_resolve_workspace() {
  local requested="${1:-}"
  if [[ -z "$requested" ]]; then
    requested="${LUNA_ENV[MCP_WORKSPACE_ROOT]:-$LUNA_PROJECT_DIR/workspace}"
  fi
  [[ -d "$requested" ]] || luna_die "Workspace must be an existing directory: $requested"
  LUNA_WORKSPACE="$(realpath -e -- "$requested")"
  [[ "$LUNA_WORKSPACE" != "/" ]] || luna_die "Refusing to authorize the filesystem root as a workspace."
  case "$LUNA_PRIVATE_STATE_DIR/" in
    "$LUNA_WORKSPACE/"*) luna_die "LUNA_STATE_DIR must remain outside the authorized workspace." ;;
  esac
  case "$LUNA_WORKSPACE/" in
    "$LUNA_PRIVATE_STATE_DIR/"*) luna_die "The authorized workspace must not be nested inside LUNA_STATE_DIR." ;;
  esac
  export MCP_WORKSPACE_ROOT="$LUNA_WORKSPACE"
}

luna_tunnel() {
  local -a environment=(
    XDG_CONFIG_HOME="$LUNA_TUNNEL_CONFIG_HOME"
    XDG_STATE_HOME="$LUNA_TUNNEL_STATE_HOME"
  )
  if [[ "${LUNA_TUNNEL_INCLUDE_API_KEY:-0}" == "1" ]]; then
    environment+=(CONTROL_PLANE_API_KEY="${LUNA_ENV[CONTROL_PLANE_API_KEY]}")
  fi
  env "${environment[@]}" "$LUNA_PROJECT_DIR/tunnel-client" "$@"
}

luna_control_lock() {
  mkdir -p -- "$LUNA_PROJECT_DIR/logs"
  if [[ "${LUNA_CONTROL_LOCK_HELD:-0}" == "1" ]]; then
    return
  fi
  if command -v flock >/dev/null 2>&1; then
    exec {LUNA_CONTROL_LOCK_FD}>"$LUNA_PROJECT_DIR/logs/lifecycle-linux.lock"
    flock -n "$LUNA_CONTROL_LOCK_FD" || luna_die "Another Luna start/stop command is already running."
    export LUNA_CONTROL_LOCK_HELD=1
  else
    luna_warn "'flock' is unavailable; concurrent lifecycle commands cannot be serialized."
  fi
}

luna_close_control_lock_for_child() {
  if [[ -n "${LUNA_CONTROL_LOCK_FD:-}" ]]; then
    eval "exec ${LUNA_CONTROL_LOCK_FD}>&-"
  fi
}

luna_pid_is_mcp_server() {
  local pid="$1" cmdline cwd executable
  [[ "$pid" =~ ^[0-9]+$ && -d "/proc/$pid" ]] || return 1
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink -f -- "/proc/$pid/cwd" 2>/dev/null || true)"
  executable="$(basename -- "$(readlink -f -- "/proc/$pid/exe" 2>/dev/null || true)")"
  [[ "$executable" == node || "$executable" == nodejs ]] || return 1
  [[ "$cmdline" == *"src/server.mjs"* ]] || return 1
  [[ "$cwd" == "$LUNA_PROJECT_DIR" || "$cmdline" == *"$LUNA_PROJECT_DIR/src/server.mjs"* ]]
}

luna_stop_mcp_pid() {
  local quiet="${1:-0}" pid_file="$LUNA_PROJECT_DIR/logs/mcp-linux.pid" pid index
  [[ -f "$pid_file" ]] || return 0
  pid="$(tr -d '[:space:]' < "$pid_file")"
  if luna_pid_is_mcp_server "$pid"; then
    kill "$pid" 2>/dev/null || true
    for index in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    [[ "$quiet" == "1" ]] || luna_log "Stopped MCP server PID $pid."
  elif [[ "$pid" =~ ^[0-9]+$ && -d "/proc/$pid" ]]; then
    luna_warn "PID file points to an unrelated process; it was not stopped."
  fi
  rm -f -- "$pid_file"
}

luna_port_in_use() {
  node - "$LUNA_MCP_PORT" <<'NODE'
const net = require("node:net");
const port = Number(process.argv[2]);
const socket = net.createConnection({ host: "127.0.0.1", port });
const timer = setTimeout(() => { socket.destroy(); process.exit(1); }, 400);
socket.once("connect", () => { clearTimeout(timer); socket.destroy(); process.exit(0); });
socket.once("error", () => { clearTimeout(timer); process.exit(1); });
NODE
}

luna_wait_http() {
  local url="$1" attempts="$2" index
  for ((index = 0; index < attempts; index += 1)); do
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

luna_tunnel_status_ready() {
  local json="$1"
  node - "$json" <<'NODE'
const input = process.argv[2];
{
  try {
    const root = JSON.parse(input);
    let match = null;
    const visit = (value) => {
      if (!value || typeof value !== "object" || match) return;
      if (Object.hasOwn(value, "process_running") && Object.hasOwn(value, "healthy") && Object.hasOwn(value, "ready")) {
        match = value;
        return;
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(root);
    process.exit(match?.process_running === true && match?.healthy === true && match?.ready === true ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
NODE
}
