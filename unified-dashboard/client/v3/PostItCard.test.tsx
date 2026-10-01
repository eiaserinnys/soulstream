import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PostItCardView, PostItGrid, postItRotation } from "./PostItCard";
import { reviewCard } from "./components-review-fixtures";

it("uses the complete original body and reserves the same footer for empty cards", () => {
  const body = "보고 제목 대신 실제 원문입니다.\n두 번째 줄도 유지합니다.";
  const html = renderToStaticMarkup(createElement(PostItCardView, {
    card: reviewCard, activity: { kind: "report", format: "markdown", body }, onOpen() {},
  }));
  expect(html).toContain(body);
  expect(html).toContain("마지막 보고");
  expect(html).toContain('aria-label="카드 카드 행 기본 열기"');
  expect(html).toContain("v3-postit-footer");
  const empty = renderToStaticMarkup(createElement(PostItCardView, {
    card: { ...reviewCard, request: "", assigneeKind: null, assigneeAgentId: null, assigneeSessionId: null },
    activity: null, onOpen() {},
  }));
  expect(empty).toContain("아직 지시나 보고가 없습니다");
  expect(empty).toContain("담당 없음");
  expect(empty).toContain("v3-postit-footer");
});

it("keeps deterministic corksheet rotations within the five approved angles", () => {
  expect(["a", "b", "c", "d", "e"].map(postItRotation).sort()).toEqual([-0.4, -0.8, 0, 0.4, 0.8].sort());
  expect(postItRotation(reviewCard.id)).toBe(postItRotation(reviewCard.id));
});

it("keeps completion as a separate small button without nesting it in the open button", () => {
  const html = renderToStaticMarkup(createElement(PostItCardView, {
    card: { ...reviewCard, status: "review" }, activity: null, onOpen() {},
    completion: { pending: false, onComplete() {} },
  }));
  expect(html).toContain('aria-label="완료"');
  expect(html).toContain("dashboard-icon-cap--small");
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html.indexOf("</button>")).toBeLessThan(html.indexOf('aria-label="완료"'));
});

it("offers an explicit compact presentation while the default card keeps its existing frame", () => {
  const props={card:reviewCard,activity:{kind:"report" as const,format:"markdown" as const,body:"같은 원문으로 비교합니다"},onOpen(){}};
  const standard=renderToStaticMarkup(createElement(PostItCardView,props));
  const compact=renderToStaticMarkup(createElement(PostItCardView,{...props,variant:"compact"}));
  expect(compact).toContain("v3-postit-card--compact");expect(standard).not.toContain("v3-postit-card--compact");
  expect(compact).toContain(props.activity.body);expect(standard).toContain(props.activity.body);
  expect(renderToStaticMarkup(createElement(PostItGrid,{variant:"compact"}))).toContain("v3-postit-grid--compact");
});
