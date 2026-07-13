/** @vitest-environment jsdom */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LegacyFolderProjection, SessionSummary } from "@seosoyoung/soul-ui";
import { V2LegacyFolderSurface } from "./V2LegacyFolderSurface";

const SCREENSHOT_ROW_HEIGHTS = new Map([
  ["session-0", 104],
  ["session-1", 72],
  ["session-2", 88],
  ["session-3", 56],
]);

function domRect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function projection(count: number): Extract<LegacyFolderProjection, { status: "ready" }> {
  const rows = Array.from({ length: count }, (_, index) => {
    const session: SessionSummary = {
      agentSessionId: `session-${index}`,
      status: index % 2 === 0 ? "running" : "completed",
      eventCount: 0,
      prompt: `Session ${index}`,
    };
    return {
      kind: "session" as const,
      id: session.agentSessionId,
      depth: 0,
      title: session.prompt!,
      session,
    };
  });
  return {
    status: "ready",
    folder: { id: "folder-a", name: "Legacy folder", sortOrder: 0 },
    rows,
    readOnly: true,
  };
}

function screenshotProjection(): Extract<LegacyFolderProjection, { status: "ready" }> {
  const details = [
    {
      displayName: "공식 홈페이지(emberandblade.com 랜딩)의 일본어·중국어 번역 2차 감수와 위험 표현 확인",
      prompt: "게임의 공식 인게임 로컬라이제이션 문맥과 기존 번역 메모를 함께 대조해 주세요.",
      agentName: "서소영 (Fable)",
      nodeId: "eias-linegames",
    },
    {
      displayName: "EB 공식 홈페이지 리뷰",
      prompt: "짧은 세션",
      agentName: "키키",
      nodeId: "eiaserinnys",
    },
    {
      displayName: "이 노드에서 arbor MCP 서버로 게임 데이터를 조회할 수 있는지 점검해 주세요",
      prompt: "읽기 전용 도구의 연결과 접근 가능한 리소스를 확인합니다.",
      agentName: "서소영 (Opus)",
      nodeId: "eias-linegames-wsl",
    },
    {
      displayName: "리뷰 요청",
      prompt: undefined,
      agentName: undefined,
      nodeId: undefined,
    },
  ];
  const rows = details.map((detail, index) => {
    const session: SessionSummary = {
      agentSessionId: `session-${index}`,
      displayName: detail.displayName,
      prompt: detail.prompt,
      status: index === 0 ? "interrupted" : "completed",
      eventCount: 0,
      agentName: detail.agentName,
      nodeId: detail.nodeId,
    };
    return {
      kind: "session" as const,
      id: session.agentSessionId,
      depth: 0,
      title: detail.displayName,
      session,
    };
  });
  return {
    status: "ready",
    folder: { id: "folder-a", name: "엠버 앤 블레이드 프로덕션", sortOrder: 0 },
    rows,
    readOnly: true,
  };
}

describe("V2LegacyFolderSurface", () => {
  let container: HTMLDivElement;
  let root: Root;
  let heightSpy: ReturnType<typeof vi.spyOn>;
  let widthSpy: ReturnType<typeof vi.spyOn>;
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rowId = this.getAttribute("data-legacy-row");
      if (rowId) return domRect(800, SCREENSHOT_ROW_HEIGHTS.get(rowId) ?? 56);
      if (this.getAttribute("role") === "tree") return domRect(800, 600);
      return domRect(800, 0);
    });
    heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getBoundingClientRect().height;
    });
    widthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getBoundingClientRect().width;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    heightSpy.mockRestore();
    widthSpy.mockRestore();
    rectSpy.mockRestore();
  });

  it("keeps a 2,000-session read-only projection virtualized", () => {
    flushSync(() => root.render(createElement(V2LegacyFolderSurface, {
      state: { status: "ready", projection: projection(2_000) },
      lens: "running",
      onLensChange: vi.fn(),
      onOpenFolder: vi.fn(),
      onOpenSession: vi.fn(),
    })));
    const mounted = container.querySelectorAll("[data-legacy-row]");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(40);
    expect(container.textContent).toContain("Read-only virtual page");
    expect(container.querySelector("textarea, input")).toBeNull();
  });

  it("uses measured screenshot-height rows with zero geometric overlap", () => {
    flushSync(() => root.render(createElement(V2LegacyFolderSurface, {
      state: { status: "ready", projection: screenshotProjection() },
      lens: "default",
      onLensChange: vi.fn(),
      onOpenFolder: vi.fn(),
      onOpenSession: vi.fn(),
    })));

    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-legacy-row]"));
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.getAttribute("data-index"))).toEqual(["0", "1", "2", "3"]);
    for (let index = 0; index < rows.length - 1; index += 1) {
      const current = rows[index];
      const next = rows[index + 1];
      const currentStart = Number(current.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1]);
      const nextStart = Number(next.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1]);
      const overlap = currentStart + current.getBoundingClientRect().height - nextStart;
      expect(overlap, `${current.dataset.legacyRow} overlaps ${next.dataset.legacyRow}`).toBeLessThanOrEqual(-8);
    }

    const first = rows[0].querySelector<HTMLElement>("[data-session-ref]")!;
    expect(first.getAttribute("data-session-ref-wrap")).toBe("true");
    expect(first.querySelectorAll(".truncate")).toHaveLength(0);
    expect(first.textContent).toContain("게임의 공식 인게임 로컬라이제이션 문맥");
  });

  it("separates authentication, forbidden, missing, and empty states", () => {
    for (const [status, message] of [
      ["authentication", "Sign in again"],
      ["forbidden", "do not have access"],
      ["missing", "no longer exists"],
      ["empty", "Nothing is stored"],
    ] as const) {
      flushSync(() => root.render(createElement(V2LegacyFolderSurface, {
        state: { status, message },
        lens: "default",
        onLensChange: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenSession: vi.fn(),
      })));
      expect(container.textContent).toContain(message);
    }
  });
});
