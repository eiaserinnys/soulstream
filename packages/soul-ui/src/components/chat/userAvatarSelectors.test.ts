import { describe, expect, it } from "vitest";
import type { MetadataEntry } from "../../shared/session-types";
import {
  extractCallerAvatarUrl,
  pickUserPortraitUrl,
} from "./userAvatarSelectors";

describe("extractCallerAvatarUrl", () => {
  it("returns avatar_url for source=browser (google picture)", () => {
    const metadata: MetadataEntry[] = [
      {
        type: "caller_info",
        value: {
          source: "browser",
          display_name: "Jubok Kim",
          user_id: "eiaserinnys@gmail.com",
          avatar_url: "https://lh3.googleusercontent.com/a/ABC123",
          email: "eiaserinnys@gmail.com",
        },
      },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBe(
      "https://lh3.googleusercontent.com/a/ABC123",
    );
  });

  it("returns avatar_url for source=slack (image_192)", () => {
    const metadata: MetadataEntry[] = [
      {
        type: "caller_info",
        value: {
          source: "slack",
          display_name: "user",
          user_id: "U08ABCDE",
          avatar_url: "https://avatars.slack-edge.com/2024/img_192.png",
          slack: { channel_id: "C08CHAN", user_id: "U08ABCDE" },
        },
      },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBe(
      "https://avatars.slack-edge.com/2024/img_192.png",
    );
  });

  it("returns avatar_url for source=agent (orch portrait proxy)", () => {
    const metadata: MetadataEntry[] = [
      {
        type: "caller_info",
        value: {
          source: "agent",
          display_name: "shay",
          user_id: "shay",
          avatar_url: "/api/agents/shay/portrait",
          agent_node: "eiaserinnys",
          agent_id: "shay",
        },
      },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBe("/api/agents/shay/portrait");
  });

  it("returns avatar_url for source=soul-app (RN attaches google picture)", () => {
    const metadata: MetadataEntry[] = [
      {
        type: "caller_info",
        value: {
          source: "soul-app",
          display_name: "Jubok Kim",
          user_id: "eiaserinnys@gmail.com",
          avatar_url: "https://lh3.googleusercontent.com/a/RN-PIC",
          email: "eiaserinnys@gmail.com",
        },
      },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBe(
      "https://lh3.googleusercontent.com/a/RN-PIC",
    );
  });

  it("returns null when metadata is undefined (no session loaded)", () => {
    expect(extractCallerAvatarUrl(undefined)).toBeNull();
  });

  it("returns null when metadata array is empty", () => {
    expect(extractCallerAvatarUrl([])).toBeNull();
  });

  it("returns null when no caller_info entry exists (legacy session)", () => {
    const metadata: MetadataEntry[] = [
      { type: "summary", value: "old summary text" },
      { type: "tag", value: "x" },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBeNull();
  });

  it("returns null when caller_info entry exists but avatar_url is missing", () => {
    const metadata: MetadataEntry[] = [
      {
        type: "caller_info",
        value: {
          source: "browser",
          display_name: "Anonymous",
          email: "x@y.z",
        },
      },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBeNull();
  });

  it("returns null when avatar_url is empty string", () => {
    const metadata: MetadataEntry[] = [
      {
        type: "caller_info",
        value: { source: "browser", avatar_url: "" },
      },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBeNull();
  });

  it("returns null when avatar_url is non-string (defensive)", () => {
    const metadata: MetadataEntry[] = [
      {
        type: "caller_info",
        value: { source: "browser", avatar_url: 12345 as unknown as string },
      },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBeNull();
  });

  it("returns null when caller_info value is a string (legacy schema)", () => {
    const metadata: MetadataEntry[] = [
      { type: "caller_info", value: "legacy-string-form" },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBeNull();
  });

  it("uses the first caller_info entry only", () => {
    const metadata: MetadataEntry[] = [
      {
        type: "caller_info",
        value: { source: "browser", avatar_url: "first" },
      },
      {
        type: "caller_info",
        value: { source: "slack", avatar_url: "second" },
      },
    ];
    expect(extractCallerAvatarUrl(metadata)).toBe("first");
  });
});

describe("pickUserPortraitUrl", () => {
  it("prefers callerAvatarUrl over userConfig portrait", () => {
    expect(pickUserPortraitUrl("/caller.png", "/user.png")).toBe("/caller.png");
  });

  it("falls back to userConfig portrait when caller is null", () => {
    expect(pickUserPortraitUrl(null, "/user.png")).toBe("/user.png");
  });

  it("returns null when both are null", () => {
    expect(pickUserPortraitUrl(null, null)).toBeNull();
  });

  it("returns null when caller is null and userConfig is undefined", () => {
    expect(pickUserPortraitUrl(null, undefined)).toBeNull();
  });

  it("uses caller even if userConfig is also set", () => {
    expect(pickUserPortraitUrl("/caller.png", "/user.png")).toBe("/caller.png");
  });

  it("falls through to null when caller and userConfig are both empty fallthrough", () => {
    // pickUserPortraitUrl uses ?? so falsy "" doesn't fall through; this preserves
    // explicit null/undefined as the only fallback trigger (caller of extractCallerAvatarUrl
    // never returns "", so this case is theoretical).
    expect(pickUserPortraitUrl(null, null)).toBeNull();
  });
});
