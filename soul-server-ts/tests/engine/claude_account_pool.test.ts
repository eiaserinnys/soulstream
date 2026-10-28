import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildClaudeAccountPoolEnvironment,
  assertClaudeAccountPoolOverrides,
  useLocalClaudeAccountPoolResume,
  type ClaudeAccountPoolTurn,
} from "../../src/engine/claude_account_pool.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Claude account pool environment", () => {
  it("uses the selected profile and removes inherited credentials", () => {
    const env = buildClaudeAccountPoolEnvironment({
      ANTHROPIC_API_KEY: "inherited-key",
      CLAUDE_CODE_OAUTH_TOKEN: "inherited-oauth",
      ANTHROPIC_AUTH_TOKEN: "inherited-auth",
      CLAUDE_AUTH_TOKEN_PATH: "/tmp/legacy-token",
      PATH: "/usr/bin",
    }, { account_id: "account-a", config_dir: "/accounts/a", available_count: 1 });

    expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/accounts/a" });
  });

  it("rejects explicit authentication and base URL overrides for an official model", () => {
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_AUTH_TOKEN_PATH",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      expect(() => assertClaudeAccountPoolOverrides({ [key]: "override" })).toThrow(
        `Claude account pool does not allow ${key}`,
      );
    }
  });

  it("accepts a resolved account selection as the turn binding", () => {
    const binding: ClaudeAccountPoolTurn = {
      account_id: "account-a",
      config_dir: "/accounts/a",
      available_count: 1,
    };
    expect(buildClaudeAccountPoolEnvironment({}, binding).CLAUDE_CONFIG_DIR)
      .toBe("/accounts/a");
  });

  it("keeps transcript writes and session keys while making pool resume use shared local projects", async () => {
    const key = { projectKey: "project", sessionId: "session", subpath: "agent" };
    const mainKey = { projectKey: key.projectKey, sessionId: key.sessionId };
    const configDir = mkdtempSync(join(tmpdir(), "claude-pool-store-"));
    roots.push(configDir);
    mkdirSync(join(configDir, "projects"));
    const entries = [{ type: "assistant", uuid: "entry-1" }] as never;
    const store = {
      append: vi.fn(async () => undefined),
      load: vi.fn(async () => entries),
      listSessions: vi.fn(async () => []),
      listSubkeys: vi.fn(async () => ["agent"]),
      delete: vi.fn(async () => undefined),
    };
    const poolStore = useLocalClaudeAccountPoolResume(store as never, configDir);

    await expect(poolStore.load(mainKey)).resolves.toBeNull();
    await poolStore.append(key as never, entries);
    await expect(poolStore.listSessions?.("project")).resolves.toEqual([]);
    await expect(poolStore.listSubkeys?.(key)).resolves.toEqual(["agent"]);
    await poolStore.delete?.(key as never);

    expect(store.load).toHaveBeenCalledWith(mainKey);
    expect(store.load).toHaveBeenCalledWith(key);
    expect(store.append).toHaveBeenCalledWith(key, entries);
    expect(store.listSessions).toHaveBeenCalledWith("project");
    expect(store.listSubkeys).toHaveBeenCalledWith(key);
    expect(store.delete).toHaveBeenCalledWith(key);
  });
});
