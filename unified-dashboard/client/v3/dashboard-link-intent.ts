import { parseSessionSearchIntent, removeSessionSearchIntent } from "@soulstream/search-contract";
import { classifyInternalLink, type InternalLinkTarget } from "@seosoyoung/soul-ui";

export type DashboardLinkTarget = Exclude<InternalLinkTarget, { kind: "attachment" }>;

/** 세션 지정 열기를 기다리는 동안의 대기 표시 셋. 어느 쪽으로 끝나든 함께 푼다. */
export interface SessionIntentWait {
  /** 지정 열기가 진행 중인가. */
  inFlight: { current: boolean };
  /** 지정을 아직 읽는 중인가(인증 대기 포함). */
  pending: { current: boolean };
  /** 대기 중에 눌린 모바일 채팅 탭을 기억했는가. */
  rememberedChatTab: { current: boolean };
}

/** 대기 표시 셋을 함께 풀고 기억해 둔 채팅 탭 누름을 돌려준다. 지정 열기가
 *  성공·거짓·예외 어느 쪽으로 끝나도 같은 자리로 돌아오게 한다. */
export function settleSessionIntentWait(wait: SessionIntentWait): boolean {
  const rememberedChatTab = wait.rememberedChatTab.current;
  wait.inFlight.current = false;
  wait.pending.current = false;
  wait.rememberedChatTab.current = false;
  return rememberedChatTab;
}

/** 지정 열기를 실행하고 결과를 알린다. 열기가 예외로 끝나도 거짓으로 끝난 것과
 *  똑같이 대기 표시를 푼다. 예외는 삼킨다(사용자 알림은 열기 함수가 맡는다). */
export function runSessionIntentOpen(
  open: () => Promise<boolean>,
  wait: SessionIntentWait,
  onOpened: (opened: boolean, rememberedChatTab: boolean) => void,
): void {
  void open().then(
    (opened) => onOpened(opened, settleSessionIntentWait(wait)),
    () => settleSessionIntentWait(wait),
  );
}

export interface DashboardLinkIntent {
  target: DashboardLinkTarget;
  identity: string;
  legacy: boolean;
}

export function readDashboardLinkIntent(
  location: Pick<Location, "pathname" | "search" | "hash">,
  internalOrigins: readonly string[],
): DashboardLinkIntent | null {
  const identity = `${location.pathname}${location.search}${location.hash}`;
  const target = classifyInternalLink(`${location.pathname}${location.search}`, internalOrigins);
  if (target && target.kind !== "attachment") {
    return { target, identity, legacy: false };
  }

  if (/^#\/feed\//.test(location.hash)) {
    const legacySession = parseSessionSearchIntent(identity);
    if (legacySession) {
      return {
        target: {
          kind: "session",
          sessionId: legacySession.sessionId,
          ...(legacySession.eventId === undefined ? {} : { eventId: legacySession.eventId }),
        },
        identity,
        legacy: true,
      };
    }
  }
  return null;
}

export function consumeDashboardLinkIntent(
  href: string,
  intent: DashboardLinkIntent,
): string {
  if (intent.legacy) return removeSessionSearchIntent(href);

  const url = new URL(href, "https://dashboard-link-intent.invalid");
  if (intent.target.kind === "session") {
    url.searchParams.delete("session");
    url.searchParams.delete("event");
  } else if (intent.target.kind === "attachment_asset") {
    url.searchParams.delete("attachment");
    url.searchParams.delete("context_type");
    url.searchParams.delete("context_id");
  } else {
    url.searchParams.delete(intent.target.kind);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
