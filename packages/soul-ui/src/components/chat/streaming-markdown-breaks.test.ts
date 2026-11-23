import { describe, expect, it } from "vitest";
import { applyStreamingHardBreaks } from "./streaming-markdown-breaks";

describe("applyStreamingHardBreaks", () => {
  it("문단 안의 단일 줄바꿈에 하드 브레이크 표시를 붙인다", () => {
    expect(applyStreamingHardBreaks("한 줄\n다음 줄")).toBe("한 줄  \n다음 줄");
  });

  it("코드 펜스 안의 줄바꿈은 그대로 둔다", () => {
    const markdown = "앞 문단\n```ts\nconst a = 1;\nconst b = 2;\n```\n뒤 문단\n다음 줄";

    // 펜스 여는 줄 앞은 블록 경계라 하드 브레이크를 붙이지 않는다.
    expect(applyStreamingHardBreaks(markdown)).toBe(
      "앞 문단\n```ts\nconst a = 1;\nconst b = 2;\n```\n뒤 문단  \n다음 줄",
    );
  });

  it("빈 줄과 펜스 여는 줄 앞에는 붙이지 않는다", () => {
    expect(applyStreamingHardBreaks("문단\n\n다음 문단")).toBe("문단\n\n다음 문단");
    expect(applyStreamingHardBreaks("문장\n- 목록")).toBe("문장  \n- 목록");
    expect(applyStreamingHardBreaks("문장\n```\n코드\n```")).toBe("문장\n```\n코드\n```");
  });

  it("닫는 펜스 뒤의 줄바꿈은 다시 바꾼다", () => {
    expect(applyStreamingHardBreaks("```\na\n```\n문장\n다음")).toBe("```\na\n```\n문장  \n다음");
  });

  it("줄바꿈이 없으면 그대로 돌려준다", () => {
    expect(applyStreamingHardBreaks("한 줄짜리 글")).toBe("한 줄짜리 글");
  });
});
