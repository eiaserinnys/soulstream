import { describe, expect, it } from "vitest";

import { WorktreeServiceError } from "../../src/worktree/worktree_service.js";
import { decodeRemoteWorktreeResponse } from "../../src/mcp/tools/worktree.js";

describe("decodeRemoteWorktreeResponse", () => {
  it("uses non-JSON error response text as the message", async () => {
    await expect(
      decodeRemoteWorktreeResponse(new Response("upstream bad gateway", { status: 502 })),
    ).rejects.toMatchObject({
      name: "WorktreeServiceError",
      code: "REMOTE_WORKTREE_FAILED",
      message: "upstream bad gateway",
    });
  });

  it("preserves typed remote worktree errors", async () => {
    const response = new Response(JSON.stringify({
      error: {
        code: "WORKTREE_DIRTY",
        message: "worktree has changes",
        details: { path: "/repo/worktree" },
      },
    }), { status: 409 });
    await expect(
      decodeRemoteWorktreeResponse(response),
    ).rejects.toMatchObject({
      code: "WORKTREE_DIRTY",
      message: "worktree has changes",
      details: { path: "/repo/worktree" },
    });
  });
});
