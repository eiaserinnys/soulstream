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
 * §11의 mount 순서를 만든다.
 *
 * 1. 고정 base(`--ro-bind / /` 등)와 호출자가 넘긴 추가 mount
 * 2. directory mask(`--tmpfs`)와 계획의 bind를 **destination 경로 순서**로
 *    섞어서 낸다. 조상이 먼저 오고, 같은 경로면 tmpfs가 먼저다.
 * 3. file mask(`--ro-bind /dev/null`)
 * 4. directory mask의 `--remount-ro` — 모든 bind와 file mask 뒤에 건다.
 * 5. `/proc/locks` 읽기 전용 bind, 이어서 `--chdir`
 *
 * 순서가 곧 의미다. mask한 부모 아래에 다시 승인된 경로를 되살리는 bind가
 * 있으면(세션 sandbox, `~/.pm2/logs`, 공통 파일 디렉터리) 부모 tmpfs가 먼저
 * 놓여야 그 아래에 mountpoint를 만들 수 있다. 반대로 부모를 RO로 여는 bind
 * 아래에 있는 mask는 부모 bind가 나중에 오면 덮여 사라지므로, 부모 bind가
 * mask보다 먼저 와야 한다. tmpfs를 곧바로 `--remount-ro`하면 빈 RO tmpfs가
 * 되어 그 아래 bind나 file mask가 mountpoint를 만들지 못하고 restricted
 * 세션 시작에 실패한다. 따라서 file mask도 RO 전환 전에 놓는다.
 *
 * `/proc/locks` bind는 base의 `--proc /proc`이 만든 새 procfs를 덮는다.
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

  const directoryMasks = plan.masks.filter((mask) => mask.kind === "directory");
  const mounts: PlannedMount[] = [
    ...directoryMasks.map((mask) => ({ path: mask.path, binding: null })),
    ...plan.bindings.map((binding) => ({ path: binding.destination, binding })),
    ...plan.heavyWorkLockBindings.map((binding) => ({ path: binding.destination, binding })),
  ];
  mounts.sort(comparePlannedMounts);
  for (const mount of mounts) {
    if (mount.binding === null) {
      flags.push("--tmpfs", mount.path);
    } else {
      flags.push(...renderMount(mount.binding));
    }
  }

  for (const mask of plan.masks) {
    if (mask.kind !== "file") continue;
    flags.push("--ro-bind", "/dev/null", mask.path);
  }

  // bind와 file mask가 모두 끝난 뒤에 건다. remount-ro는 그 경로에 지금 올라와 있는
  // tmpfs mount 하나에만 걸리고, 그 아래에 얹힌 bind는 그대로 남는다.
  for (const mask of directoryMasks) {
    flags.push("--remount-ro", mask.path);
  }

  flags.push(...renderMount(plan.hostProcLocksBinding));

  flags.push("--chdir", plan.workspaceDir);
  return flags;
}

/** 한 경로에 놓을 mount. `binding === null`이면 directory mask(tmpfs)다. */
interface PlannedMount {
  readonly path: string;
  readonly binding: MountBinding | null;
}

function comparePlannedMounts(left: PlannedMount, right: PlannedMount): number {
  const components = comparePathComponents(left.path, right.path);
  if (components !== 0) return components;
  if (left.binding === null && right.binding !== null) return -1;
  if (left.binding !== null && right.binding === null) return 1;
  return 0;
}

/** 경로를 구성 요소 단위로 비교한다. 조상이 자손보다 먼저 온다. */
function comparePathComponents(left: string, right: string): number {
  const leftParts = left.split("/").filter((part) => part.length > 0);
  const rightParts = right.split("/").filter((part) => part.length > 0);
  const limit = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < limit; index += 1) {
    const leftPart = leftParts[index] ?? "";
    const rightPart = rightParts[index] ?? "";
    if (leftPart === rightPart) continue;
    return leftPart < rightPart ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
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
