import { z } from "zod";
import type { McpToolDefinition } from "./tool_definitions.js";

/**
 * 웹훅 관리 입력의 정본 (카드 #1458).
 *
 * orch 관리 경로(`/api/webhooks/inbound`, `/api/webhooks/outbound`)와 MCP 웹훅
 * 도구가 같은 칸과 같은 상한을 쓴다. 경로는 이 칸으로 엄격한 본문 스키마를 만들고,
 * 도구는 이 칸을 그대로 입력 스키마로 싣는다.
 */

/** 아웃바운드 구독이 고를 수 있는 이벤트. */
export const OUTBOUND_WEBHOOK_EVENT_TYPES = [
  "session.reply",
  "session.question",
  "session.failed",
  "session.ended",
] as const;

/** 아웃바운드 전달 기록의 상태. */
export const OUTBOUND_WEBHOOK_DELIVERY_STATES = ["pending", "delivered", "dead"] as const;

export const INBOUND_WEBHOOK_PREAMBLE_MAX_LENGTH = 4000;
export const INBOUND_WEBHOOK_MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;
export const INBOUND_WEBHOOK_REQUESTS_DEFAULT_LIMIT = 20;
export const INBOUND_WEBHOOK_REQUESTS_MAX_LIMIT = 50;

/** 인바운드 웹훅 발급 입력 칸. */
export const inboundWebhookIssueFields = {
  target_session_id: z.uuid(),
  label: z.string().trim().min(1).max(80),
  auth_mode: z.enum(["key", "signature"]),
  preamble: z.string().max(INBOUND_WEBHOOK_PREAMBLE_MAX_LENGTH).nullable().optional(),
  expires_in_seconds: z
    .number()
    .int()
    .min(60)
    .max(INBOUND_WEBHOOK_MAX_EXPIRES_IN_SECONDS)
    .nullable()
    .optional(),
};

/** 아웃바운드 구독 등록 입력 칸. */
export const outboundWebhookCreateFields = {
  target_session_id: z.string().trim().min(1),
  label: z.string().trim().min(1).max(200),
  url: z.string().trim().max(2048).refine(isHttpsUrl),
  event_types: z
    .array(z.enum(OUTBOUND_WEBHOOK_EVENT_TYPES))
    .min(1)
    .refine((types) => new Set(types).size === types.length),
};

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const callerSchema = { caller_session_id: z.string().min(1).optional() };
const directionSchema = z.enum(["inbound", "outbound"]);

/**
 * 받을 주소로 한 번 보내는 도구의 노드 전달 상한. orch의 전송 상한(10초)보다 길어야
 * 노드가 먼저 끊고 orch만 등록을 끝내 signing_secret을 잃는 일이 없다.
 */
const OUTBOUND_SEND_TIMEOUT_MS = 30_000;

const OWNER_NOTE =
  "소유자는 호출 세션의 소유자이고, 그 사람의 설정 화면 웹훅 탭에 같은 목록으로 보인다.";

export const webhookTools = {
  create_inbound_webhook: {
    name: "create_inbound_webhook", audience: "internal",
    config: {
      description: `대상 세션에 외부 입력을 넣는 인바운드 웹훅을 만든다. ${OWNER_NOTE} secret과 key_url(key 방식만)은 이 결과에만 한 번 나오고 다시 볼 수 없다.`,
      inputSchema: { ...inboundWebhookIssueFields, ...callerSchema },
    },
  },
  revoke_inbound_webhook: {
    name: "revoke_inbound_webhook", audience: "internal",
    config: {
      description: `인바운드 웹훅 하나를 폐기한다. 폐기 뒤 그 웹훅으로 들어오는 요청은 거절된다. ${OWNER_NOTE}`,
      inputSchema: { id: z.uuid(), ...callerSchema },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
  },
  create_outbound_webhook: {
    name: "create_outbound_webhook", audience: "internal", timeoutMs: OUTBOUND_SEND_TIMEOUT_MS,
    config: {
      description: `대상 세션의 답변, 질문, 종료를 외부 주소로 보내는 아웃바운드 구독을 등록한다. 받을 주소는 https 공개 주소여야 하고, 등록 전에 보낸 verification 요청의 challenge를 그대로 돌려줘야 한다. ${OWNER_NOTE} signing_secret은 이 결과에만 한 번 나온다.`,
      inputSchema: { ...outboundWebhookCreateFields, ...callerSchema },
    },
  },
  set_outbound_webhook_active: {
    name: "set_outbound_webhook_active", audience: "internal",
    config: {
      description: `아웃바운드 구독을 끄거나 켠다. 꺼진 동안에는 외부 주소로 보내지 않는다. ${OWNER_NOTE}`,
      inputSchema: { id: z.string().min(1), active: z.boolean(), ...callerSchema },
      annotations: { idempotentHint: true },
    },
  },
  delete_outbound_webhook: {
    name: "delete_outbound_webhook", audience: "internal",
    config: {
      description: `아웃바운드 구독과 그 전달 기록을 지운다. 되돌릴 수 없다. ${OWNER_NOTE}`,
      inputSchema: { id: z.string().min(1), ...callerSchema },
      annotations: { destructiveHint: true },
    },
  },
  redeliver_outbound_webhook: {
    name: "redeliver_outbound_webhook", audience: "internal", timeoutMs: OUTBOUND_SEND_TIMEOUT_MS,
    config: {
      description: `아웃바운드 구독의 전달 기록 하나를 지금 다시 보내고 그 결과(outcome)를 돌려준다. 꺼진 구독은 다시 보내지 않는다. ${OWNER_NOTE}`,
      inputSchema: { id: z.string().min(1), delivery_id: z.string().min(1), ...callerSchema },
    },
  },
  list_webhooks: {
    name: "list_webhooks", audience: "internal",
    config: {
      description: `호출 세션 소유자의 인바운드 웹훅(상태와 최근 수신 요약 포함) 또는 아웃바운드 구독 목록을 본다. ${OWNER_NOTE} secret, signing_secret, key_url은 싣지 않는다.`,
      inputSchema: { direction: directionSchema, ...callerSchema },
      annotations: { readOnlyHint: true },
    },
  },
  list_webhook_activity: {
    name: "list_webhook_activity", audience: "internal",
    config: {
      description: `웹훅 하나의 최근 활동을 본다. inbound는 받은 요청(limit 기본 ${INBOUND_WEBHOOK_REQUESTS_DEFAULT_LIMIT}, 최대 ${INBOUND_WEBHOOK_REQUESTS_MAX_LIMIT}), outbound는 전달 기록이고 state로 거를 수 있다. ${OWNER_NOTE}`,
      inputSchema: {
        direction: directionSchema,
        id: z.string().min(1),
        state: z.enum(OUTBOUND_WEBHOOK_DELIVERY_STATES).optional(),
        limit: z.number().int().positive().optional(),
        ...callerSchema,
      },
      annotations: { readOnlyHint: true },
    },
  },
} as const satisfies Record<string, McpToolDefinition>;
