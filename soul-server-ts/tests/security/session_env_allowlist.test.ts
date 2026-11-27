import { describe, expect, it } from "vitest";

import type { AgentProfile } from "@soulstream/agent-profile-contract";
import { restrictedSessionEnvKeys } from
  "../../src/runner/runner_process_isolation.js";
import {
  buildRestrictedSessionEnv,
  isRestrictedBaseEnvKeyAllowed,
  selectRestrictedBaseEnv,
} from "../../src/runner/session_env.js";
import type { Task } from "../../src/task/task_models.js";

describe("restricted base env allowlist", () => {
  it("passes the Bash default timeout but not shell-injecting BASH_ names", () => {
    expect(
      selectRestrictedBaseEnv({ BASH_DEFAULT_TIMEOUT_MS: "600000", BASH_ENV: "/tmp/x" }),
    ).toEqual({ BASH_DEFAULT_TIMEOUT_MS: "600000" });
  });

  it("keeps fixed names and the allowed prefixes", () => {
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "HTTPS_PROXY",
      "https_proxy",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
      "PLAYWRIGHT_BROWSERS_PATH",
      "ANTHROPIC_API_KEY",
      "CODEX_HOME",
      "SOULSTREAM_NODE_ID",
      "AGENT_COMMON_FILES_DIR",
      "LOG_LEVEL",
      "WSL_DISTRO_NAME",
      "LC_ALL",
      "XDG_CONFIG_HOME",
      "GIT_CONFIG_KEY_0",
      "npm_config_store_dir",
      "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE",
    ]) {
      expect(isRestrictedBaseEnvKeyAllowed(key), key).toBe(true);
    }
  });

  it("drops unrelated API keys and credential-shaped prefixed names", () => {
    for (const key of [
      "ATOM_API_KEY",
      "ATOM_NL_API_KEY",
      "ARBOR_API_KEY",
      "KIMI_API_KEY",
      "LLM_ANTHROPIC_API_KEY",
      "LLM_OPENAI_API_KEY",
      "SERENDIPITY_API_KEY",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "npm_config_password",
      "XDG_CREDENTIAL_PATH",
      "DATABASE_URL",
      "SSH_AUTH_SOCK",
    ]) {
      expect(isRestrictedBaseEnvKeyAllowed(key), key).toBe(false);
    }
  });

  it("keeps internal MCP coordinates out of the base because the isolation plan supplies them", () => {
    for (const key of ["MCP_INTERNAL_PORT", "MCP_PATH"]) {
      expect(isRestrictedBaseEnvKeyAllowed(key), key).toBe(false);
    }
  });

  it("admits only the session keys handed in by the caller", () => {
    expect(isRestrictedBaseEnvKeyAllowed("KIMI_API_KEY", ["KIMI_API_KEY"])).toBe(true);
    expect(isRestrictedBaseEnvKeyAllowed("ATOM_API_KEY", ["KIMI_API_KEY"])).toBe(false);
  });
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "session-1",
    prompt: "start",
    status: "pending",
    ...overrides,
  } as Task;
}

const agent = {
  id: "kimi",
  name: "Kimi",
  backend: "claude",
  workspace_dir: "/workspace/kimi",
} as AgentProfile;

describe("restrictedSessionEnvKeys", () => {
  it("collects preset ${VAR} references resolved on the host", () => {
    const keys = restrictedSessionEnvKeys(
      task({
        modelPresetBackend: "claude",
        modelPresetEnv: {
          ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
          ANTHROPIC_API_KEY: "${KIMI_API_KEY}",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144",
        },
      }),
      agent,
    );

    expect(keys).toEqual(["KIMI_API_KEY"]);
  });

  it("falls back to the profile env and adds the provider api_key_env", () => {
    const keys = restrictedSessionEnvKeys(
      task(),
      {
        ...agent,
        env: { OPENAI_API_KEY: "${PROFILE_OPENAI_KEY}" },
        agents_sdk: {
          entry_agent: "triage",
          agents: [],
          guardrails: { input_blocklist: [], output_blocklist: [] },
          provider: { type: "openai", api_key_env: "AGENTS_KEY" },
        },
      } satisfies Pick<AgentProfile, "env" | "agents_sdk">,
    );

    expect(keys).toEqual(["AGENTS_KEY", "PROFILE_OPENAI_KEY"]);
  });

  it("lets the referenced key through the restricted env boundary", () => {
    const keys = restrictedSessionEnvKeys(
      task({
        modelPresetBackend: "claude",
        modelPresetEnv: { ANTHROPIC_API_KEY: "${KIMI_API_KEY}" },
      }),
      agent,
    );
    const env = buildRestrictedSessionEnv({
      baseEnv: { PATH: "/usr/bin", KIMI_API_KEY: "kimi", ATOM_API_KEY: "atom" },
      sessionKeys: keys,
      additions: { AUTH_BEARER_TOKEN: "ssr1.s1.signature" },
      restrictedCredential: "ssr1.s1.signature",
      fullSecrets: [],
      wsl: false,
    });

    expect(env.KIMI_API_KEY).toBe("kimi");
    expect(env).not.toHaveProperty("ATOM_API_KEY");
    expect(env.AUTH_BEARER_TOKEN).toBe("ssr1.s1.signature");
  });
});
