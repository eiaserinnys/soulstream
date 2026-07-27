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

});
