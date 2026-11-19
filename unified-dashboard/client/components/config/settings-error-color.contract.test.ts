import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 설정 창 인라인 오류 글색 계약 (카드 #1691).
 * 글자색은 --destructive-foreground 만 쓴다. 오류 상자의 bg-/border- 는 그대로 둔다.
 */
function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

const TARGETS = [
  "../ConfigModal.tsx",
  "./SettingsListDetail.tsx",
  "./access-links.css",
  "../AgentProfileEditorTab.tsx",
  "../UserManagementTab.tsx",
  "./ConfigResultMessage.tsx",
  "../CardDispatchTab.tsx",
  "../FileStorageTab.tsx",
  "../UsageLogTab.tsx",
  "../SessionReviewPolicyTab.tsx",
  "../CardOrchestrationSettingsForm.tsx",
  "../ContextBundleEditor.tsx",
  "../OwnedAgentsTab.tsx",
] as const;

const VIOLATIONS = [
  { name: "text-accent-red", pattern: /text-accent-red/ },
  { name: "text-destructive", pattern: /text-destructive(?![-a-z])/ },
  { name: "color:var(--destructive)", pattern: /color\s*:\s*var\(\s*--destructive\s*\)/ },
];

function violations(text: string): string[] {
  return VIOLATIONS.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
}

describe("settings inline error text color contract", () => {
  it("catches each old error color and allows the box colors", () => {
    expect(violations('<p className="text-accent-red">오류</p>')).toEqual(["text-accent-red"]);
    expect(violations('<p className="text-destructive">오류</p>')).toEqual(["text-destructive"]);
    expect(violations('<p className="text-sm text-destructive">오류</p>')).toEqual(["text-destructive"]);
    expect(violations(".field small { color:var(--destructive); }")).toEqual(["color:var(--destructive)"]);
    expect(violations('<p className="text-destructive-foreground">오류</p>')).toEqual([]);
    expect(violations('<div className="bg-accent-red/10 border-accent-red/30">오류</div>')).toEqual([]);
  });

  it.each(TARGETS)("uses --destructive-foreground for inline error text in %s", (name) => {
    expect(violations(source(name))).toEqual([]);
  });

  const lightOverride =
    /:root:not\(\.dark\)\s+\.approved-dialog\s*\{[^}]*--destructive-foreground\s*:\s*var\(--color-red-800\)/;

  it("redefines --destructive-foreground to red-800 in the light approved-dialog scope", () => {
    expect(lightOverride.test(source("./config-layout.css"))).toBe(true);
  });

  it("catches a missing override or one that also hits the dark theme", () => {
    expect(lightOverride.test(":root { --destructive-foreground: var(--color-red-700); }")).toBe(false);
    expect(lightOverride.test(".dark .approved-dialog { --destructive-foreground: var(--color-red-800); }")).toBe(false);
    expect(
      lightOverride.test(":root:not(.dark) .approved-dialog { --destructive-foreground: var(--color-red-700); }"),
    ).toBe(false);
  });
});
