import { describe, expect, it } from "vitest";

import { omitInlineImageData } from "../../src/db/omit_inline_image_data.js";

describe("omitInlineImageData", () => {
  it("replaces image data in structured MCP and provider image objects", () => {
    const input = {
      type: "tool_result",
      result: [
        {
          type: "image",
          source: { type: "base64", data: "A".repeat(80), media_type: "image/png" },
        },
        { type: "image", data: "B".repeat(80), mimeType: "image/jpeg" },
      ],
    };

    const transformed = omitInlineImageData(input);
    expect(transformed).toEqual({
      type: "tool_result",
      result: [
        {
          type: "image",
          source: { type: "base64", data: "[omitted image]", media_type: "image/png" },
        },
        { type: "image", data: "[omitted image]", mimeType: "image/jpeg" },
      ],
    });
    expect(input.result[0].source.data).toBe("A".repeat(80));
    expect(omitInlineImageData(transformed)).toBe(transformed);
  });

  it("replaces inline image bytes in JSON and data URL strings", () => {
    const sourceBytes = "A".repeat(300 * 1024);
    const mcpText = JSON.stringify([{
      type: "image",
      source: { type: "base64", data: sourceBytes, media_type: "image/png" },
    }]);
    const dataUrlText = `image=data:image/webp;base64,${"B".repeat(80)}`;

    expect(omitInlineImageData(mcpText)).toBe(
      '[{"type":"image","source":{"type":"base64","data":"[omitted image]","media_type":"image/png"}}]',
    );
    expect(omitInlineImageData(dataUrlText)).toBe("image=data:image/webp;base64,[omitted image]");
  });

  it("replaces base64 in a truncated image JSON string without requiring a closing quote", () => {
    const truncated = `[{"type":"image","source":{"type":"base64","data":"${"C".repeat(80)}\n[잘림]`;

    expect(omitInlineImageData(truncated)).toBe(
      '[{"type":"image","source":{"type":"base64","data":"[omitted image]\n[잘림]',
    );
  });

  it("preserves non-image base64 and ordinary strings", () => {
    const documentBytes = "D".repeat(80);
    const input = {
      type: "tool_result",
      result: [{ type: "document", data: documentBytes }],
      text: "ordinary text",
    };

    expect(omitInlineImageData(input)).toBe(input);
  });
});
