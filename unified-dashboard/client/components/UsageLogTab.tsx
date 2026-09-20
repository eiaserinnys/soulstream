/**
 * 사용 로그 열람 탭.
 *
 * 분석 제품이 아니라 **타임라인 열람기**다. 날짜와 기기로 좁혀 시간순으로 보고,
 * 연결된 대상으로 건너뛴다. 점수·집계·해석은 두지 않는다 —
 * 이탈을 취소로, 체류를 집중으로 읽는 판단은 사람이 한다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, useDashboardStore } from "@seosoyoung/soul-ui";

type UiEventRef = { kind: string; id: string } | null;

type UiEventRow = {
  eventId: string;
  seq: number;
  occurredAt: string;
  receivedAt: string;
  clientKind: string;
  installId: string;
  clientSessionKey: string;
  appVersion: string;
  type: string;
  target: UiEventRef;
  from: UiEventRef;
  entry: string | null;
  flowId: string | null;
  attrs: Record<string, unknown>;
};

type InstallRow = {
  installId: string;
  clientKind: string;
  appVersion: string;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
};

/** 사람이 읽는 이름. 해석을 섞지 않는다 — "이탈"이지 "취소"가 아니다. */
const EVENT_LABELS: Readonly<Record<string, string>> = {
  view_open: "화면 열기",
  search_submit: "검색 실행",
  search_result: "검색 결과",
  search_result_open: "결과 선택",
  notification_open: "알림 클릭",
  compose_start: "입력 시작",
  compose_submit: "전송",
  compose_result: "전송 결과",
  compose_abandon: "작성 중 이탈",
  compose_resume: "작성 복귀",
  app_active: "활성",
  app_inactive: "비활성",
  action_start: "조작 시작",
  action_end: "조작 종료",
};

const CLIENT_LABELS: Readonly<Record<string, string>> = {
  browser: "웹",
  "soul-app": "앱",
};

export function UsageLogTab() {
  const [date, setDate] = useState(() => todayInputValue());
  const [installId, setInstallId] = useState("");
  const [events, setEvents] = useState<UiEventRow[]>([]);
  const [installs, setInstalls] = useState<InstallRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const openTaskBoard = useDashboardStore((s) => s.openTaskBoard);
  const selectFolder = useDashboardStore((s) => s.selectFolder);

  const range = useMemo(() => dayRange(date), [date]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to, limit: "500" });
      if (installId) params.set("installId", installId);
      const [eventsResponse, installsResponse] = await Promise.all([
        fetch(`/api/ui-events?${params}`, { credentials: "same-origin" }),
        fetch(
          `/api/ui-events/installs?${new URLSearchParams({ from: range.from, to: range.to })}`,
          { credentials: "same-origin" },
        ),
      ]);
      if (!eventsResponse.ok) throw new Error(`조회 실패: ${eventsResponse.status}`);
      const body = await eventsResponse.json();
      setEvents(body.events ?? []);
      if (installsResponse.ok) {
        setInstalls((await installsResponse.json()).installs ?? []);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, installId]);

  useEffect(() => { void load(); }, [load]);

  /** 연결된 대상으로 이동한다. 이동할 수 없는 대상이면 아무 일도 하지 않는다. */
  const openTarget = (target: UiEventRef): void => {
    if (target === null) return;
    if (target.kind === "session") setActiveSession(target.id);
    else if (target.kind === "task") openTaskBoard(target.id);
    else if (target.kind === "folder") selectFolder(target.id);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          날짜
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="rounded border border-border bg-transparent px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          기기
          <select
            value={installId}
            onChange={(event) => setInstallId(event.target.value)}
            className="rounded border border-border bg-transparent px-2 py-1 text-sm"
          >
            <option value="">전체</option>
            {installs.map((install) => (
              <option key={install.installId} value={install.installId}>
                {CLIENT_LABELS[install.clientKind] ?? install.clientKind}
                {" · "}
                {install.installId.slice(0, 8)} ({install.eventCount})
              </option>
            ))}
          </select>
        </label>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? "불러오는 중..." : "새로고침"}
        </Button>
      </div>

      {error && <div className="py-2 text-sm text-accent-red">❌ {error}</div>}

      {!loading && !error && events.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          이 날짜에 기록된 사용 로그가 없습니다.
        </div>
      )}

      {events.length > 0 && (
        <div className="max-h-[420px] overflow-y-auto rounded border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="text-muted-foreground">
                <th className="px-2 py-1 font-normal">시각</th>
                <th className="px-2 py-1 font-normal">기기</th>
                <th className="px-2 py-1 font-normal">사건</th>
                <th className="px-2 py-1 font-normal">진입</th>
                <th className="px-2 py-1 font-normal">대상</th>
                <th className="px-2 py-1 font-normal">세부</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId} className="border-t border-border/60">
                  <td className="whitespace-nowrap px-2 py-1 tabular-nums">
                    {clockTime(event.occurredAt)}
                  </td>
                  <td className="px-2 py-1">
                    {CLIENT_LABELS[event.clientKind] ?? event.clientKind}
                  </td>
                  <td className="px-2 py-1">{EVENT_LABELS[event.type] ?? event.type}</td>
                  <td className="px-2 py-1 text-muted-foreground">{event.entry ?? "—"}</td>
                  <td className="px-2 py-1">
                    {event.target === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-accent-blue"
                        onClick={() => openTarget(event.target)}
                      >
                        {event.target.kind}:{event.target.id.slice(0, 8)}
                      </button>
                    )}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">{summarize(event.attrs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        원시 기록 30일 보존. 이동/체류 시간은 해석 없이 사실만 남습니다.
      </p>
    </div>
  );
}

function summarize(attrs: Record<string, unknown>): string {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(" ");
}

function clockTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
}

function todayInputValue(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 입력된 날짜의 로컬 하루 구간. 서버에는 절대시각으로 보낸다. */
export function dayRange(date: string): { from: string; to: string } {
  const start = new Date(`${date}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    const now = new Date();
    return { from: now.toISOString(), to: now.toISOString() };
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}
