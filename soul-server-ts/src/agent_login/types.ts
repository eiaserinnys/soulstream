import type { ChildProcess } from "node:child_process";

import type { AgentLoginError, AgentLoginFlow } from "@soulstream/wire-schema";

import type { ChildExit } from "../claude_accounts/login_cli_helpers.js";

export type AgentLoginProvider = AgentLoginFlow["provider"];
export type AgentLoginState = AgentLoginFlow["state"];
export type AgentLoginErrorCode =
  | "agent_login_unsupported"
  | "cli_not_installed"
  | "login_not_found"
  | "login_not_ready"
  | "code_not_expected"
  | "invalid_request";

export const AGENT_LOGIN_PROVIDERS: readonly AgentLoginProvider[] = ["codex", "antigravity"];

/** 서비스가 호출자에게 거절 사유를 알릴 때 던진다. 흐름 안의 실패는 스냅샷 error로 간다. */
export class AgentLoginServiceError extends Error {
  readonly code: AgentLoginErrorCode;

  constructor(code: AgentLoginErrorCode, message: string) {
    super(message);
    this.name = "AgentLoginServiceError";
    this.code = code;
  }

  toWire(): AgentLoginError {
    return { code: this.code, message: this.message };
  }
}

export interface AgentLoginTimings {
  /** 주소와 코드를 못 읽고 기다리는 상한(Codex). */
  codexOutputWaitMs: number;
  /** 주소와 붙여 넣기 안내를 못 읽고 기다리는 상한(Antigravity). */
  agyOutputWaitMs: number;
  /** 「expires in N minutes」가 없을 때 쓰는 유효 시간. */
  codexDefaultExpiryMs: number;
  /** expires_at 뒤에도 Codex가 끝나지 않을 때 더 기다리는 유예. */
  codexExpiryGraceMs: number;
  /** Antigravity의 expires_at까지 걸리는 시간(시작 기준). */
  agyLoginTimeoutMs: number;
  /** 코드 제출 뒤 화면을 보는 시간. */
  agySubmitWatchMs: number;
  /** 성공 문구가 보인 뒤 CLI가 자격을 쓰도록 기다리는 시간. */
  agySuccessSettleMs: number;
  killGracePeriodMs: number;
  postKillWaitMs: number;
  /** 끝난 흐름의 스냅샷을 읽을 수 있는 시간. */
  retentionMs: number;
  /** 프로세스가 끝난 뒤 출력 스트림이 비기를 기다리는 상한. */
  streamDrainWaitMs: number;
}

export const DEFAULT_AGENT_LOGIN_TIMINGS: AgentLoginTimings = {
  codexOutputWaitMs: 15_000,
  agyOutputWaitMs: 20_000,
  codexDefaultExpiryMs: 15 * 60_000,
  codexExpiryGraceMs: 30_000,
  agyLoginTimeoutMs: 15 * 60_000,
  agySubmitWatchMs: 30_000,
  agySuccessSettleMs: 2_000,
  killGracePeriodMs: 5_000,
  postKillWaitMs: 5_000,
  retentionMs: 10 * 60_000,
  streamDrainWaitMs: 250,
};

export type TerminationReason = "cancel" | "shutdown" | "failure" | "superseded";

export interface InternalAgentLoginFlow {
  readonly loginId: string;
  readonly provider: AgentLoginProvider;
  readonly startedAtMs: number;
  readonly expectsCode: boolean;
  state: AgentLoginState;
  authUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
  error: AgentLoginError | null;
  /** CLI 원출력의 뒤쪽만 둔다. 끝나면 비운다. 로그에 싣지 않는다. */
  buffer: string;
  bufferLimit: number;
  child: ChildProcess | null;
  exitPromise: Promise<ChildExit> | null;
  timers: Set<NodeJS.Timeout>;
  /** 취소, 실패, 대체로 끝내는 중이거나 확인 단계로 넘어가 CLI 출력을 더 보지 않는다. */
  terminating: boolean;
  /** 확인 단계로 넘어가며 CLI를 일부러 끝냈다. 이 종료는 실패로 보지 않는다. */
  childReleased: boolean;
  terminationPromise: Promise<void> | null;
  /** agy: 선택 화면에 `\r`을 보냈다. */
  selectionSent: boolean;
  /** agy: 성공 문구를 봤고 마무리 대기를 시작했다. */
  settling: boolean;
}

export function isTerminalState(state: AgentLoginState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

export function toAgentLoginSnapshot(flow: InternalAgentLoginFlow): AgentLoginFlow {
  return {
    login_id: flow.loginId,
    provider: flow.provider,
    state: flow.state,
    auth_url: flow.authUrl,
    user_code: flow.userCode,
    expects_code: flow.expectsCode,
    expires_at: flow.expiresAt,
    error: flow.error ? { ...flow.error } : null,
  };
}
