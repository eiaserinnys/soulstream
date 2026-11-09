import type {
  MountBinding,
  SessionCommand,
  SessionIsolationSpec,
} from "../security/session_isolation_contract.js";

/**
 * bwrap argv의 고정 앞부분. net namespace는 이미 unshare한 netns를 물려받고,
 * user namespace는 pasta가 붙을 수 있도록 host가 소유한다. 그래서 여기서는
 * `--unshare-net`·`--unshare-user`·`--unshare-all`을 쓰지 않는다.
 */
export const BWRAP_BASE_FLAGS: readonly string[] = Object.freeze([
  "--unshare-pid",
  "--die-with-parent",
  "--new-session",
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--perms",
  "1777",
  "--tmpfs",
  "/tmp",
  "--perms",
  "1777",
  "--tmpfs",
  "/var/tmp",
]);

/**
 * §7의 mount 순서를 만든다.
 *
 * 1. 고정 base(`--ro-bind / /` 등)와 호출자가 넘긴 추가 mount
 * 2. directory mask(`--tmpfs` + `--remount-ro`)
 * 3. 계획의 일반 bind와 heavy-work-lock 파일 bind
 * 4. `/proc/locks` 읽기 전용 bind
 * 5. file mask(`--ro-bind /dev/null`)를 마지막에
 *
 * file mask를 마지막에 두는 이유는, mask한 부모 아래에 다시 승인된 경로를
 * 되살리는 바인드가 앞서 있어야 하기 때문이다. `/proc/locks` bind는 base의
 * `--proc /proc`이 만든 새 procfs를 덮는다.
 */
export function buildBwrapFlags(
  plan: SessionIsolationSpec,
  additionalMounts: readonly MountBinding[] = [],
): string[] {
  const flags: string[] = [...BWRAP_BASE_FLAGS];

  const plannedDestinations = new Set<string>([
    ...plan.bindings.map((binding) => binding.destination),
    ...plan.heavyWorkLockBindings.map((binding) => binding.destination),
  ]);
  for (const mount of additionalMounts) {
    if (plannedDestinations.has(mount.destination)) continue;
    flags.push(...renderMount(mount));
  }

  for (const mask of plan.masks) {
    if (mask.kind !== "directory") continue;
    flags.push("--tmpfs", mask.path, "--remount-ro", mask.path);
  }

  for (const binding of plan.bindings) {
    flags.push(...renderMount(binding));
  }
  for (const binding of plan.heavyWorkLockBindings) {
    flags.push(...renderMount(binding));
  }
  flags.push(...renderMount(plan.hostProcLocksBinding));

  for (const mask of plan.masks) {
    if (mask.kind !== "file") continue;
    flags.push("--ro-bind", "/dev/null", mask.path);
  }

  flags.push("--chdir", plan.workspaceDir);
  return flags;
}

/** bwrap 실행 파일 경로와 원래 argv를 합쳐 실제 spawn argv를 만든다. */
export function buildBwrapCommand(
  bwrapPath: string,
  plan: SessionIsolationSpec,
  original: SessionCommand,
  additionalMounts: readonly MountBinding[] = [],
): SessionCommand {
  return {
    command: bwrapPath,
    args: [...buildBwrapFlags(plan, additionalMounts), "--", original.command, ...original.args],
  };
}

/**
 * `WrapSessionCommand` 계약 구현.
 *
 * - `enabled === false`면 원래 command·args를 한 글자도 바꾸지 않는다.
 *   shell 문자열로 합치지 않으므로 argv 경계가 유지된다.
 * - 켜져 있으면 bwrap flag + `--` + 원래 argv가 된다.
 *
 * 이 함수는 순수하다. 프로세스를 띄우지 않고 파일도 읽지 않는다.
 */
export function wrapSessionCommand(
  original: SessionCommand,
  plan: SessionIsolationSpec,
): SessionCommand {
  if (!plan.enabled) {
    return { command: original.command, args: [...original.args] };
  }
  return buildBwrapCommand("bwrap", plan, original);
}

function renderMount(binding: MountBinding): string[] {
  return [binding.writable ? "--bind" : "--ro-bind", binding.source, binding.destination];
}
