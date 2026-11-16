import { z } from "zod";
import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";

const id = z.string().min(1);

export const registerAttachmentInputSchema = z.object({
  local_path: id,
  name: id.optional(),
  mime_type: id.optional(),
  target_scope: z.object({ type: z.literal("card"), id }).strict().optional(),
}).strict();

export const resolveAttachmentInputSchema = z.object({
  attachment_id: id,
}).strict();

export const attachSessionOutputInputSchema = z.object({
  attachment_ids: z.array(id).min(1),
}).strict();

export type ResolveAttachmentResult = {
  attachment_id: string;
  local_path: string;
  descriptor: AttachmentDescriptor;
};

export type AttachSessionOutputResult =
  | {
      status: "committed";
      event_id: string;
      output_command_id: string;
      attachment_ids: string[];
    }
  | {
      status: "delivery_unconfirmed";
      output_key: string;
      output_command_id: string;
      attachment_ids: string[];
    };

export const attachmentTools = {
  register_attachment: {
    name: "register_attachment",
    timeoutMs: 300000,
    config: {
      description:
        "이 세션의 작업 폴더(워크트리가 붙은 세션은 그 워크트리) 또는 자기 incoming 안의 파일을 영구 첨부로 등록합니다. 0~100MiB. 단위 폴더(.local/tmp/card…)처럼 그 밖에 있는 파일은 워크트리 안 git이 무시하는 .local/ 아래로 복사한 뒤 등록하세요. target_scope 카드 등록은 실제 카드 연결 전에는 카드 독자에게 열리지 않습니다. 카드로 등록한 첨부는 항목 증거나 질문 첨부로 연결되기 전에는 등록한 세션도 resolve_attachment로 읽지 못합니다. 등록 확인은 응답의 checksum_sha256과 byte_size로 합니다. 성공 ID를 담당에게 넘기거나 report_card_item evidence에 attachment_id로 사용하세요.",
      inputSchema: registerAttachmentInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    audience: "internal",
    strictInputSchema: true,
  },
  resolve_attachment: {
    name: "resolve_attachment",
    timeoutMs: 300000,
    config: {
      description: "현재 세션에 연결된 첨부(이 세션에 들어온 첨부, 소속 카드나 담당 카드의 항목 증거와 질문에 연결된 첨부)를 이 노드의 로컬 파일로 준비합니다. 연결 전 첨부는 ATTACHMENT_REF_REQUIRED로 거부됩니다.",
      inputSchema: resolveAttachmentInputSchema.shape,
    },
    audience: "internal",
    strictInputSchema: true,
  },
  attach_session_output: {
    name: "attach_session_output",
    timeoutMs: 300000,
    config: {
      description: "현재 실행에서 등록된 첨부 ID를 세션 응답에 명시적으로 연결합니다.",
      inputSchema: attachSessionOutputInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    audience: "internal",
    strictInputSchema: true,
  },
} as const;
