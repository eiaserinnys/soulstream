import { afterEach, expect, it, vi } from "vitest";
import { CardApiError } from "./card-api";
import { cardExecutionProblem, cardExecutionState, executeCard, resetCardExecutions } from "./card-execution";

afterEach(() => { vi.unstubAllGlobals(); resetCardExecutions(); });

const refusal = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 422 }));

it("422 응답에 서버 사유가 있으면 그 문구를 그대로 보인다", async () => {
  const reason = "폴더·노드·에이전트·모델을 선택한 뒤 실행하세요.";
  vi.stubGlobal("fetch", refusal({ detail: { error: { code: "CARD_EXECUTION_SETTINGS_REQUIRED", message: reason } } }));

  const failure = await executeCard("card-1", 3).catch(error => error);

  expect(failure).toBeInstanceOf(CardApiError);
  expect(failure.message).toBe(reason);
  expect(failure.status).toBe(422);
  expect(failure.code).toBe("CARD_EXECUTION_SETTINGS_REQUIRED");
  expect(cardExecutionState("card-1")).toEqual({ phase: "error", message: reason });
});

it("422 응답에 서버 사유가 없으면 기존 문구를 쓴다", async () => {
  vi.stubGlobal("fetch", refusal({}));

  const failure = await executeCard("card-2", 1).catch(error => error);

  expect(failure.message).toBe("카드를 시작하지 못했습니다. 다시 시도해 주세요.");
  expect(cardExecutionProblem(new CardApiError("카드 요청 실패 (422)", 422)))
    .toBe("카드를 시작하지 못했습니다. 다시 시도해 주세요.");
});

it("최상위 message만 있는 422는 내부 문구를 가리고 기존 문구를 쓴다", async () => {
  vi.stubGlobal("fetch", refusal({ message: "internal delivery/idempotency detail" }));

  const failure = await executeCard("card-3", 1).catch(error => error);

  expect(failure.message).toBe("카드를 시작하지 못했습니다. 다시 시도해 주세요.");
});

it("서버 사유가 있는 오류 객체는 그 사유를 그대로 낸다", () => {
  expect(cardExecutionProblem(new CardApiError("카드 요청 실패 (422)", 422, "CODE", "서버 사유"))).toBe("서버 사유");
});

it("422가 아닌 거절은 서버 사유와 무관하게 기존 문구를 쓴다", () => {
  expect(cardExecutionProblem(new CardApiError("서버 문구", 409))).toBe("카드가 변경되었습니다. 최신 상태를 확인해 주세요.");
  expect(cardExecutionProblem(new CardApiError("서버 문구", 403))).toBe("로그인과 카드 접근 권한을 확인해 주세요.");
  expect(cardExecutionProblem(new Error("network"))).toBe("연결을 확인한 뒤 다시 시도해 주세요.");
});
