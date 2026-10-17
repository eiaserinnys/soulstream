import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { applyCardQuestionReply } from "../src/session/card_question_reply.js";

const request = { log: {} } as unknown as FastifyRequest;
const detail = (folderId: string) => ({
  card: { id: "card-1", folder_id: folderId }, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [],
});
const cardOptions = (folderId: string, answer = vi.fn(async () => ({
  operation: { target_kind: "card", target_id: "card-1" },
  snapshot: { folder: { id: folderId }, cards: [{ id: "card-1" }] },
  idempotent: false,
}))) => {
  const service = { getCard: async () => detail(folderId), answerQuestion: answer };
  return {
    answer,
    options: {
      cardServiceProvider: async () => service,
      provider: { listFolders: async () => [{ id: folderId }] },
    } as never,
  };
};

describe("board answers reach the card only through the same access checks", () => {
  it("denies a resend ACK when the caller cannot read the card folder", async () => {
    const { options, answer } = cardOptions("secret-folder");
    const requireSessionAccess = vi.fn(async () => undefined);
    await expect(applyCardQuestionReply({ action: "card-acked", cardId: "card-1" }, {
      sessionId: "pas", request, requireSessionAccess, cardOptions: options,
      resolveAccess: async () => ({ restricted: true, folders: [] }),
      resolveActor: async () => ({ actorKind: "user", actorUserId: "other@example.com", actorSessionId: null }),
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(answer).not.toHaveBeenCalled();
  });
  it("runs the session check before touching the card", async () => {
    const { options } = cardOptions("report-folder");
    const order: string[] = [];
    await expect(applyCardQuestionReply({ action: "card-acked", cardId: "card-1" }, {
      sessionId: "pas", request,
      requireSessionAccess: async () => { order.push("session"); throw Object.assign(new Error("denied"), { statusCode: 403 }); },
      cardOptions: options,
      resolveAccess: async () => { order.push("card"); return { restricted: false }; },
      resolveActor: async () => ({ actorKind: "user", actorUserId: "director@example.com", actorSessionId: null }),
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(order).toEqual(["session"]);
  });
  it("saves the answer when the caller may read the card folder", async () => {
    const { options, answer } = cardOptions("report-folder");
    await applyCardQuestionReply({ action: "card", cardId: "card-1", questionId: "q-1", option: "진행" }, {
      sessionId: "pas", request, requireSessionAccess: async () => undefined, cardOptions: options,
      resolveAccess: async () => ({ restricted: false }),
      resolveActor: async () => ({ actorKind: "user", actorUserId: "director@example.com", actorSessionId: null }),
    });
    expect(answer).toHaveBeenCalledTimes(1);
  });
});
