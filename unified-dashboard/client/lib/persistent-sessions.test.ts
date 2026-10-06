import { describe, expect, it, vi } from "vitest";

import { createPersistentSessionsApi, PersistentSessionError, type PersistentInstruction } from "./persistent-sessions";

const instruction: PersistentInstruction = {
  id: "instruction-1",
  text: "간결하게 답합니다.",
  source_turns: ["T195", "T210"],
  created_at: "2026-10-06T10:00:00.000Z",
  updated_at: "2026-10-06T11:00:00.000Z",
  origin: "user",
};

describe("persistent instruction API", () => {
  it("loads active instructions with the wrapped response", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ instructions: [instruction] }));
    const api = createPersistentSessionsApi(request);

    await expect(api.listInstructions("session/a")).resolves.toEqual({ instructions: [instruction] });
    expect(request).toHaveBeenCalledWith("/api/persistent-sessions/session%2Fa/instructions", {
      credentials: "same-origin",
      method: "GET",
      headers: { Accept: "application/json" },
    });
  });

  it("adds and edits an instruction through the session-scoped routes", async () => {
    const updated = { ...instruction, text: "짧게 답합니다.", updated_at: "2026-10-06T12:00:00.000Z" };
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ instruction }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ instruction: updated }))
      .mockResolvedValueOnce(Response.json({ instruction: { ...updated, status: "removed" } }));
    const api = createPersistentSessionsApi(request);

    await expect(api.addInstruction("session/a", "간결하게 답합니다.")).resolves.toEqual({ instruction });
    await expect(api.updateInstruction("session/a", "instruction/1", { text: "짧게 답합니다." })).resolves.toEqual({ instruction: updated });
    await expect(api.updateInstruction("session/a", "instruction/1", { status: "removed" })).resolves.toEqual({ instruction: { ...updated, status: "removed" } });

    expect(request.mock.calls.slice(0, 2)).toEqual([
      ["/api/persistent-sessions/session%2Fa/instructions", expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "간결하게 답합니다." }) })],
      ["/api/persistent-sessions/session%2Fa/instructions/instruction%2F1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ text: "짧게 답합니다." }) })],
    ]);
    expect(request.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ status: "removed" }),
    }));
  });

  it("preserves the cap_reached error code from the server response", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "cap_reached" }, { status: 409 }));
    const api = createPersistentSessionsApi(request);

    await expect(api.addInstruction("session/a", "추가 지시")).rejects.toMatchObject({
      status: 409,
      code: "cap_reached",
    } satisfies Partial<PersistentSessionError>);
  });
});
