import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { ClaudeAuthError, ClaudeAuthLoginFlow } from "@soulstream/wire-schema";
import type { Logger } from "pino";

import { resolveClaudeExecutableFromPath } from "../engine/claude_executable_path.js";
import type { ClaudeLoginAccountPort } from "./types.js";
import {
  type ChildExit,
  CLAUDE_CODE_EXECPATH_ENV,
  ClaudeLoginError,
  type ClaudeLoginProfileFetcher,
  createInternalLoginFlow,
  type InternalLoginFlow,
  isTerminalState,
  MAX_STDOUT_SCAN_BUFFER_CHARS,
  scanStdoutForAuthUrl,
  terminateFlowChildren,
  type TerminationReason,
  toLoginFlowSnapshot,
  validateLoginCode,
  verifyLoggedInIdentity,
  waitForChildExit,
} from "./login_cli_helpers.js";

export { ClaudeLoginError, type ClaudeLoginProfileFetcher } from "./login_cli_helpers.js";

export type { ClaudeLoginAccountPort } from "./types.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_KILL_GRACE_PERIOD_MS = 5_000;
const DEFAULT_ACTIVE_SESSION_POLL_INTERVAL_MS = 50;

export interface ClaudeLoginServiceConfig {
  port: ClaudeLoginAccountPort;
  logger: Logger;
  executablePath?: string;
  resolveClaudeExecutablePath?: () => string | undefined;
  baseEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetchProfile?: ClaudeLoginProfileFetcher;
  loginTimeoutMs?: number;
  killGracePeriodMs?: number;
  activeSessionPollIntervalMs?: number;
  now?: () => number;
}

export class ClaudeLoginService {
  private readonly port: ClaudeLoginAccountPort;
  private readonly logger: Logger;
  private readonly executablePath?: string;
  private readonly resolveClaudeExecutablePath: () => string | undefined;
  private readonly baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
  private readonly fetchProfile?: ClaudeLoginProfileFetcher;
  private readonly loginTimeoutMs: number;
  private readonly killGracePeriodMs: number;
  private readonly activeSessionPollIntervalMs: number;
  private readonly now: () => number;
  private readonly flows = new Map<string, InternalLoginFlow>();
  private activeFlowId: string | null = null;

  constructor(config: ClaudeLoginServiceConfig) {
    this.port = config.port;
    this.logger = config.logger;
    this.executablePath = config.executablePath;
    this.baseEnv = config.baseEnv ?? process.env;
    this.resolveClaudeExecutablePath =
      config.resolveClaudeExecutablePath ?? (() => resolveClaudeExecutableFromPath(this.baseEnv));
    this.fetchProfile = config.fetchProfile;
    this.loginTimeoutMs = config.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.killGracePeriodMs = config.killGracePeriodMs ?? DEFAULT_KILL_GRACE_PERIOD_MS;
    this.activeSessionPollIntervalMs =
      config.activeSessionPollIntervalMs ?? DEFAULT_ACTIVE_SESSION_POLL_INTERVAL_MS;
    this.now = config.now ?? Date.now;
  }

  async start(input: { account_id?: string | null } = {}): Promise<ClaudeAuthLoginFlow> {
    if (this.activeFlowId !== null) {
      throw new ClaudeLoginError(
        "login_in_progress",
        "Another Claude login flow is already in progress",
      );
    }

    const loginId = randomUUID();
    const requestedAccountId = input.account_id?.trim() || null;
    this.activeFlowId = loginId;

    try {
      let configDir: string;
      if (requestedAccountId !== null) {
        const existing = await this.port.findAccount(requestedAccountId);
        const profileDir = this.port.profileDir(requestedAccountId);
        if (!existing || !profileDir) {
          throw new ClaudeLoginError("account_not_found", "Target Claude account was not found");
        }
        configDir = profileDir;
        await this.port.beginRelogin(requestedAccountId);
      } else {
        configDir = await this.port.createPendingDir(loginId);
      }

      const flow = createInternalLoginFlow({
        loginId,
        requestedAccountId,
        configDir,
        baseEnv: this.baseEnv,
        expiresAt: new Date(this.now() + this.loginTimeoutMs).toISOString(),
      });

      this.flows.set(loginId, flow);
      flow.timeoutTimer = setTimeout(() => {
        void this.terminateFlow(flow, "timeout");
      }, this.loginTimeoutMs);

      this.logger.info(
        { loginId, accountId: requestedAccountId, isRelogin: flow.isRelogin },
        "Claude CLI login flow started",
      );

      if (flow.isRelogin && this.port.activeSessions(requestedAccountId!) > 0) {
        void this.waitForZeroActiveSessionsAndSpawn(flow, requestedAccountId!);
      } else {
        this.spawnLoginProcess(flow);
      }

      return toLoginFlowSnapshot(flow);
    } catch (error) {
      if (this.activeFlowId === loginId) this.activeFlowId = null;
      throw error;
    }
  }

  async status(input: { login_id: string }): Promise<ClaudeAuthLoginFlow> {
    return toLoginFlowSnapshot(this.requireFlow(input.login_id));
  }

  async submit_code(input: { login_id: string; code: string }): Promise<ClaudeAuthLoginFlow> {
    const validatedCode = validateLoginCode(input.code);
    const flow = this.requireFlow(input.login_id);

    if (flow.codeSubmitted || flow.terminatingReason !== null || isTerminalState(flow.state)) {
      return toLoginFlowSnapshot(flow);
    }
    if (
      flow.state !== "url_ready" ||
      !flow.loginChild?.stdin ||
      flow.loginChild.stdin.destroyed ||
      !flow.loginChild.stdin.writable
    ) {
      throw new ClaudeLoginError(
        "login_not_ready",
        "Claude login flow is not ready to accept an authorization code",
      );
    }

    flow.codeSubmitted = true;
    flow.state = "code_submitted";
    const handleStdinError = () => {
      void this.failFlow(flow, {
        code: "login_stdin_failed",
        message: "Failed to deliver authorization code to Claude CLI",
      });
    };
    try {
      flow.loginChild.stdin.write(`${validatedCode}\n`, (error) => {
        if (error) handleStdinError();
      });
      flow.loginChild.stdin.end();
    } catch {
      handleStdinError();
    }

    this.logger.info({ loginId: flow.loginId }, "Claude CLI login authorization code submitted");
    return toLoginFlowSnapshot(flow);
  }

  async submitCode(input: { login_id: string; code: string }): Promise<ClaudeAuthLoginFlow> {
    return this.submit_code(input);
  }

  async cancel(input: { login_id: string }): Promise<ClaudeAuthLoginFlow> {
    const flow = this.requireFlow(input.login_id);
    if (isTerminalState(flow.state) && flow.terminationPromise === null) {
      return toLoginFlowSnapshot(flow);
    }
    return this.terminateFlow(flow, "cancel");
  }

  async close(): Promise<void> {
    const activeId = this.activeFlowId;
    if (!activeId) return;
    const flow = this.flows.get(activeId);
    if (flow) await this.terminateFlow(flow, "shutdown");
  }

  async shutdown(): Promise<void> { await this.close(); }

  private async waitForZeroActiveSessionsAndSpawn(
    flow: InternalLoginFlow,
    accountId: string,
  ): Promise<void> {
    while (
      flow.terminatingReason === null &&
      !isTerminalState(flow.state) &&
      this.port.activeSessions(accountId) > 0
    ) {
      await new Promise((resolve) => setTimeout(resolve, this.activeSessionPollIntervalMs));
    }
    if (flow.terminatingReason === null && !isTerminalState(flow.state)) {
      this.spawnLoginProcess(flow);
    }
  }

  private spawnLoginProcess(flow: InternalLoginFlow): void {
    if (flow.terminatingReason !== null || isTerminalState(flow.state)) return;

    let child: ChildProcess;
    try {
      child = spawn(this.resolveExecutable(), ["auth", "login"], {
        env: flow.childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      void this.failFlow(flow, {
        code: "login_spawn_failed",
        message: "Failed to start Claude CLI login process",
      });
      return;
    }

    flow.loginChild = child;
    flow.loginChildExitPromise = waitForChildExit(child);
    child.on("error", () => {
      void this.failFlow(flow, {
        code: "login_process_failed",
        message: "Claude CLI login process failed",
      });
    });
    child.stdin?.on("error", () => {
      void this.failFlow(flow, {
        code: "login_stdin_failed",
        message: "Failed to deliver authorization code to Claude CLI",
      });
    });
    child.stdout?.on("error", () => this.failForStreamError(flow));
    child.stderr?.on("error", () => this.failForStreamError(flow));
    child.stderr?.resume();

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onLoginStdoutChunk(flow, chunk));
    }

    void flow.loginChildExitPromise.then((exit) => void this.onLoginChildExited(flow, exit));
  }

  private onLoginStdoutChunk(flow: InternalLoginFlow, chunk: string): void {
    if (flow.authUrl !== null || flow.terminatingReason !== null || isTerminalState(flow.state)) {
      return;
    }
    flow.stdoutBuffer = (flow.stdoutBuffer + chunk).slice(-MAX_STDOUT_SCAN_BUFFER_CHARS);
    const authUrl = scanStdoutForAuthUrl(flow.stdoutBuffer);
    if (authUrl) this.commitAuthUrl(flow, authUrl);
  }

  private commitAuthUrl(flow: InternalLoginFlow, url: string): void {
    flow.authUrl = url;
    flow.stdoutBuffer = "";
    if (flow.state === "requested") flow.state = "url_ready";
    this.logger.info({ loginId: flow.loginId }, "Claude CLI login authorization URL ready");
  }

  private async onLoginChildExited(flow: InternalLoginFlow, exit: ChildExit): Promise<void> {
    if (flow.terminatingReason !== null || isTerminalState(flow.state)) return;

    if (exit.code !== 0 || exit.signal !== null || !flow.codeSubmitted) {
      await this.failFlow(flow, {
        code: "login_process_failed",
        message: "Claude CLI login exited without completing authentication",
      });
      return;
    }

    try {
      flow.state = "verifying";
      const identity = await verifyLoggedInIdentity({
        cli: this.resolveExecutable(),
        configDir: flow.configDir,
        env: flow.childEnv,
        fetchProfile: this.fetchProfile,
        onSpawnStatus: (child, exitPromise) => {
          flow.statusChild = child;
          flow.statusChildExitPromise = exitPromise;
        },
        onStatusStreamError: () => this.failForStreamError(flow),
      });
      if (flow.terminatingReason !== null || isTerminalState(flow.state)) return;

      if (!identity.loggedIn) {
        await this.failFlow(flow, {
          code: "auth_status_failed",
          message: "Claude CLI authentication status check failed",
        });
        return;
      }

      if (!identity.accountUuid) {
        await this.failFlow(flow, {
          code: "account_uuid_missing",
          message: "Could not determine Claude account UUID after login",
        });
        return;
      }

      if (flow.isRelogin) {
        if (identity.accountUuid !== flow.accountId!) {
          await this.failFlow(flow, {
            code: "account_identity_mismatch",
            message: "Logged-in Claude account does not match the target account",
          });
          return;
        }
        flow.successCommitPromise = this.commitSuccessfulLogin(flow, null);
        await flow.successCommitPromise;
        return;
      }

      const duplicate = await this.port.findByIdentity({
        id: identity.accountUuid,
        email: identity.email,
      });
      if (flow.terminatingReason !== null || isTerminalState(flow.state)) return;

      if (duplicate !== null) {
        await this.failFlow(flow, {
          code: "account_exists",
          message: "Claude account is already registered",
          existing_account_id: duplicate.id,
        });
        return;
      }

      flow.successCommitPromise = this.commitSuccessfulLogin(flow, {
        id: identity.accountUuid,
        email: identity.email,
        plan: identity.plan,
      });
      await flow.successCommitPromise;
    } catch {
      if (flow.terminatingReason === null && !isTerminalState(flow.state)) {
        await this.failFlow(flow, {
          code: "login_verification_failed",
          message: "Claude CLI login verification failed",
        });
      }
    }
  }

  private async commitSuccessfulLogin(
    flow: InternalLoginFlow,
    identity: { id: string; email: string | null; plan: string | null } | null,
  ): Promise<void> {
    this.clearTimeoutTimer(flow);
    if (identity === null) {
      await this.settleRelogin(flow, "ok");
    } else {
      await this.port.registerFromPending({ loginId: flow.loginId, ...identity });
      flow.pendingSettled = true;
      flow.accountId = identity.id;
    }
    this.finishFlow(flow, "done", null);
  }

  private failForStreamError(flow: InternalLoginFlow): void {
    void this.failFlow(flow, {
      code: "login_process_failed",
      message: "Claude CLI login stream failed",
    });
  }

  private terminateFlow(
    flow: InternalLoginFlow,
    reason: TerminationReason,
    failureError?: ClaudeAuthError,
  ): Promise<ClaudeAuthLoginFlow> {
    if (flow.terminationPromise !== null) return flow.terminationPromise;
    if (isTerminalState(flow.state)) return Promise.resolve(toLoginFlowSnapshot(flow));
    if (flow.successCommitPromise !== null) {
      return flow.successCommitPromise.then(
        () => toLoginFlowSnapshot(flow),
        () => this.beginTermination(flow, reason, failureError),
      );
    }
    return this.beginTermination(flow, reason, failureError);
  }

  private beginTermination(
    flow: InternalLoginFlow,
    reason: TerminationReason,
    failureError?: ClaudeAuthError,
  ): Promise<ClaudeAuthLoginFlow> {
    if (flow.terminationPromise !== null) return flow.terminationPromise;
    flow.terminatingReason = reason;
    this.clearTimeoutTimer(flow);

    const promise = (async (): Promise<ClaudeAuthLoginFlow> => {
      try {
        await terminateFlowChildren(flow, this.killGracePeriodMs);
        await this.cleanupNonSuccessFlow(flow);
      } finally {
        if (reason === "timeout" || reason === "failure") {
          const error = reason === "timeout" ? {
            code: "login_timed_out",
            message: "Claude CLI login timed out",
          } : failureError ?? {
            code: "login_process_failed",
            message: "Claude CLI login failed",
          };
          this.finishFlow(flow, "failed", error, true);
        } else {
          this.finishFlow(flow, "cancelled", null, true);
        }
      }
      return toLoginFlowSnapshot(flow);
    })();

    flow.terminationPromise = promise;
    return promise;
  }

  private async failFlow(flow: InternalLoginFlow, error: ClaudeAuthError): Promise<void> {
    await this.terminateFlow(flow, "failure", error);
  }

  private async cleanupNonSuccessFlow(flow: InternalLoginFlow): Promise<void> {
    if (flow.isRelogin) {
      await this.settleRelogin(flow, "needs_relogin");
    } else if (!flow.pendingSettled) {
      flow.pendingSettled = true;
      await this.port.retirePending(flow.loginId);
    }
  }

  private async settleRelogin(
    flow: InternalLoginFlow,
    outcome: "ok" | "needs_relogin",
  ): Promise<void> {
    if (flow.reloginEnded || !flow.accountId) return;
    flow.reloginEnded = true;
    await this.port.endRelogin(flow.accountId, outcome);
  }

  private finishFlow(
    flow: InternalLoginFlow,
    state: "done" | "failed" | "cancelled",
    error: ClaudeAuthError | null,
    terminating = false,
  ): void {
    if (isTerminalState(flow.state)) return;
    if (flow.terminatingReason !== null && !terminating) return;
    this.clearTimeoutTimer(flow);
    flow.stdoutBuffer = "";
    flow.state = state;
    flow.error = error;
    if (this.activeFlowId === flow.loginId) this.activeFlowId = null;
    this.logger.info(
      {
        loginId: flow.loginId,
        accountId: flow.accountId,
        state,
        errorCode: error?.code ?? null,
      },
      "Claude CLI login flow finished",
    );
  }

  private resolveExecutable(): string {
    return (
      this.executablePath?.trim() ||
      this.baseEnv[CLAUDE_CODE_EXECPATH_ENV]?.trim() ||
      this.resolveClaudeExecutablePath() ||
      "claude"
    );
  }

  private requireFlow(loginId: string): InternalLoginFlow {
    const flow = this.flows.get(loginId);
    if (!flow) throw new ClaudeLoginError("login_not_found", "Claude login flow was not found");
    return flow;
  }

  private clearTimeoutTimer(flow: InternalLoginFlow): void {
    if (flow.timeoutTimer !== null) {
      clearTimeout(flow.timeoutTimer);
      flow.timeoutTimer = null;
    }
  }
}
