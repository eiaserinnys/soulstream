/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SessionFilesDiffReviewSample } from "./SessionFilesDiffReviewSample";

vi.mock("@seosoyoung/soul-ui", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  DashboardIconCap: ({ label, children, ...props }: any) => <button aria-label={label} {...props}>{children}</button>,
  DisclosureActionIcon: () => <span/>,
  FrameLoading: () => null,
  formatWorkspaceTime: (value: string) => value,
}));
vi.mock("@seosoyoung/soul-ui/components/AttachmentViewer", () => ({ AttachmentViewer: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it("shows the real panel in each diff review state without a server", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<SessionFilesDiffReviewSample/>); });
  for (const [scene, expected] of [
    ["added", "새 파일"], ["deleted", "지움"], ["renamed", "바뀐 내용 없음"],
    ["binary", "바이너리 파일"], ["truncated", "앞 512KiB만 보입니다"],
    ["loading", "변경분을 읽는 중"], ["error", "변경분을 불러오지 못했습니다"],
    ["unsupported", "이 노드는 아직 변경분을 보이지 않습니다"],
  ]) {
    const pane = host.querySelector(`[data-session-files-scene="${scene}"]`)!;
    expect(pane.textContent + pane.innerHTML).toContain(expected);
  }
  await act(async () => root.unmount()); host.remove();
});
