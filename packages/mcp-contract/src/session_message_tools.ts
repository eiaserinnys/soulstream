import { z } from "zod";

export const sessionMessageTools = {
  send_message_to_session: {
    name: "send_message_to_session",
    config: {
      description:
        "대상 세션에 메시지 전달. running이면 현재 턴 개입을 먼저 시도하고, 지금 전달할 수 없을 때만 next_turn 큐로 보낸다. 결과의 delivered·reason·consumeWhen을 확인한다. 종료된 세션은 auto-resume. local 실패 시 orch /intervene fallback.",
      inputSchema: {
        target_session_id: z.string(),
        message: z.string(),
        caller_session_id: z.string().optional(),
      },
    },
    audience: "all",
  },
} as const;
