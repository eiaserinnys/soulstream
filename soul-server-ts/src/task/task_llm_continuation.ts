import type { InterventionMessage, Task } from "./task_models.js";

export interface LlmContinuationTurn {
  /** 새 user_message 이벤트에 덧붙일 llm 필드(전체 이력, provider, model 등). */
  userMessageFields: Record<string, unknown>;
  /** 중앙이 running을 적용한 뒤 어댑터를 불러 답과 마감을 기록한다. 던지지 않는다. */
  run(): Promise<void>;
}

/** 끝난 llm 세션의 이어 쓰기. 이벤트를 쓰기 전에 거절 여부를 가린다. */
export interface LlmContinuation {
  prepare(task: Task, message: InterventionMessage): Promise<LlmContinuationTurn>;
}
