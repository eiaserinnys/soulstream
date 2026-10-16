import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  attachmentTools,
  registerAttachmentInputSchema,
  resolveAttachmentInputSchema,
} from "../src/attachment_tools.ts";
import { cardTools } from "../src/card_tools.ts";

describe("attachment tool contract", () => {
  const tool = attachmentTools.register_attachment;

  it("registers as an internal strict worker-local tool", () => {
    expect(tool.name).toBe("register_attachment");
    expect(tool.audience).toBe("internal");
    expect(tool.strictInputSchema).toBe(true);
    expect(tool.timeoutMs).toBe(300000);
    expect(tool.config.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it("exposes a strict current attached-ref resolution contract", () => {
    const resolveTool = attachmentTools.resolve_attachment;
    expect(resolveTool).toMatchObject({
      name: "resolve_attachment",
      audience: "internal",
      timeoutMs: 300000,
      config: {
        description: "현재 세션에 연결된 첨부를 이 노드의 로컬 파일로 준비합니다.",
      },
      strictInputSchema: true,
    });
    expect(Object.keys(resolveTool.config.inputSchema)).toEqual(["attachment_id"]);
    expect(resolveAttachmentInputSchema.safeParse({ attachment_id: "asset-1" }).success).toBe(true);
    expect(resolveAttachmentInputSchema.safeParse({ attachment_id: "asset-1", session_id: "sess-1" }).success).toBe(false);
    expect(resolveAttachmentInputSchema.safeParse({ attachment_id: "" }).success).toBe(false);
    expect(registerAttachmentInputSchema.safeParse({ local_path: "/tmp/a.png" }).success).toBe(true);
  });

  it("keeps model arguments to path, name, mime type and a card scope", () => {
    expect(Object.keys(tool.config.inputSchema).sort()).toEqual([
      "local_path",
      "mime_type",
      "name",
      "target_scope",
    ]);
  });

  it("accepts a bare local path and a full card-targeted registration", () => {
    expect(registerAttachmentInputSchema.safeParse({ local_path: "/tmp/a.png" }).success).toBe(true);
    expect(registerAttachmentInputSchema.safeParse({
      local_path: "reports/a.pdf",
      name: "a.pdf",
      mime_type: "application/pdf",
      target_scope: { type: "card", id: "card-1" },
    }).success).toBe(true);
  });

  it("rejects empty ids, unknown keys and non-card scopes", () => {
    expect(registerAttachmentInputSchema.safeParse({ local_path: "" }).success).toBe(false);
    expect(registerAttachmentInputSchema.safeParse({ local_path: "/tmp/a.png", owner: "self" }).success).toBe(false);
    expect(registerAttachmentInputSchema.safeParse({
      local_path: "/tmp/a.png",
      target_scope: { type: "session", id: "s-1" },
    }).success).toBe(false);
    expect(registerAttachmentInputSchema.safeParse({
      local_path: "/tmp/a.png",
      target_scope: { type: "card", id: "" },
    }).success).toBe(false);
    expect(registerAttachmentInputSchema.safeParse({
      local_path: "/tmp/a.png",
      target_scope: { type: "card", id: "card-1", extra: 1 },
    }).success).toBe(false);
  });

  it("requires exactly one of attachment_id or url in report evidence", () => {
    const evidence = cardTools.report_card_item.config.inputSchema.evidence;
    expect(evidence.safeParse([{ type: "image", label: "a", attachment_id: "att-1" }]).success).toBe(true);
    expect(evidence.safeParse([{ type: "link", label: "a", url: "https://example.test/x" }]).success).toBe(true);
    expect(evidence.safeParse([{ type: "image", label: "a" }]).success).toBe(false);
    expect(evidence.safeParse([
      { type: "image", label: "a", attachment_id: "att-1", url: "https://example.test/x" },
    ]).success).toBe(false);
  });
});
