import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCliCredentialRenewer } from "../../src/claude_accounts/credential_renewal.js";

describe("ClaudeCliCredentialRenewer", () => {
  let root: string;
  let executable: string;
  const warn = vi.fn();
  const logger = { warn } as unknown as Logger;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "credential-renewal-test-"));
    executable = path.join(root, "fake-claude.cjs");
    warn.mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  function fakeCli(body: string): void {
    fs.writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  }

  it("runs auth status with the profile and sanitized environment", async () => {
    fakeCli(`
      const ok = process.argv.slice(2).join(' ') === 'auth status --json'
        && process.env.CLAUDE_CONFIG_DIR === process.env.EXPECTED_DIR
        && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN
        && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_BASE_URL;
      console.log(JSON.stringify({ loggedIn: ok }));
    `);
    const renewer = new ClaudeCliCredentialRenewer({ logger, executablePath: executable,
      baseEnv: { PATH: process.env.PATH, EXPECTED_DIR: root, ANTHROPIC_API_KEY: "fake-key",
        ANTHROPIC_AUTH_TOKEN: "fake-token", CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth", ANTHROPIC_BASE_URL: "fake-url" } });
    await renewer.renew({ accountId: "account-a", profileDir: root });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["logged out", "console.log(JSON.stringify({ loggedIn: false, secret: 'do-not-log' }));"],
    ["nonzero exit", "console.log('do-not-log'); process.exit(1);"],
  ])("logs only the account ID on %s", async (_case, body) => {
    fakeCli(body);
    await new ClaudeCliCredentialRenewer({ logger, executablePath: executable }).renew({ accountId: "account-a", profileDir: root });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]).toEqual([{ accountId: "account-a" }, "Claude account credential renewal failed"]);
  });

  it("terminates a CLI that exceeds the time limit and logs only the account ID", async () => {
    fakeCli("setInterval(() => {}, 1000);");
    const actualSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: never[]) => void, delay?: number, ...args: never[]) =>
      actualSetTimeout(callback, delay === 20_000 ? 150 : delay, ...args)) as typeof setTimeout);
    await new ClaudeCliCredentialRenewer({ logger, executablePath: executable }).renew({ accountId: "account-a", profileDir: root });
    expect(warn.mock.calls[0]).toEqual([{ accountId: "account-a" }, "Claude account credential renewal failed"]);
  });

  it("shares one CLI run for concurrent renewals of the same account", async () => {
    const counterPath = path.join(root, "runs.txt");
    fakeCli([
      'const { appendFileSync } = require("node:fs");',
      "appendFileSync(process.env.RENEW_COUNTER_FILE, \"run\\n\");",
      "setTimeout(() => console.log(JSON.stringify({ loggedIn: true })), 200);",
    ].join("\n"));
    const renewal = new ClaudeCliCredentialRenewer({
      logger,
      executablePath: executable,
      baseEnv: { PATH: process.env.PATH, RENEW_COUNTER_FILE: counterPath },
    });

    await Promise.all([
      renewal.renew({ accountId: "account-a", profileDir: root }),
      renewal.renew({ accountId: "account-a", profileDir: root }),
    ]);
    await renewal.renew({ accountId: "account-b", profileDir: root });

    const runs = fs.readFileSync(counterPath, "utf8").trim().split("\n").filter(Boolean);
    expect(runs).toHaveLength(2);
  });
});
