/**
 * @vitest-environment jsdom
 */

import { createElement, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwayCharacter } from "./SwayCharacter";

describe("SwayCharacter", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let reducedMotion = false;
  const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();

  beforeEach(() => {
    reducedMotion = false;
    mediaListeners.clear();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
      media: query,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
      removeEventListener: vi.fn(),
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  function render(props: Partial<ComponentProps<typeof SwayCharacter>> = {}) {
    flushSync(() => root?.render(createElement(SwayCharacter, {
      width: 184,
      height: 276,
      shown: true,
      motionEnabled: true,
      active: true,
      assetBaseUrl: "/characters/seosoyoung",
      ...props,
    })));
  }

  it("shows still art until the same-origin host reports its first frame", () => {
    render();

    const still = container?.querySelector<HTMLImageElement>("img");
    const frame = container?.querySelector<HTMLIFrameElement>("iframe");
    expect(still?.getAttribute("src")).toBe("/characters/seosoyoung/still.png");
    expect(still?.hidden).toBe(false);
    expect(frame?.getAttribute("src")).toBe("/characters/seosoyoung/index.html");

    flushSync(() => window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: frame?.contentWindow,
      data: { type: "sway-character:ready" },
    })));

    expect(still?.hidden).toBe(true);
    expect(frame?.hidden).toBe(false);
  });

  it("does not mount the animation host when motion is disabled or reduced", () => {
    render({ motionEnabled: false });
    expect(container?.querySelector("iframe")).toBeNull();
    expect(container?.querySelector("img")?.hidden).toBe(false);

    reducedMotion = true;
    for (const listener of mediaListeners) listener(new Event("change") as MediaQueryListEvent);
    expect(container?.querySelector("iframe")).toBeNull();
    expect(container?.querySelector("img")?.hidden).toBe(false);
  });

  it("pauses and resumes the active state through the host boundary", () => {
    render();
    const frame = container?.querySelector<HTMLIFrameElement>("iframe");
    const postMessage = vi.spyOn(frame!.contentWindow!, "postMessage");

    render({ active: false });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "sway-character:state",
      shown: true,
      motionEnabled: true,
      active: false,
    }, window.location.origin);

    render({ active: true });
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "sway-character:state",
      shown: true,
      motionEnabled: true,
      active: true,
    }, window.location.origin);
  });

  it("keeps the still image when the host reports an asset or renderer error", () => {
    render();
    const frame = container?.querySelector<HTMLIFrameElement>("iframe");
    const still = container?.querySelector<HTMLImageElement>("img");

    flushSync(() => window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: frame?.contentWindow,
      data: { type: "sway-character:error" },
    })));

    expect(container?.querySelector("iframe")).toBeNull();
    expect(still?.hidden).toBe(false);
  });
});
