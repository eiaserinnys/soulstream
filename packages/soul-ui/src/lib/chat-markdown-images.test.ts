import { describe, expect, it } from "vitest";
import { buildStructuredChatImageItems, getChatImageFilename } from "./chat-markdown-images";

describe("chat image sources", () => {
  it("keeps only supported image attachment paths and preserves their order", () => {
    const images = buildStructuredChatImageItems([
      "/incoming/first.png",
      "/incoming/readme.txt",
      "/incoming/second.HEIC",
    ], "node / one");

    expect(images).toEqual([
      {
        id: "attachment:0:/incoming/first.png",
        src: "/api/attachments/files?nodeId=node%20%2F%20one&path=%2Fincoming%2Ffirst.png",
        alt: "",
      },
      {
        id: "attachment:2:/incoming/second.HEIC",
        src: "/api/attachments/files?nodeId=node%20%2F%20one&path=%2Fincoming%2Fsecond.HEIC",
        alt: "",
      },
    ]);
  });

  it("does not invent a source node when the event and session lack one", () => {
    expect(buildStructuredChatImageItems(["/incoming/first.png"], undefined)).toEqual([]);
  });

  it("gets a real basename from a protected path query or URL pathname", () => {
    expect(getChatImageFilename("/api/attachments/files?path=%2Fincoming%2Ffirst%20image.png"))
      .toBe("first image.png");
    expect(getChatImageFilename("https://images.test/path/second.png?size=large"))
      .toBe("second.png");
    expect(getChatImageFilename("https://images.test/"))
      .toBeUndefined();
  });
});
