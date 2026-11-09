import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

  it("hands a restricted turn only the selected account's access token", () => {
    const env = buildClaudeAccountPoolEnvironment({
      ANTHROPIC_API_KEY: "inherited-key",
      CLAUDE_CODE_OAUTH_TOKEN: "inherited-oauth",
      ANTHROPIC_AUTH_TOKEN: "inherited-auth",
      CLAUDE_AUTH_TOKEN_PATH: "/tmp/legacy-token",
      PATH: "/usr/bin",
    }, {
      account_id: "account-b",
      config_dir: "/sandbox/restricted/claude-config",
      available_count: 2,
      credential: { kind: "access-token", access_token: "selected-token-b" },
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/sandbox/restricted/claude-config",
      CLAUDE_CODE_OAUTH_TOKEN: "selected-token-b",
    });
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

  it("resumes the transcript and sidecar from the sandbox config after an account switch", async () => {
    const sandboxConfig = mkdtempSync(join(tmpdir(), "claude-pool-sandbox-"));
    roots.push(sandboxConfig);
    const projects = join(sandboxConfig, "projects");
    mkdirSync(projects);
    const key = { projectKey: "project", sessionId: "550e8400-e29b-41d4-a716-446655440000" };
    const entries = [
      { type: "user", uuid: "one" },
      { type: "assistant", uuid: "two" },
    ] as never;
    const subagent = [
      { type: "assistant", uuid: "sub-one" },
      { type: "agent_metadata", agentType: "helper" },
    ] as never;
    const store = {
      append: vi.fn(async () => undefined),
      load: vi.fn(async (loadedKey: typeof key & { subpath?: string }) =>
        loadedKey.subpath ? subagent : entries),
      listSessions: vi.fn(async () => []),
      listSubkeys: vi.fn(async () => ["subagents/agent-a"]),
      delete: vi.fn(async () => undefined),
    };
    const wrapped = useLocalClaudeAccountPoolResume(store as never, sandboxConfig);
    const turnA = buildClaudeAccountPoolEnvironment({}, {
      account_id: "account-a",
      config_dir: sandboxConfig,
      available_count: 2,
      credential: { kind: "access-token", access_token: "token-a" },
    });
    const turnB = buildClaudeAccountPoolEnvironment(turnA, {
      account_id: "account-b",
      config_dir: sandboxConfig,
      available_count: 2,
      credential: { kind: "access-token", access_token: "token-b" },
    });

    // 한도로 계정이 바뀌어도 샌드박스 config 경로는 그대로다.
    expect(turnB.CLAUDE_CONFIG_DIR).toBe(turnA.CLAUDE_CONFIG_DIR);
    await wrapped.load(key as never);
    const transcriptPath = join(projects, key.projectKey, `${key.sessionId}.jsonl`);
    const sidecarPath = join(
      projects, key.projectKey, key.sessionId, "subagents", "agent-a.meta.json",
    );
    const transcriptInode = statSync(transcriptPath).ino;
    const sidecarInode = statSync(sidecarPath).ino;
    const parseLines = (path: string) => readFileSync(path, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));

    expect(parseLines(transcriptPath)).toEqual(entries);
    expect(JSON.parse(readFileSync(sidecarPath, "utf8"))).toEqual({ agentType: "helper" });

    // 새 계정의 토큰을 받은 다음 턴에서도 같은 자리에서 이력과 사이드카를 되살린다.
    await wrapped.load(key as never);
    expect(statSync(transcriptPath).ino).toBe(transcriptInode);
    expect(statSync(sidecarPath).ino).toBe(sidecarInode);
    expect(parseLines(transcriptPath)).toEqual(entries);
    expect(JSON.parse(readFileSync(sidecarPath, "utf8"))).toEqual({ agentType: "helper" });
    expect(readFileSync(transcriptPath, "utf8")).not.toContain("token-a");
    expect(readFileSync(transcriptPath, "utf8")).not.toContain("token-b");
    expect(readFileSync(sidecarPath, "utf8")).not.toContain("token-b");
  });
});
