import type { ControlInboxResult, ControlInboxWork } from "./control_inbox_store.js";

// 내구 작업의 완료 기록(SQLite)이 실패하면(데이터베이스가 바쁨 등) 오류로 올리기 전에 짧게 다시 해 본다.
const COMPLETE_RETRY_DELAYS_MS = [100, 400] as const;

export async function completeDurableWork(input: {
  store: {
    complete(work: ControlInboxWork, response: Record<string, unknown>): ControlInboxResult;
  };
  work: ControlInboxWork;
  response: Record<string, unknown>;
  schedule: (callback: () => void, delayMs: number) => unknown;
  log?: (message: string, fields: Record<string, unknown>) => void;
}): Promise<ControlInboxResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return input.store.complete(input.work, input.response);
    } catch (error) {
      const delayMs = COMPLETE_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) throw error;
      input.log?.("control inbox completion failed; retrying", {
        requestId: input.work.requestId,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise<void>((resolve) => input.schedule(resolve, delayMs));
    }
  }
}
