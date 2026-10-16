import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectAntigravityUsage } from "../../src/auth/antigravity_usage.js";
import { ProviderUsageCommands } from "../../src/upstream/provider_usage_commands.js";
import { ProviderUsageService } from "../../src/auth/provider_usage.js";

const fixture = await readFile(new URL("./fixtures/antigravity_usage.jsonl", import.meta.url), "utf8");
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fakeCli(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "agy-usage-"));
  directories.push(directory);
  const cliPath = join(directory, "agy");
  await writeFile(cliPath, `#!${process.execPath}\n${body}`);
  await chmod(cliPath, 0o700);
  return { cliPath, stateDirectory: directory, environment: process.env };
}

describe("Antigravity account usage", () => {
  it("collects only command_result Gemini weekly and 5h quotas with no model or conversation", async () => {
    const config = await fakeCli(`const fs = require('node:fs'); fs.writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.stdout.write(${JSON.stringify(fixture)});`);
    const limits = await collectAntigravityUsage(config, new AbortController().signal);
    expect(limits).toMatchObject({ status: "auto", source: "agy:/usage", sourceKind: "remote", weeklyTokens: null, monthlyTokens: null, sessionTokens: null, planType: null, shortWindowMinutes: 300 });
    expect(limits.weeklyUsedPercent).toBeCloseTo(100 * (1 - 0.9991282224655151));
    expect(limits.shortUsedPercent).toBeCloseTo(100 * (1 - 0.9920746684074402));
    expect(limits.quotas).toHaveLength(2);
    expect(limits.quotas).toEqual([
      expect.objectContaining({ id: "antigravity:gemini:5h", label: "5시간", window: "5h", resetAt: Date.parse("2026-10-13T21:54:02Z") / 1000 }),
      expect.objectContaining({ id: "antigravity:gemini:weekly", label: "7일", window: "7d", model: null, unit: null, used: null, remaining: null, limit: null, purpose: "execution", resetAt: Date.parse("2026-10-20T16:54:02Z") / 1000 }),
    ]);
    const invocation = JSON.parse(await readFile(join(config.stateDirectory, "invocation.json"), "utf8"));
    expect(invocation).toEqual({ args: ["--output-format", "stream-json", "--log-file", join(config.stateDirectory, "antigravity-usage.log"), "--print=/usage"], cwd: config.stateDirectory });
    expect(limits.observedAt).toEqual(expect.any(String));
  });

  it("does not spawn an unconfigured CLI and dispatches that state through the service", async () => {
    const limits = await collectAntigravityUsage(undefined, new AbortController().signal);
    expect(limits).toMatchObject({ status: "not_configured", quotas: [], weeklyUsedPercent: null });
    expect(await new ProviderUsageService().fetchProvider("antigravity")).toEqual(limits);
  });

  it.each([
    ["process.exit(3)", "Antigravity usage CLI exited with code 3"],
    [`process.stdout.write(${JSON.stringify(fixture.split("\n").slice(1).join("\n"))})`, "Invalid Antigravity /usage response"],
    [`process.stdout.write('invalid json')`, "Invalid Antigravity /usage response"],
  ])("reports CLI failure and malformed command data as error (%s)", async (body, error) => {
    const config = await fakeCli(body);
    expect(await collectAntigravityUsage(config, new AbortController().signal)).toMatchObject({ status: "error", error, quotas: [] });
  });

  it("ends the child on the service's existing abort signal", async () => {
    const config = await fakeCli("process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const pending = collectAntigravityUsage(config, controller.signal);
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ status: "error", quotas: [] });
  });

  it("dispatches the collector through provider_usage_get", async () => {
    const config = await fakeCli(`process.stdout.write(${JSON.stringify(fixture)})`);
    const response = await new ProviderUsageCommands({ providerUsage: new ProviderUsageService({ antigravity: config }) }).handle({ type: "provider_usage_get", requestId: "req", provider: "antigravity" });
    expect(response).toMatchObject({ success: true, data: { status: "auto", quotas: [expect.objectContaining({ window: "5h" }), expect.objectContaining({ window: "7d" })] } });
  });
});

it('retires standalone Gemini commands and excludes it from full snapshots', async () => {
  const service = new ProviderUsageService({ homeDir: '/nonexistent-354-fixture-home' });
  const snapshot = await service.fetchSnapshot();
  expect(Object.keys(snapshot.providers)).toEqual(['claude', 'codex', 'antigravity']);
  await expect(new ProviderUsageCommands({ providerUsage: service }).handle({ type: 'provider_usage_get', provider: 'gemini' })).rejects.toThrow('provider must be one of: claude, codex, antigravity');
});
