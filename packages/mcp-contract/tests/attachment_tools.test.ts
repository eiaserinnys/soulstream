import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  attachSessionOutputInputSchema,
  type AttachSessionOutputResult,
  attachmentTools,
  registerAttachmentInputSchema,
  resolveAttachmentInputSchema,
} from "../src/attachment_tools.ts";
import { cardTools } from "../src/card_tools.ts";

describe("attachment tool contract", () => {
  const tool = attachmentTools.register_attachment;

  it("registers as an internal strict worker-local tool", () => {
    assert.equal(tool.name, "register_attachment");
    assert.equal(tool.audience, "internal");
    assert.equal(tool.strictInputSchema, true);
    assert.equal(tool.timeoutMs, 300000);
    assert.deepEqual(tool.config.annotations, {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it("exposes a strict current attached-ref resolution contract", () => {
    const resolveTool = attachmentTools.resolve_attachment;
    assert.partialDeepStrictEqual(resolveTool, {
      name: "resolve_attachment",
      audience: "internal",
      timeoutMs: 300000,
      config: {
        description: "현재 세션에 연결된 첨부를 이 노드의 로컬 파일로 준비합니다.",
      },
      strictInputSchema: true,
    });
    assert.deepEqual(Object.keys(resolveTool.config.inputSchema), ["attachment_id"]);
    assert.equal(resolveAttachmentInputSchema.safeParse({ attachment_id: "asset-1" }).success, true);
    assert.equal(resolveAttachmentInputSchema.safeParse({ attachment_id: "asset-1", session_id: "sess-1" }).success, false);
    assert.equal(resolveAttachmentInputSchema.safeParse({ attachment_id: "" }).success, false);
    assert.equal(registerAttachmentInputSchema.safeParse({ local_path: "/tmp/a.png" }).success, true);
  });

  it("exposes explicit output attachment input and idempotent internal tool metadata", () => {
    const outputTool = attachmentTools.attach_session_output;
    assert.partialDeepStrictEqual(outputTool, {
      name: "attach_session_output",
      audience: "internal",
      strictInputSchema: true,
      timeoutMs: 300000,
      config: {
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
    });
    assert.deepEqual(Object.keys(outputTool.config.inputSchema), ["attachment_ids"]);
    assert.equal(attachSessionOutputInputSchema.safeParse({ attachment_ids: ["asset-1"] }).success, true);
    assert.equal(attachSessionOutputInputSchema.safeParse({ attachment_ids: [] }).success, false);
    assert.equal(attachSessionOutputInputSchema.safeParse({ attachment_ids: [""] }).success, false);
    assert.equal(attachSessionOutputInputSchema.safeParse({
      attachment_ids: ["asset-1"],
      output_command_id: "caller-controlled",
    }).success, false);
    assert.equal(attachSessionOutputInputSchema.safeParse({
      attachment_ids: ["asset-1"],
      local_path: "/tmp/a.png",
      url: "https://example.test/a.png",
      target_scope: { type: "card", id: "card-1" },
    }).success, false);
  });

  it("keeps both committed and unconfirmed output results in the shared type", () => {
    const committed: AttachSessionOutputResult = {
      status: "committed",
      event_id: "event-1",
      output_command_id: "command-1",
      attachment_ids: ["asset-1"],
    };
    const deliveryUnconfirmed: AttachSessionOutputResult = {
      status: "delivery_unconfirmed",
      output_key: "output-key-1",
      output_command_id: "command-1",
      attachment_ids: ["asset-1"],
    };

    assert.equal(committed.status, "committed");
    assert.equal(deliveryUnconfirmed.status, "delivery_unconfirmed");
  });

  it("keeps model arguments to path, name, mime type and a card scope", () => {
    assert.deepEqual(Object.keys(tool.config.inputSchema).sort(), [
      "local_path",
      "mime_type",
      "name",
      "target_scope",
    ]);
  });

  it("accepts a bare local path and a full card-targeted registration", () => {
    assert.equal(registerAttachmentInputSchema.safeParse({ local_path: "/tmp/a.png" }).success, true);
    assert.equal(registerAttachmentInputSchema.safeParse({
      local_path: "reports/a.pdf",
      name: "a.pdf",
      mime_type: "application/pdf",
      target_scope: { type: "card", id: "card-1" },
    }).success, true);
  });

  it("rejects empty ids, unknown keys and non-card scopes", () => {
    assert.equal(registerAttachmentInputSchema.safeParse({ local_path: "" }).success, false);
    assert.equal(registerAttachmentInputSchema.safeParse({ local_path: "/tmp/a.png", owner: "self" }).success, false);
    assert.equal(registerAttachmentInputSchema.safeParse({
      local_path: "/tmp/a.png",
      target_scope: { type: "session", id: "s-1" },
    }).success, false);
    assert.equal(registerAttachmentInputSchema.safeParse({
      local_path: "/tmp/a.png",
      target_scope: { type: "card", id: "" },
    }).success, false);
    assert.equal(registerAttachmentInputSchema.safeParse({
      local_path: "/tmp/a.png",
      target_scope: { type: "card", id: "card-1", extra: 1 },
    }).success, false);
  });

  it("requires exactly one of attachment_id or url in report evidence", () => {
    const evidence = cardTools.report_card_item.config.inputSchema.evidence;
    assert.equal(evidence.safeParse([{ type: "image", label: "a", attachment_id: "att-1" }]).success, true);
    assert.equal(evidence.safeParse([{ type: "link", label: "a", url: "https://example.test/x" }]).success, true);
    assert.equal(evidence.safeParse([{ type: "image", label: "a" }]).success, false);
    assert.equal(evidence.safeParse([
      { type: "image", label: "a", attachment_id: "att-1", url: "https://example.test/x" },
    ]).success, false);
  });
});
