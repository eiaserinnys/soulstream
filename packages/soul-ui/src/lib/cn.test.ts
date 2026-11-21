import { describe, expect, it } from "vitest";

import { cn } from "./cn";

// 카드 #1735 R1: 곡률 이름(root, floor, mark, in-N)이 tailwind-merge의 곡률 그룹으로
// 등록됐는지 확인한다. 등록 전에는 cn("rounded-full", "rounded-floor")가 둘 다 남아
// 카드 질문 장의 선택지가 알약으로 그려졌다.
describe("cn — 곡률 클래스 합치기", () => {
  it("곡률 이름은 마지막 하나만 남긴다", () => {
    expect(cn("rounded-full rounded-floor")).toBe("rounded-floor");
    expect(cn("rounded-floor", "rounded-full")).toBe("rounded-full");
    expect(cn("rounded-root", "rounded-floor")).toBe("rounded-floor");
    expect(cn("rounded-floor", "rounded-root")).toBe("rounded-root");
    expect(cn("rounded-mark", "rounded-root")).toBe("rounded-root");
    expect(cn("rounded-in-4", "rounded-mark")).toBe("rounded-mark");
    expect(cn("rounded-mark", "rounded-in-4")).toBe("rounded-in-4");
    expect(cn("rounded-in-4", "rounded-full")).toBe("rounded-full");
  });

  it("동심 단계끼리도 하나만 남긴다", () => {
    expect(cn("rounded-in-4", "rounded-in-8")).toBe("rounded-in-8");
  });

  it("곡률과 none도 마지막 하나만 남긴다", () => {
    expect(cn("rounded-mark", "rounded-none")).toBe("rounded-none");
    expect(cn("rounded-none", "rounded-mark")).toBe("rounded-mark");
  });

  it("방향 변형도 같은 값으로 합친다", () => {
    expect(cn("rounded-t-full", "rounded-t-floor")).toBe("rounded-t-floor");
    expect(cn("rounded-bl-root", "rounded-bl-mark")).toBe("rounded-bl-mark");
    expect(cn("before:rounded-mark", "before:rounded-none")).toBe("before:rounded-none");
  });

  it("곡률 밖 클래스는 그대로 둔다", () => {
    expect(cn("p-2 rounded-floor hover:bg-accent", "p-3")).toBe("rounded-floor hover:bg-accent p-3");
  });
});
