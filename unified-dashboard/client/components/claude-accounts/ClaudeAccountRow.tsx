import { Button, DashboardIconCap, Switch } from "@seosoyoung/soul-ui";
import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from "lucide-react";
import type { ClaudeAccount, ClaudeAccountUsageWindow } from "@seosoyoung/soul-ui";

type Props = {
  account: ClaudeAccount;
  index: number;
  enabledCount: number;
  busy: boolean;
  confirmingDelete: boolean;
  highlighted: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onMove: (direction: -1 | 1) => void;
  onRelogin: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
};

function localClock(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
    : null;
}

function resetLabel(window: ClaudeAccountUsageWindow | null): string {
  if (!window?.resets_at) return "미측정";
  const reset = new Date(window.resets_at);
  if (!Number.isFinite(reset.getTime())) return "미측정";
  if (window.used_percent >= 100) {
    const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(reset);
    return `${time} 해제`;
  }
  const minutes = Math.max(0, Math.ceil((reset.getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}분 후`;
  if (minutes < 12 * 60) return `${Math.ceil(minutes / 60)}시간 후`;
  return new Intl.DateTimeFormat("ko-KR", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(reset);
}

function quotaColor(usedPercent: number): string {
  if (usedPercent >= 95) return "var(--color-red-500)";
  if (usedPercent >= 80) return "var(--color-amber-500)";
  return "var(--v3-accent)";
}

function statusColor(account: ClaudeAccount): string {
  if (!account.enabled || account.auth_state === "idle") return "var(--v3-text-tertiary)";
  if (account.auth_state === "needs_relogin") return "var(--color-red-400)";
  if (account.blocked) return "var(--color-amber-400)";
  if (account.auth_state === "logging_in") return "var(--v3-accent)";
  return "var(--color-emerald-400)";
}

function accountStatus(account: ClaudeAccount): string | null {
  if (account.auth_state === "needs_relogin") return "재로그인 필요";
  if (account.auth_state === "logging_in") return "로그인 중";
  if (!account.enabled) return "사용 안 함";
  if (account.auth_state === "idle") return "대기";
  if (account.blocked) {
    const until = localClock(account.blocked.until) ?? "해제 시각 미정";
    return account.blocked.scope === "fable" ? `Fable ${until} 해제` : `${until} 해제`;
  }
  return null;
}

function QuotaCell({ label, value }: { label: string; value: ClaudeAccountUsageWindow | null }) {
  const used = value ? Math.min(100, Math.max(0, value.used_percent)) : 0;
  return <div className="c724-quota-cell">
    <div className="c724-quota-label-row">
      <span className="c724-quota-name">{label}</span>
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="c724-quota-pct">{value ? `${Math.round(value.used_percent)}%` : "—"}</span>
        <span className="c724-quota-reset">{resetLabel(value)}</span>
      </div>
    </div>
    <div className="c724-quota-track" aria-hidden="true">
      {value ? <div className="c724-quota-fill" style={{ width: `${used}%`, backgroundColor: quotaColor(used) }} /> : null}
    </div>
  </div>;
}

export function ClaudeAccountRow({
  account,
  index,
  enabledCount,
  busy,
  confirmingDelete,
  highlighted,
  onEnabledChange,
  onMove,
  onRelogin,
  onRequestDelete,
  onCancelDelete,
  onDelete,
}: Props) {
  const status = accountStatus(account);
  const rowState = account.auth_state === "needs_relogin" ? "needs_relogin" : account.blocked ? "blocked" : "normal";
  const hasUsage = account.usage.five_hour !== null || account.usage.seven_day !== null || account.usage.fable_weekly !== null;
  const observed = account.observed_at ? localClock(account.observed_at) : null;
  const showPriority = enabledCount > 1 && account.enabled;

  return <div
    className="c724-account-row"
    data-account-id={account.id}
    data-disabled={!account.enabled}
    data-state={rowState}
    data-highlighted={highlighted || undefined}
  >
    <div className="c724-account-top">
      <div className="c724-account-identity">
        <span className="c724-status-dot" style={{ backgroundColor: statusColor(account) }} />
        <span className="c724-account-email" title={account.email}>{account.email}</span>
        {account.plan ? <span className="c724-badge c724-badge-neutral">{account.plan}</span> : null}
        {showPriority ? <span className="c724-badge c724-badge-accent">{index + 1}순위</span> : null}
        {status ? <span className={`c724-badge ${account.auth_state === "needs_relogin" ? "c724-badge-danger" : account.blocked ? "c724-badge-warn" : "c724-badge-neutral"}`}>{status}</span> : null}
        {account.active_sessions > 0 ? <span className="c724-meta-inline">세션 {account.active_sessions}</span> : null}
      </div>

      <div className="c724-account-actions">
        <span className="c724-switch-wrap">
          <Switch checked={account.enabled} disabled={busy} aria-label={`${account.email} 사용`} onCheckedChange={onEnabledChange} />
        </span>
        {showPriority ? <>
          <DashboardIconCap size="small" label="우선순위 올리기" disabled={busy || index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-4" aria-hidden="true" />
          </DashboardIconCap>
          <DashboardIconCap size="small" label="우선순위 내리기" disabled={busy || index >= enabledCount - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-4" aria-hidden="true" />
          </DashboardIconCap>
        </> : null}
        <DashboardIconCap size="small" label="재로그인" disabled={busy} onClick={onRelogin}>
          <RotateCcw className="size-4" aria-hidden="true" />
        </DashboardIconCap>
        <DashboardIconCap size="small" label="계정 삭제" disabled={busy} onClick={onRequestDelete}>
          <Trash2 className="size-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
    </div>

    {hasUsage ? <div className="c724-quota-grid" aria-label={`${account.email} 사용량`}>
      <QuotaCell label="5시간" value={account.usage.five_hour} />
      <QuotaCell label="7일" value={account.usage.seven_day} />
      <QuotaCell label="Fable" value={account.usage.fable_weekly} />
    </div> : <div className="c724-idle-row">
      <span className="c724-meta-inline">{account.auth_state === "needs_relogin" ? "인증 만료로 사용량 조회 중단" : "미측정 (실제 호출 시 갱신)"}</span>
      <span className="c724-meta-inline">{observed ? `${observed} ${account.auth_state === "idle" ? "확인" : "갱신"}` : ""}</span>
    </div>}

    {confirmingDelete ? <div className="c724-confirm-bar" data-testid={`delete-confirm-${account.id}`}>
      <span className="c724-confirm-text">이 계정을 노드에서 삭제할까요?</span>
      <div className="c724-confirm-actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancelDelete}>취소</Button>
        <Button variant="destructive" size="sm" disabled={busy} onClick={onDelete}>{busy ? "삭제 중" : "삭제"}</Button>
      </div>
    </div> : null}
  </div>;
}
