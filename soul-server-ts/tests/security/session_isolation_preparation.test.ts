import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  IsolationPolicy,
  IsolationPreparationInput,
} from "../../src/security/session_isolation_contract.js";
import {
  ISOLATION_AUTH_UNAVAILABLE,
  ISOLATION_POLICY_UNAVAILABLE,
  SESSION_ISOLATION_UNAVAILABLE,
} from "../../src/runner/session_filesystem_errors.js";
import { prepareIsolationPlan } from "../../src/runner/session_filesystem_plan.js";
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
}

async function makeFixture(overrides: FixtureOverrides = {}): Promise<Fixture> {
  const root = await makeTempDir("b2-prep-");
  const workspace = join(root, "workspace");
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
  const sensitive = join(root, "prod-state");
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
  touch(root, join(canonicalCodex, "auth.json"), "canonical-auth", 0o600);
  touch(root, join(canonicalCodex, "auth.lock"), "", 0o600);

  const lockFilePaths: Record<string, string> = {};
  HEAVY_LOCK_PATHS.forEach((lockPath, index) => {
    lockFilePaths[lockPath] = touch(root, `locks/${index}.lock`, "", 0o600);
  });

  const systemFacts: FakeHostPortsOptions["systemFacts"] = {
    "/run/docker.sock": { kind: "file" },
    "/var/run/docker.sock": { kind: "file", realPath: "/run/docker.sock" },
    "/run/user/1000": { kind: "directory" },
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
      workspaceDir: fixture.workspace,
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
    // worktree가 있으면 workspace RO bind를 두지 않아 부모가 자식 RW를 덮지 않는다.
    expect(bindingOf(prepared.spec.bindings, fixture.workspace)).toBeUndefined();
    expect(bindingOf(prepared.spec.bindings, fixture.worktree)).toMatchObject({
      writable: true,
    });
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
    for (const name of ["hooks", "info", "packed-refs"]) {
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
      "/run/user/1000",
      fixture.sensitive,
      dirname(fixture.sessionDir),
    ]) {
      expect(maskedPaths).toContain(path);
    }
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

    expect(prepared.spec.heavyWorkLockBindings).toHaveLength(4);
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
    expect(prepared.env.XDG_CACHE_HOME).toBe(join(cacheRoot, "xdg"));
    expect(prepared.env.COREPACK_HOME).toBe(join(cacheRoot, "corepack"));
    expect(prepared.env.PIP_CACHE_DIR).toBe(join(cacheRoot, "pip"));
    expect(prepared.env.UV_CACHE_DIR).toBe(join(cacheRoot, "uv"));
    expect(prepared.env.CARGO_HOME).toBe(join(cacheRoot, "cargo"));
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

  it("masks service env files and backups at the dotenv directory top level", async () => {
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
    // 하위 디렉터리로는 내려가지 않는다.
    expect(
      masks.some((mask) => mask.path === join(serviceDir, "sub/.env.nested")),
    ).toBe(false);
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

  it("prepares a Claude OAuth token without exposing it", async () => {
    const fixture = await makeFixture();
    const tokenFile = touch(fixture.root, "home/claude-oauth-token", "test-oauth-token", 0o600);

    fixture.input.backend = "claude";
    fixture.input.authPreparation = {
      kind: "claude-oauth-token",
      claudeTokenFile: tokenFile,
      credentialAccountId: "account-1",
    };
    fixture.options.claudeOauthToken = "test-oauth-token";
    fixture.ports = createFakeHostPorts(fixture.options);

    const prepared = await prepareIsolationPlan(fixture.input, fixture.ports);

    expect(prepared.spec.authKind).toBe("claude-oauth-token");
    expect(prepared.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-oauth-token");
    expect(prepared.env.CLAUDE_CONFIG_DIR).toBe(
      join(fixture.sessionDir, "sandbox", "claude-config"),
    );
    expect(prepared.spec.masks).toContainEqual({ path: tokenFile, kind: "file" });
    expect(prepared.spec.masks).toContainEqual({
      path: join(fixture.home, ".local/share/soulstream/credentials"),
      kind: "directory",
    });
    expect(bindingOf(prepared.spec.bindings, fixture.canonicalCodex)).toBeUndefined();
    expect(prepared.contextNotice).not.toContain("test-oauth-token");
    expect(prepared.contextNotice).not.toContain(tokenFile);
    expect(fixture.ports.calls.verifyAuthPreparation).toBe(1);
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
