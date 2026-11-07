import { Button, DashboardIconCap, Switch } from "@seosoyoung/soul-ui";
import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from "lucide-react";
import type { ClaudeAccount, ClaudeAccountUsageWindow, ProviderQuotaSlot, ProviderQuotaSlots } from "@seosoyoung/soul-ui";
import { ProviderQuotaGrid } from "./ProviderQuotaGrid";

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

function windowSlot(
  kind: ProviderQuotaSlot["kind"],
  label: string,
  window: ClaudeAccountUsageWindow | null,
): ProviderQuotaSlot | null {
  if (!window) return null;
  const reset = window.resets_at ? new Date(window.resets_at).getTime() : NaN;
  return {
    kind,
    label,
    usedPercent: Math.min(100, Math.max(0, window.used_percent)),
    resetAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null,
  };
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
  const slots: ProviderQuotaSlots = [
    windowSlot("short", "5시간", account.usage.five_hour),
    windowSlot("weekly", "7일", account.usage.seven_day),
    windowSlot("fable", "Fable", account.usage.fable_weekly),
  ];

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
        <span className="c724-account-email" data-selectable="true" title={account.email}>{account.email}</span>
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

    {hasUsage ? <ProviderQuotaGrid slots={slots} label={`${account.email} 사용량`} /> : <div className="c724-idle-row">
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
