/**
 * attachment_converter.ts 단위 테스트.
 *
 * classifyAttachment — 확장자별 3개 분기 (image / text-reference / rejected)
 * composeCodexInput — 변환 결과 목록으로 Codex SDK Input 합성
 */

import { describe, expect, it } from "vitest";
import {
  classifyAttachment,
  composeCodexInput,
} from "../../src/engine/attachment_converter.js";

describe("classifyAttachment — image 분기", () => {
  it(".png → kind:image + userInput.type=local_image", () => {
    const result = classifyAttachment("/tmp/sess-1/1234_image.png");
    expect(result.kind).toBe("image");
    if (result.kind === "image") {
      expect(result.userInput.type).toBe("local_image");
      expect((result.userInput as { type: string; path: string }).path).toBe(
        "/tmp/sess-1/1234_image.png",
      );
      expect(result.path).toBe("/tmp/sess-1/1234_image.png");
    }
  });

  it(".jpg, .jpeg → image", () => {
    expect(classifyAttachment("/tmp/a.jpg").kind).toBe("image");
    expect(classifyAttachment("/tmp/a.jpeg").kind).toBe("image");
  });

  it(".gif, .webp, .bmp → image", () => {
    expect(classifyAttachment("/tmp/a.gif").kind).toBe("image");
    expect(classifyAttachment("/tmp/a.webp").kind).toBe("image");
    expect(classifyAttachment("/tmp/a.bmp").kind).toBe("image");
  });

  it("대문자 확장자도 image로 분류 (대소문자 무시)", () => {
    expect(classifyAttachment("/tmp/a.PNG").kind).toBe("image");
    expect(classifyAttachment("/tmp/a.JPG").kind).toBe("image");
  });
});

describe("classifyAttachment — text-reference 분기", () => {
  it(".txt → kind:text-reference + quotedText 형식", () => {
    const result = classifyAttachment("/tmp/sess-1/1234_note.txt");
    expect(result.kind).toBe("text-reference");
    if (result.kind === "text-reference") {
      expect(result.quotedText).toBe("- /tmp/sess-1/1234_note.txt");
      expect(result.path).toBe("/tmp/sess-1/1234_note.txt");
    }
  });

  it(".md, .json, .yaml, .yml → text-reference", () => {
    expect(classifyAttachment("/tmp/a.md").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.json").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.yaml").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.yml").kind).toBe("text-reference");
  });

  it(".py, .ts, .tsx, .js, .jsx → text-reference", () => {
    expect(classifyAttachment("/tmp/a.py").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.ts").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.tsx").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.js").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.jsx").kind).toBe("text-reference");
  });

  it(".go, .rs, .java, .c, .cpp, .h, .hpp → text-reference", () => {
    expect(classifyAttachment("/tmp/a.go").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.rs").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.java").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.c").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.cpp").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.h").kind).toBe("text-reference");
    expect(classifyAttachment("/tmp/a.hpp").kind).toBe("text-reference");
  });

  it(".csv, .log, .toml, .ini, .conf, .sh, .html, .css, .sql → text-reference", () => {
    for (const ext of [".csv", ".log", ".toml", ".ini", ".conf", ".sh", ".html", ".css", ".sql"]) {
      expect(classifyAttachment(`/tmp/a${ext}`).kind).toBe("text-reference");
    }
  });
});

describe("classifyAttachment — rejected 분기", () => {
  it(".pdf → kind:rejected + reason에 확장자 명시", () => {
    const result = classifyAttachment("/tmp/sess-1/1234_doc.pdf");
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain(".pdf");
      expect(result.path).toBe("/tmp/sess-1/1234_doc.pdf");
    }
  });

  it(".docx, .exe, .zip → rejected", () => {
    expect(classifyAttachment("/tmp/a.docx").kind).toBe("rejected");
    expect(classifyAttachment("/tmp/a.exe").kind).toBe("rejected");
    expect(classifyAttachment("/tmp/a.zip").kind).toBe("rejected");
  });

  it("확장자 없음 → rejected + reason에 '(확장자 없음)' 포함", () => {
    const result = classifyAttachment("/tmp/sess-1/1234_noext");
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.reason).toContain("(확장자 없음)");
    }
  });
});

describe("composeCodexInput — image 0개 + text 0개 (빈 배열)", () => {
  it("conversions 빈 배열 → string prompt 그대로 반환", () => {
    const result = composeCodexInput("hello world", []);
    expect(typeof result).toBe("string");
    expect(result).toBe("hello world");
  });
});

describe("composeCodexInput — image 0개 + text-reference N개", () => {
  it("text-reference 1개 → string에 인용 append (Python attachment_helpers.py 형식 정합)", () => {
    const result = composeCodexInput("내 파일을 봐줘", [
      { kind: "text-reference", path: "/tmp/a.py", quotedText: "- /tmp/a.py" },
    ]);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("내 파일을 봐줘");
    expect(result as string).toContain("다음 파일들이 첨부되었습니다. Read 도구로 내용을 확인하세요:");
    expect(result as string).toContain("- /tmp/a.py");
  });

  it("text-reference 2개 → string에 모두 인용", () => {
    const result = composeCodexInput("두 파일", [
      { kind: "text-reference", path: "/tmp/a.py", quotedText: "- /tmp/a.py" },
      { kind: "text-reference", path: "/tmp/b.ts", quotedText: "- /tmp/b.ts" },
    ]);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("- /tmp/a.py");
    expect(result as string).toContain("- /tmp/b.ts");
  });
});

describe("composeCodexInput — image N개 + text 0개", () => {
  it("image 1개 → UserInput[] 반환 (첫 항목 type:text, 두 번째 local_image)", () => {
    const result = composeCodexInput("이미지 봐줘", [
      {
        kind: "image",
        path: "/tmp/a.png",
        userInput: { type: "local_image", path: "/tmp/a.png" },
      },
    ]);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<{ type: string; text?: string; path?: string }>;
    expect(arr).toHaveLength(2);
    expect(arr[0].type).toBe("text");
    expect(arr[0].text).toBe("이미지 봐줘");
    expect(arr[1].type).toBe("local_image");
    expect(arr[1].path).toBe("/tmp/a.png");
  });

  it("image 2개 → UserInput[] 길이 3 (text + 2 local_image)", () => {
    const result = composeCodexInput("두 이미지", [
      {
        kind: "image",
        path: "/tmp/a.png",
        userInput: { type: "local_image", path: "/tmp/a.png" },
      },
      {
        kind: "image",
        path: "/tmp/b.jpg",
        userInput: { type: "local_image", path: "/tmp/b.jpg" },
      },
    ]);
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(3);
  });
});

describe("composeCodexInput — image N개 + text-reference M개 mixed", () => {
  it("image 1 + text 1 → UserInput[] 길이 2, 첫 항목 text에 text-ref 인용 포함", () => {
    const result = composeCodexInput("이미지와 파일", [
      {
        kind: "image",
        path: "/tmp/a.png",
        userInput: { type: "local_image", path: "/tmp/a.png" },
      },
      { kind: "text-reference", path: "/tmp/b.py", quotedText: "- /tmp/b.py" },
    ]);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<{ type: string; text?: string; path?: string }>;
    expect(arr[0].type).toBe("text");
    expect(arr[0].text).toContain("이미지와 파일");
    expect(arr[0].text).toContain("다음 파일들이 첨부되었습니다");
    expect(arr[0].text).toContain("- /tmp/b.py");
    expect(arr[1].type).toBe("local_image");
    expect(arr[1].path).toBe("/tmp/a.png");
  });
});

describe("composeCodexInput — rejected 분기는 무시됨 (이미 codex_adapter에서 early-return)", () => {
  it("rejected만 들어와도 string prompt 반환 (codex_adapter에서 rejected 차단 전제)", () => {
    // codex_adapter는 rejected 있으면 early-return하므로 composeCodexInput에 rejected가
    // 들어오는 일은 없어야 한다. 하지만 함수 자체는 rejected를 무시하고 나머지만 처리.
    const result = composeCodexInput("test", [
      { kind: "rejected", path: "/tmp/a.pdf", reason: "지원하지 않는 형식: .pdf" },
    ]);
    // image 없으므로 string 반환
    expect(typeof result).toBe("string");
    expect(result).toBe("test");
  });
});
