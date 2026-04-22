#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
DRY_RUN=0
REQUESTED_VERSION="latest"
SETUP_MODE="auto"
NPM_USER_PREFIX="$HOME/.npm-global"
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh"

usage() {
  cat <<EOF
Install PulSeed globally via npm.

Usage:
  $SCRIPT_NAME [options]

Options:
  --version <version>  Install a specific pulseed version (default: latest)
  --setup              Run 'pulseed setup' after install
  --no-setup           Skip setup after install
  --dry-run            Print planned actions without executing them
  -h, --help           Show this help message
EOF
}

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

is_interactive() {
  [ -t 0 ] && [ -t 1 ]
}

detect_os() {
  local uname_out
  uname_out="$(uname -s 2>/dev/null || true)"
  case "$uname_out" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) echo "unknown" ;;
  esac
}

is_wsl() {
  [ -r /proc/version ] && grep -qi 'microsoft' /proc/version
}

require_command() {
  local cmd="$1"
  local hint="$2"
  command -v "$cmd" >/dev/null 2>&1 || die "$hint"
}

node_major_version() {
  node -p "process.versions.node.split('.')[0]"
}

path_contains() {
  local dir="$1"
  case ":$PATH:" in
    *":$dir:"*) return 0 ;;
    *) return 1 ;;
  esac
}

to_home_expr() {
  local dir="$1"
  if [ "$dir" = "$HOME" ]; then
    printf '%s\n' '$HOME'
    return 0
  fi
  case "$dir" in
    "$HOME"/*)
      printf '$HOME/%s\n' "${dir#"$HOME"/}"
      ;;
    *)
      printf '%s\n' "$dir"
      ;;
  esac
}

append_line_if_missing() {
  local file="$1"
  local line="$2"
  if [ ! -f "$file" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] Create $file"
    else
      touch "$file"
      log "Created $file"
    fi
  fi
  if grep -Fqx "$line" "$file"; then
    log "PATH already persisted in $file"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] Append to $file: $line"
    return 0
  fi
  printf '\n%s\n' "$line" >>"$file"
  log "Updated $file for PATH persistence"
}

persist_path_for_future_shells() {
  local dir="$1"
  local home_expr
  home_expr="$(to_home_expr "$dir")"
  local export_line="export PATH=\"$home_expr:\$PATH\""

  append_line_if_missing "$HOME/.zshrc" "$export_line"
  append_line_if_missing "$HOME/.bashrc" "$export_line"
  append_line_if_missing "$HOME/.profile" "$export_line"
}

ensure_path_now_and_persistent() {
  local dir="$1"
  if [ -z "$dir" ]; then
    return 0
  fi
  if path_contains "$dir"; then
    log "PATH already contains $dir"
  else
    export PATH="$dir:$PATH"
    log "Added $dir to PATH in current shell"
  fi
  persist_path_for_future_shells "$dir"
}

npm_global_bin_dir() {
  local prefix
  prefix="$(npm config get prefix 2>/dev/null || true)"
  if [ -z "$prefix" ] || [ "$prefix" = "undefined" ] || [ "$prefix" = "null" ]; then
    return 1
  fi
  printf '%s\n' "$prefix/bin"
}

is_permission_error() {
  local message
  message="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$message" in
    *eacces*|*eperm*|*"permission denied"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

bootstrap_node_with_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    require_command "curl" "curl is required to bootstrap Node.js via nvm."
    log "Installing nvm into $NVM_DIR (profile files will not be modified)..."
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] curl -fsSL $NVM_INSTALL_URL | PROFILE=/dev/null bash"
    else
      curl -fsSL "$NVM_INSTALL_URL" | PROFILE=/dev/null bash
    fi
  else
    log "Found existing nvm at $NVM_DIR"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "Dry run: skipping nvm source/install/use steps."
    return 0
  fi

  [ -s "$NVM_DIR/nvm.sh" ] || die "nvm installation did not produce $NVM_DIR/nvm.sh"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  log "Installing and using Node.js 24 via nvm for this installer run..."
  nvm install 24 >/dev/null
  nvm use 24 >/dev/null
}

ensure_supported_node() {
  local need_bootstrap=0

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    warn "Node.js/npm not found. Bootstrapping Node.js 24 with nvm."
    need_bootstrap=1
  else
    local current_major
    current_major="$(node_major_version)"
    if [ "$current_major" -ne 22 ] && [ "$current_major" -ne 24 ]; then
      warn "Detected unsupported Node.js $(node -v). Bootstrapping Node.js 24 with nvm."
      need_bootstrap=1
    fi
  fi

  if [ "$need_bootstrap" -eq 1 ]; then
    bootstrap_node_with_nvm
  fi

  if [ "$DRY_RUN" -eq 1 ] && (! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1); then
    log "Dry run: skipping strict Node.js/npm availability check."
    return 0
  fi

  require_command "node" "Node.js 22 or 24 is required. Install from https://nodejs.org/ and retry."
  require_command "npm" "npm is required. Install Node.js 22 or 24 (includes npm) and retry."

  local node_major
  node_major="$(node_major_version)"
  if [ "$node_major" -ne 22 ] && [ "$node_major" -ne 24 ]; then
    die "Detected Node.js $(node -v). PulSeed supports Node.js 22 or 24."
  fi
  log "Detected Node.js $(node -v)"
}

configure_npm_user_prefix() {
  local bin_dir="$NPM_USER_PREFIX/bin"
  log "Configuring npm user prefix at $NPM_USER_PREFIX"
  run mkdir -p "$bin_dir"
  run npm config set prefix "$NPM_USER_PREFIX"
  ensure_path_now_and_persistent "$bin_dir"
}

install_package_with_npm() {
  local package_spec="$1"
  log "Installing $package_spec globally with npm..."

  if [ "$DRY_RUN" -eq 1 ]; then
    run npm install -g "$package_spec"
    return 0
  fi

  local output
  if output="$(npm install -g "$package_spec" 2>&1)"; then
    [ -n "$output" ] && printf '%s\n' "$output"
    return 0
  fi

  printf '%s\n' "$output" >&2
  if ! is_permission_error "$output"; then
    die "Global npm install failed."
  fi

  warn "Global npm install failed due to permissions. Retrying with user prefix."
  configure_npm_user_prefix
  run npm install -g "$package_spec"
}

ensure_pulseed_on_path() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "Dry run: skipping pulseed PATH checks."
    return 0
  fi

  if command -v pulseed >/dev/null 2>&1; then
    return 0
  fi

  local npm_bin
  npm_bin="$(npm_global_bin_dir || true)"
  if [ -n "$npm_bin" ]; then
    warn "'pulseed' not found on PATH. Attempting to add npm global bin: $npm_bin"
    ensure_path_now_and_persistent "$npm_bin"
  fi

  command -v pulseed >/dev/null 2>&1 || die "Install completed but 'pulseed' is still not on PATH."
}

verify_installation() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "Dry run: skipping post-install verification."
    return 0
  fi

  local pulseed_version
  pulseed_version="$(pulseed --version 2>&1)" || die "'pulseed --version' failed after install."
  log "pulseed --version: $pulseed_version"

  log "Running 'pulseed doctor' (best-effort)..."
  local doctor_output
  if doctor_output="$(pulseed doctor 2>&1)"; then
    log "pulseed doctor: OK"
    [ -n "$doctor_output" ] && printf '%s\n' "$doctor_output"
  else
    warn "pulseed doctor reported issues. Continuing installer completion."
    [ -n "$doctor_output" ] && printf '%s\n' "$doctor_output"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "${2:-}" ] || die "--version requires a value"
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --setup)
      SETUP_MODE="yes"
      shift
      ;;
    --no-setup)
      SETUP_MODE="no"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1 (use --help)"
      ;;
  esac
done

OS_NAME="$(detect_os)"
if [ "$OS_NAME" = "unknown" ]; then
  die "Unsupported OS. This installer currently supports macOS (darwin) and Linux."
fi
log "Detected OS: $OS_NAME"
if [ "$OS_NAME" = "linux" ] && is_wsl; then
  warn "WSL detected. PulSeed works in WSL, but ensure Node/npm are installed inside your WSL distro."
fi

ensure_supported_node

PACKAGE_SPEC="pulseed"
if [ "$REQUESTED_VERSION" != "latest" ]; then
  PACKAGE_SPEC="pulseed@$REQUESTED_VERSION"
fi

install_package_with_npm "$PACKAGE_SPEC"
ensure_pulseed_on_path
verify_installation

SHOULD_RUN_SETUP=0
case "$SETUP_MODE" in
  yes) SHOULD_RUN_SETUP=1 ;;
  no) SHOULD_RUN_SETUP=0 ;;
  auto)
    if is_interactive; then
      SHOULD_RUN_SETUP=1
    fi
    ;;
  *)
    die "Invalid setup mode: $SETUP_MODE"
    ;;
esac

if [ "$SHOULD_RUN_SETUP" -eq 1 ]; then
  log "Running: pulseed setup"
  run pulseed setup
else
  log "Skipping setup. Run 'pulseed setup' later if needed."
fi
