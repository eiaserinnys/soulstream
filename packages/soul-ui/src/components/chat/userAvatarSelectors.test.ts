import { describe, expect, it } from "vitest";
import type { CallerInfo, MetadataEntry } from "../../shared/types";
import {
  extractCallerAvatarUrl,
  pickMessageAvatarUrl,
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

describe("pickMessageAvatarUrl", () => {
  // === 메시지 우선순위 (atom ed3a216d 후속 fix — 첫 history fetch 시점 즉시 표시) ===

  it("prefers msg caller_info.avatar_url over session avatar over userConfig", () => {
    const msgCi: CallerInfo = {
      source: "browser",
      avatar_url: "/msg.png",
    };
    expect(pickMessageAvatarUrl(msgCi, "/session.png", "/user.png")).toBe("/msg.png");
  });

  it("falls back to session avatar when msg caller_info is undefined", () => {
    expect(pickMessageAvatarUrl(undefined, "/session.png", "/user.png")).toBe("/session.png");
  });

  it("falls back to session avatar when msg caller_info has no avatar_url", () => {
    const msgCi: CallerInfo = { source: "browser", display_name: "User" };
    expect(pickMessageAvatarUrl(msgCi, "/session.png", "/user.png")).toBe("/session.png");
  });

  it("falls back to userConfig portrait when both msg and session are absent", () => {
    expect(pickMessageAvatarUrl(undefined, null, "/user.png")).toBe("/user.png");
  });

  it("returns null when all three are absent", () => {
    expect(pickMessageAvatarUrl(undefined, null, null)).toBeNull();
  });

  it("returns null when msg has no avatar, session is null, userConfig is undefined", () => {
    expect(pickMessageAvatarUrl(undefined, null, undefined)).toBeNull();
  });

  it("ignores empty string msg avatar_url and falls back (defensive)", () => {
    const msgCi: CallerInfo = { source: "browser", avatar_url: "" };
    expect(pickMessageAvatarUrl(msgCi, "/session.png", "/user.png")).toBe("/session.png");
  });

  it("ignores non-string msg avatar_url and falls back (defensive)", () => {
    const msgCi = { source: "browser", avatar_url: 12345 as unknown as string } as CallerInfo;
    expect(pickMessageAvatarUrl(msgCi, "/session.png", "/user.png")).toBe("/session.png");
  });

  it("uses msg caller_info from agent source for delegated message", () => {
    // 정확히 결함 3 시나리오: 위임 메시지 첫 진입 시점에 메시지 단위 caller_info만으로 표시.
    const msgCi: CallerInfo = {
      source: "agent",
      display_name: "shay",
      avatar_url: "/api/agents/shay/portrait",
      agent_node: "eias",
      agent_id: "shay",
    };
    expect(pickMessageAvatarUrl(msgCi, null, null)).toBe("/api/agents/shay/portrait");
  });

  it("uses msg caller_info from slack source", () => {
    const msgCi: CallerInfo = {
      source: "slack",
      avatar_url: "https://avatars.slack-edge.com/2024/img_192.png",
      slack: { channel_id: "C08", user_id: "U08" },
    };
    expect(pickMessageAvatarUrl(msgCi, null, "/user.png")).toBe(
      "https://avatars.slack-edge.com/2024/img_192.png",
    );
  });
});
