/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { extractClipboardFiles, handleClipboardFiles } from "./clipboard-files";

function clipboard(files: File[], itemFiles = files) {
  return { files, items: itemFiles.map(file => ({ kind: "file", type: file.type, getAsFile: () => file })) } as unknown as DataTransfer;
}
describe("clipboard attachment files", () => {
  it("uses image items once and gives generic clipboard images unique MIME extensions", () => {
    const image = new File(["png"], "image", { type: "image/png" });
    const first = extractClipboardFiles(clipboard([image]))[0];
    const second = extractClipboardFiles(clipboard([image]))[0];
    expect(first.name).toMatch(/^clipboard-.+\.png$/);
    expect(second.name).not.toBe(first.name);
    expect(first.type).toBe("image/png");
    expect(first.size).toBe(image.size);
    expect(extractClipboardFiles(clipboard([image]))).toHaveLength(1);
  });
  it("falls back to files and preserves named images and non-image files", () => {
    const image = new File(["jpeg"], "", { type: "image/jpeg" });
    const named = new File(["png"], "capture.png", { type: "image/png" });
    const pdf = new File(["pdf"], "report.pdf", { type: "application/pdf" });
    const result = extractClipboardFiles(clipboard([image, named, pdf], []));
    expect(result[0].name).toMatch(/\.jpg$/);
    expect(result.slice(1)).toEqual([named, pdf]);
  });
  it("prefers image items when clipboard files also expose them", () => {
    const item = new File(["png"], "image.png", { type: "image/png" });
    const fallback = new File(["png"], "image.png", { type: "image/png" });
    const pdf = new File(["pdf"], "file.pdf", { type: "application/pdf" });
    expect(extractClipboardFiles(clipboard([fallback, pdf], [item]))).toEqual([expect.any(File), pdf]);
  });
  it("leaves ordinary text paste alone and sends existing file paste through addFiles", () => {
    const preventDefault = vi.fn(), addFiles = vi.fn();
    handleClipboardFiles({ clipboardData: clipboard([]), preventDefault }, addFiles);
    expect(preventDefault).not.toHaveBeenCalled();
    const file = new File(["text"], "notes.txt", { type: "text/plain" });
    handleClipboardFiles({ clipboardData: clipboard([file]), preventDefault }, addFiles);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(addFiles).toHaveBeenCalledWith([file]);
  });
});
