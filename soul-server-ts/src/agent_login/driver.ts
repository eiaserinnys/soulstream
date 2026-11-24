import type { Logger } from "pino";

import type { ChildExit } from "../claude_accounts/login_cli_helpers.js";
import type {
  AgentLoginProvider,
  AgentLoginTimings,
  InternalAgentLoginFlow,
} from "./types.js";

export interface LaunchPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** 공급자별 동작이 서비스의 공통 부분(상태, 타이머, 종료)을 부르는 길. */
export interface FlowHost {
  readonly timings: AgentLoginTimings;
  readonly logger: Logger;
  now(): number;
  /** 흐름이 끝나거나 확인 단계로 넘어가면 지워지는 타이머. */
  schedule(flow: InternalAgentLoginFlow, ms: number, fn: () => void): void;
  setState(flow: InternalAgentLoginFlow, state: InternalAgentLoginFlow["state"]): void;
  markUrlReady(
    flow: InternalAgentLoginFlow,
    input: { authUrl: string; userCode: string | null; expiresAt: Date },
  ): void;
  /** CLI를 끝내고 failed로 둔다. 원출력을 오류 메시지에 싣지 않으므로 message는 고정 문구만 받는다. */
  fail(flow: InternalAgentLoginFlow, code: string, message: string): Promise<void>;
  /** CLI를 끝낸 뒤 확인(verifying)으로 간다. */
  verify(flow: InternalAgentLoginFlow): Promise<void>;
  write(flow: InternalAgentLoginFlow, data: string): void;
}

export interface ProviderDriver {
  readonly provider: AgentLoginProvider;
  readonly expectsCode: boolean;
  /** CLI가 없으면 cli_not_installed로 거절한다. */
  plan(): LaunchPlan;
  onStart(flow: InternalAgentLoginFlow, host: FlowHost): void;
  onOutput(flow: InternalAgentLoginFlow, host: FlowHost): void;
  onExit(flow: InternalAgentLoginFlow, host: FlowHost, exit: ChildExit): Promise<void>;
  /** 로그인이 끝난 뒤 그 공급자가 실제로 쓸 수 있는지 한 번 확인한다. */
  checkLoggedIn(): Promise<boolean>;
  /** antigravity만. url_ready에서만 서비스가 부른다. */
  submitCode?(flow: InternalAgentLoginFlow, host: FlowHost, code: string): void;
}
