import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { AgentLoginFlow } from "@soulstream/wire-schema";
import type { Logger } from "pino";

import {
  type ChildExit,
  MAX_STDOUT_SCAN_BUFFER_CHARS,
  waitForChildExit,
} from "../claude_accounts/login_cli_helpers.js";
import { AgentLoginActivity } from "./activity.js";
import type { FlowHost, ProviderDriver } from "./driver.js";
import { appendTail } from "./output_scan.js";
import { spawnInOwnGroup, terminateProcessTree } from "./process_control.js";
import {
  AGENT_LOGIN_PROVIDERS,
  AgentLoginServiceError,
  DEFAULT_AGENT_LOGIN_TIMINGS,
  type AgentLoginProvider,
  type AgentLoginTimings,
  type InternalAgentLoginFlow,
  isTerminalState,
  type TerminationReason,
  toAgentLoginSnapshot,
} from "./types.js";

const LIVE_CLI_STATES = new Set(["requested", "url_ready", "code_submitted"]);

export interface AgentLoginServiceConfig {
  logger: Logger;
  /** 공급자별 로그인 방식. 서비스는 CLI 종류를 모른다. */
  drivers: Record<AgentLoginProvider, ProviderDriver>;
  activity?: AgentLoginActivity;
  timings?: Partial<AgentLoginTimings>;
  now?: () => number;
}

/**
 * Codex와 Antigravity CLI 로그인을 한 노드에서 하나씩 돌린다(ClaudeLoginService와는 따로 돈다).
 * 로그에는 상태 전이, 종료 코드, 걸린 시간만 남기고 일회용 코드, 인증 주소, 붙여 넣은 코드, CLI 원출력은 싣지 않는다.
 */
export class AgentLoginService {
  private readonly logger: Logger;
  private readonly drivers: Record<AgentLoginProvider, ProviderDriver>;
  /** 사용량 확인이 로그인 CLI가 살아 있는지 읽는 값. */
  readonly activity: AgentLoginActivity;
  private readonly timings: AgentLoginTimings;
  private readonly now: () => number;
  private readonly flows = new Map<string, InternalAgentLoginFlow>();
  private activeFlowId: string | null = null;
  private readonly host: FlowHost;

  constructor(config: AgentLoginServiceConfig) {
    this.logger = config.logger;
    this.drivers = config.drivers;
    this.activity = config.activity ?? new AgentLoginActivity();
    this.timings = { ...DEFAULT_AGENT_LOGIN_TIMINGS, ...config.timings };
    this.now = config.now ?? Date.now;
    this.host = {
      timings: this.timings,
      logger: this.logger,
      now: () => this.now(),
      schedule: (flow, ms, fn) => this.schedule(flow, ms, fn),
      setState: (flow, state) => this.setState(flow, state),
      markUrlReady: (flow, input) => this.markUrlReady(flow, input),
      fail: (flow, code, message) => this.terminate(flow, "failure", { code, message }),
      verify: (flow) => this.verify(flow),
      write: (flow, data) => this.write(flow, data),
    };
  }

  async start(input: { provider: string }): Promise<AgentLoginFlow> {
    const provider = input.provider;
    if (typeof provider !== "string" || provider.length === 0) {
      throw new AgentLoginServiceError("invalid_request", "provider is required");
    }
    if (!AGENT_LOGIN_PROVIDERS.includes(provider as AgentLoginProvider)) {
      throw new AgentLoginServiceError("agent_login_unsupported", `Unsupported login provider: ${provider}`);
    }
    const driver = this.drivers[provider as AgentLoginProvider];
    const plan = driver.plan();

    const flow = this.createFlow(driver);
    // 진행 중인 흐름이 있으면 새 시작이 잠금을 곧바로 넘겨받고 옛 흐름은 뒤에서 끝낸다.
    const previous = this.activeFlowId === null ? undefined : this.flows.get(this.activeFlowId);
    this.activeFlowId = flow.loginId;
    this.flows.set(flow.loginId, flow);
    this.activity.mark(flow.provider, flow.loginId, true);
    if (previous && !isTerminalState(previous.state)) {
      this.logger.info({ loginId: previous.loginId, supersededBy: flow.loginId }, "Agent login flow superseded");
      void this.terminate(previous, "superseded", {
        code: "cancelled_by_new_login",
        message: "A newer login replaced this one",
      });
    }

    try {
      const child = spawnInOwnGroup(plan.command, plan.args, plan.env);
      this.attachChild(flow, driver, child);
    } catch {
      void this.terminate(flow, "failure", { code: "cli_exited", message: "Login CLI could not be started" });
      return toAgentLoginSnapshot(flow);
    }
    this.logger.info({ loginId: flow.loginId, provider: flow.provider }, "Agent login flow started");
    driver.onStart(flow, this.host);
    return toAgentLoginSnapshot(flow);
  }

  async status(input: { login_id: string }): Promise<AgentLoginFlow> {
    return toAgentLoginSnapshot(this.requireFlow(input.login_id));
  }

  async submit_code(input: { login_id: string; code: string }): Promise<AgentLoginFlow> {
    const flow = this.requireFlow(input.login_id);
    const driver = this.drivers[flow.provider];
    if (!driver.submitCode) {
      throw new AgentLoginServiceError("code_not_expected", "This login does not take a pasted code");
    }
    if (flow.state !== "url_ready" || flow.terminating || !flow.child?.stdin?.writable) {
      throw new AgentLoginServiceError("login_not_ready", "Login flow is not ready to accept a code");
    }
    driver.submitCode(flow, this.host, input.code);
    return toAgentLoginSnapshot(flow);
  }

  async submitCode(input: { login_id: string; code: string }): Promise<AgentLoginFlow> {
    return this.submit_code(input);
  }

  async cancel(input: { login_id: string }): Promise<AgentLoginFlow> {
    const flow = this.requireFlow(input.login_id);
    if (!isTerminalState(flow.state)) await this.terminate(flow, "cancel", null);
    return toAgentLoginSnapshot(flow);
  }

  /** 워커가 끝날 때 진행 중인 흐름의 프로세스를 정리한다. */
  async shutdown(): Promise<void> {
    const pending = [...this.flows.values()]
      .filter((flow) => !isTerminalState(flow.state))
      .map((flow) => this.terminate(flow, "shutdown", null));
    await Promise.all(pending);
  }

  async close(): Promise<void> {
    await this.shutdown();
  }

  private createFlow(driver: ProviderDriver): InternalAgentLoginFlow {
    return {
      loginId: randomUUID(),
      provider: driver.provider,
      startedAtMs: this.now(),
      expectsCode: driver.expectsCode,
      state: "requested",
      authUrl: null,
      userCode: null,
      expiresAt: null,
      error: null,
      buffer: "",
      bufferLimit: MAX_STDOUT_SCAN_BUFFER_CHARS,
      child: null,
      exitPromise: null,
      timers: new Set(),
      terminating: false,
      childReleased: false,
      terminationPromise: null,
      selectionSent: false,
      settling: false,
    };
  }

  private attachChild(flow: InternalAgentLoginFlow, driver: ProviderDriver, child: ChildProcess): void {
    flow.child = child;
    flow.exitPromise = waitForChildExit(child);
    const failStream = () => {
      void this.terminate(flow, "failure", { code: "cli_exited", message: "Login CLI stream failed" });
    };
    child.on("error", failStream);
    child.stdin?.on("error", failStream);
    const stdoutDrained = new Promise<void>((resolve) => {
      child.stdout?.once("close", resolve);
      child.stdout?.once("end", resolve);
      if (!child.stdout) resolve();
    });
    // Codex는 오류 안내를 stderr로 찍을 수 있어 두 스트림을 같은 버퍼에서 읽는다.
    const onData = (chunk: string) => {
      if (flow.terminating || flow.childReleased || isTerminalState(flow.state)) return;
      flow.buffer = appendTail(flow.buffer, chunk, flow.bufferLimit);
      driver.onOutput(flow, this.host);
    };
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      stream.on("error", failStream);
      stream.on("data", onData);
    }
    void flow.exitPromise.then(async (exit: ChildExit) => {
      // 끝난 뒤에 도착하는 마지막 출력(기기 코드 꺼짐 안내 등)을 읽고 판정한다.
      await Promise.race([
        stdoutDrained,
        new Promise((resolve) => setTimeout(resolve, this.timings.streamDrainWaitMs)),
      ]);
      if (flow.terminating || flow.childReleased || isTerminalState(flow.state)) return;
      this.logger.info(
        { loginId: flow.loginId, provider: flow.provider, exitCode: exit.code, signal: exit.signal },
        "Agent login CLI exited",
      );
      await driver.onExit(flow, this.host, exit);
    });
  }

  private write(flow: InternalAgentLoginFlow, data: string): void {
    const stdin = flow.child?.stdin;
    const failWrite = () => {
      void this.terminate(flow, "failure", { code: "cli_exited", message: "Failed to write to the login CLI" });
    };
    if (!stdin || stdin.destroyed || !stdin.writable) {
      failWrite();
      return;
    }
    try {
      stdin.write(data, (error) => {
        if (error) failWrite();
      });
    } catch {
      failWrite();
    }
  }

  private schedule(flow: InternalAgentLoginFlow, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      flow.timers.delete(timer);
      if (flow.terminating || isTerminalState(flow.state)) return;
      fn();
    }, ms);
    flow.timers.add(timer);
  }

  private clearTimers(flow: InternalAgentLoginFlow): void {
    for (const timer of flow.timers) clearTimeout(timer);
    flow.timers.clear();
  }

  private setState(flow: InternalAgentLoginFlow, state: InternalAgentLoginFlow["state"]): void {
    if (flow.state === state) return;
    const from = flow.state;
    flow.state = state;
    if (!LIVE_CLI_STATES.has(state)) this.activity.mark(flow.provider, flow.loginId, false);
    this.logger.info(
      {
        loginId: flow.loginId,
        provider: flow.provider,
        from,
        to: state,
        errorCode: flow.error?.code ?? null,
        elapsedMs: this.now() - flow.startedAtMs,
      },
      "Agent login state changed",
    );
  }

  private markUrlReady(
    flow: InternalAgentLoginFlow,
    input: { authUrl: string; userCode: string | null; expiresAt: Date },
  ): void {
    flow.authUrl = input.authUrl;
    flow.userCode = input.userCode;
    flow.expiresAt = input.expiresAt.toISOString();
    this.setState(flow, "url_ready");
  }

  /** CLI를 끝내고 확인 단계로 간다. 같은 흐름에서 한 번만 돈다. */
  private async verify(flow: InternalAgentLoginFlow): Promise<void> {
    if (flow.terminating || flow.childReleased || isTerminalState(flow.state)) return;
    flow.childReleased = true;
    this.clearTimers(flow);
    if (flow.child && flow.exitPromise) {
      await terminateProcessTree(flow.child, flow.exitPromise, this.timings.killGracePeriodMs, this.timings.postKillWaitMs);
    }
    if (flow.terminating || isTerminalState(flow.state)) return;
    flow.buffer = "";
    this.setState(flow, "verifying");
    let verified = false;
    try {
      verified = await this.drivers[flow.provider].checkLoggedIn();
    } catch {
      verified = false;
    }
    if (flow.terminating || isTerminalState(flow.state)) return;
    this.finish(flow, verified ? "done" : "failed", verified ? null : {
      code: "verify_failed",
      message: "The login finished but the provider could not be used",
    });
  }

  private terminate(
    flow: InternalAgentLoginFlow,
    reason: TerminationReason,
    error: { code: string; message: string } | null,
  ): Promise<void> {
    if (isTerminalState(flow.state)) return Promise.resolve();
    if (flow.terminationPromise) return flow.terminationPromise;
    flow.terminating = true;
    this.clearTimers(flow);
    const finalState = reason === "failure" || reason === "superseded" ? "failed" : "cancelled";
    flow.terminationPromise = (async () => {
      try {
        if (flow.child && flow.exitPromise) {
          await terminateProcessTree(flow.child, flow.exitPromise, this.timings.killGracePeriodMs, this.timings.postKillWaitMs);
        }
      } finally {
        this.finish(flow, finalState, finalState === "failed" ? error : null);
      }
    })();
    return flow.terminationPromise;
  }

  private finish(
    flow: InternalAgentLoginFlow,
    state: "done" | "failed" | "cancelled",
    error: { code: string; message: string } | null,
  ): void {
    if (isTerminalState(flow.state)) return;
    this.clearTimers(flow);
    flow.error = error;
    // 끝난 흐름의 스냅샷은 보존 기간 동안 읽히므로 일회용 값을 거기에 남기지 않는다.
    flow.authUrl = null;
    flow.userCode = null;
    flow.buffer = "";
    this.setState(flow, state);
    if (this.activeFlowId === flow.loginId) this.activeFlowId = null;
    const retention = setTimeout(() => this.flows.delete(flow.loginId), this.timings.retentionMs);
    retention.unref();
  }

  private requireFlow(loginId: string): InternalAgentLoginFlow {
    const flow = typeof loginId === "string" ? this.flows.get(loginId) : undefined;
    if (!flow) throw new AgentLoginServiceError("login_not_found", "Login flow was not found");
    return flow;
  }
}
