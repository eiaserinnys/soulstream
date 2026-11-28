import { useTranslation } from "react-i18next";
import { Button, DashboardIconCap, Switch } from "@seosoyoung/soul-ui";
import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from "lucide-react";
import type { ClaudeAccount, ClaudeAccountUsageWindow } from "../../../../packages/wire-schema/generated/typescript/index";
import { accountClockLabel, ProviderQuotaGrid, type QuotaWindow } from "./ProviderQuotaGrid";

type Props = {
  account: ClaudeAccount;
  index: number;
  enabledCount: number;
  nowMs: number;
  busy: boolean;
  confirmingDelete: boolean;
  highlighted: boolean;
  /** 중앙 풀 대상이면 삭제 확인 문구가 「중앙 풀에서」가 된다. */
  central?: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onMove: (direction: -1 | 1) => void;
  onRelogin: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
};

function windowSlot(
  kind: QuotaWindow["kind"],
  window: ClaudeAccountUsageWindow | null,
): QuotaWindow | null {
  if (!window) return null;
  const reset = window.resets_at ? new Date(window.resets_at).getTime() : NaN;
  return {
    kind,
    usedPercent: Math.min(100, Math.max(0, window.used_percent)),
    resetAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null,
    sevenDay: kind === "weekly" || kind === "fable",
  };
}

function statusColor(account: ClaudeAccount): string {
  if (!account.enabled || account.auth_state === "idle") return "var(--v3-text-tertiary)";
  if (account.auth_state === "needs_relogin") return "var(--color-red-400)";
  if (account.blocked) return "var(--color-amber-400)";
  if (account.auth_state === "logging_in") return "var(--v3-accent)";
  return "var(--color-emerald-400)";
}

function accountStatus(account: ClaudeAccount, nowMs: number, t: ReturnType<typeof useTranslation>["t"], locale: string | undefined): string | null {
  if (account.auth_state === "needs_relogin") return t("accounts.claude.needsRelogin");
  if (account.auth_state === "logging_in") {
    const expiresAt = account.login_expires_at ? new Date(account.login_expires_at).getTime() : NaN;
    const remainingMinutes = Number.isFinite(expiresAt) ? Math.ceil((expiresAt - nowMs) / 60_000) : 0;
    return remainingMinutes > 0 ? t("accounts.claude.loginMinutes", { value: remainingMinutes }) : t("accounts.claude.loggingIn");
  }
  if (!account.enabled) return t("accounts.claude.disabled");
  if (account.auth_state === "idle") return t("accounts.claude.idle");
  if (account.blocked) {
    const until = accountClockLabel(account.blocked.until, locale) ?? t("accounts.quota.unknownReset");
    return account.blocked.scope === "fable" ? t("accounts.quota.modelReset", { value: until }) : t("accounts.quota.resets", { value: until });
  }
  return null;
}

export function ClaudeAccountRow({
  account,
  index,
  enabledCount,
  nowMs,
  busy,
  confirmingDelete,
  highlighted,
  central = false,
  onEnabledChange,
  onMove,
  onRelogin,
  onRequestDelete,
  onCancelDelete,
  onDelete,
}: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const status = accountStatus(account, nowMs, t, locale);
  const rowState = account.auth_state === "needs_relogin" ? "needs_relogin" : account.blocked ? "blocked" : "normal";
  const hasUsage = account.usage.five_hour !== null || account.usage.seven_day !== null || account.usage.fable_weekly !== null;
  const observed = account.observed_at ? accountClockLabel(account.observed_at, locale) : null;
  const showPriority = enabledCount > 1 && account.enabled;
  const slots = [
    windowSlot("short", account.usage.five_hour),
    windowSlot("weekly", account.usage.seven_day),
    windowSlot("fable", account.usage.fable_weekly),
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
        <span className="c724-account-email" data-selectable="true" title={account.email} data-v3-selectable-content="true">{account.email}</span>
        {account.plan ? <span className="c724-badge c724-badge-neutral">{account.plan}</span> : null}
        {showPriority ? <span className="c724-badge c724-badge-accent">{t("accounts.claude.priority", { number: index + 1 })}</span> : null}
        {status ? <span className={`c724-badge ${account.auth_state === "needs_relogin" ? "c724-badge-danger" : account.blocked ? "c724-badge-warn" : "c724-badge-neutral"}`}>{status}</span> : null}
        {account.active_sessions > 0 ? <span className="c724-meta-inline" data-v3-selectable-content="true">{t("accounts.claude.sessions", { number: account.active_sessions })}</span> : null}
      </div>

      <div className="c724-account-actions">
        <span className="c724-switch-wrap">
          <Switch checked={account.enabled} disabled={busy} aria-label={t("accounts.claude.enableAccount", { value: account.email })} onCheckedChange={onEnabledChange} />
        </span>
        {showPriority ? <>
          <DashboardIconCap size="small" label={t("accounts.claude.moveUp")} disabled={busy || index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-4" aria-hidden="true" />
          </DashboardIconCap>
          <DashboardIconCap size="small" label={t("accounts.claude.moveDown")} disabled={busy || index >= enabledCount - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-4" aria-hidden="true" />
          </DashboardIconCap>
        </> : null}
        <DashboardIconCap size="small" label={account.auth_state === "logging_in" ? t("accounts.claude.restartLogin") : t("accounts.common.relogin")} disabled={busy} onClick={onRelogin}>
          <RotateCcw className="size-4" aria-hidden="true" />
        </DashboardIconCap>
        <DashboardIconCap size="small" label={t("accounts.claude.deleteAccount")} disabled={busy} onClick={onRequestDelete}>
          <Trash2 className="size-4" aria-hidden="true" />
        </DashboardIconCap>
      </div>
    </div>

    {hasUsage ? <ProviderQuotaGrid slots={slots} label={t("accounts.quota.usage", { value: account.email })} /> : <div className="c724-idle-row">
      <span className="c724-meta-inline">{account.auth_state === "needs_relogin" ? t("accounts.claude.usageAuthExpired") : t("accounts.claude.notMeasured")}</span>
      <span className="c724-meta-inline" data-v3-selectable-content="true">{observed ? t(account.auth_state === "idle" ? "accounts.claude.observed" : "accounts.claude.updated", { time: observed }) : ""}</span>
    </div>}

    {confirmingDelete ? <div className="c724-confirm-bar" data-testid={`delete-confirm-${account.id}`}>
      <span className="c724-confirm-text">{central ? t("accounts.claude.deleteCentralConfirm") : t("accounts.claude.deleteNodeConfirm")}</span>
      <div className="c724-confirm-actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancelDelete}>{t("accounts.common.cancel")}</Button>
        <Button variant="destructive" size="sm" disabled={busy} onClick={onDelete}>{busy ? t("accounts.common.deleting") : t("accounts.common.delete")}</Button>
      </div>
    </div> : null}
  </div>;
}
