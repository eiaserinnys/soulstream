import { describe, expect, it } from "vitest";

import {
  AGENT_COMMON_FILES_DIR_ENV,
  SCRATCH_WORKSPACE_DIR_ENV,
  SOULSTREAM_AGENT_ID_ENV,
  withScratchWorkspaceEnv,
} from "../../src/engine/scratch_workspace_env.js";

function withProcessEnvValue(key: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[key];
  try {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("scratch workspace env", () => {
  it("overrides caller-provided scratch env at the adapter boundary", () => {
    withProcessEnvValue(AGENT_COMMON_FILES_DIR_ENV, undefined, () => {
      expect(
        withScratchWorkspaceEnv(
          {
            PATH: "/usr/bin",
            [SCRATCH_WORKSPACE_DIR_ENV]: "/wrong",
            [SOULSTREAM_AGENT_ID_ENV]: "wrong-agent",
          },
          { workspaceDir: "/scratch/agent-a", agentId: "agent-a" },
        ),
      ).toEqual({
        PATH: "/usr/bin",
        [SCRATCH_WORKSPACE_DIR_ENV]: "/scratch/agent-a",
        [SOULSTREAM_AGENT_ID_ENV]: "agent-a",
      });
    });
  });

  it("injects AGENT_COMMON_FILES_DIR from the soul-server process env", () => {
    withProcessEnvValue(AGENT_COMMON_FILES_DIR_ENV, "/srv/agent-common", () => {
      expect(
        withScratchWorkspaceEnv(
          {
            PATH: "/usr/bin",
            [AGENT_COMMON_FILES_DIR_ENV]: "/wrong-common",
          },
          { workspaceDir: "/scratch/agent-a" },
        ),
      ).toEqual({
        PATH: "/usr/bin",
        [SCRATCH_WORKSPACE_DIR_ENV]: "/scratch/agent-a",
        [AGENT_COMMON_FILES_DIR_ENV]: "/srv/agent-common",
      });
    });
  });

  it("omits AGENT_COMMON_FILES_DIR when the soul-server process env is unset or blank", () => {
    withProcessEnvValue(AGENT_COMMON_FILES_DIR_ENV, undefined, () => {
      expect(
        withScratchWorkspaceEnv(
          {
            PATH: "/usr/bin",
            [AGENT_COMMON_FILES_DIR_ENV]: "/wrong-common",
          },
          { workspaceDir: "/scratch/agent-a" },
        ),
      ).toEqual({
        PATH: "/usr/bin",
        [SCRATCH_WORKSPACE_DIR_ENV]: "/scratch/agent-a",
      });
    });

    withProcessEnvValue(AGENT_COMMON_FILES_DIR_ENV, "   ", () => {
      expect(
        withScratchWorkspaceEnv(
          {
            PATH: "/usr/bin",
            [AGENT_COMMON_FILES_DIR_ENV]: "/wrong-common",
          },
          { workspaceDir: "/scratch/agent-a" },
        ),
      ).toEqual({
        PATH: "/usr/bin",
        [SCRATCH_WORKSPACE_DIR_ENV]: "/scratch/agent-a",
      });
    });
  });

  it("fills TEST_DATABASE_URL from the isolation test database URL when the result has none", () => {
    withProcessEnvValue(AGENT_COMMON_FILES_DIR_ENV, undefined, () => {
      expect(
        withScratchWorkspaceEnv(
          {
            PATH: "/usr/bin",
            SESSION_ISOLATION_TEST_DATABASE_URL:
              "postgres://tester@127.0.0.1:15432/soulstream_test",
          },
          { workspaceDir: "/scratch/agent-a" },
        ),
      ).toEqual({
        PATH: "/usr/bin",
        SESSION_ISOLATION_TEST_DATABASE_URL:
          "postgres://tester@127.0.0.1:15432/soulstream_test",
        [SCRATCH_WORKSPACE_DIR_ENV]: "/scratch/agent-a",
        TEST_DATABASE_URL: "postgres://tester@127.0.0.1:15432/soulstream_test",
      });

      // 빈 값도 없는 것으로 본다.
      expect(
        withScratchWorkspaceEnv(
          {
            PATH: "/usr/bin",
            TEST_DATABASE_URL: "",
            SESSION_ISOLATION_TEST_DATABASE_URL:
              "postgres://tester@127.0.0.1:15432/soulstream_test",
          },
          { workspaceDir: "/scratch/agent-a" },
        ).TEST_DATABASE_URL,
      ).toBe("postgres://tester@127.0.0.1:15432/soulstream_test");
    });
  });

  it("keeps an existing TEST_DATABASE_URL instead of the isolation test database URL", () => {
    withProcessEnvValue(AGENT_COMMON_FILES_DIR_ENV, undefined, () => {
      expect(
        withScratchWorkspaceEnv(
          {
            PATH: "/usr/bin",
            TEST_DATABASE_URL: "postgres://keep@127.0.0.1:15432/soulstream_test",
            SESSION_ISOLATION_TEST_DATABASE_URL:
              "postgres://isolation@127.0.0.1:15432/soulstream_test",
          },
          { workspaceDir: "/scratch/agent-a" },
        ),
      ).toEqual({
        PATH: "/usr/bin",
        TEST_DATABASE_URL: "postgres://keep@127.0.0.1:15432/soulstream_test",
        SESSION_ISOLATION_TEST_DATABASE_URL:
          "postgres://isolation@127.0.0.1:15432/soulstream_test",
        [SCRATCH_WORKSPACE_DIR_ENV]: "/scratch/agent-a",
      });
    });
  });

  it("does not create TEST_DATABASE_URL when the result has neither value", () => {
    withProcessEnvValue(AGENT_COMMON_FILES_DIR_ENV, undefined, () => {
      const env = withScratchWorkspaceEnv(
        { PATH: "/usr/bin" },
        { workspaceDir: "/scratch/agent-a" },
      );
      expect(env).not.toHaveProperty("TEST_DATABASE_URL");
    });
  });

});
