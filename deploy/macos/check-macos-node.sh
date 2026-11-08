#!/bin/bash
# Read-only preflight checks for a new macOS Soulstream node.
# This script never installs, starts, stops, or deletes anything.
# Compatible with the /bin/bash 3.2 that ships with macOS.
set -u

failures=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
warn() { printf 'WARN  %s\n' "$1"; }

# version_at_least CURRENT REQUIRED -> returns 0 when CURRENT >= REQUIRED.
version_at_least() {
  local current="$1"
  local required="$2"
  local index current_part required_part
  local IFS=.
  local current_parts=($current)
  local required_parts=($required)
  for index in 0 1 2; do
    current_part="${current_parts[$index]:-0}"
    required_part="${required_parts[$index]:-0}"
    current_part="${current_part%%[!0-9]*}"
    required_part="${required_part%%[!0-9]*}"
    current_part="${current_part:-0}"
    required_part="${required_part:-0}"
    if [ "$current_part" -gt "$required_part" ]; then
      return 0
    fi
    if [ "$current_part" -lt "$required_part" ]; then
      return 1
    fi
  done
  return 0
}

check_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  if [ "$os" = "Darwin" ]; then
    pass "platform: Darwin ($arch)"
  else
    fail "platform: expected Darwin, found $os"
  fi
  case "$arch" in
    arm64 | x86_64) pass "architecture: $arch" ;;
    *) fail "architecture: expected arm64 or x86_64, found $arch" ;;
  esac
}

check_python() {
  local version
  if ! command -v python3 >/dev/null 2>&1; then
    fail "python3: not found in PATH (3.11 or newer is required for Haniel and the Darwin build runner)"
    return
  fi
  version="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null)"
  if [ -z "$version" ]; then
    fail "python3: could not read the interpreter version"
    return
  fi
  if version_at_least "$version" "3.11"; then
    pass "python3: $version"
  else
    fail "python3: $version found, 3.11 or newer is required"
  fi
}

check_node() {
  local version
  if ! command -v node >/dev/null 2>&1; then
    fail "node: not found in PATH (22.12 or newer is required)"
    return
  fi
  version="$(node --version 2>/dev/null)"
  version="${version#v}"
  if [ -z "$version" ]; then
    fail "node: could not read the runtime version"
    return
  fi
  if ! version_at_least "$version" "22.12"; then
    fail "node: $version found, 22.12 or newer is required"
    return
  fi
  if node -e "require('node:sqlite')" >/dev/null 2>&1; then
    pass "node: $version with node:sqlite"
  else
    fail "node: $version cannot load node:sqlite; the runner database requires it"
  fi
}

check_required_command() {
  local name="$1"
  local label="$2"
  local path
  path="$(command -v "$name" 2>/dev/null || true)"
  if [ -n "$path" ]; then
    pass "$label: $path"
  else
    fail "$label: not found in PATH (required for install and build)"
  fi
}

check_optional_command() {
  local name="$1"
  local label="$2"
  local path
  path="$(command -v "$name" 2>/dev/null || true)"
  if [ -n "$path" ]; then
    pass "$label: $path"
  else
    warn "$label: not found in PATH (required only for sessions that use this backend)"
  fi
}

check_runner_state_dir() {
  local state_dir="${SOUL_RUNNER_STATE_DIR:-}"
  local bytes
  if [ -z "$state_dir" ]; then
    fail "SOUL_RUNNER_STATE_DIR: not set (use a short absolute path such as /tmp/ss-run)"
    return
  fi
  case "$state_dir" in
    /*) ;;
    *)
      fail "SOUL_RUNNER_STATE_DIR: must be an absolute path, found $state_dir"
      return
      ;;
  esac
  bytes="$(printf '%s/000000000000000000000000/runner.sock' "$state_dir" | LC_ALL=C wc -c | tr -d '[:space:]')"
  if [ -z "$bytes" ]; then
    fail "SOUL_RUNNER_STATE_DIR: could not measure $state_dir"
  elif [ "$bytes" -le 103 ]; then
    pass "SOUL_RUNNER_STATE_DIR: $state_dir (runner socket path $bytes bytes, maximum 103)"
  else
    fail "SOUL_RUNNER_STATE_DIR: $state_dir produces a $bytes byte runner socket path; maximum is 103 bytes"
  fi
}

printf 'Soulstream macOS node preflight checks\n\n'
check_platform
check_python
check_node
check_required_command pnpm "pnpm"
check_required_command git "git"
check_optional_command claude "cli claude"
check_optional_command codex "cli codex"
check_optional_command agy "cli agy"
check_runner_state_dir
printf '\n'

if [ "$failures" -ne 0 ]; then
  printf '%s check(s) failed. Fix the FAIL lines before registering this node.\n' "$failures"
  exit 1
fi
printf 'All checks passed.\n'
