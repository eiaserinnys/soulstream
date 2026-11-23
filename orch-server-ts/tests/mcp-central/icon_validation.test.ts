import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MCP_ICON_COLORS,
  MCP_ICON_MAX_BYTES,
  MCP_ICON_SYMBOL_NAMES,
  brandIconHexForSlug,
  parseIconUpload,
  validateIcon,
} from "../../src/mcp_central/icon_validation.js";
import { base64, jpegBytes, pngBytes, webpBytes } from "./test_images.js";

function expectInvalidIcon(input: unknown): void {
  expect(() => validateIcon(input)).toThrow(expect.objectContaining({
    code: "MCP_INVALID_ICON",
    statusCode: 400,
  }));
}

function expectInvalidUpload(input: unknown): void {
  expect(() => parseIconUpload(input)).toThrow(expect.objectContaining({
    code: "MCP_INVALID_ICON_UPLOAD",
    statusCode: 400,
  }));
}

describe("icon validation", () => {
  it("accepts a known brand slug and confirms hex from the catalog", () => {
    const catalogHex = brandIconHexForSlug("github");
    expect(catalogHex).not.toBeNull();

    const icon = validateIcon({ kind: "brand", slug: "github", hex: "#000000" });

    expect(icon).toEqual({ kind: "brand", slug: "github", hex: catalogHex });
  });

  it("rejects an unknown brand slug", () => {
    expectInvalidIcon({ kind: "brand", slug: "definitely-not-a-real-brand-xyz" });
  });

  it("accepts all 24 symbols with all 8 colors", () => {
    expect(MCP_ICON_SYMBOL_NAMES).toHaveLength(24);
    expect(MCP_ICON_COLORS).toHaveLength(8);
    for (const name of MCP_ICON_SYMBOL_NAMES) {
      for (const color of MCP_ICON_COLORS) {
        expect(validateIcon({ kind: "symbol", name, color })).toEqual({
          kind: "symbol",
          name,
          color,
        });
      }
    }
  });

  it("rejects symbol values outside the curated lists", () => {
    expectInvalidIcon({ kind: "symbol", name: "not-a-symbol", color: "node-user" });
    expectInvalidIcon({ kind: "symbol", name: "layers", color: "not-a-color" });
    expectInvalidIcon({ kind: "symbol", name: "layers", color: "--node-user" });
  });

  it("treats a missing icon as no icon", () => {
    expect(validateIcon(null)).toBeNull();
    expect(validateIcon(undefined)).toBeNull();
  });

  it("accepts PNG, JPEG and WebP uploads", () => {
    const png = pngBytes(32, 16);
    expect(parseIconUpload({ data_base64: base64(png) })).toMatchObject({
      mime: "image/png",
      width: 32,
      height: 16,
      content_hash: createHash("sha256").update(png).digest("hex"),
    });
    expect(parseIconUpload({ data_base64: base64(jpegBytes(64, 48)) })).toMatchObject({
      mime: "image/jpeg",
      width: 64,
      height: 48,
    });
    expect(parseIconUpload({ data_base64: base64(webpBytes(12, 24)) })).toMatchObject({
      mime: "image/webp",
      width: 12,
      height: 24,
    });
  });

  it("accepts the maximum size and rejects SVG, GIF, oversize and bad encodings", () => {
    expect(parseIconUpload({ data_base64: base64(pngBytes(512, 512)) })).toMatchObject({
      width: 512,
      height: 512,
    });

    expectInvalidUpload({ data_base64: base64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) });
    expectInvalidUpload({ data_base64: base64(Buffer.from("GIF89a", "ascii")) });

    const oversize = Buffer.concat([pngBytes(1, 1), Buffer.alloc(MCP_ICON_MAX_BYTES)]);
    expectInvalidUpload({ data_base64: base64(oversize) });
    expectInvalidUpload({ data_base64: base64(pngBytes(513, 1)) });
    expectInvalidUpload({ data_base64: base64(pngBytes(1, 513)) });

    const encoded = base64(pngBytes(8, 8));
    expectInvalidUpload({ data_base64: `${encoded.slice(0, -1)}!` });

    const png = pngBytes(8, 8);
    expectInvalidUpload({ data_base64: base64(png), sha256: "0".repeat(64) });
    expect(() => parseIconUpload({
      data_base64: base64(png),
      sha256: createHash("sha256").update(png).digest("hex"),
    })).not.toThrow();
  });
});
