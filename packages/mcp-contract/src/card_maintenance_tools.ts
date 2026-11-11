import { z } from "zod";
import { callerSessionIdSchema } from "./folder_shared.js";

const id = z.string().min(1);

/**
 * PAS card maintenance: edit cards before their first start, merge small related cards
 * into one, and move several cards between board states. All three are internal-only;
 * external ingress keeps the existing 65-tool inventory.
 */
export const cardMaintenanceTools = {
  update_unstarted_card: { name: "update_unstarted_card", strictInputSchema: true, config: {
    description: "아직 시작하지 않은 카드의 제목, 요청, 인계와 담당 에이전트·모델·노드를 고칩니다. 보관되지 않았고 사람 담당이나 담당 세션이 없으며 todo·queued·on_hold 상태이고 실행 결과 확인 중이 아닌 카드만 됩니다. 변경할 필드를 하나 이상 지정하세요. agent_id를 주면 그 에이전트가 담당이 됩니다. 상태와 대기열 순서는 유지합니다. 담당 세션이 있는 카드의 후속 지시와 담당 교체는 dispatch_work를 쓰세요. idempotency_key를 재사용하면 중복 변경을 막습니다.",
    inputSchema: {
      card_id: id,
      title: id.optional(),
      request: z.string().optional(),
      brief: z.string().optional(),
      agent_id: id.optional(),
      model_preset: id.optional(),
      node_id: id.optional(),
      expected_version: z.number().int().positive().optional(),
      idempotency_key: id,
      caller_session_id: callerSessionIdSchema,
    },
  }, audience: "internal" },
  merge_cards: { name: "merge_cards", strictInputSchema: true, config: {
    description: "아직 시작하지 않은 원 카드 1~9장을 대상 카드에 순서대로 합칩니다. 대상과 원 카드 모두 보관되지 않았고 사람 담당이나 담당 세션이 없으며 todo·queued·on_hold 상태이고 실행 결과 확인 중이 아니어야 합니다. 요청과 사용자 커멘트, 인계, 첨부, 노트와 확인 항목을 대상에 남기고 원 카드는 취소합니다. 접근 가능한 다른 폴더의 카드도 합칠 수 있습니다. 하나라도 안 되면 전부 그대로 둡니다. 대상의 상태와 대기열 순서는 유지합니다. 실행 중 카드의 후속 지시는 dispatch_work를 쓰세요. 같은 idempotency_key로 다시 부르면 같은 결과를 반환합니다.",
    inputSchema: {
      target_card_id: id,
      source_card_ids: z.array(id).min(1).max(9),
      title: id.optional(),
      idempotency_key: id,
      caller_session_id: callerSessionIdSchema,
    },
  }, audience: "internal" },
  bulk_set_card_status: { name: "bulk_set_card_status", strictInputSchema: true, config: {
    description: "카드 1~20장의 상태를 todo·queued·on_hold·cancelled 가운데 하나로 바꿉니다. 담당 세션이 없는 카드는 기존 set_card_status와 같은 규칙입니다. 사람 담당을 제외한 담당 세션이 있는 카드는 실행 중이 아니고 담당이 지금 턴을 돌고 있지 않을 때 보류·취소만 됩니다. 담당 연결과 워크트리는 유지합니다. reason은 변경한 카드마다 노트로 남깁니다. 카드별로 처리하므로 실패한 카드가 있어도 나머지는 계속하고 결과를 각각 반환합니다. 실행 중 담당에게는 dispatch_work로 지시하세요.",
    inputSchema: {
      card_ids: z.array(id).min(1).max(20),
      status: z.enum(["todo", "queued", "on_hold", "cancelled"]),
      reason: z.string().optional(),
      idempotency_key: id,
      caller_session_id: callerSessionIdSchema,
    },
  }, audience: "internal" },
} as const;
