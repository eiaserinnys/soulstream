import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { collapseReportTimeline, isCardQuestionReplyContext, parsePersistentReportEntry, readPersistentReport, parsePersistentReportReply, REPORT_TIMELINE_STATUS_LABEL } from "../../packages/wire-schema/src/persistent_report.js";
import type { ReportTimelineQuestionClosed, ReportTimelineQuestionClosedStatus, ReportTimelineRowLine } from "../../packages/wire-schema/src/persistent_report.js";

const entry = { key: "deploy-270", kind: "ask", title: "배포 결정", card_numbers: [], context: "검증을 마쳤습니다", action: "[결과](https://example.com/result)", options: ["진행", "보류"] };

type Row = { line?: ReportTimelineRowLine; closures?: ReportTimelineQuestionClosed[]; conversation?: boolean };
const access = {
  lineOf: (item: Row) => item.line ?? null,
  closuresOf: (item: Row) => item.closures ?? null,
  isConversation: (item: Row) => item.conversation === true,
  withStatus: (item: Row, status: ReportTimelineQuestionClosedStatus): Row => ({ ...item, line: { ...item.line!, status } }),
};
const line = (overrides: Partial<ReportTimelineRowLine> = {}): ReportTimelineRowLine => ({
  line_key: "card:c1", status: "question", title: "#1 검수", detail: "질문 글", card_id: "c1", card_number: 1, ...overrides,
});
const question = (overrides: Partial<ReportTimelineRowLine> = {}): Row => ({ line: line(overrides) });
const closed = (overrides: Partial<ReportTimelineQuestionClosed> = {}): ReportTimelineQuestionClosed => ({
  question_id: "q1", line_key: "card:c1", detail: "질문 글", status: "answered", ...overrides,
});
const conversation = (): Row => ({ conversation: true });

describe("persistent report shared contract", () => {
  it("collapses repeated timeline lines only within conversation boundaries", () => {
    const a1 = { line: line({ line_key: "A", status: "review" as const }) };
    const a2 = { line: line({ line_key: "A", status: "done" as const }) };
    const b1 = { line: line({ line_key: "B", status: "review" as const }) };
    const other: Row = {};

    expect(collapseReportTimeline([a1, other, a2], access)).toEqual([a2, other]);
    expect(collapseReportTimeline([a1, conversation(), a2], access)).toEqual([a1, conversation(), a2]);
    expect(collapseReportTimeline([a1, b1, a2], access)).toEqual([a2, b1]);
    expect(REPORT_TIMELINE_STATUS_LABEL).toEqual({
      review: "검수 대기", blocked: "막힘", question: "질문", done: "완료",
      cancelled: "취소", on_hold: "보류", report: "보고", answered: "답함", withdrawn: "철회",
    });
    expect([a1, other, a2]).toEqual([a1, other, a2]);
  });
  it("changes the preceding question line in place and drops the closure row", () => {
    const asked = question({ question_id: "q1" });
    const answered = question({ question_id: "q1", status: "answered" });
    expect(collapseReportTimeline([asked, { closures: [closed()] }], access)).toEqual([answered]);
    expect(collapseReportTimeline([asked, conversation(), { closures: [closed({ status: "withdrawn" })] }], access))
      .toEqual([question({ question_id: "q1", status: "withdrawn" }), conversation()]);
  });
  it("finds old question lines without question_id by line_key and detail only", () => {
    expect(collapseReportTimeline([question(), { closures: [closed({ question_id: "q9" })] }], access))
      .toEqual([question({ status: "answered" })]);
    expect(collapseReportTimeline([question(), { closures: [closed({ question_id: "q9", detail: "다른 글" })] }], access))
      .toEqual([question()]);
  });
  it("leaves a line alone once another status replaced it in the same segment", () => {
    const asked = question({ question_id: "q1" });
    const review = question({ question_id: "q1", status: "review" });
    expect(collapseReportTimeline([asked, review, { closures: [closed()] }], access)).toEqual([review]);
  });
  it("applies every closure in one event and matches the right question of the same card", () => {
    const first = question({ question_id: "q1" });
    const second = question({ question_id: "q2" });
    const rows = collapseReportTimeline([first, conversation(), second, { closures: [
      closed({ question_id: "q1", status: "withdrawn" }), closed({ question_id: "q2", status: "answered" }),
    ] }], access);
    expect(rows).toEqual([
      question({ question_id: "q1", status: "withdrawn" }), conversation(), question({ question_id: "q2", status: "answered" }),
    ]);
    expect(collapseReportTimeline([first, conversation(), second, { closures: [closed({ question_id: "q1" })] }], access))
      .toEqual([question({ question_id: "q1", status: "answered" }), conversation(), second]);
  });
  it("keeps the link recognition regex aligned with the display contract", () => {
    const source = readFileSync(new URL("../../packages/wire-schema/src/persistent_report.ts", import.meta.url), "utf8");
    expect(source).toContain(String.raw`action.replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g,`);
  });
  it("uses codepoints, defaults open and permits agent-written answers", () => {
    expect(parsePersistentReportEntry({ ...entry, title: "😀".repeat(24) })).toMatchObject({ ok: true, value: { state: "open", answer: "" } });
    expect(parsePersistentReportEntry({ ...entry, state: "answered", answer: "진행" })).toMatchObject({ ok: true, value: { state: "answered", answer: "진행" } });
  });
  it.each([["card_id", "4ba81937-7f22-4ab5-945a-29d2d7e94626"], ["card_status", "review"]])(
    "keeps the server-only %s field out of PAS input",
    (field, value) => {
      expect(parsePersistentReportEntry({ ...entry, [field]: value }))
        .toMatchObject({ ok: false, errors: [{ path: field, reason: "지원하지 않는 칸입니다" }] });
    },
  );
  it.each([
    ["key", "Upper"], ["key", "a".repeat(49)], ["title", "가".repeat(25)],
    ["context", "가".repeat(121)], ["action", "가".repeat(101)], ["answer", "가".repeat(41)],
    ["options", ["가".repeat(13)]], ["card_numbers", [1, 2, 3, 4]], ["card_numbers", [1.5]],
    ["action", "[위험](javascript:alert(1))"], ["action", "![이미지](https://example.com/a.png)"],
    ["action", "<b>글</b>"], ["action", "**강조**"],
  ])("rejects invalid %s with the field and reason", (field, value) => {
    expect(parsePersistentReportEntry({ ...entry, [field]: value })).toMatchObject({ ok: false, errors: [expect.objectContaining({ path: expect.stringContaining(field), reason: expect.any(String) })] });
  });
  it("rejects options on see, including an explicitly empty array", () => {
    const { options: _options, ...see } = { ...entry, kind: "see" };
    expect(parsePersistentReportEntry(see).ok).toBe(true);
    expect(parsePersistentReportEntry({ ...see, options: [] })).toMatchObject({ ok: false });
  });
  it("reads one current metadata entry and recognizes reply context only", () => {
    expect(readPersistentReport([])).toEqual([]);
    expect(readPersistentReport([{ type: "persistent_report", value: { entries: [entry] } }])).toEqual([entry]);
    expect(parsePersistentReportReply([{ key: "persistent_report_reply", content: { key: "deploy-270", option: "진행" } }])).toEqual({ key: "deploy-270", option: "진행" });
    expect(parsePersistentReportReply([{ key: "persistent_report_visible", content: { key: "deploy-270", title: "배포 결정" } }])).toBeNull();
  });
  it("rejects answered state on a see entry", () => {
    const { options: _options, ...see } = { ...entry, kind: "see" };
    expect(parsePersistentReportEntry({ ...see, state: "answered", answer: "확인" })).toMatchObject({ ok: false, errors: [{path:"state",reason:expect.any(String)}] });
  });
  it("accepts three links with long digest addresses without counting their URLs", () => {
    const action = ["첫 글", "둘째 글", "셋째 글"]
      .map((label, i) => `[${label}](https://pages.eiaserinnys.me/d/${"a".repeat(55)}${i})`).join(" ");
    expect(Array.from(action).length).toBeGreaterThan(100);
    expect(parsePersistentReportEntry({ ...entry, action })).toMatchObject({ok:true,value:{action}});
  });
  it.each(["HTTPS://", "https:/"])("rejects %s addresses that the displays do not recognize as links", scheme => {
    const action = `[글](${scheme}example.com/${"a".repeat(110)})`;
    expect(Array.from(action).length).toBeGreaterThan(100);
    expect(parsePersistentReportEntry({ ...entry, action })).toMatchObject({
      ok: false, errors: expect.arrayContaining([{path:"action",reason:"글과 [글](https://…) 링크만 넣을 수 있습니다"}]),
    });
  });
  it("counts visible labels as codepoints and rejects 101 visible characters", () => {
    expect(parsePersistentReportEntry({ ...entry, action: `[${"😀".repeat(100)}](https://example.com)` }).ok).toBe(true);
    expect(parsePersistentReportEntry({ ...entry, action: `[${"😀".repeat(100)}](https://example.com)가` }))
      .toMatchObject({ok:false,errors:[{path:"action",reason:"보이는 글은 100자까지입니다(링크 주소 제외)"}]});
  });
  it("rejects raw action text above 1,000 codepoints independently of its visible length", () => {
    const prefix = "[글](https://example.com/";
    const atLimit = prefix + "a".repeat(1000 - Array.from(prefix).length - 1) + ")";
    expect(parsePersistentReportEntry({ ...entry, action: atLimit }).ok).toBe(true);
    expect(parsePersistentReportEntry({ ...entry, action: atLimit.replace(")", "a)") }))
      .toMatchObject({ok:false,errors:[{path:"action",reason:"전체 원문은 1,000자까지입니다"}]});
  });
  it("accepts five links and rejects a sixth even when both text limits are met", () => {
    const link = "[글](https://a)";
    expect(parsePersistentReportEntry({ ...entry, action: Array(5).fill(link).join(" ") }).ok).toBe(true);
    expect(parsePersistentReportEntry({ ...entry, action: Array(6).fill(link).join(" ") }))
      .toMatchObject({ok:false,errors:[{path:"action",reason:"링크는 5개까지입니다"}]});
  });
});

describe("persistent report reply parsing", () => {
  const reply = (content: Record<string, unknown>) => [{ key: "persistent_report_reply", content }];
  it("keeps the legacy choice shape and reads appended text", () => {
    expect(parsePersistentReportReply(reply({ key: "deploy-270", option: "진행" }))).toEqual({ key: "deploy-270", option: "진행" });
    expect(parsePersistentReportReply(reply({ key: "cq_q-1", option: "진행" }))).toEqual({ key: "cq_q-1", option: "진행" });
    expect(parsePersistentReportReply(reply({ key: "cq_q-1", option: "진행", text: "덧붙임" }))).toEqual({ key: "cq_q-1", option: "진행", text: "덧붙임" });
  });
  it("reads a text answer only on a card question entry", () => {
    expect(parsePersistentReportReply(reply({ key: "cq_q-1", mode: "text", text: "직접 쓴 답" })))
      .toEqual({ key: "cq_q-1", mode: "text", text: "직접 쓴 답" });
    expect(parsePersistentReportReply(reply({ key: "deploy-270", mode: "text", text: "직접 쓴 답" }))).toBeNull();
  });
  it.each([
    ["a missing option", { key: "cq_q-1" }],
    ["a blank option", { key: "cq_q-1", option: "   " }],
    ["a non-string appended text", { key: "cq_q-1", option: "진행", text: 3 }],
    ["a blank appended text", { key: "cq_q-1", option: "진행", text: "  " }],
    ["a text answer without text", { key: "cq_q-1", mode: "text" }],
    ["a blank text answer", { key: "cq_q-1", mode: "text", text: "   " }],
    ["an unknown mode", { key: "cq_q-1", mode: "other", option: "진행" }],
  ])("marks %s on a card question instead of falling through", (_name, content) => {
    expect(parsePersistentReportReply(reply(content))).toMatchObject({ key: "cq_q-1", invalid: expect.any(String) });
  });
  it("leaves generic board replies and S4 followups to the existing path", () => {
    expect(parsePersistentReportReply(reply({ key: "deploy-270" }))).toBeNull();
    expect(parsePersistentReportReply(reply({ key: "deploy-270", option: "가".repeat(13) }))).toBeNull();
    expect(parsePersistentReportReply(reply({ key: "deploy-270", mode: "followup", text: "더", idempotency_key: "k" }))).toBeNull();
    expect(parsePersistentReportReply(reply({ key: "cq_q-1", mode: "followup", text: "더", idempotency_key: "k" }))).toBeNull();
  });
  it("recognizes a card question reply attempt for the ingress guard", () => {
    expect(isCardQuestionReplyContext(reply({ key: "cq_q-1", option: "진행" }))).toBe(true);
    expect(isCardQuestionReplyContext(reply({ key: "cq_q-1" }))).toBe(true);
    expect(isCardQuestionReplyContext(reply({ key: "deploy-270", option: "진행" }))).toBe(false);
    expect(isCardQuestionReplyContext([{ key: "persistent_report_visible", content: { key: "cq_q-1" } }])).toBe(false);
    expect(isCardQuestionReplyContext(undefined)).toBe(false);
  });
});
