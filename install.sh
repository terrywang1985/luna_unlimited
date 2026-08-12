#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
LUNA_PROJECT_DIR="$PROJECT_DIR"
source "$PROJECT_DIR/scripts/linux-common.sh"

force_tunnel=0
case "${1:-}" in
  "") ;;
  --force-tunnel-download) force_tunnel=1 ;;
  -h|--help)
    printf 'Usage: bash ./install.sh [--force-tunnel-download]\n'
    exit 0
    ;;
  *) luna_die "Unknown option: $1" ;;
esac

[[ "$(uname -s)" == "Linux" ]] || luna_die "install.sh supports Linux only. Use install.ps1 on Windows."
luna_require_command node
luna_require_command npm
luna_require_command curl
luna_require_command sha256sum
luna_require_command unzip
luna_require_command realpath
luna_require_command install
luna_require_command awk
luna_require_command find

node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
(( node_major >= 20 )) || luna_die "Node.js 20 or newer is required. Installed version: $node_version"
luna_log "Node.js $node_version detected."

if [[ -d "$PROJECT_DIR/node_modules" ]] && (cd "$PROJECT_DIR" && npm ls --depth=0 --silent >/dev/null 2>&1); then
  luna_log "npm dependencies are already installed."
else
  luna_log "Installing locked npm dependencies with lifecycle scripts disabled..."
  (cd "$PROJECT_DIR" && npm ci --ignore-scripts --no-audit --no-fund)
fi

tunnel_target="$PROJECT_DIR/tunnel-client"
if [[ -x "$tunnel_target" && "$force_tunnel" == "0" ]]; then
  tunnel_version="$($tunnel_target --version 2>/dev/null | head -n 1 || true)"
  luna_log "Tunnel client already installed: ${tunnel_version:-version unavailable}"
else
  case "$(uname -m)" in
    x86_64|amd64) release_arch="amd64" ;;
    aarch64|arm64) release_arch="arm64" ;;
    *) luna_die "Unsupported Linux architecture: $(uname -m). Only amd64 and arm64 are supported." ;;
  esac

  luna_log "Resolving the latest official OpenAI tunnel-client release..."
  # Explicitly select ES module input. Node 20 otherwise parses stdin as
  # CommonJS and rejects the top-level await used for the release lookup.
  release_info="$(RELEASE_ARCH="$release_arch" node --input-type=module <<'NODE'
const response = await fetch("https://api.github.com/repos/openai/tunnel-client/releases/latest", {
  headers: { Accept: "application/vnd.github+json", "User-Agent": "luna-unlimited-linux-installer" }
});
if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
const release = await response.json();
const suffix = `-linux-${process.env.RELEASE_ARCH}.zip`;
const archive = release.assets.find((asset) => asset.name.endsWith(suffix));
const checksums = release.assets.find((asset) => asset.name === "SHA256SUMS.txt");
if (!archive || !checksums) throw new Error("Expected Linux archive or SHA256SUMS.txt is missing from the latest release.");
process.stdout.write([release.tag_name, archive.name, archive.browser_download_url, checksums.browser_download_url].join("\t"));
NODE
)" || luna_die "Could not resolve the latest official tunnel-client release."
  IFS=$'\t' read -r release_tag archive_name archive_url checksum_url <<< "$release_info"
  [[ -n "$archive_name" && -n "$archive_url" && -n "$checksum_url" ]] ||
    luna_die "Latest release metadata was incomplete."

  temp_parent="$(realpath -e -- "${TMPDIR:-/tmp}")"
  temp_root="$(mktemp -d "$temp_parent/luna-tunnel.XXXXXX")"
  pending_target="$PROJECT_DIR/.tunnel-client.$$.tmp"
  cleanup_install() {
    case "$(realpath -m -- "$temp_root")" in
      "$temp_parent"/luna-tunnel.*) rm -rf -- "$temp_root" ;;
      *) luna_warn "Refusing to remove unexpected temporary path: $temp_root" ;;
    esac
    rm -f -- "$pending_target"
  }
  trap cleanup_install EXIT

  curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 \
    --output "$temp_root/$archive_name" "$archive_url"
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 \
    --output "$temp_root/SHA256SUMS.txt" "$checksum_url"

  expected_hash="$(awk -v file="$archive_name" '$2 == file || $2 == "*" file { print tolower($1); exit }' "$temp_root/SHA256SUMS.txt")"
  [[ "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || luna_die "Archive checksum was not found in SHA256SUMS.txt."
  actual_hash="$(sha256sum "$temp_root/$archive_name" | awk '{print tolower($1)}')"
  [[ "$actual_hash" == "$expected_hash" ]] ||
    luna_die "Tunnel client checksum verification failed. Expected $expected_hash but received $actual_hash."

  mkdir -p -- "$temp_root/expanded"
  unzip -q "$temp_root/$archive_name" -d "$temp_root/expanded"
  downloaded_binary="$(find "$temp_root/expanded" -type f -name tunnel-client -print -quit)"
  [[ -n "$downloaded_binary" ]] || luna_die "Downloaded archive did not contain tunnel-client."
  install -m 0755 "$downloaded_binary" "$pending_target"
  "$pending_target" --version >/dev/null
  mv -f -- "$pending_target" "$tunnel_target"
  tunnel_version="$($tunnel_target --version 2>/dev/null | head -n 1 || true)"
  luna_log "Installed official tunnel-client ${tunnel_version:-$release_tag} and verified SHA-256."

  trap - EXIT
  cleanup_install
fi

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  cp -- "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  chmod 600 "$PROJECT_DIR/.env"
  luna_warn "Created .env. Fill in CONTROL_PLANE_API_KEY and CONTROL_PLANE_TUNNEL_ID before starting."
else
  mode="$(stat -c '%a' "$PROJECT_DIR/.env" 2>/dev/null || true)"
  if [[ -n "$mode" && "$mode" != "600" ]]; then
    luna_warn ".env permissions are $mode; run 'chmod 600 .env' to keep the Runtime API Key private."
  fi
fi

luna_log "Luna Unlimited Linux installation is ready."
