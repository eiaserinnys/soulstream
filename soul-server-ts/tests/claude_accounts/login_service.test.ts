import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";

import {
  ClaudeLoginError,
  ClaudeLoginService,
  type ClaudeLoginAccountPort,
} from "../../src/claude_accounts/login_service.js";

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

afterEach(async () => {
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

    const expectedUrl =
      "https://claude.ai/oauth/authorize?code=true&client_id=test-client&state=split-state-token-999";
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
  process.stdout.write("SECRET_RAW_STDOUT_MARKER\\nOpen URL: https://claude.ai/oauth/autho");
  setTimeout(() => {
    process.stdout.write("rize?code=true&client_id=test-client");
    setTimeout(() => {
      process.stdout.write("&state=split-state-token-999\\nPaste code: ");
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
  process.stdout.write("https://claude.ai/oauth/authorize?state=1\\n");
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
  process.stdout.write("https://claude.ai/oauth/authorize?state=status-fail\\n");
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
  process.stdout.write("https://claude.ai/oauth/authorize?state=no-uuid\\n");
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
  process.stdout.write("https://claude.ai/oauth/authorize?state=dup\\n");
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
  process.stdout.write("https://claude.ai/oauth/authorize?state=relogin\\n");
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
    expect(urlReady.auth_url).toBe("https://claude.ai/oauth/authorize?state=relogin");

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
  process.stdout.write("https://claude.ai/oauth/authorize?state=mismatch\\n");
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

process.stdout.write("https://claude.ai/oauth/authorize?state=hang\\n");
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

  it("shutdown은 진행 중인 로그인 CLI를 종료하고 pending 계정을 격리한다", async () => {
    const rootDir = await makeTempDir();
    const state = createFakePort(rootDir);
    const { logger } = createCapturingLogger();
    const cliPath = await createFakeClaudeCli(
      rootDir,
      `
process.stdin.resume();
process.stdout.write("https://claude.ai/oauth/authorize?state=shutdown\\n");
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
