#!/usr/bin/env bash

wait_for_lab_memory() {
  require_command free
  local available_mb
  available_mb="$(free -m | awk '/^Mem:/{print $7}')"
  if (( available_mb < 2000 )); then
    printf 'available memory is %sMB; waiting 60 seconds before one retry\n' "$available_mb"
    sleep 60
    available_mb="$(free -m | awk '/^Mem:/{print $7}')"
  fi
  (( available_mb >= 2000 )) \
    || fail "available memory remains below 2000MB"
}

print_fresh_lab_provenance() {
  ensure_main_fetch_refspec "$LAB_REPO"

  local checkout origin_main branch dirty
  checkout="$(git -C "$LAB_REPO" rev-parse HEAD)"
  origin_main="$(git -C "$LAB_REPO" rev-parse refs/remotes/origin/main)"
  branch="$(git -C "$LAB_REPO" branch --show-current)"
  [[ -n "$branch" ]] || branch=detached
  dirty=false
  [[ -z "$(git -C "$LAB_REPO" status --porcelain)" ]] || dirty=true

  printf 'lab provenance: checkout=%s origin_main=%s branch=%s dirty=%s\n' \
    "$checkout" "$origin_main" "$branch" "$dirty"
}

stop_lab_for_reset() {
  stop_owned_process \
    lab-node "$LAB_ROOT/state/node.pid" "$LAB_REPO/soul-server-ts/dist/main.js"
  stop_owned_runners
  stop_owned_process \
    lab-orch "$LAB_ROOT/state/orch.pid" "$LAB_REPO/orch-server-ts/dist/production_main.js"

  if docker container inspect "$LAB_POSTGRES_CONTAINER" >/dev/null 2>&1; then
    postgres_container_is_owned \
      || fail "refusing to stop an unowned postgres container"
    if [[ "$(docker inspect --format '{{.State.Running}}' "$LAB_POSTGRES_CONTAINER")" == "true" ]]; then
      docker stop "$LAB_POSTGRES_CONTAINER" >/dev/null
    fi
  fi
}

remove_lab_postgres() {
  require_command docker
  if docker container inspect "$LAB_POSTGRES_CONTAINER" >/dev/null 2>&1; then
    postgres_container_is_owned \
      || fail "refusing to remove an unowned postgres container"
    docker rm "$LAB_POSTGRES_CONTAINER" >/dev/null
  fi

  if docker volume inspect "$LAB_POSTGRES_VOLUME" >/dev/null 2>&1; then
    [[ "$(docker volume inspect --format '{{ index .Labels "com.soulstream.lab" }}' "$LAB_POSTGRES_VOLUME")" == "true" ]] \
      || fail "refusing to remove an unowned postgres volume"
    docker volume rm "$LAB_POSTGRES_VOLUME" >/dev/null
  fi
  printf 'lab postgres container and volume reset\n'
}

remove_lab_mutable_path() {
  local path="$1"
  [[ "$path" == "$LAB_ROOT/"* && ! -L "$path" ]] \
    || fail "unsafe mutable path: $path"
  chmod -R u+w -- "$path"
  rm -rf -- "$path"
}

reset_lab_mutable_state() {
  [[ "$LAB_ROOT" == "$LAB_DEFAULT_ROOT" ]] \
    || fail "refusing mutable reset outside $LAB_DEFAULT_ROOT"
  [[ ! -L "$LAB_ROOT" && -d "$LAB_ROOT" ]] \
    || fail "lab root must be a real directory"

  local state_root="$LAB_ROOT/state"
  local auth_file="$state_root/claude-auth.json"
  [[ ! -L "$state_root" && -d "$state_root" ]] \
    || fail "lab state root must be a real directory"
  [[ ! -L "$auth_file" && -f "$auth_file" ]] \
    || fail "lab Claude auth credential is missing or unsafe"

  local directory
  for directory in \
    "$LAB_ROOT/logs" \
    "$LAB_ROOT/outbox" \
    "$LAB_ROOT/runner-state" \
    "$LAB_ROOT/workspace"; do
    [[ "$directory" == "$LAB_ROOT/"* && ! -L "$directory" ]] \
      || fail "unsafe mutable directory: $directory"
    mkdir -p "$directory"
    while IFS= read -r -d '' path; do
      remove_lab_mutable_path "$path"
    done < <(find "$directory" -mindepth 1 -maxdepth 1 -print0)
  done

  while IFS= read -r -d '' path; do
    remove_lab_mutable_path "$path"
  done < <(find "$state_root" -mindepth 1 -maxdepth 1 \
    ! -name claude-auth.json \
    ! -name fault-harness \
    -print0)
  mkdir -p "$state_root/fault-harness"
  chmod 700 "$state_root" "$state_root/fault-harness" \
    "$LAB_ROOT/logs" "$LAB_ROOT/outbox" "$LAB_ROOT/runner-state" "$LAB_ROOT/workspace"
  printf 'lab mutable state reset; evidence preserved\n'
}
