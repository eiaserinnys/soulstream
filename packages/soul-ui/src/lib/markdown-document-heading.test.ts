import { describe, expect, it } from "vitest";
import { removeOverlappingDocumentHeading } from "./markdown-document-heading";

const headingCases: Array<[string, string, string]> = [
  ["계획", "# 계획\n\n본문", "본문"],
  [
    "#270 계획 갱신 v4 (2026-10-12): 지금 PAS 응답에 맞춘 범위와 순서",
    "# #270 계획 갱신 v4 (2026-10-12)\n\n본문",
    "본문",
  ],
  ["계획", "# 계획 갱신 v4\n\n본문", "본문"],
  ["#270 PAS 누적 응답 뷰 설계 검토", "# PAS 누적 응답 뷰 설계 검토\n\n본문", "본문"],
  ["설계 검토", "# PAS 누적 응답 뷰 설계 검토\n\n본문", "본문"],
  ["주간 보고 정리본", "# 보고\n\n본문", "# 보고\n\n본문"],
  ["계획", "# 전혀 다른 제목\n\n본문", "# 전혀 다른 제목\n\n본문"],
  ["계획", "본문만 있음", "본문만 있음"],
  ["계획", "## 계획\n\n본문", "## 계획\n\n본문"],
  ["계획", "\n\n# 계획\n\n\n본문", "본문"],
  ["계획", "    # 계획\n\n본문", "    # 계획\n\n본문"],
  ["계획   갱신", "#  계획 갱신\n본문", "본문"],
  ["계획", "", ""],
  ["", "# 계획\n\n본문", "# 계획\n\n본문"],
];

describe("removeOverlappingDocumentHeading", () => {
  it.each(headingCases)("handles title %s and body %s", (title, body, expected) => {
    expect(removeOverlappingDocumentHeading(body, title)).toBe(expected);
  });
});
