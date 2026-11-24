import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLoginActivity } from "../agent_login/activity.js";
import { emptyLimits, type ProviderLimits, type ProviderQuota } from "./provider_limits.js";
import { readProviderUsageObservation } from "./provider_usage_observation.js";

export interface AntigravityUsageConfig {
  cliPath?: string;
  environment: NodeJS.ProcessEnv;
  stateDirectory: string;
  /** agy 로그인 흐름이 진행 중이면 사용량 확인이 agy를 띄우지 않는다. */
  loginActivity?: Pick<AgentLoginActivity, "isLive">;
}

// 파이프 입력이면 "authentication required"를, stdin이 /dev/null이면(지금 띄우는 방식) "Waiting for authentication"과
// 붙여 넣기 안내를 찍는다(관찰 보고 U14b). 셋 다 로그인이 안 된 상태이므로 곧바로 끝낸다.
const AUTH_REQUIRED_PATTERN = /authentication required|waiting for authentication|paste the authorization code/i;

/** Account lookup only: no model, conversation, agent definition or prompt. */
export async function collectAntigravityUsage(
  config: AntigravityUsageConfig | undefined,
  signal: AbortSignal,
): Promise<ProviderLimits> {
  if (!config?.cliPath) return emptyLimits("not_configured");
  if (config.loginActivity?.isLive("antigravity")) {
    // 로그인 화면이 떠 있는 동안 또 띄우면 인증 흐름이 겹친다. 마지막 결과를 돌려주고, 없으면 지금 실패와 같은 결과를 낸다.
    return readProviderUsageObservation("antigravity")?.result
      ?? emptyLimits("error", "Antigravity login is in progress");
  }
  try {
    const logPath = join(config.stateDirectory, "antigravity-usage.log");
    await mkdir(config.stateDirectory, { recursive: true });
    await writeFile(logPath, "", { mode: 0o600 });
    if (signal.aborted) throw new Error("Antigravity usage aborted");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(config.cliPath!, [
        "--output-format", "stream-json", "--log-file", logPath, "--print=/usage",
      ], { cwd: config.stateDirectory, env: config.environment, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let settled = false;
      const abort = () => { child.kill("SIGTERM"); };
      signal.addEventListener("abort", abort, { once: true });
      // 로그인 안 된 서버에서는 agy가 인증 안내를 찍고 기다린다. 안내가 보이면 45초를 기다리지 않고 끝낸다.
      const failEarly = (error: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        child.kill("SIGTERM");
        reject(error);
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => {
        if (AUTH_REQUIRED_PATTERN.test(chunk.toString("utf8"))) failEarly(new Error("Antigravity authentication required"));
      });
      child.on("error", () => failEarly(new Error("Antigravity usage CLI could not start")));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(new Error("Antigravity usage aborted"));
        else if (code !== 0) reject(new Error(`Antigravity usage CLI exited with code ${code}`));
        else resolve(stdout);
      });
    });
    return limitsFromOutput(output);
  } catch (error) {
    return emptyLimits("error", error instanceof Error ? error.message : "Antigravity usage failed");
  }
}

function limitsFromOutput(output: string): ProviderLimits {
  try {
    const events = output.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const command = events.find((event) => event.event === "command_result" && event.command?.name === "usage")?.command;
    const group = command?.data?.groups?.find((entry: { name: string }) => entry.name === "Gemini Models");
    const quotas: ProviderQuota[] = ["5h", "weekly"].map((window) => {
      const bucket = group?.buckets?.find((entry: { window: string }) => entry.window === window);
      const fraction = bucket?.remaining_fraction;
      const resetAt = Date.parse(bucket?.reset_time) / 1000;
      if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1 || !Number.isFinite(resetAt)) {
        throw new Error("Invalid bucket");
      }
      return {
        id: `antigravity:gemini:${window}`, label: window === "weekly" ? "7일" : "5시간", window: window === "weekly" ? "7d" : "5h",
        unit: null, used: null, remaining: null, limit: null, model: null,
        remainingPercent: 100 * fraction, usedPercent: 100 * (1 - fraction), resetAt,
        source: "agy:/usage", purpose: "execution",
      };
    });
    const weekly = quotas.find(quota => quota.window === "7d")!;
    const short = quotas.find(quota => quota.window === "5h")!;
    return {
      ...emptyLimits("auto"), source: "agy:/usage", sourceKind: "remote", observedAt: new Date().toISOString(),
      weeklyUsedPercent: weekly.usedPercent, weeklyResetAt: weekly.resetAt,
      shortUsedPercent: short.usedPercent, shortResetAt: short.resetAt, shortWindowMinutes: 300, quotas,
    };
  } catch {
    throw new Error("Invalid Antigravity /usage response");
  }
}
