"""검수용 세션 파일 응답: 시안의 outbox 변경과 같은 unified diff 구성."""

def hunk_diff(path, hunks):
    lines = [f"diff --git a/{path} b/{path}", "index 4c1d2e9..8a7f3b1 100644", f"--- a/{path}", f"+++ b/{path}"]
    offset = added = deleted = 0
    for old_start, heading, body in hunks:
        old_count = sum(line.startswith((" ", "-")) for line in body)
        new_count = sum(line.startswith((" ", "+")) for line in body)
        added += sum(line.startswith("+") for line in body)
        deleted += sum(line.startswith("-") for line in body)
        lines.append(f"@@ -{old_start},{old_count} +{old_start + offset},{new_count} @@ {heading}".rstrip())
        lines.extend(body)
        offset += new_count - old_count
    return "\n".join(lines) + "\n", added, deleted

UP = "soul-server-ts/src/upstream"
EVENT_DIFF, EVENT_ADD, EVENT_DEL = hunk_diff(f"{UP}/event_outbox.ts", [
    (1, "", [
        ' import type { UpstreamSocket } from "./upstream_socket";',
        ' import type { OutboxEvent, OutboxStore } from "./event_outbox_types";',
        '+import { canSend, resetRetry, scheduleRetry, type OutboxRetryState } from "./outbox_retry";',
        ' import { logger } from "../logger";',
        ' ',
        '-const RETRY_DELAY_MS = 1_000;',
        ' const BATCH_SIZE = 50;',
        ' ',
        ' export class EventOutbox {',
        '   private timer: NodeJS.Timeout | null = null;',
        '+  private retry: OutboxRetryState | null = null;',
        ' ',
    ]),
    (47, "export class EventOutbox {", [
        '   private async flush(): Promise<void> {',
        '+    if (!canSend(this.retry, Date.now())) return;',
        '     const batch = await this.store.peek(BATCH_SIZE);',
        '     if (batch.length === 0) return;',
        '     try {',
        '       await this.socket.send({ type: "events", events: batch });',
        '       await this.store.ack(batch.map(event => event.id));',
        '+      this.retry = resetRetry();',
        '       this.schedule(0);',
        '     } catch (error) {',
        '-      logger.warn("outbox send failed", { error });',
        '-      this.schedule(RETRY_DELAY_MS);',
        '+      this.retry = scheduleRetry(this.retry, Date.now());',
        '+      const delay = this.retry.nextAttemptAt - Date.now();',
        '+      logger.warn("outbox send failed", { error, attempt: this.retry.attempt, delay });',
        '+      this.schedule(delay);',
        '     }',
        '   }',
    ]),
    (118, "export class EventOutbox {", [
        '   onReconnect(): void {',
        '+    // orch가 다시 붙으면 백오프를 처음부터 센다.',
        '+    this.retry = resetRetry();',
        '     this.schedule(0);',
        '   }',
        ' ',
        '   stop(): void {',
        '     if (this.timer) clearTimeout(this.timer);',
        '   }',
    ]),
])

CONFIG_DIFF, CONFIG_ADD, CONFIG_DEL = hunk_diff("soul-server-ts/src/config.ts", [
    (31, "export const config = {", [
        "   upstream: {",
        "-    reconnectDelayMs: 1_000,",
        "+    reconnectDelayMs: 2_000,",
        "+    outboxRetryMaxMs: 30_000,",
        "+    outboxRetryEnabled: true,",
        "   },",
    ]),
])

NEW_LINES = [
    "// 노드 이벤트 아웃박스의 재전송 간격.",
    "// 실패할 때 간격을 두 배씩 늘리고 30초에서 멈춘다.",
    "",
    "export const OUTBOX_RETRY_BASE_MS = 1_000;",
    "export const OUTBOX_RETRY_MAX_MS = 30_000;",
    "",
    "export interface OutboxRetryState {",
    "  attempt: number;",
    "  nextAttemptAt: number;",
    "}",
    "",
    "export function nextRetryDelay(attempt: number): number {",
    "  if (!Number.isInteger(attempt) || attempt < 0) return OUTBOX_RETRY_BASE_MS;",
    "  const delay = OUTBOX_RETRY_BASE_MS * 2 ** attempt;",
    "  return Math.min(delay, OUTBOX_RETRY_MAX_MS);",
    "}",
    "",
    "export function scheduleRetry(state: OutboxRetryState | null, now: number): OutboxRetryState {",
    "  const attempt = state ? state.attempt + 1 : 0;",
    "  return { attempt, nextAttemptAt: now + nextRetryDelay(attempt) };",
    "}",
    "",
    "export function canSend(state: OutboxRetryState | null, now: number): boolean {",
    "  return state === null || now >= state.nextAttemptAt;",
    "}",
    "",
    "export function resetRetry(): null {",
    "  return null;",
    "}",
]
NEW_DIFF = "\n".join([f"diff --git a/{UP}/outbox_retry.ts b/{UP}/outbox_retry.ts", "new file mode 100644", "--- /dev/null", f"+++ b/{UP}/outbox_retry.ts", f"@@ -0,0 +1,{len(NEW_LINES)} @@"] + ["+" + line for line in NEW_LINES]) + "\n"
DELETED_LINES = [
    "// 아웃박스 재전송 간격. outbox_retry.ts로 옮겼다.",
    "export const RETRY_DELAY_MS = 1_000;",
    "export const RETRY_JITTER_MS = 0;",
    "",
    "export function retryDelay(): number {",
    "  return RETRY_DELAY_MS + RETRY_JITTER_MS;",
    "}",
]
DELETED_DIFF = "\n".join([f"diff --git a/{UP}/retry_constants.ts b/{UP}/retry_constants.ts", "deleted file mode 100644", f"--- a/{UP}/retry_constants.ts", "+++ /dev/null", f"@@ -1,{len(DELETED_LINES)} +0,0 @@"] + ["-" + line for line in DELETED_LINES]) + "\n"
