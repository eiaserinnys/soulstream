#!/bin/sh
# portable-node bootstrap: 고정 Node만 받아 launcher를 띄운다.
# 사용법: ./portable-node/start.sh  (저장소 루트에서 clone 직후 실행)
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
STATE_DIR="$SCRIPT_DIR/.state"
BOOT_DIR="$STATE_DIR/boot"
LOCK_FILE="$SCRIPT_DIR/runtime-lock.json"
export PORTABLE_NODE_DIR="$SCRIPT_DIR"

fail() {
  printf '[portable-node] 중단: %s\n' "$1" >&2
  exit 1
}

# lock 파일에서 값 하나를 읽는다. jq 없이 고정 들여쓰기를 이용한다.
lock_value() {
  awk -v kind="$1" -v plat="$2" -v field="$3" '
    $0 ~ "^    \"" kind "\": \\{" { inkind = 1; next }
    inkind && $0 ~ /^    "[A-Za-z0-9_-]+": \{/ { inkind = 0; inplatforms = 0; inentry = 0 }
    inkind && $0 ~ /^      "version": / {
      v = $0
      sub(/^[^:]*: */, "", v)
      sub(/",?[[:space:]]*$/, "", v)
      sub(/^"/, "", v)
      version = v
    }
    inkind && $0 ~ /^      "platforms": \{/ { inplatforms = 1; next }
    inplatforms && $0 ~ "^        \"" plat "\": \\{" { inentry = 1; next }
    inentry && $0 ~ /^        }/ { inentry = 0 }
    inentry && index($0, "\"" field "\":") {
      line = $0
      sub(/^[^:]*: */, "", line)
      sub(/",?[[:space:]]*$/, "", line)
      sub(/^"/, "", line)
      if (value == "") value = line
    }
    END {
      if (field == "version") print version
      else print value
    }
  ' "$LOCK_FILE"
}

detect_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) os_key="linux" ;;
    Darwin) os_key="darwin" ;;
    *) fail "지원하지 않는 운영체제입니다: $os (지원: Linux, macOS)" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch_key="x64" ;;
    aarch64|arm64) arch_key="arm64" ;;
    *) fail "지원하지 않는 아키텍처입니다: $arch" ;;
  esac
  printf '%s-%s' "$os_key" "$arch_key"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256 도구(sha256sum 또는 shasum)가 없습니다."
  fi
}

# launcher가 쓰는 것과 같은 설치 기록. 런타임을 다시 쓰지 않을 판정에 쓴다.
marker_sha() {
  [ -f "$1/.portable-runtime.json" ] || return 0
  awk '/"sha256"/ { line = $0; sub(/^[^:]*: *"/, "", line); sub(/".*$/, "", line); print line; exit }' \
    "$1/.portable-runtime.json"
}

write_marker() {
  dir=$1
  version=$2
  sha=$3
  installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{\n  "kind": "node",\n  "version": "%s",\n  "sha256": "%s",\n  "installed_at": "%s"\n}\n' \
    "$version" "$sha" "$installed_at" >"$dir/.portable-runtime.json"
}

ensure_tools() {
  command -v curl >/dev/null 2>&1 || fail "curl이 없습니다."
  command -v tar >/dev/null 2>&1 || fail "tar가 없습니다."
  command -v git >/dev/null 2>&1 || fail "git이 없습니다. Git을 설치한 뒤 다시 실행하십시오."
}

sync_boot() {
  rm -rf "$BOOT_DIR"
  mkdir -p "$BOOT_DIR"
  cp "$SCRIPT_DIR/launcher.mjs" "$BOOT_DIR/launcher.mjs"
  cp "$SCRIPT_DIR/defaults.json" "$BOOT_DIR/defaults.json"
  cp -R "$SCRIPT_DIR/lib" "$BOOT_DIR/lib"
  cp -R "$SCRIPT_DIR/config" "$BOOT_DIR/config"
}

install_node() {
  version=$1
  platform=$2
  url=$3
  sha=$4
  executable=$5
  install_dir="$STATE_DIR/runtimes/node/$version/$platform"
  node_bin="$install_dir/$executable"
  if [ -x "$node_bin" ] && [ "$(marker_sha "$install_dir")" = "$sha" ]; then
    printf '%s' "$node_bin"
    return 0
  fi
  mkdir -p "$STATE_DIR/cache/downloads" "$STATE_DIR/tmp"
  archive="$STATE_DIR/cache/downloads/$(basename "$url")"
  if [ ! -f "$archive" ] || [ "$(sha256_of "$archive")" != "$sha" ]; then
    printf '[portable-node] Node %s 내려받는 중…\n' "$version" >&2
    curl -fsSL --retry 2 -o "$archive.part" "$url" || fail "Node를 내려받지 못했습니다."
    if [ "$(sha256_of "$archive.part")" != "$sha" ]; then
      rm -f "$archive.part"
      fail "Node checksum이 맞지 않습니다."
    fi
    mv "$archive.part" "$archive"
  fi
  temp_dir="$STATE_DIR/tmp/node-$version-$$"
  rm -rf "$temp_dir"
  mkdir -p "$temp_dir"
  tar -xzf "$archive" -C "$temp_dir" || fail "Node 압축을 풀지 못했습니다."
  inner=$(find "$temp_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  if [ -z "$inner" ]; then
    inner="$temp_dir"
  fi
  rm -rf "$install_dir"
  mkdir -p "$(dirname "$install_dir")"
  mv "$inner" "$install_dir"
  rm -rf "$temp_dir"
  chmod +x "$node_bin" 2>/dev/null || true
  [ -x "$node_bin" ] || fail "Node 실행 파일을 찾지 못했습니다: $node_bin"
  write_marker "$install_dir" "$version" "$sha"
  printf '%s' "$node_bin"
}

main() {
  self_test=0
  for arg in "$@"; do
    if [ "$arg" = "--self-test" ]; then
      self_test=1
    fi
  done
  ensure_tools
  platform=$(detect_platform)
  version=$(lock_value node "$platform" version)
  url=$(lock_value node "$platform" url)
  sha=$(lock_value node "$platform" sha256)
  executable=$(lock_value node "$platform" executable)
  [ -n "$version" ] && [ -n "$url" ] && [ -n "$sha" ] && [ -n "$executable" ] ||
    fail "runtime-lock.json에 이 플랫폼($platform)용 Node 정보가 없습니다."

  mkdir -p "$STATE_DIR"
  sync_boot
  # 종료 코드 75는 계획된 재진입이다. 반복 방지는 launcher의 reentry.json이 맡는다.
  while :; do
    node_bin=$(install_node "$version" "$platform" "$url" "$sha" "$executable") ||
      fail "Node 준비에 실패했습니다."
    if [ "$self_test" -eq 1 ]; then
      "$node_bin" --version || fail "Node 실행 확인에 실패했습니다."
      install_dir="$STATE_DIR/runtimes/node/$version/$platform"
      [ -f "$install_dir/.portable-runtime.json" ] || fail "Node 설치 기록이 없습니다."
      [ "$(marker_sha "$install_dir")" = "$sha" ] ||
        fail "Node 설치 기록의 sha256이 잠금 파일과 다릅니다."
      printf '[portable-node] Node 준비 확인 완료: %s\n' "$node_bin"
      exit 0
    fi
    "$node_bin" "$BOOT_DIR/launcher.mjs" "$@"
    code=$?
    if [ "$code" -eq 75 ]; then
      # checkout의 lock이 바뀌었을 수 있으므로 다시 읽고 boot도 새로 복사한다.
      sync_boot
      version=$(lock_value node "$platform" version)
      url=$(lock_value node "$platform" url)
      sha=$(lock_value node "$platform" sha256)
      executable=$(lock_value node "$platform" executable)
      continue
    fi
    exit "$code"
  done
}

main "$@"
