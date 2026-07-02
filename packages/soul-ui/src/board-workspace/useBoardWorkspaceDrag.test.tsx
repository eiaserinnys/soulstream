/**
 * @vitest-environment jsdom
 */

import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardWorkspaceItem } from "./board-workspace-items";
import { useBoardWorkspaceDrag } from "./useBoardWorkspaceDrag";

const boardItem: BoardWorkspaceItem = {
  type: "folder",
  id: "folder-1",
  boardItemId: "subfolder:folder-1",
  folder: {
    id: "folder-1",
    name: "Folder",
    sortOrder: 0,
    parentFolderId: "root",
    createdAt: "2026-06-01T00:00:00.000Z",
  },
  childCount: 0,
  x: 40,
  y: 80,
};

function dispatchPointer(
  target: EventTarget,
  type: string,
  init: MouseEventInit = {},
) {
  const PointerCtor = window.PointerEvent ?? window.MouseEvent;
  target.dispatchEvent(new PointerCtor(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  }));
}

function Harness({
  callbacks,
}: {
  callbacks: {
    selectBoardItems: ReturnType<typeof vi.fn>;
    toggleBoardItemSelection: ReturnType<typeof vi.fn>;
    clearBoardSelection: ReturnType<typeof vi.fn>;
    raiseBoardItems: ReturnType<typeof vi.fn>;
    updateBoardItemPositions: ReturnType<typeof vi.fn>;
  };
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useBoardWorkspaceDrag({
    scrollRef,
    zoom: 1,
    boardItems: [boardItem],
    selectedBoardItemIds: new Set(),
    resolveBoardPoint: (clientX, clientY) => ({ x: clientX, y: clientY }),
    selectBoardItems: callbacks.selectBoardItems,
    toggleBoardItemSelection: callbacks.toggleBoardItemSelection,
    clearBoardSelection: callbacks.clearBoardSelection,
    raiseBoardItems: callbacks.raiseBoardItems,
    updateBoardItemPositions: callbacks.updateBoardItemPositions,
  });

  return (
    <div ref={scrollRef} data-testid="board-scroll">
      <div
        data-testid="board-tile"
        data-board-tile="true"
        onPointerDown={(event) => drag.handleTilePointerDown(event, boardItem)}
      >
        <label data-testid="status-label">
          <input data-testid="status-checkbox" type="checkbox" />
          완료
        </label>
        <button data-testid="accordion-button" type="button">절차</button>
        <div data-testid="drag-zone">drag from here</div>
      </div>
    </div>
  );
}

describe("useBoardWorkspaceDrag", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  function renderHarness() {
    const callbacks = {
      selectBoardItems: vi.fn(),
      toggleBoardItemSelection: vi.fn(),
      clearBoardSelection: vi.fn(),
      raiseBoardItems: vi.fn(),
      updateBoardItemPositions: vi.fn(),
    };
    flushSync(() => {
      root!.render(createElement(Harness, { callbacks }));
    });
    return callbacks;
  }

  it("does not arm tile selection or drag from interactive descendants", () => {
    const callbacks = renderHarness();
    const label = container!.querySelector<HTMLElement>('[data-testid="status-label"]');
    const button = container!.querySelector<HTMLElement>('[data-testid="accordion-button"]');
    expect(label).not.toBeNull();
    expect(button).not.toBeNull();

    flushSync(() => {
      dispatchPointer(label!, "pointerdown", { clientX: 100, clientY: 100 });
      dispatchPointer(window, "pointermove", { clientX: 140, clientY: 130 });
      dispatchPointer(window, "pointerup", { clientX: 140, clientY: 130 });
      dispatchPointer(button!, "pointerdown", { clientX: 110, clientY: 110 });
      dispatchPointer(window, "pointermove", { clientX: 150, clientY: 140 });
      dispatchPointer(window, "pointerup", { clientX: 150, clientY: 140 });
    });

    expect(callbacks.selectBoardItems).not.toHaveBeenCalled();
    expect(callbacks.raiseBoardItems).not.toHaveBeenCalled();
    expect(callbacks.updateBoardItemPositions).not.toHaveBeenCalled();
  });

  it("still selects, raises, and drags from non-interactive tile space", () => {
    const callbacks = renderHarness();
    const dragZone = container!.querySelector<HTMLElement>('[data-testid="drag-zone"]');
    expect(dragZone).not.toBeNull();

    flushSync(() => {
      dispatchPointer(dragZone!, "pointerdown", { clientX: 100, clientY: 100 });
      dispatchPointer(window, "pointermove", { clientX: 140, clientY: 130 });
      dispatchPointer(window, "pointerup", { clientX: 140, clientY: 130 });
    });

    expect(callbacks.selectBoardItems).toHaveBeenCalledWith(
      ["subfolder:folder-1"],
      "subfolder:folder-1",
    );
    expect(callbacks.raiseBoardItems).toHaveBeenCalledWith(["subfolder:folder-1"]);
    expect(callbacks.updateBoardItemPositions).toHaveBeenCalledWith([
      { boardItemId: "subfolder:folder-1", x: 80, y: 120 },
    ]);
  });
});
