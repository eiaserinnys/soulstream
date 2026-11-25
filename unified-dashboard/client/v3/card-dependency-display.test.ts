import { describe, expect, it } from "vitest";
import { cardDependencyDisplay } from "../../../packages/wire-schema/src/card_dependency_display";

const dep = (number: number, extra: Record<string, unknown> = {}) => ({ id: String(number), number, title: `카드 ${number}`, status: "running" as const, archived: false, met: false, ...extra });
describe("선행 카드 대기 문구", () => {
 it("미충족 장수와 멈춘 원인을 표시한다", () => {
  expect(cardDependencyDisplay("queued", [dep(12)])).toEqual({ text: "선행 대기 #12", tone: "neutral" });
  expect(cardDependencyDisplay("queued", [dep(12), dep(15)])?.text).toBe("선행 대기 #12, #15");
  expect(cardDependencyDisplay("queued", [dep(12), dep(15), dep(16)])?.text).toBe("선행 대기 #12 외 2건");
  expect(cardDependencyDisplay("queued", [dep(12), dep(15, {status: "cancelled"})])).toEqual({text:"선행 취소됨 #15",tone:"error"});
  expect(cardDependencyDisplay("queued", [dep(12, {archived: true})])).toEqual({text:"선행 보관됨 #12",tone:"error"});
  expect(cardDependencyDisplay("queued", [dep(12, {met: true, archived: true}), dep(15)])?.text).toBe("선행 대기 #15");
  expect(cardDependencyDisplay("queued", [dep(12, {met: true})])).toBeNull();
  expect(cardDependencyDisplay("todo", [dep(12)])).toBeNull();
  expect(cardDependencyDisplay("on_hold", [dep(12)])).toBeNull();
 });
});
