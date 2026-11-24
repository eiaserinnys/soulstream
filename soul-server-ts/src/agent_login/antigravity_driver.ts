import { executableCandidatesInPath, findSpawnableExecutable } from "@soulstream/executable-path";

import type { ChildExit } from "../claude_accounts/login_cli_helpers.js";
import type { FlowHost, LaunchPlan, ProviderDriver } from "./driver.js";
import {
  AGY_PASTE_MARKER,
  AGY_SELECT_MARKER,
  compactText,
  extractGoogleAuthUrl,
  indicatesAgyInvalidCode,
  indicatesAgySuccess,
} from "./output_scan.js";
import { shellQuote } from "./process_control.js";
import { AgentLoginServiceError, type InternalAgentLoginFlow } from "./types.js";

const MAX_CODE_LENGTH = 200;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
/** 제출 뒤에는 성공과 틀린 코드 문구만 보면 되므로 화면의 뒤쪽 조금만 둔다. */
const SUBMITTED_BUFFER_LIMIT = 1_024;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export interface AntigravityDriverConfig {
  resolveCliPath: () => string | undefined;
  /** script 실행 파일. 기본은 PATH에서 찾는다. */
  resolveScriptPath?: () => string | undefined;
  buildEnv: () => NodeJS.ProcessEnv;
  verifyUsage: () => Promise<boolean>;
  platform?: NodeJS.Platform;
}

export function findScriptExecutable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  return findSpawnableExecutable(executableCandidatesInPath("script", env, platform, "PATH"), platform)?.path;
}

export function validateAntigravityCode(raw: unknown): string {
  const code = typeof raw === "string" ? raw.trim() : "";
  if (code.length === 0 || code.length > MAX_CODE_LENGTH || CONTROL_CHAR_PATTERN.test(code)) {
    throw new AgentLoginServiceError(
      "invalid_request",
      `Authorization code must be 1 to ${MAX_CODE_LENGTH} characters without control characters`,
    );
  }
  return code;
}

export function createAntigravityDriver(config: AntigravityDriverConfig): ProviderDriver {
  const platform = config.platform ?? process.platform;

  /** 제출 뒤 30초 감시와 성공 문구가 같은 마무리를 한 번만 하게 한다. */
  const settleThenVerify = (flow: InternalAgentLoginFlow, host: FlowHost): void => {
    if (flow.settling) return;
    flow.settling = true;
    host.schedule(flow, host.timings.agySuccessSettleMs, () => void host.verify(flow));
  };

  return {
    provider: "antigravity",
    expectsCode: true,

    plan(): LaunchPlan {
      const cli = config.resolveCliPath();
      const script = platform === "linux"
        ? (config.resolveScriptPath ?? (() => findScriptExecutable(process.env, platform)))()
        : undefined;
      if (!cli) throw new AgentLoginServiceError("cli_not_installed", "Antigravity CLI is not installed on this node");
      if (!script) {
        throw new AgentLoginServiceError(
          "cli_not_installed",
          "The script utility needed to drive the Antigravity login screen is not available on this node",
        );
      }
      return {
        command: script,
        args: ["-qfec", `stty cols 250 rows 50; exec ${shellQuote(cli)}`, "/dev/null"],
        env: config.buildEnv(),
      };
    },

    onStart(flow, host) {
      host.schedule(flow, host.timings.agyOutputWaitMs, () => {
        if (flow.state === "requested") {
          void host.fail(flow, "cli_exited", "Antigravity CLI did not show the sign-in screen in time");
        }
      });
      host.schedule(flow, host.timings.agyLoginTimeoutMs, () => {
        if (flow.state === "requested" || flow.state === "url_ready") {
          void host.fail(flow, "timeout", "Antigravity login code was not submitted in time");
        }
      });
    },

    onOutput(flow, host) {
      const compact = compactText(flow.buffer);
      if (flow.state === "requested") {
        if (!flow.selectionSent && compact.includes(AGY_SELECT_MARKER)) {
          flow.selectionSent = true;
          host.write(flow, "\r");
        }
        if (!flow.selectionSent && indicatesAgySuccess(compact)) {
          void host.verify(flow);
          return;
        }
        const authUrl = extractGoogleAuthUrl(flow.buffer);
        if (authUrl && compact.includes(AGY_PASTE_MARKER)) {
          const expiresAt = new Date(flow.startedAtMs + host.timings.agyLoginTimeoutMs);
          host.markUrlReady(flow, { authUrl, userCode: null, expiresAt });
        }
        return;
      }
      if (flow.state !== "code_submitted") return;
      if (indicatesAgyInvalidCode(compact)) {
        void host.fail(flow, "invalid_code", "Antigravity rejected the authorization code; start a new login");
        return;
      }
      if (indicatesAgySuccess(compact)) settleThenVerify(flow, host);
    },

    async onExit(flow: InternalAgentLoginFlow, host: FlowHost, _exit: ChildExit) {
      if (flow.state === "code_submitted") {
        await host.verify(flow);
        return;
      }
      await host.fail(flow, "cli_exited", "Antigravity CLI exited before the login finished");
    },

    submitCode(flow, host, rawCode) {
      const code = validateAntigravityCode(rawCode);
      // 코드는 stdin 한 번에만 쓰고 어디에도 남기지 않는다. 화면 버퍼도 비워 에코가 남지 않게 한다.
      flow.buffer = "";
      flow.bufferLimit = SUBMITTED_BUFFER_LIMIT;
      host.setState(flow, "code_submitted");
      host.write(flow, `${PASTE_START}${code}${PASTE_END}\r`);
      host.schedule(flow, host.timings.agySubmitWatchMs, () => settleThenVerify(flow, host));
    },

    checkLoggedIn: () => config.verifyUsage(),
  };
}
