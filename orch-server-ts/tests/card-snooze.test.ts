import { describe, expect, it, vi } from "vitest";
import { executeCardOperation, parseSnoozedUntil } from "../src/cards/card_operations.js";
import { buildStatusHistory } from "../src/cards/control_plane/card_repository_read.js";
import type { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";

const NOW = new Date("2026-11-25T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const rejected = (value: unknown) => {
  try { parseSnoozedUntil(value, NOW); } catch (error) { return error as { statusCode?: number; code?: string; message: string }; }
  throw new Error(`accepted: ${String(value)}`);
};

describe("snoozedUntil 입력 검사", () => {
  it("지금보다 뒤이고 30일 안인 시각은 ISO 문자열로 받는다", () => {
    expect(parseSnoozedUntil(at(60_000), NOW)).toBe(at(60_000));
    expect(parseSnoozedUntil(at(30 * DAY), NOW)).toBe(at(30 * DAY));
    expect(parseSnoozedUntil("2026-11-25T09:30:00+09:00", NOW)).toBe("2026-11-25T00:30:00.000Z");
  });
  it("null은 해제다", () => {
    expect(parseSnoozedUntil(null, NOW)).toBeNull();
  });
  it("과거와 지금 시각은 400으로 거부한다", () => {
    expect(rejected(at(-1000))).toMatchObject({ statusCode: 400, code: "INVALID_CARD_REQUEST" });
    expect(rejected(at(0)).statusCode).toBe(400);
  });
  it("30일을 넘으면 400으로 거부한다", () => {
    expect(rejected(at(30 * DAY + 1))).toMatchObject({ statusCode: 400, code: "INVALID_CARD_REQUEST" });
  });
  it("형식이 틀리면 400으로 거부한다", () => {
    for (const value of ["내일", "2026-12-01", "2026-12-01T10:00:00", "2026-13-45T10:00:00Z", 12345, undefined, ""])
      expect(rejected(value).statusCode).toBe(400);
  });
});

describe("PATCH update_card의 snoozedUntil 경계", () => {
  const actor = { actorKind: "user" as const, actorSessionId: null };
  const fakeService = () => {
    const patchCard = vi.fn(async () => ({
      operation: { target_kind: "card", target_id: "c1" },
      snapshot: { folder: { id: "f1" }, card: { id: "c1" } },
    }));
    return { service: { patchCard } as unknown as CardControlPlaneService, patchCard };
  };
  const body = (extra: Record<string, unknown>) => ({ expectedVersion: 1, idempotencyKey: "k", ...extra });

  it("HTTP 경로는 snoozedUntil만 보내도 patchCard로 넘기고 null도 해제로 넘긴다", async () => {
    const future = new Date(Date.now() + DAY).toISOString();
    const { service, patchCard } = fakeService();
    await executeCardOperation(service, "update_card", body({ snoozedUntil: future }), "c1", actor, true);
    expect(patchCard).toHaveBeenLastCalledWith(expect.objectContaining({ cardId: "c1", snoozedUntil: future }));
    await executeCardOperation(service, "update_card", body({ snoozedUntil: null }), "c1", actor, true);
    expect(patchCard).toHaveBeenLastCalledWith(expect.objectContaining({ snoozedUntil: null }));
  });
  it("HTTP 경로도 과거나 30일 초과는 400이고 patchCard를 부르지 않는다", async () => {
    const { service, patchCard } = fakeService();
    for (const value of [new Date(Date.now() - DAY).toISOString(), new Date(Date.now() + 31 * DAY).toISOString(), "내일"])
      await expect(executeCardOperation(service, "update_card", body({ snoozedUntil: value }), "c1", actor, true))
        .rejects.toMatchObject({ statusCode: 400 });
    expect(patchCard).not.toHaveBeenCalled();
  });
  it("MCP 경로(사용자 칸 꺼짐)는 snoozedUntil을 받지 않는다", async () => {
    const { service, patchCard } = fakeService();
    await expect(executeCardOperation(service, "update_card", body({ snoozedUntil: new Date(Date.now() + DAY).toISOString() }), "c1", actor))
      .rejects.toThrow();
    expect(patchCard).not.toHaveBeenCalled();
  });
});

describe("statusHistory 행 만들기", () => {
  const row = (payload: Record<string, unknown>, created: string, kind = "agent", session: string | null = "s1") =>
    ({ payload_json: payload, actor_kind: kind, actor_session_id: session, created_at: new Date(created) });

  it("최신순으로 읽은 행을 오래된 순으로 뒤집고 {status, at, actorKind, sessionId}만 낸다", () => {
    const history = buildStatusHistory([
      row({ status: "review" }, "2026-11-25T03:00:00Z"),
      row({ status: "running" }, "2026-11-25T02:00:00Z", "user", null),
    ]);
    expect(history).toEqual([
      { status: "running", at: "2026-11-25T02:00:00.000Z", actorKind: "user", sessionId: null },
      { status: "review", at: "2026-11-25T03:00:00.000Z", actorKind: "agent", sessionId: "s1" },
    ]);
  });
  it("상태가 없거나 문자열이 아닌 행은 넣지 않는다", () => {
    expect(buildStatusHistory([row({ execution: {} }, "2026-11-25T03:00:00Z"), row({ status: null }, "2026-11-25T02:00:00Z"), row({ status: "done" }, "2026-11-25T01:00:00Z")]))
      .toHaveLength(1);
  });
});
