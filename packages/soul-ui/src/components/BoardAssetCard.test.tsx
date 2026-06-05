/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { BoardAssetCard } from "./BoardAssetCard";

function renderCard(props: ComponentProps<typeof BoardAssetCard>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(createElement(BoardAssetCard, props));
  });
  return { container, root };
}

describe("BoardAssetCard", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("renders image assets with an img preview", () => {
    ({ container, root } = renderCard({
      fileName: "photo.png",
      mimeType: "image/png",
      byteSize: 1024,
      signedUrl: "https://r2.example/photo.png",
    }));

    const image = container.querySelector<HTMLImageElement>('[data-testid="board-asset-image"]');
    expect(image?.src).toBe("https://r2.example/photo.png");
    expect(image?.alt).toBe("photo.png");
  });

  it("renders audio assets with metadata preload controls", () => {
    ({ container, root } = renderCard({
      fileName: "song.mp3",
      mimeType: "audio/mpeg",
      signedUrl: "https://r2.example/song.mp3",
    }));

    const audio = container.querySelector<HTMLAudioElement>('[data-testid="board-asset-audio"]');
    expect(audio).not.toBeNull();
    expect(audio?.preload).toBe("metadata");
    expect(audio?.controls).toBe(true);
  });

  it("renders video assets with metadata preload controls", () => {
    ({ container, root } = renderCard({
      fileName: "clip.mp4",
      mimeType: "video/mp4",
      signedUrl: "https://r2.example/clip.mp4",
    }));

    const video = container.querySelector<HTMLVideoElement>('[data-testid="board-asset-video"]');
    expect(video).not.toBeNull();
    expect(video?.preload).toBe("metadata");
    expect(video?.preload).not.toBe("auto");
    expect(video?.controls).toBe(true);
  });

  it("renders general files with a download action", () => {
    ({ container, root } = renderCard({
      fileName: "archive.zip",
      mimeType: "application/zip",
      signedUrl: "https://r2.example/archive.zip",
    }));

    expect(container.querySelector('[data-testid="board-asset-title"]')?.textContent).toBe("archive.zip");
    expect(container.querySelector<HTMLAnchorElement>("a[download='archive.zip']")?.href).toBe(
      "https://r2.example/archive.zip",
    );
  });
});
