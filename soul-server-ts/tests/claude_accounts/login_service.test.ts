import { ChildProcess, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "pino";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeAuthService, FileClaudeAuthTokenStore } from "../../src/auth/claude_auth.js";
import { ClaudeAccountService } from "../../src/claude_accounts/service.js";
import {
  ClaudeLoginError,
  ClaudeLoginService,
  type ClaudeLoginAccountPort,
} from "../../src/claude_accounts/login_service.js";
import { composeClaudeLoginService } from "../../src/runtime/claude_login_runtime_composition.js";

interface FakePortState {
  port: ClaudeLoginAccountPort;
  accounts: Map<string, { id: string; email: string | null; plan: string | null }>;
  pendingDirs: Map<string, string>;
  retiredLogins: string[];
  registered: Array<{ loginId: string; id: string; email: string | null; plan: string | null }>;
  reloginBegun: string[];
  reloginEnded: Array<{ accountId: string; outcome: "ok" | "needs_relogin" }>;
  activeSessionCounts: Map<string, number>;
}

function createFakePort(rootDir: string): FakePortState {
  const accounts = new Map<string, { id: string; email: string | null; plan: string | null }>();
  const pendingDirs = new Map<string, string>();
  const retiredLogins: string[] = [];
  const registered: Array<{ loginId: string; id: string; email: string | null; plan: string | null }> = [];
  const reloginBegun: string[] = [];
  const reloginEnded: Array<{ accountId: string; outcome: "ok" | "needs_relogin" }> = [];
  const activeSessionCounts = new Map<string, number>();

  const port: ClaudeLoginAccountPort = {
    async createPendingDir(loginId: string): Promise<string> {
      const dir = join(rootDir, `pending-${loginId}`);
      await writeFile(join(rootDir, `.marker-${loginId}`), "");
      await chmod(rootDir, 0o700);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      pendingDirs.set(loginId, dir);
      return dir;
    },
    profileDir(accountId: string): string | null {
      if (!accounts.has(accountId)) return null;
      return join(rootDir, `profile-${accountId}`);
    },
    async findAccount(accountId: string): Promise<{ id: string; email: string | null } | null> {
      const found = accounts.get(accountId);
      return found ? { id: found.id, email: found.email } : null;
    },
    async findByIdentity(input: { id: string; email: string | null }): Promise<{ id: string } | null> {
      for (const account of accounts.values()) {
        if (account.id === input.id) {
          return { id: account.id };
        }
        if (
          input.email !== null &&
          account.email !== null &&
          account.email.toLowerCase() === input.email.toLowerCase()
        ) {
          return { id: account.id };
        }
      }
      return null;
    },
    async registerFromPending(input: {
      loginId: string;
      id: string;
      email: string | null;
      plan: string | null;
    }): Promise<void> {
      registered.push(input);
      accounts.set(input.id, { id: input.id, email: input.email, plan: input.plan });
    },
    async retirePending(loginId: string): Promise<void> {
      retiredLogins.push(loginId);
    },
    async beginRelogin(accountId: string): Promise<void> {
      reloginBegun.push(accountId);
    },
    async endRelogin(accountId: string, outcome: "ok" | "needs_relogin"): Promise<void> {
      reloginEnded.push({ accountId, outcome });
    },
    activeSessions(accountId: string): number {
      return activeSessionCounts.get(accountId) ?? 0;
    },
  };

  return {
    port,
    accounts,
    pendingDirs,
    retiredLogins,
    registered,
    reloginBegun,
    reloginEnded,
    activeSessionCounts,
  };
}

function createCapturingLogger(): { logger: Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const record = (level: string) => (fieldsOrMsg: unknown, maybeMsg?: string) => {
    if (typeof fieldsOrMsg === "string") {
      entries.push({ level, message: fieldsOrMsg });
    } else if (fieldsOrMsg && typeof fieldsOrMsg === "object") {
      entries.push({ level, message: maybeMsg ?? "", ...(fieldsOrMsg as Record<string, unknown>) });
    }
  };
  const logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child() {
      return logger;
    },
  } as unknown as Logger;
  return { logger, entries };
}

async function createFakeClaudeCli(rootDir: string, scriptBody: string): Promise<string> {
  const cliPath = join(rootDir, "fake-claude-cli.mjs");
  const content = `#!/usr/bin/env node\n${scriptBody}\n`;
  await writeFile(cliPath, content, { encoding: "utf8", mode: 0o755 });
  await chmod(cliPath, 0o755);
  return cliPath;
}

async function createInteractiveCli(
  rootDir: string,
  state: string,
  statusScript = `
    process.stdout.write(JSON.stringify({
      loggedIn: true,
      email: "login@example.com",
      accountUuid: "88888888-8888-4888-8888-888888888888",
    }));
    process.exit(0);
  `,
): Promise<string> {
  return createFakeClaudeCli(
    rootDir,
    `
const [group, action] = process.argv.slice(2);
if (group === "auth" && action === "login") {
  process.stdout.write(${JSON.stringify(makeAuthUrl(state) + String.fromCharCode(10))});
  process.stdin.once("data", () => process.exit(0));
} else if (group === "auth" && action === "status") {
  ${statusScript}
}
    `,
  );
}

async function waitFor<T>(
  fn: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs = 3_000,
  intervalMs = 15,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue = await fn();
  while (!predicate(lastValue)) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out; last value: ${JSON.stringify(lastValue)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    lastValue = await fn();
  }
  return lastValue;
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "soul-claude-login-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeAuthUrl(state: string): string {
  const stateValue = Buffer.from(state).toString("base64url").padEnd(43, "A").slice(0, 43);
  const params = new URLSearchParams({
    code: "true",
    client_id: "test-client",
    response_type: "code",
    redirect_uri: "https://platform.claude.com/oauth/code/callback",
    scope: "user:profile user:inference",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    state: stateValue,
  });
  return "https://claude.com/cai/oauth/authorize?" + params.toString();
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("ClaudeLoginService (P3 stage 1)", () => {
  it("조각난 인증 주소를 합쳐 url_ready로 바꾸고 코드는 stdin에 한 번만 기록한 뒤 status 검증 후 등록한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger, entries } = createCapturingLogger();

    const expectedUrl = makeAuthUrl("split-state-token-999");
    const stateStart = expectedUrl.lastIndexOf("state=");
    const urlPrefix = expectedUrl.slice(0, stateStart);
    const urlStateName = expectedUrl.slice(stateStart, stateStart + "state=".length);
    const urlStateValue = expectedUrl.slice(stateStart + "state=".length);
    const secretCode = "oauth-paste-code-xyz-777";
    const targetUuid = "11111111-1111-4111-8111-111111111111";

    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir) {
  process.exit(2);
}

const leakedEnv = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
].filter((key) => process.env[key] !== undefined);
writeFileSync(join(configDir, "leaked-env.json"), JSON.stringify(leakedEnv));

if (args[0] === "auth" && args[1] === "login") {
  process.stderr.write("SECRET_RAW_STDERR_MARKER\\n");
  process.stdout.write("SECRET_RAW_STDOUT_MARKER\\nOpen URL: " + ${JSON.stringify(urlPrefix)});
  setTimeout(() => {
    process.stdout.write(${JSON.stringify(urlStateName)});
    setTimeout(() => {
      process.stdout.write(${JSON.stringify(urlStateValue + String.fromCharCode(10) + "Paste code: ")});
    }, 25);
  }, 25);

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    appendFileSync(join(configDir, "stdin-chunks.log"), chunk);
    if (buffer.includes("\\n")) {
      setTimeout(() => process.exit(0), 20);
    }
  });
} else if (args[0] === "auth" && args[1] === "status" && args.includes("--json")) {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      loggedIn: true,
      email: "alpha@example.com",
      accountUuid: "${targetUuid}",
      subscriptionType: "Max 20x",
    }));
    process.exit(0);
  }, 40);
} else {
  process.exit(1);
}
      `,
    );

    const envKeyA = ["ANTHROPIC", "API", "KEY"].join("_");
    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      baseEnv: {
        ...process.env,
        [envKeyA]: "should-be-removed-1",
        ANTHROPIC_AUTH_TOKEN: "should-be-removed-2",
        CLAUDE_CODE_OAUTH_TOKEN: "should-be-removed-3",
        ANTHROPIC_BASE_URL: "https://example.invalid",
      },
    });

    const initial = await service.start();
    expect(initial.state).toBe("requested");
    expect(initial.account_id).toBeNull();
    expect(initial.auth_url).toBeNull();

    const urlReady = await waitFor(
      () => service.status({ login_id: initial.login_id }),
      (flow) => flow.state === "url_ready",
    );
    expect(urlReady.auth_url).toBe(expectedUrl);

    await expect(
      service.submit_code({ login_id: initial.login_id, code: "bad\ncode" }),
    ).rejects.toThrow(ClaudeLoginError);
    await expect(
      service.submit_code({ login_id: initial.login_id, code: "   " }),
    ).rejects.toThrow(ClaudeLoginError);
    await expect(
      service.submit_code({ login_id: initial.login_id, code: "x".repeat(2049) }),
    ).rejects.toThrow(ClaudeLoginError);

    const submitted = await service.submit_code({
      login_id: initial.login_id,
      code: secretCode,
    });
    expect(submitted.state).toBe("code_submitted");

    const duplicateSubmit = await service.submit_code({
      login_id: initial.login_id,
      code: "duplicate-code-must-not-write",
    });
    expect(["code_submitted", "verifying", "done"]).toContain(duplicateSubmit.state);

    const done = await waitFor(
      () => service.status({ login_id: initial.login_id }),
      (flow) => flow.state === "done",
    );
    expect(done.account_id).toBe(targetUuid);
    expect(done.error).toBeNull();

    const pendingDir = state.pendingDirs.get(initial.login_id)!;
    const stdinReceived = await readFile(join(pendingDir, "stdin-chunks.log"), "utf8");
    expect(stdinReceived).toBe(`${secretCode}\n`);

    const leakedEnv = JSON.parse(await readFile(join(pendingDir, "leaked-env.json"), "utf8"));
    expect(leakedEnv).toEqual([]);

    expect(state.registered).toEqual([
      {
        loginId: initial.login_id,
        id: targetUuid,
        email: "alpha@example.com",
        plan: "Max 20x",
      },
    ]);
    expect(state.retiredLogins).toEqual([]);

    const serializedLogs = JSON.stringify(entries);
    expect(serializedLogs).not.toContain(expectedUrl);
    expect(serializedLogs).not.toContain(secretCode);
    expect(serializedLogs).not.toContain("SECRET_RAW_STDOUT_MARKER");
    expect(serializedLogs).not.toContain("SECRET_RAW_STDERR_MARKER");
  });

  it("동시에 두 개의 로그인을 시작할 수 없으며 완료 뒤에는 새 로그인이 가능하다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger } = createCapturingLogger();

    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write(${JSON.stringify(makeAuthUrl("one") + String.fromCharCode(10))});
  process.stdin.once("data", () => process.exit(0));
} else if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    email: "one@example.com",
    accountUuid: "22222222-2222-4222-8222-222222222222",
  }));
  process.exit(0);
}
      `,
    );

    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
    });

    const first = await service.start();
    await expect(service.start()).rejects.toMatchObject({
      code: "login_in_progress",
    });

    await waitFor(
      () => service.status({ login_id: first.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await service.submit_code({ login_id: first.login_id, code: "code-1" });
    await waitFor(
      () => service.status({ login_id: first.login_id }),
      (flow) => flow.state === "done",
    );

    const second = await service.start();
    expect(second.login_id).not.toBe(first.login_id);
    await service.cancel({ login_id: second.login_id });
  });

  it("claude auth status --json이 실패하면 등록하지 않고 pending을 격리한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger, entries } = createCapturingLogger();

    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write(${JSON.stringify(makeAuthUrl("status-fail") + String.fromCharCode(10))});
  process.stdin.once("data", () => process.exit(0));
} else if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }));
  process.exit(0);
}
      `,
    );

    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
    });

    const started = await service.start();
    await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await service.submit_code({ login_id: started.login_id, code: "code-status-fail" });

    const failed = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "failed",
    );
    expect(failed.error?.code).toBe("auth_status_failed");
    expect(state.registered).toEqual([]);
    expect(state.retiredLogins).toEqual([started.login_id]);
    expect(JSON.stringify(entries)).not.toContain("code-status-fail");
  });

  it("status에 UUID가 없을 때 프로필 API account.uuid 폴백을 지원하고 둘 다 없으면 failed로 격리한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger } = createCapturingLogger();

    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write(${JSON.stringify(makeAuthUrl("no-uuid") + String.fromCharCode(10))});
  process.stdin.once("data", () => process.exit(0));
} else if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    email: "fallback@example.com",
  }));
  process.exit(0);
}
      `,
    );

    const serviceWithoutUuid = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      fetchProfile: async () => ({ account: { email: "fallback@example.com" } }),
    });

    const flow1 = await serviceWithoutUuid.start();
    await waitFor(
      () => serviceWithoutUuid.status({ login_id: flow1.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await serviceWithoutUuid.submit_code({ login_id: flow1.login_id, code: "code-no-uuid" });

    const failed = await waitFor(
      () => serviceWithoutUuid.status({ login_id: flow1.login_id }),
      (flow) => flow.state === "failed",
    );
    expect(failed.error?.code).toBe("account_uuid_missing");
    expect(state.registered).toEqual([]);
    expect(state.retiredLogins).toEqual([flow1.login_id]);

    const fallbackUuid = "33333333-3333-4333-8333-333333333333";
    const serviceWithProfileUuid = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      fetchProfile: async () => ({
        account: {
          uuid: fallbackUuid,
          email: "fallback@example.com",
        },
      }),
    });

    const flow2 = await serviceWithProfileUuid.start();
    await waitFor(
      () => serviceWithProfileUuid.status({ login_id: flow2.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await serviceWithProfileUuid.submit_code({ login_id: flow2.login_id, code: "code-with-uuid" });

    const done = await waitFor(
      () => serviceWithProfileUuid.status({ login_id: flow2.login_id }),
      (flow) => flow.state === "done",
    );
    expect(done.account_id).toBe(fallbackUuid);
    expect(state.registered).toEqual([
      {
        loginId: flow2.login_id,
        id: fallbackUuid,
        email: "fallback@example.com",
        plan: null,
      },
    ]);
  });

  it("새 계정 추가 시 UUID나 이메일이 기존 계정과 겹치면 account_exists로 실패하고 pending을 격리한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const existingId = "44444444-4444-4444-8444-444444444444";
    state.accounts.set(existingId, {
      id: existingId,
      email: "dup@example.com",
      plan: "Max 5x",
    });
    const { logger } = createCapturingLogger();

    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(join(process.env.CLAUDE_CONFIG_DIR, "invocations.log"), args.join(" ") + "\\n");
if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write(${JSON.stringify(makeAuthUrl("dup") + String.fromCharCode(10))});
  process.stdin.once("data", () => process.exit(0));
} else if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    email: "dup@example.com",
    accountUuid: "99999999-9999-4999-8999-999999999999",
  }));
  process.exit(0);
}
      `,
    );

    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
    });

    const started = await service.start();
    await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await service.submit_code({ login_id: started.login_id, code: "dup-code" });

    const failed = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "failed",
    );
    expect(failed.error).toEqual({
      code: "account_exists",
      message: expect.any(String),
      existing_account_id: existingId,
    });
    expect(state.registered).toEqual([]);
    expect(state.retiredLogins).toEqual([started.login_id]);

    const invocations = await readFile(
      join(state.pendingDirs.get(started.login_id)!, "invocations.log"),
      "utf8",
    );
    expect(invocations).not.toContain("logout");
  });

  it("재로그인 시 activeSessions가 0이 될 때까지 requested 상태로 대기한 뒤 실행하고 UUID 일치 시 ok로 종료한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const accountId = "55555555-5555-4555-8555-555555555555";
    state.accounts.set(accountId, {
      id: accountId,
      email: "relogin@example.com",
      plan: "Pro",
    });
    const { mkdir } = await import("node:fs/promises");
    const profileDir = state.port.profileDir(accountId)!;
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    state.activeSessionCounts.set(accountId, 2);

    const { logger } = createCapturingLogger();
    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "login") {
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "spawned.txt"), "1");
  process.stdout.write(${JSON.stringify(makeAuthUrl("relogin") + String.fromCharCode(10))});
  process.stdin.once("data", () => process.exit(0));
} else if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    email: "relogin@example.com",
    accountUuid: "${accountId}",
  }));
  process.exit(0);
}
      `,
    );

    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      activeSessionPollIntervalMs: 20,
    });

    const started = await service.start({ account_id: accountId });
    expect(started.state).toBe("requested");
    expect(started.account_id).toBe(accountId);
    expect(state.reloginBegun).toEqual([accountId]);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await service.status({ login_id: started.login_id })).state).toBe("requested");

    state.activeSessionCounts.set(accountId, 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await service.status({ login_id: started.login_id })).state).toBe("requested");

    state.activeSessionCounts.set(accountId, 0);
    const urlReady = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );
    expect(urlReady.auth_url).toBe(makeAuthUrl("relogin"));

    await service.submit_code({ login_id: started.login_id, code: "relogin-code" });
    const done = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "done",
    );
    expect(done.state).toBe("done");
    expect(state.reloginEnded).toEqual([{ accountId, outcome: "ok" }]);
  });

  it("재로그인 UUID가 원래 계정 ID와 다르면 account_identity_mismatch로 실패하고 needs_relogin으로 끝낸다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const accountId = "66666666-6666-4666-8666-666666666666";
    state.accounts.set(accountId, {
      id: accountId,
      email: "orig@example.com",
      plan: "Max 5x",
    });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(state.port.profileDir(accountId)!, { recursive: true, mode: 0o700 });

    const { logger } = createCapturingLogger();
    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write(${JSON.stringify(makeAuthUrl("mismatch") + String.fromCharCode(10))});
  process.stdin.once("data", () => process.exit(0));
} else if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    email: "other@example.com",
    accountUuid: "77777777-7777-4777-8777-777777777777",
  }));
  process.exit(0);
}
      `,
    );

    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
    });

    const started = await service.start({ account_id: accountId });
    await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await service.submit_code({ login_id: started.login_id, code: "mismatch-code" });

    const failed = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "failed",
    );
    expect(failed.error?.code).toBe("account_identity_mismatch");
    expect(state.reloginEnded).toEqual([{ accountId, outcome: "needs_relogin" }]);
    expect(state.registered).toEqual([]);
  });

  it("취소, timeout, close에서 stdin 닫기 → SIGTERM → SIGKILL → 실제 exit 대기를 수행하고 새 계정 pending을 격리한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger } = createCapturingLogger();

    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const configDir = process.env.CLAUDE_CONFIG_DIR;
const logEvent = (event) => appendFileSync(join(configDir, "signals.log"), event + "\\n");

process.stdin.resume();
process.stdin.on("end", () => logEvent("stdin_eof"));
process.on("SIGTERM", () => {
  logEvent("sigterm");
  // SIGTERM을 무시해 SIGKILL까지 살아 있는 자식 시뮬레이션
});

process.stdout.write(${JSON.stringify(makeAuthUrl("hang") + String.fromCharCode(10))});
setInterval(() => {}, 1000);
      `,
    );

    const cancelService = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      killGracePeriodMs: 80,
    });

    const cancelFlow = await cancelService.start();
    await waitFor(
      () => cancelService.status({ login_id: cancelFlow.login_id }),
      (flow) => flow.state === "url_ready",
    );

    const cancelled = await cancelService.cancel({ login_id: cancelFlow.login_id });
    expect(cancelled.state).toBe("cancelled");
    expect(state.retiredLogins).toContain(cancelFlow.login_id);

    const cancelSignals = await readFile(
      join(state.pendingDirs.get(cancelFlow.login_id)!, "signals.log"),
      "utf8",
    );
    expect(cancelSignals).toContain("stdin_eof");
    expect(cancelSignals).toContain("sigterm");

    const timeoutService = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      loginTimeoutMs: 100,
      killGracePeriodMs: 80,
    });

    const timeoutFlow = await timeoutService.start();
    const timedOut = await waitFor(
      () => timeoutService.status({ login_id: timeoutFlow.login_id }),
      (flow) => flow.state === "failed",
      3_000,
    );
    expect(timedOut.error?.code).toBe("login_timed_out");
    expect(state.retiredLogins).toContain(timeoutFlow.login_id);

    const timeoutSignals = await readFile(
      join(state.pendingDirs.get(timeoutFlow.login_id)!, "signals.log"),
      "utf8",
    );
    expect(timeoutSignals).toContain("stdin_eof");
    expect(timeoutSignals).toContain("sigterm");

    const closeService = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      killGracePeriodMs: 80,
    });

    const closeFlow = await closeService.start();
    await waitFor(
      () => closeService.status({ login_id: closeFlow.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await closeService.close();
    const closedStatus = await closeService.status({ login_id: closeFlow.login_id });
    expect(closedStatus.state).toBe("cancelled");
    expect(state.retiredLogins).toContain(closeFlow.login_id);
  });

  it.each([120, 2_000])(
    "혼합 출력의 도움말 URL을 건너뛰고 %i ms 뒤 완성된 인증 URL을 선택한다",
    async (delayMs) => {
      const rootDir = await makeTempDir();
      const state = createFakePort(rootDir);
      const { logger } = createCapturingLogger();
      const expectedUrl = makeAuthUrl("delayed-" + delayMs) + "&orgUUID=12345678-1234-4123-8123-123456789abc";
      const optionalSuffixStart = expectedUrl.indexOf("&orgUUID=");
      const prefix = expectedUrl.slice(0, optionalSuffixStart);
      const suffix = expectedUrl.slice(optionalSuffixStart) + "\n";
      const scriptBody = [
        'const [group, action] = process.argv.slice(2);',
        'if (group === "auth" && action === "login") {',
        '  process.stdout.write("Docs: https://docs.example/help\\n" + ' + JSON.stringify(prefix) + ');',
        '  setTimeout(() => process.stdout.write(' + JSON.stringify(suffix) + '), ' + delayMs + ');',
        '  process.stdin.once("data", () => process.exit(0));',
        '} else if (group === "auth" && action === "status") { process.exit(1); }',
      ].join("\n");
      const cliPath = await createFakeClaudeCli(rootDir, scriptBody);
      const service = new ClaudeLoginService({
        port: state.port,
        logger,
        executablePath: cliPath,
        loginTimeoutMs: 5_000,
      });

      const started = await service.start();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect((await service.status({ login_id: started.login_id })).state).toBe("requested");

      const ready = await waitFor(
        () => service.status({ login_id: started.login_id }),
        (flow) => flow.state === "url_ready",
        4_000,
      );
      expect(ready.auth_url).toBe(expectedUrl);
      await service.cancel({ login_id: started.login_id });
    },
    10_000,
  );

  it.each(["partial", "absent"] as const)("인증 URL이 %s 상태로 끝나면 timeout 처리한다", async (urlCase) => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger } = createCapturingLogger();
    const partialUrl = makeAuthUrl("missing-tail");
    const stateStart = partialUrl.lastIndexOf("state=") + "state=".length;
    const prefix = partialUrl.slice(0, stateStart + 12);
    const outputExpression = urlCase === "partial"
      ? '"Docs: https://docs.example/help\\n" + ' + JSON.stringify(prefix)
      : JSON.stringify("Docs: https://docs.example/help\n");
    const cliPath = await createFakeClaudeCli(
      rootDir,
      [
        'const [group, action] = process.argv.slice(2);',
        'if (group === "auth" && action === "login") {',
        '  process.stdout.write(' + outputExpression + ');',
        '  process.stdin.resume();',
        '  setInterval(() => {}, 1000);',
        '}',
      ].join("\n"),
    );
    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      loginTimeoutMs: 140,
      killGracePeriodMs: 40,
    });

    const started = await service.start();
    const failed = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "failed",
      3_000,
    );
    expect(failed.auth_url).toBeNull();
    expect(failed.error?.code).toBe("login_timed_out");
    expect(state.retiredLogins).toEqual([started.login_id]);
  });

  it("비동기 stdin EPIPE를 잡아 CLI를 SIGTERM→SIGKILL로 종료하고 failed로 격리한다", async () => {
    const rootDir = await makeTempDir();
    const cliPath = await createFakeClaudeCli(
      rootDir,
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const [group, action] = process.argv.slice(2);',
        'if (group === "auth" && action === "login") {',
        '  const configDir = process.env.CLAUDE_CONFIG_DIR;',
        '  writeFileSync(join(configDir, "pid"), String(process.pid));',
        '  process.on("SIGTERM", () => writeFileSync(join(configDir, "sigterm"), "seen"));',
        '  process.stdout.write(' + JSON.stringify(makeAuthUrl("epipe") + String.fromCharCode(10)) + ');',
        '  setInterval(() => {}, 1000);',
        '} else if (group === "auth" && action === "status") { process.exit(1); }',
      ].join("\n"),
    );
    const harnessPath = join(rootDir, "epipe-harness.mjs");
    const harnessSource = [
      'import { ChildProcess } from "node:child_process";',
      'import { existsSync, mkdirSync, readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const [moduleUrl, cliPath, rootDir] = process.argv.slice(2);',
      'const { ClaudeLoginService } = await import(moduleUrl);',
      'const uncaught = [];',
      'process.on("uncaughtException", (error) => uncaught.push(error?.code ?? "unknown"));',
      'const killCalls = [];',
      'const originalKill = ChildProcess.prototype.kill;',
      'ChildProcess.prototype.kill = function (signal, ...rest) { killCalls.push([this.pid, signal ?? null]); return originalKill.call(this, signal, ...rest); };',
      'const retired = [];',
      'const port = {',
      '  async createPendingDir(loginId) { const dir = join(rootDir, "pending-" + loginId); mkdirSync(dir, { recursive: true }); return dir; },',
      '  profileDir() { return null; },',
      '  async findAccount() { return null; },',
      '  async findByIdentity() { return null; },',
      '  async registerFromPending() {},',
      '  async retirePending(loginId) { retired.push(loginId); },',
      '  async beginRelogin() {},',
      '  async endRelogin() {},',
      '  activeSessions() { return 0; },',
      '};',
      'const logger = { info() {}, error() {}, warn() {}, debug() {}, child() { return this; } };',
      'const service = new ClaudeLoginService({ port, logger, executablePath: cliPath, loginTimeoutMs: 1200, killGracePeriodMs: 40 });',
      'const started = await service.start();',
      'const untilReady = Date.now() + 2000;',
      'let flow = await service.status({ login_id: started.login_id });',
      'while (flow.state !== "url_ready" && Date.now() < untilReady) { await new Promise((resolve) => setTimeout(resolve, 10)); flow = await service.status({ login_id: started.login_id }); }',
      'if (flow.state !== "url_ready") throw new Error("login URL did not arrive");',
      'const stdin = service.flows.get(started.login_id).loginChild.stdin;',
      'stdin.write = function (_chunk, callback) { queueMicrotask(() => { const error = Object.assign(new Error("pipe closed"), { code: "EPIPE" }); this.emit("error", error); if (callback) callback(error); }); return true; };',
      'await service.submit_code({ login_id: started.login_id, code: "epipe-test-code" });',
      'const untilFailed = Date.now() + 2500;',
      'while (flow.state !== "failed" && Date.now() < untilFailed) { await new Promise((resolve) => setTimeout(resolve, 10)); flow = await service.status({ login_id: started.login_id }); }',
      'const configDir = join(rootDir, "pending-" + started.login_id);',
      'const pid = Number(readFileSync(join(configDir, "pid"), "utf8"));',
      'let pidAlive = true;',
      'try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") pidAlive = false; else throw error; }',
      'const killSignals = killCalls.filter(([targetPid]) => targetPid === pid).map(([, signal]) => signal);',
      'await service.shutdown();',
      'process.stdout.write(JSON.stringify({ state: flow.state, errorCode: flow.error?.code ?? null, retired, uncaught, pidAlive, sigterm: existsSync(join(configDir, "sigterm")), killSignals }));',
    ].join("\n");
    await writeFile(harnessPath, harnessSource, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        harnessPath,
        new URL("../../src/claude_accounts/login_service.ts", import.meta.url).href,
        cliPath,
        rootDir,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 6_000 },
    );
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout.trim()) as {
      state: string;
      errorCode: string | null;
      retired: string[];
      uncaught: string[];
      pidAlive: boolean;
      sigterm: boolean;
      killSignals: Array<string | number | null>;
    };
    expect(observed.state).toBe("failed");
    expect(observed.errorCode).toBe("login_stdin_failed");
    expect(observed.retired).toHaveLength(1);
    expect(observed.uncaught).toEqual([]);
    expect(observed.sigterm).toBe(true);
    expect(observed.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(observed.pidAlive).toBe(false);
  }, 10_000);

  it.each([0, 4])("로그인 자식이 코드 입력 전 종료 코드 %i로 끝나면 상태 검증 없이 실패시킨다", async (exitCode) => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger } = createCapturingLogger();
    const cliPath = await createFakeClaudeCli(
      rootDir,
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const [group, action] = process.argv.slice(2);',
        `if (group === "auth" && action === "login") process.exit(${exitCode});`,
        'if (group === "auth" && action === "status") writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "status-ran"), "yes");',
      ].join("\n"),
    );
    const service = new ClaudeLoginService({ port: state.port, logger, executablePath: cliPath });

    const started = await service.start();
    const failed = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "failed",
    );
    expect(failed.error?.code).toBe("login_process_failed");
    expect(existsSync(join(state.pendingDirs.get(started.login_id)!, "status-ran"))).toBe(false);
    expect(state.retiredLogins).toEqual([started.login_id]);
  });

  it.each([
    ["nonzero status exit", 'process.stdout.write(JSON.stringify({ loggedIn: true, email: "status@example.com" })); process.exit(7);'],
    ["malformed status JSON", 'process.stdout.write("not-json"); process.exit(0);'],
  ])("status의 %s는 인증 실패로 격리한다", async (_label, statusScript) => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger } = createCapturingLogger();
    const cliPath = await createInteractiveCli(rootDir, "bad-status", statusScript);
    const service = new ClaudeLoginService({ port: state.port, logger, executablePath: cliPath });

    const started = await service.start();
    await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await service.submit_code({ login_id: started.login_id, code: "status-failure-code" });
    const failed = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "failed",
    );

    expect(failed.error?.code).toBe("auth_status_failed");
    expect(state.registered).toEqual([]);
    expect(state.retiredLogins).toEqual([started.login_id]);
  });

  it("UUID만 기존 계정과 같아도 새 계정을 account_exists로 거절한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const duplicateId = "88888888-8888-4888-8888-888888888888";
    state.accounts.set(duplicateId, {
      id: duplicateId,
      email: "existing@example.com",
      plan: "Pro",
    });
    const { logger } = createCapturingLogger();
    const cliPath = await createInteractiveCli(
      rootDir,
      "uuid-only-duplicate",
      'process.stdout.write(JSON.stringify({ loggedIn: true, email: "different@example.com", accountUuid: "88888888-8888-4888-8888-888888888888" })); process.exit(0);',
    );
    const service = new ClaudeLoginService({ port: state.port, logger, executablePath: cliPath });

    const started = await service.start();
    await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await service.submit_code({ login_id: started.login_id, code: "uuid-duplicate-code" });
    const failed = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "failed",
    );

    expect(failed.error).toMatchObject({ code: "account_exists", existing_account_id: duplicateId });
    expect(state.registered).toEqual([]);
    expect(state.retiredLogins).toEqual([started.login_id]);
  });

  it.each([
    ["waiting", "cancel"],
    ["waiting", "timeout"],
    ["started", "cancel"],
    ["started", "timeout"],
  ] as const)(
    "재로그인이 %s 단계에서 %s되면 endRelogin을 정확히 한 번 호출하고 제한을 푼다",
    async (phase, ending) => {
      const rootDir = await makeTempDir();
      const state = createFakePort(rootDir);
      const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      state.accounts.set(accountId, {
        id: accountId,
        email: "relogin-race@example.com",
        plan: "Pro",
      });
      state.activeSessionCounts.set(accountId, phase === "waiting" ? 1 : 0);
      const { logger } = createCapturingLogger();
      const cliPath = await createFakeClaudeCli(
        rootDir,
        [
          'import { writeFileSync } from "node:fs";',
          'import { mkdirSync } from "node:fs";',
          'import { join } from "node:path";',
          'const [group, action] = process.argv.slice(2);',
          'if (group === "auth" && action === "login") {',
          '  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });',
          '  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "cli-started"), "yes");',
          '  process.stdout.write(' + JSON.stringify(makeAuthUrl("relogin-lifecycle") + String.fromCharCode(10)) + ');',
          '  process.on("SIGTERM", () => {});',
          '  setInterval(() => {}, 1000);',
          '} else if (group === "auth" && action === "status") { process.exit(1); }',
        ].join("\n"),
      );
      const timeoutMs = ending === "timeout" ? (phase === "waiting" ? 100 : 700) : 4_000;
      const service = new ClaudeLoginService({
        port: state.port,
        logger,
        executablePath: cliPath,
        loginTimeoutMs: timeoutMs,
        activeSessionPollIntervalMs: 10,
        killGracePeriodMs: 30,
      });

      const started = await service.start({ account_id: accountId });
      if (phase === "started") {
        await waitFor(
          () => service.status({ login_id: started.login_id }),
          (flow) => flow.state === "url_ready",
          2_000,
        );
      }
      if (ending === "cancel") {
        await service.cancel({ login_id: started.login_id });
      } else {
        await waitFor(
          () => service.status({ login_id: started.login_id }),
          (flow) => flow.state === "failed",
          3_000,
        );
      }

      expect(state.reloginEnded).toEqual([{ accountId, outcome: "needs_relogin" }]);
      const profilePath = state.port.profileDir(accountId)!;
      expect(existsSync(join(profilePath, "cli-started"))).toBe(phase === "started");

      const replacement = await service.start();
      expect(replacement.login_id).not.toBe(started.login_id);
      const replacementTerminal = await service.cancel({ login_id: replacement.login_id });
      expect(replacementTerminal.state).toBe("cancelled");
      expect(state.reloginEnded).toEqual([{ accountId, outcome: "needs_relogin" }]);
    },
    10_000,
  );

  it("등록 커밋이 시작된 뒤의 취소는 완료 결과를 기다리고 상태를 done으로 고정한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const registrationStarted = deferred<void>();
    const releaseRegistration = deferred<void>();
    const register = state.port.registerFromPending.bind(state.port);
    state.port.registerFromPending = async (input) => {
      registrationStarted.resolve();
      await releaseRegistration.promise;
      await register(input);
    };
    const { logger } = createCapturingLogger();
    const cliPath = await createInteractiveCli(
      rootDir,
      "cancel-success-race",
      'process.stdout.write(JSON.stringify({ loggedIn: true, email: "login@example.com", accountUuid: "88888888-8888-4888-8888-888888888888" })); process.exit(0);',
    );
    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      loginTimeoutMs: 5_000,
    });

    const started = await service.start();
    await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await service.submit_code({ login_id: started.login_id, code: "cancel-success-race-code" });
    await registrationStarted.promise;

    const cancelPromise = service.cancel({ login_id: started.login_id });
    releaseRegistration.resolve();
    const cancelResult = await cancelPromise;
    const finalStatus = await service.status({ login_id: started.login_id });
    expect(cancelResult.state).toBe("done");
    expect(finalStatus.state).toBe("done");
    expect(state.registered).toHaveLength(1);

    const replacement = await service.start();
    expect(replacement.login_id).not.toBe(started.login_id);
    await service.cancel({ login_id: replacement.login_id });
  }, 8_000);

  it("timeout과 계정 확인이 겹치면 failed 상태를 고정하고 다음 로그인을 허용한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const identityCheckStarted = deferred<void>();
    const releaseIdentityCheck = deferred<void>();
    const findByIdentity = state.port.findByIdentity.bind(state.port);
    state.port.findByIdentity = async (input) => {
      identityCheckStarted.resolve();
      await releaseIdentityCheck.promise;
      return findByIdentity(input);
    };
    const { logger } = createCapturingLogger();
    const cliPath = await createInteractiveCli(
      rootDir,
      "timeout-success-race",
      'process.stdout.write(JSON.stringify({ loggedIn: true, email: "login@example.com", accountUuid: "88888888-8888-4888-8888-888888888888" })); process.exit(0);',
    );
    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      loginTimeoutMs: 900,
      killGracePeriodMs: 30,
    });

    const started = await service.start();
    await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await service.submit_code({ login_id: started.login_id, code: "timeout-success-race-code" });
    await identityCheckStarted.promise;
    const failed = await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "failed",
      2_000,
    );
    releaseIdentityCheck.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(failed.error?.code).toBe("login_timed_out");
    expect((await service.status({ login_id: started.login_id })).error?.code).toBe("login_timed_out");
    expect(state.registered).toEqual([]);
    expect(state.retiredLogins).toEqual([started.login_id]);
    const replacement = await service.start();
    expect(replacement.login_id).not.toBe(started.login_id);
    await service.cancel({ login_id: replacement.login_id });
  }, 8_000);

  it("shutdown은 status 자식에 SIGTERM→SIGKILL을 보내고 실제 PID 종료까지 기다린다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger } = createCapturingLogger();
    const cliPath = await createFakeClaudeCli(
      rootDir,
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const [group, action] = process.argv.slice(2);',
        'if (group === "auth" && action === "login") {',
        '  process.stdout.write(' + JSON.stringify(makeAuthUrl("status-shutdown") + String.fromCharCode(10)) + ');',
        '  process.stdin.once("data", () => process.exit(0));',
        '} else if (group === "auth" && action === "status") {',
        '  const dir = process.env.CLAUDE_CONFIG_DIR;',
        '  writeFileSync(join(dir, "status-pid"), String(process.pid));',
        '  process.stdout.write(JSON.stringify({ loggedIn: true, email: "status@example.com" }));',
        '  process.on("SIGTERM", () => {});',
        '  setInterval(() => {}, 1000);',
        '}',
      ].join("\n"),
    );
    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      loginTimeoutMs: 5_000,
      killGracePeriodMs: 40,
    });
    const killSpy = vi.spyOn(ChildProcess.prototype, "kill");

    const started = await service.start();
    await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );
    await service.submit_code({ login_id: started.login_id, code: "status-shutdown-code" });
    const pendingDir = state.pendingDirs.get(started.login_id)!;
    const pidText = await waitFor(
      () => readFile(join(pendingDir, "status-pid"), "utf8").catch(() => ""),
      (value) => value.length > 0,
    );
    const statusPid = Number(pidText);
    expect((await service.status({ login_id: started.login_id })).state).toBe("verifying");

    await service.shutdown();

    const killedStatusChild = killSpy.mock.calls
      .map((call, index) => ({
        pid: (killSpy.mock.contexts[index] as ChildProcess).pid,
        signal: call[0],
      }))
      .filter((call) => call.pid === statusPid)
      .map((call) => call.signal);
    expect(killedStatusChild).toEqual(["SIGTERM", "SIGKILL"]);
    expect(processIsAlive(statusPid)).toBe(false);
    expect((await service.status({ login_id: started.login_id })).state).toBe("cancelled");
    expect(state.retiredLogins).toEqual([started.login_id]);
  }, 8_000);

  it("실제 runtime composition의 프로필 폴백은 프로필 인증 파일과 단일 계정 토큰 파일을 바꾸지 않는다", async () => {
    const rootDir = await makeTempDir();
    const accounts = new ClaudeAccountService({
      accountsDir: join(rootDir, "accounts"),
      homeDir: join(rootDir, "home"),
    });
    const logger = pino({ level: "silent" });
    const legacyTokenPath = join(rootDir, "legacy-auth.json");
    const legacyRaw = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-legacy-token" },
    }) + "\n";
    await writeFile(legacyTokenPath, legacyRaw, "utf8");
    const profileCredentialsRaw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "profile-access-token",
        expiresAt: Date.now() + 60_000,
      },
    }) + "\n";
    const accountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let pendingProfilePath = "";
    let profileCredentialsAtFetch = "";
    let authHeader = "";
    let profileUrl = "";
    const claudeAuth = new ClaudeAuthService(
      {
        store: new FileClaudeAuthTokenStore(legacyTokenPath),
        httpGet: async (url, init) => {
          profileUrl = url;
          authHeader = init.headers.Authorization ?? "";
          profileCredentialsAtFetch = readFileSync(pendingProfilePath, "utf8");
          return {
            status: 200,
            text: async () => "",
            json: async () => ({
              account: { uuid: accountId, email: "profile@example.com" },
              subscriptionType: "Pro",
            }),
          };
        },
      },
      logger,
    );
    const cliPath = await createFakeClaudeCli(
      rootDir,
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const [group, action] = process.argv.slice(2);',
        'if (group === "auth" && action === "login") {',
        '  const dir = process.env.CLAUDE_CONFIG_DIR;',
        '  process.stdout.write(' + JSON.stringify(makeAuthUrl("runtime-profile") + String.fromCharCode(10)) + ');',
        '  process.stdin.once("data", () => { writeFileSync(join(dir, ".credentials.json"), ' + JSON.stringify(profileCredentialsRaw) + '); process.exit(0); });',
        '} else if (group === "auth" && action === "status") {',
        '  process.stdout.write(JSON.stringify({ loggedIn: true, email: "profile@example.com" }));',
        '  process.exit(0);',
        '}',
      ].join("\n"),
    );
    const previousExecPath = process.env.CLAUDE_CODE_EXECPATH;
    process.env.CLAUDE_CODE_EXECPATH = cliPath;
    const service = composeClaudeLoginService({ accounts, claudeAuth, logger });
    try {
      const started = await service.start();
      pendingProfilePath = join(accounts.store.pendingLoginDir(started.login_id), ".credentials.json");
      await waitFor(
        () => service.status({ login_id: started.login_id }),
        (flow) => flow.state === "url_ready",
      );
      await service.submit_code({ login_id: started.login_id, code: "runtime-profile-code" });
      const done = await waitFor(
        () => service.status({ login_id: started.login_id }),
        (flow) => flow.state === "done",
      );

      expect(done.account_id).toBe(accountId);
      expect(profileUrl).toBe("https://api.anthropic.com/api/oauth/profile");
      expect(authHeader).toBe("Bearer profile-access-token");
      expect(profileCredentialsAtFetch).toBe(profileCredentialsRaw);
      expect(await readFile(join(accounts.store.profileDir(accountId), ".credentials.json"), "utf8"))
        .toBe(profileCredentialsRaw);
      expect(await readFile(legacyTokenPath, "utf8")).toBe(legacyRaw);
      expect(await accounts.findAccount(accountId)).toMatchObject({
        id: accountId,
        email: "profile@example.com",
      });
    } finally {
      await service.shutdown();
      if (previousExecPath === undefined) delete process.env.CLAUDE_CODE_EXECPATH;
      else process.env.CLAUDE_CODE_EXECPATH = previousExecPath;
    }
  }, 8_000);

  it("shutdown은 진행 중인 로그인 CLI를 종료하고 pending 계정을 격리한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger } = createCapturingLogger();
    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
process.stdin.resume();
process.stdout.write(${JSON.stringify(makeAuthUrl("shutdown") + String.fromCharCode(10))});
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
      `,
    );
    const service = new ClaudeLoginService({
      port: state.port,
      logger,
      executablePath: cliPath,
      killGracePeriodMs: 80,
    });

    const started = await service.start();
    await waitFor(
      () => service.status({ login_id: started.login_id }),
      (flow) => flow.state === "url_ready",
    );

    await service.shutdown();

    expect((await service.status({ login_id: started.login_id })).state).toBe("cancelled");
    expect(state.retiredLogins).toContain(started.login_id);
  });
});
