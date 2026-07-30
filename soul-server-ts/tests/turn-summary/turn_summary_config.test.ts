import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { TurnSummaryConfigService } from "../../src/turn-summary/turn_summary_config.js";

const tempDirs: string[] = [];
const silentLogger = pino({ level: "silent" });

function makeConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "turn-summary-config-test-"));
  tempDirs.push(dir);
  return join(dir, "turn-summary.yaml");
}

function validConfig(
  model = "gpt-5.6-terra",
  provider = "codex",
): string {
  return [
    `provider: ${provider}`,
    `model: ${model}`,
    "reasoning_effort: high",
    "timeout_ms: 30000",
    "max_attempts: 2",
    "codepoint_limit: 6000",
    "history_limit: 5",
    "excluded_folder_ids:",
    "  - 055be5a6-1285-48aa-a8a1-59e40fbe59af",
    "  - 9e7baafe-387f-4404-8349-ec994597f4cf",
    "",
  ].join("\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("TurnSummaryConfigService", () => {
  it("re-reads provider and Codex model for every job without a restart", () => {
    const path = makeConfigPath();
    writeFileSync(path, validConfig(), "utf8");
    const service = new TurnSummaryConfigService(path, silentLogger);

    expect(service.read()).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-terra",
    });

    writeFileSync(path, validConfig("gpt-5.4-mini", "openai-api"), "utf8");
    expect(service.read()).toMatchObject({
      provider: "openai-api",
      model: "gpt-5.4-mini",
    });
  });

  it("keeps the last successful config when a hot update is malformed", () => {
    const path = makeConfigPath();
    writeFileSync(path, validConfig(), "utf8");
    const service = new TurnSummaryConfigService(path, silentLogger);
    const first = service.read();

    writeFileSync(path, "timeout_ms: not-a-number\n", "utf8");

    expect(service.read()).toEqual(first);
  });

  it("rejects an invalid first config instead of inventing defaults", () => {
    const path = makeConfigPath();
    writeFileSync(path, "provider: codex\nmodel: gpt-5.6-terra\n", "utf8");
    const service = new TurnSummaryConfigService(path, silentLogger);

    expect(() => service.read()).toThrow();
  });
});
