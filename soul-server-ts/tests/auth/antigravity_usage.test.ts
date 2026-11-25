import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityUsageChildren, collectAntigravityUsage } from "../../src/auth/antigravity_usage.js";
import { ProviderUsageCommands } from "../../src/upstream/provider_usage_commands.js";
import { ProviderUsageService } from "../../src/auth/provider_usage.js";
import { resetProviderUsageObservationMemo } from "../../src/auth/provider_usage_observation.js";
import { isAlive, waitFor } from "../agent_login/fake_clis.js";

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
  it("blocks failures before first success and reports later failures as errors", async () => {
    const config = await fakeCli("process.exit(3)");
    const service = new ProviderUsageService({ antigravity: config });
    expect(await service.fetchProvider("antigravity")).toMatchObject({ status: "not_configured" });
    await writeFile(config.cliPath, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(fixture)})`);
    expect(await service.fetchProvider("antigravity")).toMatchObject({ status: "auto" });
    await writeFile(config.cliPath, `#!${process.execPath}\nprocess.exit(3)`);
    expect(await service.fetchProvider("antigravity")).toMatchObject({ status: "error" });
  });
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
  expect(Object.keys(snapshot.providers)).toEqual(['claude', 'codex', 'antigravity', 'opencode_go']);
  await expect(new ProviderUsageCommands({ providerUsage: service }).handle({ type: 'provider_usage_get', provider: 'gemini' })).rejects.toThrow('provider must be one of: claude, codex, antigravity, opencode_go');
});

describe("Antigravity usage on a node that is not logged in", () => {
  // 마지막 결과는 모듈 안에 기억되므로 앞 시험의 성공이 새어 들어오지 않게 비운다.
  beforeEach(() => resetProviderUsageObservationMemo());
  const authBanner = (text: string) => `process.stderr.write(${JSON.stringify(text)}); setInterval(() => {}, 1000);`;

  it.each([
    ["Error: Authentication required. Run 'agy' to log in, then retry.\n"],
    ["Waiting for authentication (timeout 60s)...\nOr, paste the authorization code here and press Enter:\n"],
  ])("ends right away on the sign-in prompt instead of waiting for the 45s abort (%s)", async (banner) => {
    const config = await fakeCli(authBanner(banner));
    const started = Date.now();
    const limits = await collectAntigravityUsage(config, new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(limits).toMatchObject({ status: "error", error: "Antigravity authentication required", quotas: [] });
    // 한 번도 성공하지 않았으면 지금처럼 not_configured로 바뀐다.
    const service = new ProviderUsageService({ antigravity: config });
    expect(await service.fetchProvider("antigravity")).toMatchObject({ status: "not_configured" });
  });

  it("does not start agy while a login flow is live and returns the last result instead", async () => {
    const config = await fakeCli(`require('node:fs').writeFileSync('started.flag', '1'); process.stdout.write(${JSON.stringify(fixture)});`);
    let live = false;
    const withLogin = { ...config, loginActivity: { isLive: () => live } };
    const service = new ProviderUsageService({ antigravity: withLogin });
    expect(await service.fetchProvider("antigravity")).toMatchObject({ status: "auto" });
    await rm(join(config.stateDirectory, "started.flag"));

    live = true;
    expect(await service.fetchProvider("antigravity")).toMatchObject({ status: "auto" });
    await expect(readFile(join(config.stateDirectory, "started.flag"), "utf8")).rejects.toThrow();
  });

  it("returns the same failure as before when no result exists yet", async () => {
    const config = await fakeCli("require('node:fs').writeFileSync('started.flag', '1');");
    const service = new ProviderUsageService({ antigravity: { ...config, loginActivity: { isLive: () => true } } });
    expect(await service.fetchProvider("antigravity")).toMatchObject({ status: "not_configured" });
    await expect(readFile(join(config.stateDirectory, "started.flag"), "utf8")).rejects.toThrow();
  });
});

describe("Antigravity usage child cleanup", () => {
  beforeEach(() => resetProviderUsageObservationMemo());
  // SIGTERM을 무시하는 agy가 SIGTERM을 무시하는 자손을 띄운다. 자손이 준비된 뒤에야 agy가 다음 동작(onReady)을 한다.
  const stubbornCli = (onReady: string) => `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('gc.pid', String(process.pid)); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
    fs.writeFileSync('agy.pid', String(process.pid));
    const ready = setInterval(() => { if (fs.existsSync('gc.pid') && fs.readFileSync('gc.pid', 'utf8')) { clearInterval(ready); ${onReady} } }, 20);
    setInterval(() => {}, 1000);
  `;
  const readPids = (directory: string) => {
    try {
      const agy = Number(readFileSync(join(directory, "agy.pid"), "utf8"));
      const grandchild = Number(readFileSync(join(directory, "gc.pid"), "utf8"));
      return agy > 0 && grandchild > 0 ? { agy, grandchild } : null;
    } catch { return null; }
  };
  const pidsReady = (directory: string) => waitFor(() => readPids(directory), (value) => value !== null, 5_000) as Promise<{ agy: number; grandchild: number }>;
  const expectGone = async (pids: { agy: number; grandchild: number }) => {
    await waitFor(() => [isAlive(pids.agy), isAlive(pids.grandchild)], (alive) => !alive[0] && !alive[1], 6_000);
  };

  it("reaps agy and its descendant after failEarly while returning the result right away", async () => {
    const config = await fakeCli(stubbornCli("process.stderr.write('Error: Authentication required.\\n');"));
    const started = Date.now();
    const limits = await collectAntigravityUsage(config, new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(limits).toMatchObject({ status: "error", error: "Antigravity authentication required" });
    await expectGone((await pidsReady(config.stateDirectory)));
  }, 15_000);

  it("reaps agy and its descendant after the abort deadline", async () => {
    const config = await fakeCli(stubbornCli("process.stdout.write('ready\\n');"));
    const controller = new AbortController();
    const pending = collectAntigravityUsage(config, controller.signal);
    const pids = await pidsReady(config.stateDirectory);
    controller.abort();
    expect(await pending).toMatchObject({ status: "error", error: "Antigravity usage aborted" });
    await expectGone(pids);
  }, 15_000);

  it("shutdown reaps in-flight lookups and resolves only after they are gone", async () => {
    const children = new AntigravityUsageChildren();
    const config = { ...(await fakeCli(stubbornCli("process.stdout.write('ready\\n');"))), children };
    const pending = collectAntigravityUsage(config, new AbortController().signal);
    const pids = await pidsReady(config.stateDirectory);
    await children.shutdown();
    await expectGone(pids);
    expect(await pending).toMatchObject({ status: "error" });
  }, 15_000);
});
