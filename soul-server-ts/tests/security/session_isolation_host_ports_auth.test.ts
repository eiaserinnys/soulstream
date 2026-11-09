import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  IsolationAuthUnavailableError,
  IsolationPreparationPolicyError,
  SessionIsolationUnavailableError,
} from "../../src/runner/session_filesystem_errors.js";
import {
  createIsolationHostPorts,
  resetMainPackageStorePathCacheForTests,
} from "../../src/runner/session_isolation_host_ports.js";
import { createRestrictedMcpToken } from "../../src/security/restricted_mcp_auth.js";
import type { IsolationPolicy } from "../../src/security/session_isolation_contract.js";
import { makeTempDir } from "../helpers/temp_dir.js";
import { touch } from "../helpers/session_isolation_host_fakes.js";

import {
  createDeps,
  createRecordingRunCommand,
  HOST_BEARER_TOKEN,
  INTERNAL_MCP_URL,
  OTHER_SESSION_ID,
  SESSION_ID,
} from "./session_isolation_host_ports_fixtures.js";

const policy: IsolationPolicy = {
  version: 1,
  tools: {},
  localMcp: { requiredServerId: "soulstream", optional: [] },
  filesystem: {
    sessionWorktreeRelativeRoot: ".projects/.isolated",
    credentialRelativeDirectory: ".local/share/soulstream/credentials/codex",
    isolatedCacheRelativeRoot: ".local/share/soulstream/isolated-cache",
    writableWorkspaceRelativeDirectories: [".local/tmp", ".local/artifacts"],
    additionalSensitiveRoots: [],
  },
  testDatabases: [],
  network: { mode: "pasta-nft", dnsForward4: "192.0.2.53", deniedIpv4: [], deniedIpv6: [] },
};

interface CodexFixture {
  root: string;
  canonical: string;
  authJson: string;
  homeAuthJson: string;
  codexExecutable: string;
}

async function createCodexFixture(): Promise<CodexFixture> {
  const root = await makeTempDir("host-ports-codex-");
  const canonical = join(root, "credentials", "codex");
  mkdirSync(canonical, { recursive: true, mode: 0o700 });
  chmodSync(canonical, 0o700);
  const authJson = touch(canonical, "auth.json", "{\"access_token\":\"codex-secret\"}", 0o600);
  touch(canonical, "auth.lock", "", 0o600);
  const codexDirectory = join(root, "home", ".codex");
  mkdirSync(codexDirectory, { recursive: true, mode: 0o700 });
  const homeAuthJson = join(codexDirectory, "auth.json");
  symlinkSync(authJson, homeAuthJson);
  return { root, canonical, authJson, homeAuthJson, codexExecutable: join(root, "bin", "codex") };
}

function createCodexPorts(fixture: CodexFixture, version = "0.167.0") {
  const recording = createRecordingRunCommand((command, args) => {
    if (command === fixture.codexExecutable && args[0] === "--version") {
      return { exitCode: 0, stdout: `codex-cli ${version}\n`, stderr: "" };
    }
    throw new Error(`테스트에 등록되지 않은 외부 명령입니다: ${command}`);
  });
  const deps = createDeps(fixture.root, {
    codexExecutable: fixture.codexExecutable,
    runCommand: recording.runCommand,
  });
  return { ports: createIsolationHostPorts(deps), calls: recording.calls, deps };
}

function codexPreparation(fixture: CodexFixture) {
  return { kind: "codex-grant" as const, canonicalCodexDirectory: fixture.canonical };
}

beforeEach(() => {
  resetMainPackageStorePathCacheForTests();
});

describe("session isolation host ports — auth preparation", () => {
  it("codex-grant 정상 배치를 확인하고 writer 판을 조회한다", async () => {
    const fixture = await createCodexFixture();
    const { ports, calls } = createCodexPorts(fixture);

    await expect(ports.verifyAuthPreparation(codexPreparation(fixture))).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(fixture.codexExecutable);
    expect(calls[0]?.args).toEqual(["--version"]);
    expect(calls[0]?.options.timeoutMs).toBe(20000);
  });

  it("codex-grant는 .codex/auth.json symlink 대상이 다르면 거절한다", async () => {
    const fixture = await createCodexFixture();
    const { ports } = createCodexPorts(fixture);
    unlinkSync(fixture.homeAuthJson);
    symlinkSync(join(fixture.canonical, "auth.lock"), fixture.homeAuthJson);

    await expect(ports.verifyAuthPreparation(codexPreparation(fixture))).rejects.toBeInstanceOf(
      IsolationAuthUnavailableError,
    );
  });

  it("codex-grant는 canonical 디렉터리의 허용 밖 항목을 거절한다", async () => {
    const fixture = await createCodexFixture();
    const { ports } = createCodexPorts(fixture);
    writeFileSync(join(fixture.canonical, "stray.txt"), "", { mode: 0o600 });

    await expect(ports.verifyAuthPreparation(codexPreparation(fixture))).rejects.toBeInstanceOf(
      IsolationAuthUnavailableError,
    );
  });

  it("codex-grant는 확인되지 않은 writer 판을 거절한다", async () => {
    const fixture = await createCodexFixture();
    const { ports } = createCodexPorts(fixture, "0.166.0");

    await expect(ports.verifyAuthPreparation(codexPreparation(fixture))).rejects.toBeInstanceOf(
      IsolationAuthUnavailableError,
    );
  });

  it("codex-grant는 auth.json mode 0644를 거절한다", async () => {
    const fixture = await createCodexFixture();
    const { ports } = createCodexPorts(fixture);
    chmodSync(fixture.authJson, 0o644);

    await expect(ports.verifyAuthPreparation(codexPreparation(fixture))).rejects.toBeInstanceOf(
      IsolationAuthUnavailableError,
    );
  });

  it("claude-oauth-token은 0600 파일을 확인하고 토큰을 trim해 읽는다", async () => {
    const root = await makeTempDir("host-ports-claude-");
    const tokenFile = touch(root, "claude/token", "  claude-oauth-secret \n", 0o600);
    const deps = createDeps(root, { claudeTokenFile: tokenFile });
    const ports = createIsolationHostPorts(deps);

    await expect(
      ports.verifyAuthPreparation({ kind: "claude-oauth-token", claudeTokenFile: tokenFile }),
    ).resolves.toBeUndefined();
    await expect(ports.readClaudeOauthToken()).resolves.toBe("claude-oauth-secret");
  });

  it("claude-oauth-token은 mode 0640을 거절한다", async () => {
    const root = await makeTempDir("host-ports-claude-mode-");
    const tokenFile = touch(root, "claude/token", "claude-oauth-secret", 0o640);
    const deps = createDeps(root, { claudeTokenFile: tokenFile });
    const ports = createIsolationHostPorts(deps);

    await expect(
      ports.verifyAuthPreparation({ kind: "claude-oauth-token", claudeTokenFile: tokenFile }),
    ).rejects.toBeInstanceOf(IsolationAuthUnavailableError);
  });

  it("readClaudeOauthToken은 빈 토큰을 거절한다", async () => {
    const root = await makeTempDir("host-ports-claude-empty-");
    const tokenFile = touch(root, "claude/token", " \n", 0o600);
    const deps = createDeps(root, { claudeTokenFile: tokenFile });
    const ports = createIsolationHostPorts(deps);

    await expect(ports.readClaudeOauthToken()).rejects.toBeInstanceOf(
      IsolationAuthUnavailableError,
    );
  });

  it("apikey-env는 확인할 것이 없고 unavailable은 거절한다", async () => {
    const root = await makeTempDir("host-ports-auth-kind-");
    const ports = createIsolationHostPorts(createDeps(root));

    await expect(ports.verifyAuthPreparation({ kind: "apikey-env" })).resolves.toBeUndefined();
    await expect(ports.verifyAuthPreparation({ kind: "unavailable" })).rejects.toBeInstanceOf(
      IsolationAuthUnavailableError,
    );
  });
});

describe("session isolation host ports — credentials", () => {
  it("prepareGitHubCredential은 gh 성공 값만 GH_TOKEN으로 돌려준다", async () => {
    const root = await makeTempDir("host-ports-gh-");
    const recording = createRecordingRunCommand(() => ({
      exitCode: 0,
      stdout: "  ghp_test-token\n",
      stderr: "",
    }));
    const deps = createDeps(root, { runCommand: recording.runCommand });

    const credential = await createIsolationHostPorts(deps).prepareGitHubCredential();

    expect(credential).toEqual({ GH_TOKEN: "ghp_test-token" });
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.command).toBe("gh");
    expect(recording.calls[0]?.args).toEqual(["auth", "token"]);
    expect(recording.calls[0]?.options.timeoutMs).toBe(10000);
    expect(Object.keys(recording.calls[0]?.options.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
    expect(recording.calls[0]?.options.env?.HOME).toBe(deps.homeDirectory);
  });

  it("prepareGitHubCredential은 gh 실패나 빈 출력에서 빈 객체를 돌려준다", async () => {
    const root = await makeTempDir("host-ports-gh-fail-");
    const recording = createRecordingRunCommand(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "not logged in",
    }));
    const deps = createDeps(root, { runCommand: recording.runCommand });

    await expect(
      createIsolationHostPorts(deps).prepareGitHubCredential(),
    ).resolves.toEqual({});
  });

  it("issueRestrictedCredential은 이 세션의 ssr1만 발급한다", async () => {
    const root = await makeTempDir("host-ports-ssr1-");
    const ports = createIsolationHostPorts(createDeps(root));

    await expect(ports.issueRestrictedCredential(SESSION_ID)).resolves.toBe(
      createRestrictedMcpToken(SESSION_ID, HOST_BEARER_TOKEN),
    );
    await expect(
      ports.issueRestrictedCredential(OTHER_SESSION_ID),
    ).rejects.toBeInstanceOf(IsolationPreparationPolicyError);
  });

  it("sanitizeMcpServers는 내부 MCP를 이 세션의 ssr1로 다시 세운다", async () => {
    const root = await makeTempDir("host-ports-sanitize-");
    const ports = createIsolationHostPorts(createDeps(root));

    const servers = await ports.sanitizeMcpServers([], policy);
    expect(servers).toHaveLength(1);
    const upstream = servers[0];
    expect(upstream).toMatchObject({ type: "streamable_http", name: "soulstream" });
    const serialized = JSON.stringify(upstream);
    expect(serialized).toContain(INTERNAL_MCP_URL);
    expect(serialized).toContain(SESSION_ID);
    expect(serialized).toContain(
      `Bearer ${createRestrictedMcpToken(SESSION_ID, HOST_BEARER_TOKEN)}`,
    );
  });
});

describe("session isolation host ports — host queries", () => {
  it("resolveGitCommonDir은 절대 common 디렉터리를 trim해 돌려준다", async () => {
    const root = await makeTempDir("host-ports-git-");
    const recording = createRecordingRunCommand(() => ({
      exitCode: 0,
      stdout: "/home/eias/workspace/.projects/soulstream/.git\n",
      stderr: "",
    }));
    const deps = createDeps(root, { runCommand: recording.runCommand });

    await expect(
      createIsolationHostPorts(deps).resolveGitCommonDir("/repo"),
    ).resolves.toBe("/home/eias/workspace/.projects/soulstream/.git");
    expect(recording.calls[0]?.command).toBe("git");
    expect(recording.calls[0]?.args).toEqual([
      "-C",
      "/repo",
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    expect(recording.calls[0]?.options.timeoutMs).toBe(15000);
  });

  it("resolveGitCommonDir은 git 실패를 거절로 바꾼다", async () => {
    const root = await makeTempDir("host-ports-git-fail-");
    const recording = createRecordingRunCommand(() => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    }));
    const deps = createDeps(root, { runCommand: recording.runCommand });

    await expect(
      createIsolationHostPorts(deps).resolveGitCommonDir("/repo"),
    ).rejects.toBeInstanceOf(SessionIsolationUnavailableError);
  });

  it("resolveNodeId와 디렉터리 의존성은 주입값을 그대로 돌려준다", async () => {
    const root = await makeTempDir("host-ports-dirs-");
    const deps = createDeps(root, {
      agentCommonFilesDirectory: "/opt/agent-common-files",
      serviceEnvironmentDirectory: "/srv/soulstream/env",
    });
    const ports = createIsolationHostPorts(deps);

    await expect(ports.resolveNodeId()).resolves.toBe("node-a");
    await expect(ports.resolveAgentCommonFilesDirectory()).resolves.toBe(
      "/opt/agent-common-files",
    );
    await expect(ports.resolveServiceEnvironmentDirectory()).resolves.toBe("/srv/soulstream/env");
  });

  it("resolveMainPackageStorePath는 프로세스에서 한 번만 조회하고 값을 기억한다", async () => {
    const root = await makeTempDir("host-ports-pnpm-");
    const recording = createRecordingRunCommand(() => ({
      exitCode: 0,
      stdout: "  /home/eias/.local/share/pnpm/store/v10\n",
      stderr: "",
    }));
    const deps = createDeps(root, { runCommand: recording.runCommand });
    const ports = createIsolationHostPorts(deps);

    await expect(ports.resolveMainPackageStorePath()).resolves.toBe(
      "/home/eias/.local/share/pnpm/store/v10",
    );
    await expect(ports.resolveMainPackageStorePath()).resolves.toBe(
      "/home/eias/.local/share/pnpm/store/v10",
    );
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.command).toBe("pnpm");
    expect(recording.calls[0]?.args).toEqual(["store", "path"]);
    expect(recording.calls[0]?.options.cwd).toBe(deps.homeDirectory);
    expect(recording.calls[0]?.options.timeoutMs).toBe(30000);
  });

  it("resolveMainPackageStorePath는 실패하면 null이다", async () => {
    const root = await makeTempDir("host-ports-pnpm-fail-");
    const recording = createRecordingRunCommand(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "ERR_PNPM",
    }));
    const deps = createDeps(root, { runCommand: recording.runCommand });

    await expect(
      createIsolationHostPorts(deps).resolveMainPackageStorePath(),
    ).resolves.toBeNull();
  });
});
