import { readFile } from "node:fs/promises";

import type { ChildExit } from "../claude_accounts/login_cli_helpers.js";
import type { FlowHost, LaunchPlan, ProviderDriver } from "./driver.js";
import { indicatesDeviceCodeDisabled, parseCodexDeviceOutput } from "./output_scan.js";
import { AgentLoginServiceError, type InternalAgentLoginFlow } from "./types.js";

export interface CodexDriverConfig {
  resolveCliPath: () => string | undefined;
  buildEnv: () => NodeJS.ProcessEnv;
  authFilePath: () => string;
  verifyUsage: () => Promise<boolean>;
}

export function createCodexDriver(config: CodexDriverConfig): ProviderDriver {
  return {
    provider: "codex",
    expectsCode: false,

    plan(): LaunchPlan {
      const cli = config.resolveCliPath();
      if (!cli) throw new AgentLoginServiceError("cli_not_installed", "Codex CLI is not installed on this node");
      return { command: cli, args: ["login", "--device-auth"], env: config.buildEnv() };
    },

    onStart(flow, host) {
      host.schedule(flow, host.timings.codexOutputWaitMs, () => {
        if (flow.state === "requested") {
          void host.fail(flow, "cli_exited", "Codex CLI did not show a device code in time");
        }
      });
    },

    onOutput(flow, host) {
      if (flow.state !== "requested") return;
      const info = parseCodexDeviceOutput(flow.buffer);
      if (!info) return;
      const expiryMs = info.expiresInMinutes === null
        ? host.timings.codexDefaultExpiryMs
        : info.expiresInMinutes * 60_000;
      const expiresAt = new Date(host.now() + expiryMs);
      host.markUrlReady(flow, { authUrl: info.authUrl, userCode: info.userCode, expiresAt });
      host.schedule(flow, expiryMs + host.timings.codexExpiryGraceMs, () => {
        void host.fail(flow, "timeout", "Codex login was not approved in time");
      });
    },

    async onExit(flow: InternalAgentLoginFlow, host: FlowHost, exit: ChildExit) {
      if (exit.code === 0 && exit.signal === null) {
        await host.verify(flow);
        return;
      }
      if (indicatesDeviceCodeDisabled(flow.buffer)) {
        await host.fail(flow, "device_code_disabled", "Device code sign-in is disabled for this ChatGPT account");
        return;
      }
      await host.fail(flow, "cli_exited", "Codex CLI exited without completing authentication");
    },

    async checkLoggedIn() {
      try {
        const parsed: unknown = JSON.parse(await readFile(config.authFilePath(), "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      } catch {
        return false;
      }
      return config.verifyUsage();
    },
  };
}
