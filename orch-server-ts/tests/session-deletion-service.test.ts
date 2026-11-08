import { describe, expect, it, vi } from "vitest";
import { SessionDeletionService } from "../src/session/session_deletion_service.js";

describe("session deletion", () => {
  it("delegates the deletion to the repository", async () => {
    const remove = vi.fn(async () => {});
    await new SessionDeletionService({ repository: { deleteSession: remove } }).deleteSession("session-a");
    expect(remove).toHaveBeenCalledWith({ sessionId: "session-a" });
  });
});
