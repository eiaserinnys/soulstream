import { describe, expect, it } from "vitest";
import { attachmentImageReadingFor } from "./AttachmentViewerImage";

describe("attachmentImageReadingFor", () => {
  it("reads a long phone capture at width fit with vertical scrolling", () => {
    expect(attachmentImageReadingFor({ width: 1170, height: 7200 }, { width: 1848, height: 900 }, 448))
      .toEqual({ axis: "y", frame: "column" });
  });

  it("reads a wide capture at height fit with horizontal scrolling", () => {
    expect(attachmentImageReadingFor({ width: 7200, height: 600 }, { width: 1848, height: 900 }, 448))
      .toEqual({ axis: "x", frame: "full" });
  });

  it("keeps an ordinary aspect image in the whole-image layout", () => {
    expect(attachmentImageReadingFor({ width: 800, height: 600 }, { width: 1200, height: 700 }, 448))
      .toBeNull();
  });

  it("does not upscale a small image to reach the reference width", () => {
    expect(attachmentImageReadingFor({ width: 100, height: 400 }, { width: 900, height: 700 }, 448))
      .toBeNull();
    expect(attachmentImageReadingFor({ width: 320, height: 240 }, { width: 300, height: 500 }, 280))
      .toBeNull();
  });

  it("switches to reading only when whole fit makes the short side under half the reference", () => {
    const reference = 448;
    // read = 448 / 2000 = 0.224, so whole = 224 / 2000 is exactly the half-way limit.
    expect(attachmentImageReadingFor({ width: 2000, height: 4000 }, { width: 224, height: 700 }, reference))
      .toBeNull();
    expect(attachmentImageReadingFor({ width: 2000, height: 4000 }, { width: 223, height: 700 }, reference))
      .toEqual({ axis: "y", frame: "column" });
  });

  it("returns null before the picture limits are measurable", () => {
    expect(attachmentImageReadingFor({ width: 0, height: 7200 }, { width: 1848, height: 900 }, 448)).toBeNull();
    expect(attachmentImageReadingFor({ width: 1170, height: 7200 }, { width: 0, height: 900 }, 448)).toBeNull();
    expect(attachmentImageReadingFor({ width: 1170, height: 7200 }, { width: 1848, height: 900 }, 0)).toBeNull();
  });
});
