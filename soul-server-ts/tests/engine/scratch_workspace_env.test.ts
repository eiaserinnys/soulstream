import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SCRATCH_WORKSPACE_DIR_ENV,
  SOULSTREAM_AGENT_ID_ENV,
  withScratchWorkspaceEnv,
  writeScratchAgentMarker,
} from "../../src/engine/scratch_workspace_env.js";

describe("scratch workspace env", () => {
  it("overrides caller-provided scratch env at the adapter boundary", () => {
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

  it("writes and validates the scratch agent marker without resolving the path", () => {
    const workspace = mkdtempSync(join(tmpdir(), "scratch-marker-"));
    try {
      writeScratchAgentMarker({ workspaceDir: workspace, agentId: "agent-a" });
      expect(readFileSync(join(workspace, ".local", ".agent_marker"), "utf8")).toBe(
        "agent-a\n",
      );
      expect(() =>
        writeScratchAgentMarker({ workspaceDir: workspace, agentId: "agent-b" }),
      ).toThrow(/marker mismatch/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an existing marker that belongs to another agent", () => {
    const workspace = mkdtempSync(join(tmpdir(), "scratch-marker-"));
    try {
      mkdirSync(join(workspace, ".local"));
      writeFileSync(join(workspace, ".local", ".agent_marker"), "agent-b\n", "utf8");
      expect(() =>
        writeScratchAgentMarker({ workspaceDir: workspace, agentId: "agent-a" }),
      ).toThrow(/belongs to agent-b/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
