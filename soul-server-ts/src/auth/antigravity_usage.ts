import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderLimits, ProviderQuota } from "./provider_usage.js";

export interface AntigravityUsageConfig {
  cliPath?: string;
  environment: NodeJS.ProcessEnv;
  stateDirectory: string;
}

/** Account lookup only: no model, conversation, agent definition or prompt. */
export async function collectAntigravityUsage(
  config: AntigravityUsageConfig | undefined,
  signal: AbortSignal,
): Promise<ProviderLimits> {
  if (!config?.cliPath) return blankLimits("not_configured");
  try {
    const logPath = join(config.stateDirectory, "antigravity-usage.log");
    await mkdir(config.stateDirectory, { recursive: true });
    await writeFile(logPath, "", { mode: 0o600 });
    if (signal.aborted) throw new Error("Antigravity usage aborted");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(config.cliPath!, [
        "--output-format", "stream-json", "--log-file", logPath, "--print=/usage",
      ], { cwd: config.stateDirectory, env: config.environment, stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      const abort = () => { child.kill("SIGTERM"); };
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.on("error", () => reject(new Error("Antigravity usage CLI could not start")));
      child.on("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(new Error("Antigravity usage aborted"));
        else if (code !== 0) reject(new Error(`Antigravity usage CLI exited with code ${code}`));
        else resolve(stdout);
      });
    });
    return limitsFromOutput(output);
  } catch (error) {
    return blankLimits("error", error instanceof Error ? error.message : "Antigravity usage failed");
  }
}

function limitsFromOutput(output: string): ProviderLimits {
  try {
    const events = output.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const command = events.find((event) => event.event === "command_result" && event.command?.name === "usage")?.command;
    const group = command?.data?.groups?.find((entry: { name: string }) => entry.name === "Gemini Models");
    const quotas: ProviderQuota[] = ["weekly", "5h"].map((window) => {
      const bucket = group?.buckets?.find((entry: { window: string }) => entry.window === window);
      const fraction = bucket?.remaining_fraction;
      const resetAt = Date.parse(bucket?.reset_time) / 1000;
      if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1 || !Number.isFinite(resetAt)) {
        throw new Error("Invalid bucket");
      }
      return {
        id: `antigravity:gemini:${window}`, label: "Gemini Models", window: window === "weekly" ? "7d" : "5h",
        unit: null, used: null, remaining: null, limit: null, model: null,
        remainingPercent: 100 * fraction, usedPercent: 100 * (1 - fraction), resetAt,
        source: "agy:/usage", purpose: "execution",
      };
    });
    return {
      ...blankLimits("auto"), source: "agy:/usage", sourceKind: "remote", observedAt: new Date().toISOString(),
      weeklyUsedPercent: quotas[0]!.usedPercent, weeklyResetAt: quotas[0]!.resetAt,
      shortUsedPercent: quotas[1]!.usedPercent, shortResetAt: quotas[1]!.resetAt, shortWindowMinutes: 300, quotas,
    };
  } catch {
    throw new Error("Invalid Antigravity /usage response");
  }
}

function blankLimits(status: ProviderLimits["status"], error?: string): ProviderLimits {
  return {
    status, source: "", sourceKind: "unknown", observedAt: null,
    weeklyTokens: null, monthlyTokens: null, sessionTokens: null,
    weeklyUsedPercent: null, weeklyResetAt: null, shortUsedPercent: null,
    shortWindowMinutes: null, shortResetAt: null, planType: null, quotas: [],
    ...(error ? { error } : {}),
  };
}
