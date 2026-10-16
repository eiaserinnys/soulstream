import { z } from "zod";

const id = z.string().min(1);

export const registerAttachmentInputSchema = z.object({
  local_path: id,
  name: id.optional(),
  mime_type: id.optional(),
  target_scope: z.object({ type: z.literal("card"), id }).strict().optional(),
}).strict();

export const attachmentTools = {
  register_attachment: {
    name: "register_attachment",
    timeoutMs: 300000,
    config: {
      description:
        "자기 실행 workspace/worktree/scratch 또는 자기 incoming의 명시 파일을 영구 첨부로 등록합니다. 0~100MiB. target_scope 카드 등록은 실제 카드 연결 전에는 카드 독자에게 열리지 않습니다. 성공 ID를 담당에게 넘기거나 report_card_item evidence에 attachment_id로 사용하세요.",
      inputSchema: registerAttachmentInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    audience: "internal",
    strictInputSchema: true,
  },
} as const;
