import { describe, expect, it } from "vitest";
import { parsePersistentReportEntry, readPersistentReport, parsePersistentReportReply } from "../../packages/wire-schema/src/persistent_report.js";

const entry = { key: "deploy-270", kind: "ask", title: "배포 결정", card_numbers: [], context: "검증을 마쳤습니다", action: "[결과](https://example.com/result)", options: ["진행", "보류"] };

describe("persistent report shared contract", () => {
  it("uses codepoints, defaults open and permits agent-written answers", () => {
    expect(parsePersistentReportEntry({ ...entry, title: "😀".repeat(24) })).toMatchObject({ ok: true, value: { state: "open", answer: "" } });
    expect(parsePersistentReportEntry({ ...entry, state: "answered", answer: "진행" })).toMatchObject({ ok: true, value: { state: "answered", answer: "진행" } });
  });
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
});
