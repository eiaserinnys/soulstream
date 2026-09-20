/**
 * 입력 구간(compose flow)의 사용 로그 규칙.
 *
 * ChatInput 에서 떼어 낸 이유는 하나다 — 규칙을 렌더링 없이 검증할 수 있어야 한다.
 * 여기서 만드는 attrs 는 **길이뿐**이다. 초안 문자열은 어떤 필드에도 싣지 않는다.
 */
import type { UiEventAttrValue, UiEventTracker } from "../../lib/ui-events";

export type ComposeStatus = "ok" | "error" | "aborted";

export type ComposeTarget = { readonly key: string; readonly text: string };

export type ComposeFlowRecorder = {
  /** 입력이 바뀌었다. 빈 초안에서 처음 글자가 들어온 순간만 구간 시작으로 본다. */
  readonly textChanged: (sessionKey: string | null, previous: string, next: string) => void;
  readonly submitted: (sessionKey: string | null, draftLength: number, mode: string) => void;
  readonly settled: (status: ComposeStatus, errorCode?: string) => void;
  /** 대상이 바뀌었다. 초안을 두고 떠났는지, 초안이 있는 곳으로 돌아왔는지 기록한다. */
  readonly sessionChanged: (
    previous: ComposeTarget | null,
    next: { readonly key: string; readonly draft: string } | null,
  ) => void;
};

export type CreateComposeFlowRecorderOptions = {
  readonly track: UiEventTracker;
  readonly newId: () => string;
  readonly now: () => number;
};

export function createComposeFlowRecorder(
  options: CreateComposeFlowRecorderOptions,
): ComposeFlowRecorder {
  let flowId: string | null = null;
  let submittedAt: number | null = null;

  const sessionRef = (key: string | null) =>
    key === null ? null : ({ kind: "session", id: key } as const);

  const ensureFlow = (): string => {
    if (flowId === null) flowId = options.newId();
    return flowId;
  };

  return {
    textChanged(sessionKey, previous, next) {
      if (previous.length > 0 || next.length === 0) return;
      flowId = options.newId();
      options.track("compose_start", {
        flowId,
        target: sessionRef(sessionKey),
      });
    },

    submitted(sessionKey, draftLength, mode) {
      submittedAt = options.now();
      options.track("compose_submit", {
        flowId: ensureFlow(),
        target: sessionRef(sessionKey),
        attrs: { draftLength, mode },
      });
    },

    settled(status, errorCode) {
      const attrs: Record<string, UiEventAttrValue> = {
        status,
        durationMs: submittedAt === null ? 0 : Math.max(0, options.now() - submittedAt),
      };
      if (errorCode !== undefined) attrs.errorCode = errorCode;
      // 전송 응답에 발화 id 가 없어 sessionEventId 는 채우지 않는다.
      // 시간 근접으로 추정해 붙이지 않는다 — 없는 연결을 만들어 내지 않는다.
      options.track("compose_result", { flowId: ensureFlow(), attrs });
      flowId = null;
      submittedAt = null;
    },

    sessionChanged(previous, next) {
      if (previous !== null && previous.text.length > 0) {
        options.track("compose_abandon", {
          flowId: ensureFlow(),
          target: { kind: "session", id: previous.key },
          // "이탈"이지 "취소"가 아니다. 왜 떠났는지는 이 로그가 모른다.
          attrs: { draftPresent: true, draftLength: previous.text.length },
        });
      }
      flowId = null;
      submittedAt = null;

      if (next !== null && next.draft.length > 0) {
        flowId = options.newId();
        options.track("compose_resume", {
          flowId,
          target: { kind: "session", id: next.key },
          attrs: { draftPresent: true, draftLength: next.draft.length },
        });
      }
    },
  };
}
