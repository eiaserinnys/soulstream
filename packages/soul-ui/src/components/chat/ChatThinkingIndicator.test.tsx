import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatThinkingIndicator } from "./ChatThinkingIndicator";

describe("ChatThinkingIndicator", () => {
  it("20px working orb와 세로 중앙 정렬된 작은 안내 문구를 말풍선에 표시한다", () => {
    const markup = renderToStaticMarkup(<ChatThinkingIndicator />);

    expect(markup).toContain('data-slot="chat-thinking-indicator"');
    expect(markup).toContain('aria-label="생각 중입니다"');
    expect(markup).toContain('data-thinking-orb-state="working"');
    expect(markup).toContain('style="width:20px;height:20px;display:block"');
    expect(markup).toContain("items-center");
    expect(markup).toContain("text-xs");
    expect(markup).toContain("생각 중입니다…");
  });
});
