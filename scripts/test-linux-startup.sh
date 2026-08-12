#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$(uname -s)" == "Linux" ]] || {
  printf 'SKIP: Linux startup smoke test requires Linux.\n'
  exit 0
}

# Node 20 parses stdin as CommonJS unless the installer explicitly selects
# module input; keep the release lookup compatible with the declared Node 20+.
grep -Fq 'node --input-type=module' "$SOURCE_DIR/install.sh" || {
  printf 'install.sh must run its top-level-await release lookup as an ES module.\n' >&2
  exit 1
}
node --input-type=module -e 'await Promise.resolve()'

port=$((30000 + ($$ % 20000)))
fixture="$(mktemp -d "${TMPDIR:-/tmp}/luna-linux-startup-test.XXXXXX")"
runtime_source="$SOURCE_DIR"
if [[ "$SOURCE_DIR" == /mnt/* ]]; then
  # WSL's drvfs can make detached process behavior and permission checks differ
  # from a native Linux filesystem. Copy the runtime under /tmp for this test.
  runtime_source="$fixture/runtime-source"
  mkdir -p -- "$runtime_source"
  cp -aL -- "$SOURCE_DIR/src" "$SOURCE_DIR/public" "$runtime_source/"
  ln -s -- "$SOURCE_DIR/node_modules" "$runtime_source/node_modules"
fi
if [[ "${LUNA_KEEP_TEST_FIXTURE:-0}" == "1" ]]; then
  printf 'Linux startup fixture: %s\n' "$fixture"
fi
cleanup() {
  status=$?
  if (( status != 0 )); then
    printf '%s\n' '--- Linux startup fixture server stderr ---' >&2
    tail -n 80 "$fixture/logs/server-linux.err.log" >&2 2>/dev/null || true
    printf '%s\n' '--- Linux startup fixture server stdout ---' >&2
    tail -n 80 "$fixture/logs/server-linux.out.log" >&2 2>/dev/null || true
    if [[ -f "$fixture/logs/mcp-linux.pid" ]]; then
      pid="$(cat "$fixture/logs/mcp-linux.pid")"
      printf 'fixture pid=%s cmdline=' "$pid" >&2
      tr '\0' ' ' < "/proc/$pid/cmdline" >&2 2>/dev/null || true
      printf '\n' >&2
    fi
  fi
  if [[ -f "$fixture/stop-all.sh" ]]; then
    bash "$fixture/stop-all.sh" --quiet >/dev/null 2>&1 || true
  fi
  if [[ "${LUNA_KEEP_TEST_FIXTURE:-0}" == "1" && status -ne 0 ]]; then
    printf 'Preserved Linux startup fixture: %s\n' "$fixture" >&2
    return "$status"
  fi
  case "$(realpath -m -- "$fixture")" in
    "$(realpath -e -- "${TMPDIR:-/tmp}")"/luna-linux-startup-test.*) rm -rf -- "$fixture" ;;
    *) printf 'Refusing to remove unexpected fixture: %s\n' "$fixture" >&2 ;;
  esac
  return "$status"
}
trap cleanup EXIT

mkdir -p -- "$fixture/scripts" "$fixture/workspace" "$fixture/private-state"
cp -- "$SOURCE_DIR/start-all.sh" "$SOURCE_DIR/stop-all.sh" "$SOURCE_DIR/doctor.sh" "$fixture/"
cp -- "$SOURCE_DIR/scripts/linux-common.sh" "$fixture/scripts/"
cp -aL -- "$runtime_source/src" "$runtime_source/public" "$fixture/"
ln -s -- "$runtime_source/node_modules" "$fixture/node_modules"

cat > "$fixture/.env" <<EOF
CONTROL_PLANE_API_KEY=sk-test-only
CONTROL_PLANE_TUNNEL_ID=tunnel_linux_smoke_test
MCP_SERVER_URL=url=http://127.0.0.1:${port}/mcp,channel=main
MCP_HOST=127.0.0.1
MCP_PORT=${port}
LUNA_STATE_DIR=${fixture}/private-state
LUNA_TUNNEL_RUNTIME_ALIAS=luna-linux-smoke
UNUSED_LITERAL=\$(touch ${fixture}/env-was-executed)
EOF
chmod 600 "$fixture/.env"

cat > "$fixture/tunnel-client" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
state_file="${XDG_STATE_HOME:?}/fake-runtime-ready"
if [[ "${1:-}" == "runtimes" && "${2:-}" == "connect" ]]; then
  [[ -n "${CONTROL_PLANE_API_KEY:-}" ]] || exit 20
  mkdir -p -- "$(dirname -- "$state_file")"
  printf 'ready' > "$state_file"
  printf '{"connected":true}\n'
elif [[ "${1:-}" == "runtimes" && "${2:-}" == "status" ]]; then
  [[ -f "$state_file" ]] || exit 1
  printf '{"runtime":{"process_running":true,"healthy":true,"ready":true}}\n'
elif [[ "${1:-}" == "runtimes" && "${2:-}" == "stop" ]]; then
  rm -f -- "$state_file"
  printf '{"stopped":true}\n'
elif [[ "${1:-}" == "doctor" ]]; then
  [[ -n "${CONTROL_PLANE_API_KEY:-}" ]] || exit 21
  printf 'fake doctor passed\n'
else
  exit 22
fi
EOF
chmod 700 "$fixture/tunnel-client"

bash "$fixture/start-all.sh" --skip-install --workspace "$fixture/workspace" >/dev/null
first_pid="$(cat "$fixture/logs/mcp-linux.pid")"
curl --fail --silent --show-error "http://127.0.0.1:${port}/healthz" >/dev/null
[[ ! -e "$fixture/env-was-executed" ]] || { printf '.env was executed as shell code.\n' >&2; exit 1; }
bash "$fixture/doctor.sh" >/dev/null

# A second start must stop the identified old server and produce one new PID.
bash "$fixture/start-all.sh" --skip-install --workspace "$fixture/workspace" >/dev/null
second_pid="$(cat "$fixture/logs/mcp-linux.pid")"
[[ "$first_pid" != "$second_pid" ]] || { printf 'Idempotent restart did not replace the MCP process.\n' >&2; exit 1; }
kill -0 "$second_pid"

bash "$fixture/stop-all.sh" --quiet
bash "$fixture/stop-all.sh" --quiet
[[ ! -e "$fixture/logs/mcp-linux.pid" ]] || { printf 'MCP PID file remained after stop.\n' >&2; exit 1; }
if curl --fail --silent --max-time 1 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
  printf 'MCP server remained reachable after stop.\n' >&2
  exit 1
fi

printf 'PASS: Linux install/start/doctor/restart/stop contract smoke test\n'
