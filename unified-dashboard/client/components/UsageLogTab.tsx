import { useTranslation } from "react-i18next";
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

export function UsageLogTab({ request = fetch }: { request?: typeof fetch } = {}) {
  const { t, i18n } = useTranslation();
  const [date, setDate] = useState(() => todayInputValue());
  const [installId, setInstallId] = useState("");
  const [events, setEvents] = useState<UiEventRow[]>([]);
  const [installs, setInstalls] = useState<InstallRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const selectFolder = useDashboardStore((s) => s.selectFolder);

  const range = useMemo(() => dayRange(date), [date]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to, limit: "500" });
      if (installId) params.set("installId", installId);
      const [eventsResponse, installsResponse] = await Promise.all([
        request(`/api/ui-events?${params}`, { credentials: "same-origin" }),
        request(
          `/api/ui-events/installs?${new URLSearchParams({ from: range.from, to: range.to })}`,
          { credentials: "same-origin" },
        ),
      ]);
      if (!eventsResponse.ok) throw new Error(t("admin.log.requestError", { status: eventsResponse.status }));
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
  }, [range.from, range.to, installId, request, t]);

  useEffect(() => { void load(); }, [load]);

  /** 연결된 대상으로 이동한다. 이동할 수 없는 대상이면 아무 일도 하지 않는다. */
  const openTarget = (target: UiEventRef): void => {
    if (target === null) return;
    if (target.kind === "session") setActiveSession(target.id);
    else if (target.kind === "folder") selectFolder(target.id);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("admin.log.date")}
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="rounded-floor border border-border bg-transparent px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("admin.log.device")}
          <select
            value={installId}
            onChange={(event) => setInstallId(event.target.value)}
            className="rounded-floor border border-border bg-transparent px-2 py-1 text-sm"
          >
            <option value="">{t("admin.log.all")}</option>
            {installs.map((install) => (
              <option key={install.installId} value={install.installId}>
                {t(`admin.log.${install.clientKind}`, { defaultValue: install.clientKind })}
                {" · "}
                {install.installId.slice(0, 8)} ({install.eventCount})
              </option>
            ))}
          </select>
        </label>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? t("admin.log.loading") : t("admin.log.refresh")}
        </Button>
      </div>

      {error && <div className="py-2 text-sm text-destructive-foreground" data-v3-selectable-content="true">❌ {error}</div>}

      {!loading && !error && events.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t("admin.log.empty")}
        </div>
      )}

      {events.length > 0 && (
        <div className="max-h-[420px] overflow-y-auto rounded-floor border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="text-muted-foreground">
                <th className="px-2 py-1 font-normal">{t("admin.log.time")}</th>
                <th className="px-2 py-1 font-normal">{t("admin.log.device")}</th>
                <th className="px-2 py-1 font-normal">{t("admin.log.event")}</th>
                <th className="px-2 py-1 font-normal">{t("admin.log.entry")}</th>
                <th className="px-2 py-1 font-normal">{t("admin.log.target")}</th>
                <th className="px-2 py-1 font-normal">{t("admin.log.details")}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.eventId} className="border-t border-border/60">
                  <td className="whitespace-nowrap px-2 py-1 tabular-nums" data-v3-selectable-content="true">
                    {clockTime(event.occurredAt, i18n.resolvedLanguage)}
                  </td>
                  <td className="px-2 py-1" data-v3-selectable-content="true">
                    {t(`admin.log.${event.clientKind}`, { defaultValue: event.clientKind })}
                  </td>
                  <td className="px-2 py-1" data-v3-selectable-content="true">{t(`admin.log.${event.type}`, { defaultValue: event.type })}</td>
                  <td className="px-2 py-1 text-muted-foreground" data-v3-selectable-content="true">{event.entry ?? "—"}</td>
                  <td className="px-2 py-1" data-v3-selectable-content="true">
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
                  <td className="px-2 py-1 text-muted-foreground" data-v3-selectable-content="true">{summarize(event.attrs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t("admin.log.retention")}
      </p>
    </div>
  );
}

function summarize(attrs: Record<string, unknown>): string {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(" ");
}

function clockTime(iso: string, locale: string | undefined): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString(locale);
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
