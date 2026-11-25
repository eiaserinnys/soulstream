import { describe, expect, it } from "vitest";
import { cardDependencyDisplay, cardDependencyStopReason } from "../../../packages/wire-schema/src/card_dependency_display";
import { cardDependencyStatus } from "./CardActions";

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
 it("취소와 미충족 보관만 멈춘 선행으로 본다", () => {
  expect(cardDependencyStopReason(dep(1, {status: "cancelled"}))).toBe("cancelled");
  expect(cardDependencyStopReason(dep(1, {status: "cancelled", archived: true}))).toBe("cancelled");
  expect(cardDependencyStopReason(dep(1, {archived: true}))).toBe("archived");
  expect(cardDependencyStopReason(dep(1, {archived: true, met: true, status: "done"}))).toBeNull();
  expect(cardDependencyStopReason(dep(1))).toBeNull();
 });
 it("상세 상태 칩은 충족되지 않은 보관 선행을 오류 톤 「보관됨」으로, 취소는 「취소」로 보인다", () => {
  expect(cardDependencyStatus(dep(1, {archived: true, status: "queued"}))).toEqual({label: "보관됨", tone: "error"});
  expect(cardDependencyStatus(dep(1, {status: "cancelled"}))).toEqual({label: "취소", tone: "cancelled"});
  expect(cardDependencyStatus(dep(1, {status: "queued"}))).toEqual({label: "대기", tone: "queued"});
  expect(cardDependencyStatus(dep(1, {status: "done", met: true, archived: true}))).toEqual({label: "완료", tone: "done"});
 });
});
