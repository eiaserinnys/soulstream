import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  IsolationPolicy,
  IsolationPreparationInput,
} from "../../src/security/session_isolation_contract.js";
import {
  ISOLATION_AUTH_UNAVAILABLE,
  ISOLATION_POLICY_UNAVAILABLE,
  SESSION_ISOLATION_UNAVAILABLE,
} from "../../src/runner/session_filesystem_errors.js";
import {
  clearEnvMaskScanCache,
  ENV_MASK_SCAN_CACHE_TTL_MS,
  invalidateEnvMaskScanRoot,
  type IsolationEnvMaskScan,
  scanEnvMaskRoots,
} from "../../src/runner/session_filesystem_masks.js";
import { prepareIsolationPlan } from "../../src/runner/session_filesystem_plan.js";
import { isolationChildConfigFromPlan } from
  "../../src/runner/runner_process_isolation.js";
import { applyNodeIsolationPolicy } from "../../src/security/session_isolation_runtime.js";
import { makeTempDir } from "../helpers/temp_dir.js";
import {
  createFakeHostPorts,
  touch,
  type FakeHostPorts,
  type FakeHostPortsOptions,
} from "../helpers/session_isolation_host_fakes.js";

const HEAVY_LOCK_PATHS = [
  "/tmp/soulstream-heavy-verify.lock",
  "/tmp/soulstream-heavy-verify.slot-1.lock",
  "/tmp/soulstream-heavy-verify.slot-2.lock",
  "/tmp/soulstream-heavy-verify.slot-3.lock",
  "/tmp/soulstream-heavy-verify.deploy.lock",
];

function makePolicy(
  additionalSensitiveRoots: string[],
  overrides: Partial<IsolationPolicy> = {},
): IsolationPolicy {
  return {
    version: 1,
    tools: {},
    localMcp: { requiredServerId: "soulstream", optional: [] },
    filesystem: {
      sessionWorktreeRelativeRoot: ".projects/.isolated",
      credentialRelativeDirectory: ".local/share/soulstream/credentials/codex",
      isolatedCacheRelativeRoot: ".local/share/soulstream/isolated-cache",
      writableWorkspaceRelativeDirectories: [".local/tmp", ".local/artifacts"],
      additionalSensitiveRoots,
      writableSensitiveRoots: [],
      readOnlyReexposedPaths: [],
    },
    testDatabases: [],
    network: {
      mode: "pasta-nft",
      dnsForward4: "192.0.2.53",
      deniedIpv4: [],
      deniedIpv6: [],
    },
    ...overrides,
  };
}

interface Fixture {
  root: string;
  workspace: string;
  home: string;
  stateDir: string;
  sessionDir: string;
  repo: string;
  commonDir: string;
  worktree: string;
  canonicalCodex: string;
  sensitive: string;
  agentCommonFiles: string;
  options: FakeHostPortsOptions;
  ports: FakeHostPorts;
  input: IsolationPreparationInput;
}

interface FixtureOverrides {
  backend?: IsolationPreparationInput["backend"];
  authPreparation?: IsolationPreparationInput["authPreparation"];
  testDatabaseUrl?: string;
  wsl?: boolean;
  policy?: (policy: IsolationPolicy) => IsolationPolicy;
  sensitiveRoots?: (paths: { root: string; sensitive: string }) => string[];
  systemFacts?: FakeHostPortsOptions["systemFacts"];
  resolvedServers?: IsolationPreparationInput["resolvedServers"];
  sanitizeMcpServers?: FakeHostPortsOptions["sanitizeMcpServers"];
  mainStorePath?: string | null;
  decisionTier?: "full" | "restricted";
  /** 호스트 워크스페이스를 민감 루트(디렉터리 mask) 아래에 두는 배치. */
  workspaceUnderSensitiveRoot?: boolean;
}

async function makeFixture(overrides: FixtureOverrides = {}): Promise<Fixture> {
  const root = await makeTempDir("b2-prep-");
  const sensitive = join(root, "prod-state");
  const workspace = overrides.workspaceUnderSensitiveRoot
    ? join(sensitive, "agent-workspaces", "utonium")
    : join(root, "workspace");
  const home = join(root, "home");
  const stateDir = join(root, "state");
  const sessionDir = join(stateDir, "session-1");
  const repo = join(workspace, ".projects", "soulstream");
  const commonDir = join(repo, ".git");
  const worktree = join(workspace, ".projects", "soulstream--b2");
  const canonicalCodex = join(
    home,
    ".local/share/soulstream/credentials/codex",
  );
  const agentCommonFiles = join(sensitive, "agent-common-files");

  for (const dir of [
    join(workspace, ".local/tmp"),
    join(workspace, ".local/artifacts"),
    join(workspace, ".local/index"),
    join(commonDir, "objects"),
    join(commonDir, "refs"),
    join(commonDir, "logs"),
    join(commonDir, "worktrees"),
    join(commonDir, "hooks"),
    join(commonDir, "info"),
    worktree,
    join(home, ".codex"),
    join(home, ".claude"),
    join(home, ".claude-accounts"),
    join(home, ".gemini"),
    join(home, ".pm2/logs"),
    join(home, ".cache/ms-playwright"),
    canonicalCodex,
    agentCommonFiles,
    sessionDir,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  touch(root, join(home, ".codex", "auth.json"), "original-auth");
  touch(root, join(commonDir, "config"), "[core]\n", 0o600);
  touch(root, join(commonDir, "HEAD"), "ref: refs/heads/main\n", 0o644);
  touch(root, join(commonDir, "packed-refs"), "# pack-refs\n", 0o644);
  touch(root, join(commonDir, "index"), "DIRC", 0o644);
  touch(root, join(canonicalCodex, "auth.json"), "canonical-auth", 0o600);
  touch(root, join(canonicalCodex, "auth.lock"), "", 0o600);

  const lockFilePaths: Record<string, string> = {};
  HEAVY_LOCK_PATHS.forEach((lockPath, index) => {
    lockFilePaths[lockPath] = touch(root, `locks/${index}.lock`, "", 0o600);
  });

  const systemFacts: FakeHostPortsOptions["systemFacts"] = {
    "/etc/resolv.conf": { kind: "file" },
    "/run/docker.sock": { kind: "file" },
    "/var/run/docker.sock": { kind: "file", realPath: "/run/docker.sock" },
    "/run/user": { kind: "directory" },
    "/proc/locks": { kind: "file" },
    ...overrides.systemFacts,
  };

  const sensitiveRoots = overrides.sensitiveRoots
    ? overrides.sensitiveRoots({ root, sensitive })
    : [sensitive];
  const basePolicy = makePolicy(sensitiveRoots);
  const policy = overrides.policy ? overrides.policy(basePolicy) : basePolicy;

  const options: FakeHostPortsOptions = {
    root,
    nodeId: "node-a",
    wsl: overrides.wsl ?? false,
    systemFacts,
    lockFilePaths,
    mainStorePath: overrides.mainStorePath ?? null,
    agentCommonFilesDir: agentCommonFiles,
    gitCommonDirs: { [repo]: commonDir },
    sanitizeMcpServers: overrides.sanitizeMcpServers,
  };
  const ports = createFakeHostPorts(options);

  const input: IsolationPreparationInput = {
    decision: {
      sessionId: "s1",
      tier: overrides.decisionTier ?? "restricted",
      policyVersion: 1,
      reason: "untrusted-preset",
      presetId: "deepseek-flash-4.1",
    },
    backend: overrides.backend ?? "codex",
    workspaceDir: workspace,
    sessionDirectory: sessionDir,
    hostWorkspaceRoot: workspace,
    incomingRoot: join(root, "incoming"),
    homeDirectory: home,
    uid: 1000,
    policy,
    policyDigest: "digest-b2",
    resolvedServers: overrides.resolvedServers ?? [],
    actualInternalMcpUrl: "http://127.0.0.1:3115/mcp/internal",
    ownedWorktrees: [{
      id: "wt-1",
      canonicalPath: worktree,
      repoId: "soulstream",
      commonDir,
    }],
    attachedWorktrees: [],
    registeredRepositories: [{ repoId: "soulstream", canonicalPath: repo }],
    authPreparation: overrides.authPreparation ?? {
      kind: "codex-grant",
      canonicalCodexDirectory: canonicalCodex,
    },
    testDatabaseUrl: overrides.testDatabaseUrl,
    scratchWorkspaceDir: join(workspace, ".local"),
  };

  return {
    root,
    workspace,
    home,
    stateDir,
    sessionDir,
    repo,
    commonDir,
    worktree,
    canonicalCodex,
    sensitive,
    agentCommonFiles,
    options,
    ports,
    input,
  };
}

function lstatSyncOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function bindingOf(
  bindings: readonly { source: string; destination: string; writable: boolean }[],
  destination: string,
) {
  return bindings.find((binding) => binding.destination === destination);
}

async function expectErrorCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("prepareIsolationPlan", () => {
  it("fills the spec from host facts with canonical absolute paths", async () => {
    const fixture = await makeFixture({
      testDatabaseUrl: "postgres://tester:db-secret@127.0.0.1:55432/soulstream_test",
      policy: (policy) => ({
        ...policy,
        testDatabases: [{ nodeId: "node-a", hostPort: 55432, sandboxPort: 15432 }],
      }),
    });
    // 워크트리 턴의 실제 배선: agent.workspace_dir는 워크트리 경로로 치환되고,
    // hostWorkspaceRoot는 치환 전 프로필 경로로 남는다.
    fixture.input.workspaceDir = fixture.worktree;

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    const sandbox = join(fixture.sessionDir, "sandbox");
    const sessionWorktreeRoot = join(
      fixture.workspace,
      ".projects",
      ".isolated",
      "s1",
    );
    const cacheRoot = join(
      fixture.home,
      ".local/share/soulstream/isolated-cache",
    );

    expect(prepared.spec).toMatchObject({
      version: 1,
      enabled: true,
      sessionId: "s1",
      backend: "codex",
      workspaceDir: fixture.worktree,
      scratchWorkspaceDir: join(fixture.workspace, ".local"),
      sandboxDirectory: sandbox,
      sessionWorktreeRoot,
      authKind: "codex-grant",
      policyDigest: "digest-b2",
      approvedTestDatabase: { hostPort: 55432, sandboxPort: 15432 },
    });
    for (const value of [
      prepared.spec.workspaceDir,
      prepared.spec.scratchWorkspaceDir,
      prepared.spec.sandboxDirectory,
      prepared.spec.sessionWorktreeRoot,
      prepared.spec.bindings[0]?.source,
      prepared.spec.masks[0]?.path,
    ]) {
      expect(value?.startsWith("/")).toBe(true);
      expect(value).not.toContain("..");
    }

    // 워크트리와 session worktree root, 두 .local 디렉터리, sandbox, 캐시는 RW.
    // 워크트리가 있어도 호스트 워크스페이스 루트는 RO bind다. 워크트리 턴의
    // workspaceDir는 워크트리 경로라 그것을 쓰면 같은 목적지에서 RO와 RW가 겹친다.
    expect(bindingOf(prepared.spec.bindings, fixture.workspace)).toMatchObject({
      writable: false,
    });
    expect(bindingOf(prepared.spec.bindings, fixture.worktree)).toMatchObject({
      writable: true,
    });
    // 부모 workspace RO bind가 자식 워크트리 RW bind보다 먼저 와야 한다.
    const destinations = prepared.spec.bindings.map((binding) => binding.destination);
    expect(destinations.indexOf(fixture.workspace)).toBeLessThan(
      destinations.indexOf(fixture.worktree),
    );
    expect(bindingOf(prepared.spec.bindings, sessionWorktreeRoot)).toMatchObject({
      writable: true,
    });
    expect(bindingOf(prepared.spec.bindings, sandbox)).toMatchObject({ writable: true });
    expect(
      bindingOf(prepared.spec.bindings, join(fixture.workspace, ".local/tmp")),
    ).toMatchObject({ writable: true });
    expect(
      bindingOf(prepared.spec.bindings, join(fixture.workspace, ".local/artifacts")),
    ).toMatchObject({ writable: true });
    for (const name of [
      "pnpm-store",
      "npm",
      "xdg",
      "corepack",
      "pip",
      "uv",
      "cargo",
      "sccache",
    ]) {
      expect(bindingOf(prepared.spec.bindings, join(cacheRoot, name))).toMatchObject({
        writable: true,
      });
      expect(lstatSync(join(cacheRoot, name)).mode & 0o777).toBe(0o700);
    }

    // base는 RO, 승인 재노출만 RO bind로 올린다.
    expect(bindingOf(prepared.spec.bindings, "/etc/resolv.conf")).toMatchObject({
      writable: false,
    });
    expect(
      bindingOf(prepared.spec.bindings, join(fixture.home, ".pm2/logs")),
    ).toMatchObject({ writable: false });
    expect(
      bindingOf(prepared.spec.bindings, fixture.agentCommonFiles),
    ).toMatchObject({ writable: false });
    expect(bindingOf(prepared.spec.bindings, fixture.canonicalCodex)).toMatchObject({
      writable: true,
    });

    // Git view: 공유 4개 디렉터리는 RW, hooks/info와 packed-refs는 RO.
    const viewRoot = join(sandbox, "git-common", "soulstream");
    expect(bindingOf(prepared.spec.bindings, fixture.commonDir)).toMatchObject({
      source: viewRoot,
      writable: true,
    });
    for (const name of ["objects", "refs", "logs", "worktrees"]) {
      expect(
        bindingOf(prepared.spec.bindings, join(fixture.commonDir, name)),
      ).toMatchObject({ writable: true });
    }
    for (const name of ["hooks", "info", "packed-refs", "index"]) {
      expect(
        bindingOf(prepared.spec.bindings, join(fixture.commonDir, name)),
      ).toMatchObject({ writable: false });
    }
    expect(readFileSync(join(viewRoot, "config"), "utf8")).toBe("[core]\n");
    expect(lstatSync(join(viewRoot, "config")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(viewRoot, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");

    // mask: 홈 인증 루트, PM2, user bus, 정책 민감 루트, runner state 전체.
    const maskedPaths = prepared.spec.masks.map((mask) => mask.path);
    for (const path of [
      join(fixture.home, ".codex"),
      join(fixture.home, ".claude"),
      join(fixture.home, ".claude-accounts"),
      join(fixture.home, ".gemini"),
      join(fixture.home, ".pm2"),
      join(fixture.home, ".local/share/soulstream/credentials"),
      "/run/user",
      fixture.sensitive,
      dirname(fixture.sessionDir),
    ]) {
      expect(maskedPaths).toContain(path);
    }
    // `/run/user/<uid>`는 마스크 계산과 실행 사이에 없어질 수 있어 늘 있는
    // 부모를 가린다. 자식 경로는 따로 mask하지 않는다.
    expect(maskedPaths).not.toContain(`/run/user/${fixture.input.uid}`);
    // 세션 디렉터리는 state 루트 mask에 포함되므로 따로 mask하지 않는다.
    expect(maskedPaths).not.toContain(fixture.sessionDir);
    expect(prepared.spec.masks).toContainEqual({
      path: "/run/docker.sock",
      kind: "file",
    });
    expect(prepared.spec.masks).toContainEqual({
      path: "/var/run/docker.sock",
      kind: "file",
    });
    expect(maskedPaths).not.toContain(fixture.canonicalCodex);

    // 디렉터리 mask를 먼저, 민감 파일 mask를 마지막에 둔다(B1 적용 순서 계약).
    const fileMaskStart = prepared.spec.masks.findIndex((mask) => mask.kind === "file");
    if (fileMaskStart >= 0) {
      expect(
        prepared.spec.masks.slice(fileMaskStart).every((mask) => mask.kind === "file"),
      ).toBe(true);
    }

    expect(prepared.spec.heavyWorkLockBindings).toHaveLength(5);
    prepared.spec.heavyWorkLockBindings.forEach((binding, index) => {
      expect(binding.destination).toBe(HEAVY_LOCK_PATHS[index]);
      expect(binding.writable).toBe(true);
    });
    expect(prepared.spec.hostProcLocksBinding).toEqual({
      source: "/proc/locks",
      destination: "/proc/locks",
      writable: false,
    });
    expect(fixture.ports.calls.ensureLockFile.sort()).toEqual(
      [...HEAVY_LOCK_PATHS].sort(),
    );

    // 인증: canonical 디렉터리 RW bind + 전용 CODEX_HOME symlink.
    const codexHome = join(sandbox, "codex-home");
    expect(prepared.env.CODEX_HOME).toBe(codexHome);
    expect(readlinkSync(join(codexHome, "auth.json"))).toBe(
      join(fixture.canonicalCodex, "auth.json"),
    );
    expect(readlinkSync(join(codexHome, "auth.lock"))).toBe(
      join(fixture.canonicalCodex, "auth.lock"),
    );

    // env는 세션 추가분만 담고, 시험 DB URL은 승인 포트로 바꾼다.
    expect(prepared.env.AUTH_BEARER_TOKEN).toBe("ssr1.s1.fake-signature");
    expect(prepared.env.GH_TOKEN).toBe("fake-gh-token");
    expect(prepared.env.GH_CONFIG_DIR).toBe(join(sandbox, "gh"));
    expect(prepared.env.TEST_DATABASE_URL).toBe(
      "postgres://tester:db-secret@127.0.0.1:15432/soulstream_test",
    );
    // §9 격리 캐시 env는 세션 추가분에 들어간다.
    expect(prepared.env.npm_config_store_dir).toBe(join(cacheRoot, "pnpm-store"));
    expect(prepared.env.pnpm_config_store_dir).toBe(join(cacheRoot, "pnpm-store"));
    expect(prepared.env.XDG_CACHE_HOME).toBe(join(cacheRoot, "xdg"));
    expect(prepared.env.COREPACK_HOME).toBe(join(cacheRoot, "corepack"));
    expect(prepared.env.PIP_CACHE_DIR).toBe(join(cacheRoot, "pip"));
    expect(prepared.env.UV_CACHE_DIR).toBe(join(cacheRoot, "uv"));
    expect(prepared.env.CARGO_HOME).toBe(join(cacheRoot, "cargo"));
    expect(prepared.env.SCCACHE_DIR).toBe(join(cacheRoot, "sccache"));
    expect(prepared.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
      join(fixture.home, ".cache/ms-playwright"),
    );
    expect(JSON.stringify(prepared.spec)).not.toContain("postgres://");
    expect(JSON.stringify(prepared.spec)).not.toContain("db-secret");

    expect(prepared.resolvConfPath).toBe(join(sandbox, "resolv.conf"));
    expect(readFileSync(prepared.resolvConfPath, "utf8")).toBe(
      "nameserver 192.0.2.53\n",
    );

    // 안내: 실제 write root와 SCRATCH 값, 비밀 없음.
    expect(prepared.contextNotice).toContain(join(fixture.workspace, ".local"));
    for (const root of [
      join(fixture.workspace, ".local/tmp"),
      join(fixture.workspace, ".local/artifacts"),
      sessionWorktreeRoot,
      fixture.worktree,
      cacheRoot,
    ]) {
      expect(prepared.contextNotice).toContain(root);
    }
    expect(prepared.contextNotice).not.toContain("ssr1.");
    expect(prepared.contextNotice).not.toContain("db-secret");
    expect(prepared.contextNotice).not.toContain(fixture.canonicalCodex);
  });

  it("skips the checkout index binding and removes the stale view placeholder when the host index is missing", async () => {
    const fixture = await makeFixture();
    const viewRoot = join(fixture.sessionDir, "sandbox", "git-common", "soulstream");
    // bwrap은 파일 bind의 목적지에 0바이트 자리 파일을 남긴다. 호스트 index가
    // 없으면 그 파일이 그대로 보이고 0바이트 index는 git을 fatal로 멈춘다.
    touch(fixture.root, join(viewRoot, "index"));
    rmSync(join(fixture.commonDir, "index"), { force: true });

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    expect(
      bindingOf(prepared.spec.bindings, join(fixture.commonDir, "index")),
    ).toBeUndefined();
    expect(lstatSyncOrNull(join(viewRoot, "index"))).toBeNull();
  });

  it("binds the sandbox resolver to the real path of a symlinked host resolver", async () => {
    const fixture = await makeFixture();
    const resolveRealPath = fixture.ports.resolveRealPath;
    fixture.ports.resolveRealPath = async (path) => path === "/etc/resolv.conf"
      ? "/mnt/wsl/resolv.conf"
      : resolveRealPath(path);

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    expect(bindingOf(prepared.spec.bindings, "/mnt/wsl/resolv.conf")).toEqual({
      source: prepared.resolvConfPath,
      destination: "/mnt/wsl/resolv.conf",
      writable: false,
    });
    expect(bindingOf(prepared.spec.bindings, "/etc/resolv.conf")).toBeUndefined();
  });

  it("fails when the host resolver's real path cannot be resolved", async () => {
    const fixture = await makeFixture();
    fixture.options.realPathFailures = ["/etc/resolv.conf"];
    fixture.ports = createFakeHostPorts(fixture.options);

    await expect(prepareIsolationPlan(fixture.input, fixture.ports)).rejects.toThrow(
      "EACCES: /etc/resolv.conf",
    );
  });

  it("keeps the workspace read-only when no worktree is attached", async () => {
    const fixture = await makeFixture();
    fixture.input.ownedWorktrees = [];

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    expect(bindingOf(prepared.spec.bindings, fixture.workspace)).toMatchObject({
      writable: false,
    });
    expect(
      bindingOf(prepared.spec.bindings, join(fixture.workspace, ".local/tmp")),
    ).toMatchObject({ writable: true });

    // 부모 workspace RO bind가 자식 .local RW bind보다 먼저 와야 한다.
    const destinations = prepared.spec.bindings.map((binding) => binding.destination);
    expect(destinations.indexOf(fixture.workspace)).toBeLessThan(
      destinations.indexOf(join(fixture.workspace, ".local/tmp")),
    );
  });

  it("reopens only this session's incoming folder read-only under a masked root", async () => {
    const fixture = await makeFixture();
    const incomingRoot = fixture.input.incomingRoot;
    mkdirSync(join(incomingRoot, "other-session/assets"), { recursive: true });
    const own = join(incomingRoot, "s1");
    expect(lstatSyncOrNull(own)).toBeNull();

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    // 상자 계획이 첨부 다운로드보다 먼저라 폴더가 아직 없으면 만든다.
    expect(lstatSync(own).isDirectory()).toBe(true);
    const incomingBindings = prepared.spec.bindings.filter(
      (binding) => binding.destination.startsWith(incomingRoot),
    );
    expect(incomingBindings).toEqual([
      { source: own, destination: own, writable: false },
    ]);
    expect(prepared.spec.masks).toContainEqual({ path: incomingRoot, kind: "directory" });
    expect(bindingOf(prepared.spec.bindings, incomingRoot)).toBeUndefined();
    expect(bindingOf(prepared.spec.bindings, join(incomingRoot, "other-session")))
      .toBeUndefined();
  });

  it("rejects a relative incoming root", async () => {
    const fixture = await makeFixture();
    await expect(
      prepareIsolationPlan({ ...fixture.input, incomingRoot: ".local/incoming" }, fixture.ports),
    ).rejects.toMatchObject({ code: ISOLATION_POLICY_UNAVAILABLE });
  });

  it("masks WSL mounts and refuses when the WSL marker is missing", async () => {
    const fixture = await makeFixture({
      wsl: true,
      systemFacts: {
        "/mnt": { kind: "directory" },
        "/run/WSL": { kind: "directory" },
      },
    });

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    expect(prepared.spec.masks).toContainEqual({ path: "/mnt", kind: "directory" });
    expect(prepared.spec.masks).toContainEqual({ path: "/run/WSL", kind: "directory" });

    const broken = await makeFixture({ wsl: true });
    await expectErrorCode(
      prepareIsolationPlan(broken.input, broken.ports),
      SESSION_ISOLATION_UNAVAILABLE,
    );
  });

  it("masks the real path of a symlinked sensitive root, not the symlink", async () => {
    const fixture = await makeFixture({
      sensitiveRoots: ({ root }) => [join(root, "alias-root")],
    });

    // alias-root는 sensitive를 가리키는 symlink다.
    symlinkSync(fixture.sensitive, join(fixture.root, "alias-root"));

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masks = prepared.spec.masks;

    // bwrap은 symlink destination에 mount하지 못하므로 실경로만 가린다.
    expect(masks.some((mask) => mask.path === join(fixture.root, "alias-root"))).toBe(
      false,
    );
    expect(masks).toContainEqual({ path: fixture.sensitive, kind: "directory" });
  });

  it("refuses when an existing symlink mask target cannot be resolved", async () => {
    const fixture = await makeFixture({
      sensitiveRoots: ({ root }) => [join(root, "alias-root")],
    });
    const aliasRoot = join(fixture.root, "alias-root");
    symlinkSync(fixture.sensitive, aliasRoot);
    fixture.options.realPathFailures = [aliasRoot];
    fixture.ports = createFakeHostPorts(fixture.options);

    await expectErrorCode(
      prepareIsolationPlan(fixture.input, fixture.ports),
      SESSION_ISOLATION_UNAVAILABLE,
    );
  });

  it("refuses when an existing directory mask target cannot be resolved", async () => {
    const fixture = await makeFixture();
    fixture.options.realPathFailures = [fixture.sensitive];
    fixture.ports = createFakeHostPorts(fixture.options);

    await expectErrorCode(
      prepareIsolationPlan(fixture.input, fixture.ports),
      SESSION_ISOLATION_UNAVAILABLE,
    );
  });

  it("reopens masked roots read-only and skips missing re-exposed paths", async () => {
    const fixture = await makeFixture();
    const reexposed = join(fixture.sensitive, "logs");
    mkdirSync(reexposed, { recursive: true, mode: 0o700 });
    const missing = join(fixture.sensitive, "missing-logs");
    fixture.input.policy = {
      ...fixture.input.policy,
      filesystem: {
        ...fixture.input.policy.filesystem,
        readOnlyReexposedPaths: [reexposed, missing],
      },
    };

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    // 가린 루트 아래의 재노출 디렉터리는 RO bind 하나로 올라간다.
    expect(prepared.spec.masks).toContainEqual({
      path: fixture.sensitive,
      kind: "directory",
    });
    expect(bindingOf(prepared.spec.bindings, reexposed)).toEqual({
      source: reexposed,
      destination: reexposed,
      writable: false,
    });
    // 없는 경로는 세션 시작을 막지 않고 건너뛴다.
    expect(bindingOf(prepared.spec.bindings, missing)).toBeUndefined();
  });

  it("masks the credential root for every backend and reopens it only for Codex", async () => {
    const credentialRootOf = (fixture: Fixture): string =>
      join(fixture.home, ".local/share/soulstream/credentials");

    const codex = await makeFixture();
    const codexPlan = await prepareIsolationPlan(codex.input, codex.ports);
    expect(codexPlan.spec.masks).toContainEqual({
      path: credentialRootOf(codex),
      kind: "directory",
    });
    expect(bindingOf(codexPlan.spec.bindings, codex.canonicalCodex)).toMatchObject({
      writable: true,
    });

    for (const backend of ["claude", "opencode"] as const) {
      const fixture = await makeFixture({
        backend,
        authPreparation: { kind: "apikey-env" },
      });
      const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
      expect(prepared.spec.masks).toContainEqual({
        path: credentialRootOf(fixture),
        kind: "directory",
      });
      expect(
        bindingOf(prepared.spec.bindings, fixture.canonicalCodex),
      ).toBeUndefined();
    }
  });

  it("masks service env files and backups under the dotenv directory recursively", async () => {
    const fixture = await makeFixture();
    const serviceDir = join(fixture.root, "service-env");
    touch(fixture.root, "service-env/.env.soul-server-ts", "A=1", 0o600);
    touch(fixture.root, "service-env/.env.soul-server-ts.before-20261106-x", "B=2", 0o600);
    touch(fixture.root, "service-env/.env.local", "C=3", 0o600);
    const envTarget = touch(fixture.root, "service-env/env-target", "D=4", 0o600);
    symlinkSync(envTarget, join(serviceDir, ".env"));
    touch(fixture.root, "service-env/package.json", "{}", 0o644);
    touch(fixture.root, "service-env/sub/.env.nested", "E=5", 0o600);

    fixture.options.serviceEnvironmentDir = serviceDir;
    fixture.ports = createFakeHostPorts(fixture.options);

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masks = prepared.spec.masks;

    for (const path of [
      join(serviceDir, ".env.soul-server-ts"),
      join(serviceDir, ".env.soul-server-ts.before-20261106-x"),
      join(serviceDir, ".env.local"),
    ]) {
      expect(masks).toContainEqual({ path, kind: "file" });
    }
    // `.env` symlink는 bwrap destination 제약 때문에 실경로만 가린다.
    expect(masks).toContainEqual({ path: envTarget, kind: "file" });
    expect(masks.some((mask) => mask.path === join(serviceDir, ".env"))).toBe(false);
    expect(
      masks.some((mask) => mask.path === join(serviceDir, "package.json")),
    ).toBe(false);
    // 하위 디렉터리도 훑는다.
    expect(
      masks.some((mask) => mask.path === join(serviceDir, "sub/.env.nested")),
    ).toBe(true);
  });

  it("masks .env files under read-only re-exposed paths and the workspace bind", async () => {
    const fixture = await makeFixture();
    const repoDir = join(fixture.workspace, ".projects", "BlockNote");
    // 리포 층은 작업 폴더의 바로 아래가 아니므로 프로젝트 뿌리를 입력에 명시한다.
    fixture.input.projectsRoot = join(fixture.workspace, ".projects");
    const reexposed = join(fixture.sensitive, "logs");
    fixture.input.policy = {
      ...fixture.input.policy,
      filesystem: {
        ...fixture.input.policy.filesystem,
        readOnlyReexposedPaths: [reexposed],
      },
    };

    // 뿌리에서 모음 폴더(.projects) 아래 리포 층까지가 훑는 자리다.
    const maskedTargets = [
      join(repoDir, ".env"),
      join(repoDir, ".env.local"),
      join(repoDir, "x.env"),
      join(reexposed, "config", ".env"),
    ];
    for (const path of maskedTargets) {
      touch(fixture.root, path, "SECRET=1", 0o600);
    }
    // 예시·틀 파일은 그대로 둔다.
    touch(fixture.root, join(repoDir, ".env.example"), "A=1", 0o600);
    touch(fixture.root, join(repoDir, ".env.local.sample"), "A=1", 0o600);
    touch(fixture.root, join(repoDir, ".env.template"), "A=1", 0o600);
    // 탐색하지 않는 가지: 리포 아래 패키지 층과 건너뛰는 이름.
    const unscanned = [
      join(repoDir, "playground", ".env"),
      join(repoDir, "node_modules", "pkg", ".env"),
      join(repoDir, ".git", ".env"),
    ];
    for (const path of unscanned) {
      touch(fixture.root, path, "A=1", 0o600);
    }
    // 세션이 쓸 수 있게 연 경로.
    const writePaths = [
      join(fixture.worktree, ".env"),
      join(fixture.workspace, ".local", "tmp", "s1", ".env"),
      join(fixture.workspace, ".local", "artifacts", "notes", ".env"),
      join(fixture.sessionDir, "sandbox", ".env"),
      join(fixture.workspace, ".projects", ".isolated", "s1", ".env"),
      join(fixture.home, ".local/share/soulstream/isolated-cache", "cargo", ".env"),
    ];
    for (const path of writePaths) {
      touch(fixture.root, path, "A=1", 0o600);
    }

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masked = new Set(prepared.spec.masks.map((mask) => mask.path));

    for (const path of maskedTargets) {
      expect(masked.has(path), path).toBe(true);
    }
    for (const path of [
      join(repoDir, ".env.example"),
      join(repoDir, ".env.local.sample"),
      join(repoDir, ".env.template"),
      ...unscanned,
      ...writePaths,
    ]) {
      expect(masked.has(path), path).toBe(false);
    }
  });

  it("masks .env files at each root and one level down", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const projectsRoot = join(fixture.workspace, ".projects");
    const profileRoot = join(fixture.root, "agent-workspaces", "utonium");
    fixture.input.projectsRoot = projectsRoot;
    fixture.input.agentWorkspaceDirs = [profileRoot];
    const maskedTargets = [
      join(fixture.workspace, ".env"),
      join(fixture.workspace, "a", ".env"),
      join(projectsRoot, "repo", ".env"),
      join(profileRoot, ".env.local"),
      join(profileRoot, "sub", ".env"),
    ];
    const unscanned = [
      join(fixture.workspace, "a", "b", ".env"),
      join(projectsRoot, "repo", "pkg", ".env"),
      join(profileRoot, "a", "b", ".env"),
    ];
    for (const path of [...maskedTargets, ...unscanned]) {
      touch(fixture.root, path, "A=1", 0o600);
    }

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masked = new Set(prepared.spec.masks.map((mask) => mask.path));

    for (const path of maskedTargets) {
      expect(masked.has(path), path).toBe(true);
    }
    for (const path of unscanned) {
      expect(masked.has(path), path).toBe(false);
    }
  });

  it("scans by root list, not by folder names", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    // 이름이 `.projects`가 아니어도 프로젝트 뿌리로 주면 리포 층을 훑는다.
    const projectsRoot = join(fixture.workspace, "code");
    const rooted = join(projectsRoot, "repo", ".env");
    const unrootedProjects = join(fixture.workspace, ".projects", "repo", ".env");
    const unrootedAgent = join(fixture.workspace, "agent-workspaces", "x", ".env.local");
    for (const path of [rooted, unrootedProjects, unrootedAgent]) {
      touch(fixture.root, path, "A=1", 0o600);
    }

    const withoutRoot = await prepareIsolationPlan(fixture.input, fixture.ports);
    const withoutMasks = new Set(withoutRoot.spec.masks.map((mask) => mask.path));
    // 뿌리 아래 한 층만 훑으므로 손자 층은 이름과 무관하게 나열하지 않는다.
    expect(withoutMasks.has(rooted)).toBe(false);
    expect(withoutMasks.has(unrootedProjects)).toBe(false);
    expect(withoutMasks.has(unrootedAgent)).toBe(false);

    fixture.input.projectsRoot = projectsRoot;
    const withRoot = await prepareIsolationPlan(fixture.input, fixture.ports);
    const withMasks = new Set(withRoot.spec.masks.map((mask) => mask.path));
    expect(withMasks.has(rooted)).toBe(true);
    // 뿌리 바로 아래 한 층까지다.
    expect(
      withMasks.has(join(projectsRoot, "repo", "pkg", ".env")),
    ).toBe(false);
    // 프로필 뿌리를 주지 않은 이름 기반 폴더는 여전히 훑지 않는다.
    expect(withMasks.has(unrootedProjects)).toBe(false);
    expect(withMasks.has(unrootedAgent)).toBe(false);
  });

  it("scans agent profile workspace directories and skips unusable values", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const profileRoot = join(fixture.root, "profile-workspace");
    fixture.input.agentWorkspaceDirs = [
      profileRoot,
      "relative/workspace",
      join(fixture.root, "missing-profile"),
    ];
    const maskedTargets = [
      join(profileRoot, ".env.local"),
      join(profileRoot, "sub", ".env"),
    ];
    for (const path of maskedTargets) {
      touch(fixture.root, path, "A=1", 0o600);
    }
    const unscanned = join(profileRoot, "a", "b", ".env");
    touch(fixture.root, unscanned, "A=1", 0o600);

    // 상대 경로와 없는 경로는 오류 없이 건너뛴다.
    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masked = new Set(prepared.spec.masks.map((mask) => mask.path));

    for (const path of maskedTargets) {
      expect(masked.has(path), path).toBe(true);
    }
    expect(masked.has(unscanned)).toBe(false);
  });

  it("scans policy envMaskScanRoots and rejects relative or wildcard roots", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const policyRoot = join(fixture.root, "policy-scan");
    fixture.input.policy = {
      ...fixture.input.policy,
      filesystem: {
        ...fixture.input.policy.filesystem,
        envMaskScanRoots: [policyRoot, join(fixture.root, "missing-policy-root")],
      },
    };
    const maskedTargets = [
      join(policyRoot, ".env"),
      join(policyRoot, "x", ".env"),
    ];
    for (const path of maskedTargets) {
      touch(fixture.root, path, "A=1", 0o600);
    }
    const unscanned = join(policyRoot, "x", "y", ".env");
    touch(fixture.root, unscanned, "A=1", 0o600);

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masked = new Set(prepared.spec.masks.map((mask) => mask.path));
    for (const path of maskedTargets) {
      expect(masked.has(path), path).toBe(true);
    }
    expect(masked.has(unscanned)).toBe(false);

    for (const invalid of [
      ["relative/path"],
      [join(fixture.root, "scan*")],
      [join(fixture.root, "scan?")],
      [join(fixture.root, "scan[0]")],
    ]) {
      fixture.input.policy = {
        ...fixture.input.policy,
        filesystem: {
          ...fixture.input.policy.filesystem,
          envMaskScanRoots: invalid,
        },
      };
      await expectErrorCode(
        prepareIsolationPlan(fixture.input, fixture.ports),
        ISOLATION_POLICY_UNAVAILABLE,
      );
    }
  });

  it("lists only the root and its direct children", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const workspaceRoot = await fixture.ports.resolveRealPath(fixture.workspace);
    mkdirSync(join(fixture.workspace, "a", "b"), { recursive: true, mode: 0o700 });
    mkdirSync(join(fixture.workspace, ".projects", "repo", "pkg"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(fixture.workspace, "agent-workspaces", "x", "sub"), {
      recursive: true,
      mode: 0o700,
    });

    const listings: string[] = [];
    const listDirectorySync = fixture.ports.listDirectorySync.bind(fixture.ports);
    fixture.ports.listDirectorySync = (path) => {
      listings.push(path);
      return listDirectorySync(path);
    };

    await scanEnvMaskRoots([workspaceRoot], fixture.ports, []);

    expect(listings).toContain(workspaceRoot);
    expect(listings).toContain(join(workspaceRoot, "a"));
    expect(listings).toContain(join(workspaceRoot, ".projects"));
    expect(listings).toContain(join(workspaceRoot, "agent-workspaces"));
    // 뿌리 바로 아래 폴더의 내부는 나열하지 않는다. 이름 규칙도 없다.
    expect(listings).not.toContain(join(workspaceRoot, "a", "b"));
    expect(listings).not.toContain(join(workspaceRoot, ".projects", "repo"));
    expect(listings).not.toContain(join(workspaceRoot, ".projects", "repo", "pkg"));
    expect(listings).not.toContain(join(workspaceRoot, "agent-workspaces", "x"));
    expect(listings).not.toContain(
      join(workspaceRoot, "agent-workspaces", "x", "sub"),
    );
    // 뿌리 자신은 깊이 0으로 한 번만 나열한다.
    expect(listings.filter((path) => path === workspaceRoot)).toHaveLength(1);
  });

  it("skips build output directory names in the .env scan", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const projectsRoot = join(fixture.workspace, ".projects");
    fixture.input.projectsRoot = projectsRoot;
    const repoDir = join(projectsRoot, "site");
    const skipped = [
      join(fixture.workspace, "public", ".env"),
      join(fixture.workspace, "dist", ".env"),
      // 프로젝트 뿌리 바로 아래의 건너뛰는 이름도 나열하지 않는다.
      join(projectsRoot, "dist", ".env"),
      join(repoDir, "public", ".env"),
      join(repoDir, "dist", ".env"),
    ];
    for (const path of skipped) {
      touch(fixture.root, path, "A=1", 0o600);
    }
    const kept = [
      join(fixture.workspace, "site-src", ".env"),
      join(repoDir, ".env"),
    ];
    for (const path of kept) {
      touch(fixture.root, path, "B=2", 0o600);
    }

    const listings: string[] = [];
    const listDirectorySync = fixture.ports.listDirectorySync.bind(fixture.ports);
    fixture.ports.listDirectorySync = (path) => {
      listings.push(path);
      return listDirectorySync(path);
    };

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masked = new Set(prepared.spec.masks.map((mask) => mask.path));

    for (const path of skipped) {
      expect(masked.has(path), path).toBe(false);
    }
    for (const path of kept) {
      expect(masked.has(path), path).toBe(true);
    }
    // 프로젝트 뿌리 바로 아래라도 건너뛰는 이름은 나열하지 않는다.
    const projectsRootReal = await fixture.ports.resolveRealPath(projectsRoot);
    expect(listings).not.toContain(join(projectsRootReal, "dist"));
  });

  it("excludes .local scratch directories under every re-exposed scan root", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const reexposed = join(fixture.sensitive, "logs");
    mkdirSync(reexposed, { recursive: true, mode: 0o700 });
    fixture.input.policy = {
      ...fixture.input.policy,
      filesystem: {
        ...fixture.input.policy.filesystem,
        readOnlyReexposedPaths: [reexposed],
      },
    };
    const excluded = [
      join(reexposed, ".local", "tmp", ".env"),
      join(reexposed, ".local", "artifacts", ".env"),
    ];
    for (const path of excluded) {
      touch(fixture.root, path, "A=1", 0o600);
    }
    const kept = join(reexposed, "conf", ".env");
    touch(fixture.root, kept, "B=2", 0o600);

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masked = new Set(prepared.spec.masks.map((mask) => mask.path));

    for (const path of excluded) {
      expect(masked.has(path), path).toBe(false);
    }
    expect(masked.has(kept)).toBe(true);
  });

  it("reuses the one-layer .env scan per root for five minutes and rescans after expiry", async () => {
    clearEnvMaskScanCache();
    vi.useFakeTimers();
    try {
      const fixture = await makeFixture();
      const first = join(fixture.workspace, ".projects", "one");
      const later = join(fixture.workspace, ".projects", "two");
      fixture.input.projectsRoot = join(fixture.workspace, ".projects");
      touch(fixture.root, join(first, ".env"), "A=1", 0o600);

      const scans: IsolationEnvMaskScan[] = [];
      const lastScan = (): IsolationEnvMaskScan => {
        const scan = scans[scans.length - 1];
        if (!scan) throw new Error("탐색 로그가 없습니다");
        return scan;
      };
      const prepare = () =>
        prepareIsolationPlan(fixture.input, fixture.ports, {
          logEnvMaskScan: (scan) => scans.push(scan),
        });

      const firstPlan = await prepare();
      expect(lastScan()).toMatchObject({ cache: "miss" });
      expect(lastScan().cacheMisses).toBeGreaterThan(0);
      // 로그 요약에 계측 필드가 실린다.
      expect(lastScan().walkedRoots + lastScan().joinedRoots).toBe(
        lastScan().cacheMisses,
      );
      expect(lastScan().walkedRoots).toBeGreaterThan(0);
      expect(lastScan().joinedRoots).toBe(0);
      expect(lastScan().directories).toBeGreaterThan(0);
      expect(lastScan().listMs).toBeGreaterThanOrEqual(0);
      expect(lastScan().linkMs).toBeGreaterThanOrEqual(0);
      expect(lastScan().yieldMs).toBeGreaterThanOrEqual(0);
      expect(lastScan().yields).toBeGreaterThanOrEqual(0);
      expect(firstPlan.spec.masks).toContainEqual({
        path: join(first, ".env"),
        kind: "file",
      });

      // 5분 안의 두 번째 준비는 디렉터리를 다시 읽지 않으므로, 그 사이 생긴
      // 파일은 다시 훑기 전까지 목록에 없다.
      touch(fixture.root, join(later, ".env"), "B=2", 0o600);
      const secondPlan = await prepare();
      expect(lastScan()).toMatchObject({ cache: "hit", cacheMisses: 0 });
      expect(secondPlan.spec.masks).toEqual(firstPlan.spec.masks);
      expect(
        secondPlan.spec.masks.some((mask) => mask.path === join(later, ".env")),
      ).toBe(false);

      vi.setSystemTime(Date.now() + ENV_MASK_SCAN_CACHE_TTL_MS + 1);
      const thirdPlan = await prepare();
      expect(lastScan()).toMatchObject({ cache: "miss" });
      expect(thirdPlan.spec.masks).toContainEqual({
        path: join(later, ".env"),
        kind: "file",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates a root's cached scan so a new worktree .env is masked", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const projectsRoot = join(fixture.workspace, ".projects");
    fixture.input.projectsRoot = projectsRoot;
    const prepare = () => prepareIsolationPlan(fixture.input, fixture.ports);

    const first = await prepare();
    expect(
      first.spec.masks.some((mask) => mask.path === join(projectsRoot, "new-wt", ".env.local")),
    ).toBe(false);

    // 캐시가 살아 있는 동안 만든 워크트리의 .env는 다음 준비에서 보이지 않는다.
    const late = touch(
      fixture.root,
      join(projectsRoot, "new-wt", ".env.local"),
      "S=1",
      0o600,
    );
    const cached = await prepare();
    expect(cached.spec.masks.some((mask) => mask.path === late)).toBe(false);

    invalidateEnvMaskScanRoot(projectsRoot);
    const rescanned = await prepare();
    expect(rescanned.spec.masks).toContainEqual({ path: late, kind: "file" });
  });

  it("does not cache a scan that is invalidated while it runs", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const root = join(fixture.root, "inflight-root");
    touch(fixture.root, join(root, ".env"), "A=1", 0o600);
    const late = join(root, "a", ".env");
    let invalidated = false;
    const listDirectorySync = fixture.ports.listDirectorySync.bind(fixture.ports);
    fixture.ports.listDirectorySync = (path) => {
      // 첫 나열 도중에 뿌리를 무효화한다. 아직 훑는 중이다.
      if (path === root && !invalidated) {
        invalidated = true;
        invalidateEnvMaskScanRoot(root);
        touch(fixture.root, late, "B=2", 0o600);
      }
      return listDirectorySync(path);
    };

    await scanEnvMaskRoots([root], fixture.ports, []);

    // 무효화 뒤의 다음 요청은 캐시를 되쓰지 않고 다시 훑는다.
    const second = await scanEnvMaskRoots([root], fixture.ports, []);
    expect(second).toMatchObject({ cacheHits: 0, cacheMisses: 1, walkedRoots: 1 });
    expect(second.rootScans[0]?.entries).toContainEqual({
      source: late,
      path: late,
      kind: "file",
    });
  });

  it("waits on one in-flight scan when two scans of the same root overlap", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const workspaceRoot = await fixture.ports.resolveRealPath(fixture.workspace);
    touch(fixture.root, join(fixture.workspace, ".projects", "one", ".env"), "A=1", 0o600);

    const listings: string[] = [];
    const listDirectorySync = fixture.ports.listDirectorySync.bind(fixture.ports);
    fixture.ports.listDirectorySync = (path) => {
      listings.push(path);
      return listDirectorySync(path);
    };

    const [first, second] = await Promise.all([
      scanEnvMaskRoots([workspaceRoot], fixture.ports, []),
      scanEnvMaskRoots([workspaceRoot], fixture.ports, []),
    ]);

    // 같은 뿌리를 동시에 훑어도 디렉터리 나열은 한 번이고, 두 요청은 그 결과를
    // 나눠 쓴다. 함께 기다린 요청은 캐시에서 되쓴 것이 아니므로 miss로 센다.
    expect(listings.filter((path) => path === workspaceRoot)).toHaveLength(1);
    expect(first).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      walkedRoots: 1,
      joinedRoots: 0,
    });
    expect(second).toMatchObject({
      cacheHits: 0,
      cacheMisses: 1,
      walkedRoots: 0,
      joinedRoots: 1,
    });
    // 함께 기다린 쪽은 시간·양보 계측을 겹쳐 세지 않는다.
    expect(second).toMatchObject({ listMs: 0, linkMs: 0, yields: 0, yieldMs: 0 });
    expect(second.files).toBe(first.files);
    expect(second.directories).toBe(first.directories);
    expect(second.rootScans).toEqual(first.rootScans);
  });

  it("resolves env mask symlinks through sync ports only", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const workspaceRoot = await fixture.ports.resolveRealPath(fixture.workspace);
    const target = touch(
      fixture.root,
      join(fixture.workspace, "secrets", "real.env"),
      "A=1",
      0o600,
    );
    const link = join(fixture.workspace, "secrets", ".env");
    symlinkSync(target, link);

    const resolveRealPath = vi.spyOn(fixture.ports, "resolveRealPath");
    const lstatPath = vi.spyOn(fixture.ports, "lstatPath");

    const scan = await scanEnvMaskRoots([workspaceRoot], fixture.ports, []);

    // 스캔 안의 await는 양보뿐이다. 링크 확인이 비동기 포트(스레드풀)로
    // 돌아가면 서비스의 다른 파일 작업 뒤에 줄을 선다.
    expect(resolveRealPath).not.toHaveBeenCalled();
    expect(lstatPath).not.toHaveBeenCalled();
    expect(scan.rootScans[0]?.entries).toContainEqual({
      source: link,
      path: realpathSync(target),
      kind: "file",
    });
  });

  it("yields between slow directory listings and reports finite scan metrics", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const slowRoot = join(fixture.root, "slow");
    mkdirSync(join(slowRoot, "a", "b"), { recursive: true, mode: 0o700 });
    touch(fixture.root, "slow/a/.env", "A=1", 0o600);

    const listDirectorySync = fixture.ports.listDirectorySync.bind(fixture.ports);
    fixture.ports.listDirectorySync = (path) => {
      const started = performance.now();
      while (performance.now() - started < 12) {
        // 디스크를 기다리는 나열처럼 시간을 쓴다.
      }
      return listDirectorySync(path);
    };

    const scan = await scanEnvMaskRoots([slowRoot], fixture.ports, []);

    expect(scan.walkedRoots).toBe(1);
    expect(scan.joinedRoots).toBe(0);
    expect(scan.directories).toBeGreaterThanOrEqual(2);
    expect(scan.yields).toBeGreaterThanOrEqual(1);
    expect(scan.yieldMs).toBeGreaterThanOrEqual(0);
    for (const value of [
      scan.directories,
      scan.files,
      scan.listMs,
      scan.linkMs,
      scan.yields,
      scan.yieldMs,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(scan.rootScans[0]?.entries).toContainEqual({
      source: join(slowRoot, "a", ".env"),
      path: join(slowRoot, "a", ".env"),
      kind: "file",
    });
  });

  it("applies session-specific write paths to the cached scan list", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    // 워크트리는 프로젝트 뿌리 바로 아래에 있어 그 뿌리를 입력에 명시한다.
    fixture.input.projectsRoot = join(fixture.workspace, ".projects");
    const firstWorktree = join(fixture.workspace, ".projects", "soulstream--s1");
    const secondWorktree = join(fixture.workspace, ".projects", "soulstream--s2");
    mkdirSync(firstWorktree, { recursive: true, mode: 0o700 });
    mkdirSync(secondWorktree, { recursive: true, mode: 0o700 });
    const firstSession = touch(fixture.root, join(firstWorktree, ".env"), "A=1", 0o600);
    const secondSession = touch(fixture.root, join(secondWorktree, ".env"), "B=2", 0o600);

    const scans: IsolationEnvMaskScan[] = [];
    const lastScan = (): IsolationEnvMaskScan => {
      const scan = scans[scans.length - 1];
      if (!scan) throw new Error("탐색 로그가 없습니다");
      return scan;
    };
    const prepare = async (sessionId: string, worktree: string) => {
      fixture.input.decision = { ...fixture.input.decision, sessionId };
      fixture.input.ownedWorktrees = [{
        id: `wt-${sessionId}`,
        canonicalPath: worktree,
        repoId: "soulstream",
        commonDir: fixture.commonDir,
      }];
      return prepareIsolationPlan(fixture.input, fixture.ports, {
        logEnvMaskScan: (scan) => scans.push(scan),
      });
    };

    const asFirst = await prepare("s1", firstWorktree);
    const firstMasks = new Set(asFirst.spec.masks.map((mask) => mask.path));
    expect(lastScan()).toMatchObject({ cache: "miss" });
    expect(firstMasks.has(secondSession)).toBe(true);
    expect(firstMasks.has(firstSession)).toBe(false);

    // 두 번째 세션은 캐시된 목록에서 첫 세션의 워크트리는 가리되 자기 것은 뺀다.
    const asSecond = await prepare("s2", secondWorktree);
    const secondMasks = new Set(asSecond.spec.masks.map((mask) => mask.path));
    expect(lastScan()).toMatchObject({ cache: "hit" });
    expect(secondMasks.has(firstSession)).toBe(true);
    expect(secondMasks.has(secondSession)).toBe(false);
  });

  it("drops masks covered by an ancestor directory mask unless a reopen bind lies between", async () => {
    const fixture = await makeFixture({
      wsl: true,
      sensitiveRoots: ({ sensitive }) => [
        sensitive,
        "/mnt/c/Users/eias/.azure",
        join(sensitive, "logs", "private"),
      ],
      systemFacts: {
        "/mnt": { kind: "directory" },
        "/run/WSL": { kind: "directory" },
        "/mnt/c/Users/eias/.azure": { kind: "directory" },
      },
    });
    const logs = join(fixture.sensitive, "logs");
    mkdirSync(join(logs, "private"), { recursive: true, mode: 0o700 });
    fixture.input.policy = {
      ...fixture.input.policy,
      filesystem: {
        ...fixture.input.policy.filesystem,
        readOnlyReexposedPaths: [logs],
      },
    };

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masked = new Set(prepared.spec.masks.map((mask) => mask.path));

    expect(masked.has("/mnt")).toBe(true);
    // /mnt 아래 하위 가림은 다시 여는 bind가 없으므로 계획에서 뺀다.
    expect(masked.has("/mnt/c/Users/eias/.azure")).toBe(false);
    expect(
      [...masked].some((path) => path.startsWith("/mnt/")),
    ).toBe(false);
    // 재노출 bind가 사이에 있는 하위 디렉터리 가림은 효력이 있으므로 남긴다.
    expect(masked.has(join(fixture.sensitive, "logs", "private"))).toBe(true);
  });

  it("keeps .env file masks under a sensitive root when the workspace RO bind reopens it", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture({ workspaceUnderSensitiveRoot: true });
    fixture.input.projectsRoot = join(fixture.workspace, ".projects");
    const repoEnv = touch(
      fixture.root,
      join(fixture.workspace, ".projects", "agent-project", ".env"),
      "SECRET=1",
      0o600,
    );
    const packageEnv = touch(
      fixture.root,
      join(fixture.workspace, ".projects", "agent-project", "config", ".env"),
      "SECRET=2",
      0o600,
    );
    const worktreeEnv = touch(
      fixture.root,
      join(fixture.worktree, ".env"),
      "A=1",
      0o600,
    );
    const tmpEnv = touch(
      fixture.root,
      join(fixture.workspace, ".local", "tmp", "scratch", ".env"),
      "A=1",
      0o600,
    );
    const sessionEnv = touch(
      fixture.root,
      join(fixture.workspace, ".projects", ".isolated", "s1", ".env"),
      "A=1",
      0o600,
    );

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masked = new Set(prepared.spec.masks.map((mask) => mask.path));

    // 민감 루트 디렉터리 mask는 남고, 워크스페이스 RO bind가 그 아래를 다시 연다.
    expect(masked.has(fixture.sensitive)).toBe(true);
    expect(bindingOf(prepared.spec.bindings, fixture.workspace)).toEqual({
      source: fixture.workspace,
      destination: fixture.workspace,
      writable: false,
    });
    // 다시 열린 워크스페이스 아래 `.env`는 파일 가림으로 남는다.
    expect(masked.has(repoEnv)).toBe(true);
    // 리포 아래 패키지 층은 나열하지 않으므로 이 배치에서도 가리지 않는다.
    expect(masked.has(packageEnv)).toBe(false);
    // 세션 쓰기 경로의 `.env`는 이 배치에서도 가리지 않는다.
    expect(masked.has(worktreeEnv)).toBe(false);
    expect(masked.has(tmpEnv)).toBe(false);
    expect(masked.has(sessionEnv)).toBe(false);
  });

  it("keeps a mask under the Codex auth bind that reopens the credential root", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const privateDir = join(fixture.canonicalCodex, "private");
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    fixture.input.policy = {
      ...fixture.input.policy,
      filesystem: {
        ...fixture.input.policy.filesystem,
        additionalSensitiveRoots: [
          ...fixture.input.policy.filesystem.additionalSensitiveRoots,
          privateDir,
        ],
      },
    };

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    const masked = new Set(prepared.spec.masks.map((mask) => mask.path));

    expect(
      masked.has(join(fixture.home, ".local/share/soulstream/credentials")),
    ).toBe(true);
    expect(
      bindingOf(prepared.spec.bindings, fixture.canonicalCodex),
    ).toMatchObject({ writable: true });
    // auth bind가 사이에서 다시 연 아래 가림은 빠지지 않는다.
    expect(masked.has(privateDir)).toBe(true);
  });

  it("keeps scan cache entries apart when host workspaces carry different common exclusions", async () => {
    clearEnvMaskScanCache();
    const fixture = await makeFixture();
    const otherWorkspace = join(fixture.root, "other-workspace");
    mkdirSync(otherWorkspace, { recursive: true, mode: 0o700 });
    const sharedEnv = touch(
      fixture.root,
      join(fixture.agentCommonFiles, "deep", ".env"),
      "A=1",
      0o600,
    );

    const scans: IsolationEnvMaskScan[] = [];
    const lastScan = (): IsolationEnvMaskScan => {
      const scan = scans[scans.length - 1];
      if (!scan) throw new Error("탐색 로그가 없습니다");
      return scan;
    };
    const prepare = () =>
      prepareIsolationPlan(fixture.input, fixture.ports, {
        logEnvMaskScan: (scan) => scans.push(scan),
      });

    const first = await prepare();
    expect(lastScan().cacheMisses).toBeGreaterThan(0);
    expect(first.spec.masks).toContainEqual({ path: sharedEnv, kind: "file" });

    // 호스트 워크스페이스가 달라 공통 제외 목록도 달라진다. 같은 뿌리
    // (agentCommonFiles)를 훑어도 이전 캐시를 그대로 쓰면 안 된다.
    fixture.input.hostWorkspaceRoot = otherWorkspace;
    const second = await prepare();
    expect(lastScan().cacheHits).toBe(0);
    expect(lastScan().cacheMisses).toBeGreaterThan(0);
    expect(second.spec.masks).toContainEqual({ path: sharedEnv, kind: "file" });
  });

  it("rejects a Gemini/Antigravity restricted start before producing a spec", async () => {
    const fixture = await makeFixture({
      backend: "antigravity",
      authPreparation: { kind: "unavailable" },
    });

    await expectErrorCode(
      prepareIsolationPlan(fixture.input, fixture.ports),
      ISOLATION_AUTH_UNAVAILABLE,
    );
  });

  it("rejects an unknown backend before producing a spec", async () => {
    const fixture = await makeFixture();
    (fixture.input as { backend: string }).backend = "mystery";

    await expectErrorCode(
      prepareIsolationPlan(fixture.input, fixture.ports),
      ISOLATION_POLICY_UNAVAILABLE,
    );
  });

  it("refuses to prepare a full session", async () => {
    const fixture = await makeFixture({ decisionTier: "full" });

    await expectErrorCode(
      prepareIsolationPlan(fixture.input, fixture.ports),
      ISOLATION_POLICY_UNAVAILABLE,
    );
  });

  it("prepares a Claude OAuth session without injecting a token", async () => {
    const fixture = await makeFixture();
    const accountsDir = join(fixture.root, "claude-accounts");
    mkdirSync(join(accountsDir, "profiles", "account-a"), { recursive: true, mode: 0o700 });
    touch(
      fixture.root,
      "claude-accounts/profiles/account-a/.credentials.json",
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "synthetic-access-token",
          refreshToken: "synthetic-refresh-token",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
      0o600,
    );

    fixture.input.backend = "claude";
    fixture.input.authPreparation = { kind: "claude-oauth-token" };
    fixture.input.claudeAccountsDir = accountsDir;
    fixture.ports = createFakeHostPorts(fixture.options);

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    expect(prepared.spec.authKind).toBe("claude-oauth-token");
    expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    const configDirectory = join(fixture.sessionDir, "sandbox", "claude-config");
    expect(prepared.env.CLAUDE_CONFIG_DIR).toBe(configDirectory);
    expect(lstatSync(configDirectory).isDirectory()).toBe(true);
    expect(lstatSync(join(configDirectory, "projects")).isDirectory()).toBe(true);
    expect(prepared.spec.masks).toContainEqual({ path: accountsDir, kind: "directory" });
    expect(prepared.spec.masks).toContainEqual({
      path: join(fixture.home, ".local/share/soulstream/credentials"),
      kind: "directory",
    });
    expect(bindingOf(prepared.spec.bindings, fixture.canonicalCodex)).toBeUndefined();
    expect(prepared.contextNotice).not.toContain(accountsDir);
    // restricted Claude OAuth는 호스트 자격 값을 미리 읽지 않는다.
    expect(fixture.ports.calls.verifyAuthPreparation).toBe(0);

    // 러너 자식 설정에는 키 이름만 있고 자격 값은 없다.
    const childConfig = isolationChildConfigFromPlan({
      plan: prepared,
      tools: {
        bwrap: "/usr/bin/bwrap",
        pasta: "/usr/bin/pasta",
        unshare: "/usr/bin/unshare",
        setpriv: "/usr/bin/setpriv",
        nft: "/usr/sbin/nft",
        netnsHelper: "/release/sha/session-netns-helper.py",
      },
      wsl: false,
      attachedWorktreeIds: [],
    });
    expect(childConfig.envKeys).toContain("CLAUDE_CONFIG_DIR");
    expect(childConfig.envKeys).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(childConfig)).not.toContain("synthetic-access-token");
    expect(JSON.stringify(childConfig)).not.toContain("synthetic-refresh-token");
  });

  it("keeps apikey-env presets on their existing environment", async () => {
    const fixture = await makeFixture({
      backend: "claude",
      authPreparation: { kind: "apikey-env" },
    });

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    expect(prepared.spec.authKind).toBe("apikey-env");
    expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(prepared.env).not.toHaveProperty("CODEX_HOME");
  });

  it("rejects a test database that policy did not approve", async () => {
    const base = await makeFixture({
      testDatabaseUrl: "postgres://tester:secret@127.0.0.1:5432/soulstream_test",
      policy: (policy) => ({
        ...policy,
        testDatabases: [{ nodeId: "node-a", hostPort: 55432, sandboxPort: 15432 }],
      }),
    });

    await expectErrorCode(
      prepareIsolationPlan(base.input, base.ports),
      ISOLATION_POLICY_UNAVAILABLE,
    );

    const noTestName = await makeFixture({
      testDatabaseUrl: "postgres://tester:secret@127.0.0.1:55432/soulstream_prod",
      policy: (policy) => ({
        ...policy,
        testDatabases: [{ nodeId: "node-a", hostPort: 55432, sandboxPort: 15432 }],
      }),
    });
    await expectErrorCode(
      prepareIsolationPlan(noTestName.input, noTestName.ports),
      ISOLATION_POLICY_UNAVAILABLE,
    );

    const foreignHost = await makeFixture({
      testDatabaseUrl: "postgres://tester:secret@10.1.2.3:55432/soulstream_test",
      policy: (policy) => ({
        ...policy,
        testDatabases: [{ nodeId: "node-a", hostPort: 55432, sandboxPort: 15432 }],
      }),
    });
    await expectErrorCode(
      prepareIsolationPlan(foreignHost.input, foreignHost.ports),
      ISOLATION_POLICY_UNAVAILABLE,
    );

    // 질의 문자열로 승인 밖 endpoint를 지정할 수 있으면 안 된다.
    const queryOverride = await makeFixture({
      testDatabaseUrl:
        "postgres://tester:secret@127.0.0.1:55432/soulstream_test?host=10.1.2.3",
      policy: (policy) => ({
        ...policy,
        testDatabases: [{ nodeId: "node-a", hostPort: 55432, sandboxPort: 15432 }],
      }),
    });
    await expectErrorCode(
      prepareIsolationPlan(queryOverride.input, queryOverride.ports),
      ISOLATION_POLICY_UNAVAILABLE,
    );
  });

  it("derives approved local MCP ports and rejects unapproved ones", async () => {
    const servers = [{
      type: "streamable_http" as const,
      name: "serendipity",
      url: "http://127.0.0.1:14002/mcp",
    }];
    const fixture = await makeFixture({
      resolvedServers: [{ type: "stdio", command: "true", args: [] }],
      sanitizeMcpServers: async () => servers,
      policy: (policy) => ({
        ...policy,
        localMcp: {
          requiredServerId: "soulstream",
          optional: [
            { serverId: "serendipity", nodeId: "node-a", port: 4002 },
            { serverId: "atom", nodeId: "node-other", port: 4200 },
          ],
        },
      }),
    });

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    expect(prepared.sanitizedServers).toEqual(servers);
    expect(prepared.spec.approvedLocalMcp).toEqual([
      { serverId: "soulstream", hostPort: 3115, sandboxPort: 3115 },
      { serverId: "serendipity", hostPort: 4002, sandboxPort: 14002 },
    ]);
    expect(fixture.ports.calls.sanitizeMcpServers).toBe(1);

    const denied = await makeFixture({
      sanitizeMcpServers: async () => [{
        type: "streamable_http",
        name: "trello",
        url: "http://127.0.0.1:3102/mcp",
      }],
    });
    await expectErrorCode(
      prepareIsolationPlan(denied.input, denied.ports),
      ISOLATION_POLICY_UNAVAILABLE,
    );
  });

  it("exports the approved local MCP origin and header value into the session env", async () => {
    const atomServer = {
      type: "streamable_http" as const,
      name: "atom",
      url: "http://127.0.0.1:4200/mcp",
      headers: { "x-api-key": "atom-session-key" },
    };
    const localMcp = {
      requiredServerId: "soulstream" as const,
      optional: [{
        serverId: "atom",
        nodeId: "node-a",
        port: 4200,
        envExports: [
          { name: "ATOM_SERVER_URL", source: "origin" as const },
          {
            name: "ATOM_API_KEY",
            source: "header" as const,
            header: "x-api-key",
          },
        ],
      }],
    };
    const fixture = await makeFixture({
      sanitizeMcpServers: async () => [atomServer],
      policy: (policy) => ({ ...policy, localMcp }),
    });

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    // 전달된 loopback origin과 그 세션 MCP 설정의 헤더 값이 env로 간다.
    expect(prepared.env.ATOM_SERVER_URL).toBe("http://127.0.0.1:4200");
    expect(prepared.env.ATOM_API_KEY).toBe("atom-session-key");
    expect(prepared.spec.approvedLocalMcp).toContainEqual({
      serverId: "atom",
      hostPort: 4200,
      sandboxPort: 4200,
    });

    // 전달이 없는 세션에는 같은 정책이 있어도 값을 넣지 않는다.
    const withoutForwarding = await makeFixture({
      sanitizeMcpServers: async () => [],
      policy: (policy) => ({ ...policy, localMcp }),
    });
    const plain = await prepareIsolationPlan(
      withoutForwarding.input,
      withoutForwarding.ports,
    );
    expect(plain.env).not.toHaveProperty("ATOM_SERVER_URL");
    expect(plain.env).not.toHaveProperty("ATOM_API_KEY");

    // 정책이 선언한 헤더가 MCP 설정에 없으면 반쪽 env를 만들지 않고 거절한다.
    const missingHeader = await makeFixture({
      sanitizeMcpServers: async () => [{
        type: "streamable_http" as const,
        name: "atom",
        url: "http://127.0.0.1:4200/mcp",
      }],
      policy: (policy) => ({ ...policy, localMcp }),
    });
    await expectErrorCode(
      prepareIsolationPlan(missingHeader.input, missingHeader.ports),
      ISOLATION_POLICY_UNAVAILABLE,
    );
  });

  it("keeps the file policy env exports when node settings list the same local MCP server", async () => {
    const atomServer = {
      type: "streamable_http" as const,
      name: "atom",
      url: "http://127.0.0.1:4200/mcp",
      headers: { "x-api-key": "atom-session-key" },
    };
    const localMcp = {
      requiredServerId: "soulstream" as const,
      optional: [{
        serverId: "atom",
        nodeId: "node-a",
        port: 4200,
        envExports: [
          { name: "ATOM_SERVER_URL", source: "origin" as const },
          {
            name: "ATOM_API_KEY",
            source: "header" as const,
            header: "x-api-key",
          },
        ],
      }],
    };
    const fixture = await makeFixture({
      sanitizeMcpServers: async () => [atomServer],
      policy: (policy) => ({ ...policy, localMcp }),
    });
    // 러너 환경 설정(SESSION_ISOLATION_LOCAL_MCP)이 같은 서버를 다시 나열하는
    // 운영 경로. 병합이 중복을 만들면 뒤 항목이 envExports를 지운다.
    fixture.input.policy = applyNodeIsolationPolicy(
      fixture.input.policy,
      { localMcp: [{ serverId: "atom", port: 4200 }], testDatabase: null },
      "node-a",
    );

    const atomEntries = fixture.input.policy.localMcp.optional.filter(
      (entry) => entry.serverId === "atom",
    );
    expect(atomEntries).toHaveLength(1);
    expect(atomEntries[0]?.envExports).toHaveLength(2);

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);
    expect(prepared.env.ATOM_SERVER_URL).toBe("http://127.0.0.1:4200");
    expect(prepared.env.ATOM_API_KEY).toBe("atom-session-key");
  });

  it("keeps a writable sensitive root as a writable tmpfs mask and leaves the others read-only", async () => {
    const fixture = await makeFixture();
    const wrangler = join(fixture.home, ".config/.wrangler");
    mkdirSync(wrangler, { recursive: true, mode: 0o700 });
    fixture.input.policy = {
      ...fixture.input.policy,
      filesystem: {
        ...fixture.input.policy.filesystem,
        additionalSensitiveRoots: [
          ...fixture.input.policy.filesystem.additionalSensitiveRoots,
          wrangler,
        ],
        writableSensitiveRoots: [wrangler],
      },
    };

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    expect(prepared.spec.masks).toContainEqual({
      path: wrangler,
      kind: "directory",
      writable: true,
    });
    // 쓰기 허용 목록에 없는 mask는 지금처럼 읽기 전용으로 남는다.
    expect(
      prepared.spec.masks.find((mask) => mask.path === fixture.sensitive)?.writable,
    ).toBeUndefined();
  });

  it("rejects a cache directory that aliases the main store", async () => {
    const fixture = await makeFixture();
    const cacheRoot = join(
      fixture.home,
      ".local/share/soulstream/isolated-cache",
    );
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    symlinkSync(fixture.sensitive, join(cacheRoot, "pnpm-store"));

    await expectErrorCode(
      prepareIsolationPlan(fixture.input, fixture.ports),
      "ISOLATION_SHARED_DEPENDENCY_INODE",
    );
  });
});
