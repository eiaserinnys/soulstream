import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { RotateCw } from "lucide-react";

const RUN_HISTORY_PREFETCH_DISTANCE_PX = 600;

export function RunHistoryAutoLoader({ hasMore, loading, failed, onLoadMore, testId }: {
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onLoadMore(): Promise<void>;
  testId: string;
}) {
  const { t } = useTranslation();
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [intersecting, setIntersecting] = useState(false);

  useEffect(() => {
    if (!hasMore || !sentinelRef.current) return;
    // Ancestor scroll clips apply to this tall target, including nested panels.
    const observer = new IntersectionObserver(([entry]) => {
      setIntersecting(entry.isIntersecting);
    }, { root: null });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore]);

  useEffect(() => {
    if (intersecting && hasMore && !loading && !failed) void onLoadMore();
  }, [failed, hasMore, intersecting, loading, onLoadMore]);

  if (!hasMore) return null;
  return <div className="v3-run-load-more" data-testid={testId}>
    <span ref={sentinelRef} className="v3-run-load-sentinel" aria-hidden="true"
      style={{ height: RUN_HISTORY_PREFETCH_DISTANCE_PX }} />
    {loading ? <span className="v3-detail-empty" role="status">{t("sessions.loading")}</span> : failed ? <>
      <span className="v3-detail-empty" role="status">{t("sessions.historyLoadFailed")}</span>
      <DashboardIconCap label={t("sessions.retry")} onClick={() => { void onLoadMore(); }}>
        <RotateCw className="h-4 w-4" aria-hidden="true" />
      </DashboardIconCap>
    </> : null}
  </div>;
}
