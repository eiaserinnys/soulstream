import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, DashboardIconCap } from "@seosoyoung/soul-ui";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import type { ClaudeAccount, ClaudeAccountDeleteResult, ClaudeAccountList, ClaudeAuthLoginFlow, ProviderQuotaSlots } from "@seosoyoung/soul-ui";
import { ProviderQuotaGrid, ProviderQuotaSkeleton } from "./ProviderQuotaGrid";
import {
  accountPath,
  ClaudeAuthRequestError,
  getClaudeAccounts,
  requestClaudeAuthData,
  requestErrorMessage,
  replaceAccount,
} from "../../lib/claude-auth-api";
import { ClaudeAccountRow } from "./ClaudeAccountRow";
import { ClaudeAuthLoginSheet } from "./ClaudeAuthLoginSheet";
import "./claude-account-pool.css";

type Props = {
  nodeId: string;
  request: typeof fetch;
  initialList: ClaudeAccountList;
  slots: ProviderQuotaSlots;
  loading?: boolean;
};

function ordered(accounts: readonly ClaudeAccount[]): ClaudeAccount[] {
  return [...accounts].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    if (left.priority === null) return right.priority === null ? 0 : 1;
    if (right.priority === null) return -1;
    return left.priority - right.priority;
  });
}

/** 앱의 poolAvailabilityLabel 과 같은 문구를 쓴다. 주간 잔여는 게이지가 이미 보여 준다. */
function summaryText(list: ClaudeAccountList): string {
  const pool = list.pool;
  if (!pool) return `${list.accounts.length}개 계정`;
  return `${pool.available_count}/${pool.total_count} 가용`;
}

function localClock(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function existingAccountId(error: unknown): string | null {
  return error instanceof ClaudeAuthRequestError ? error.apiError?.existing_account_id ?? null : null;
}

/** 새 흐름이 살아 있는 상태. 이 상태로 시작·대체되면 계정 목록을 다시 받아 남은 시간을 맞춘다. */
const ACTIVE_LOGIN_STATES: ReadonlySet<ClaudeAuthLoginFlow["state"]> = new Set([
  "requested",
  "url_ready",
  "code_submitted",
  "verifying",
]);

export function ClaudePoolRow({ nodeId, request, initialList, slots, loading = false }: Props) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["claude-auth-accounts", nodeId] as const, [nodeId]);
  const query = useQuery({
    queryKey,
    queryFn: () => getClaudeAccounts(request, nodeId),
    initialData: initialList,
    staleTime: Infinity,
  });
  const list = query.data ?? initialList;
  const accounts = useMemo(() => ordered(list.accounts), [list.accounts]);
  const enabledCount = accounts.filter((account) => account.enabled).length;
  const [expanded, setExpanded] = useState(false);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [loginFlow, setLoginFlow] = useState<ClaudeAuthLoginFlow | null>(null);
  const [highlightAccountId, setHighlightAccountId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const accountIdsBeforeLogin = useRef<Set<string>>(new Set());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const expiredLoginsHandled = useRef<Set<string>>(new Set());

  const reloadAccounts = useCallback(async () => {
    const next = await getClaudeAccounts(request, nodeId);
    queryClient.setQueryData(queryKey, next);
    return next;
  }, [nodeId, queryClient, queryKey, request]);

  const loginExpiries = useMemo(() => {
    const entries: Array<{ accountId: string; expiresAt: number }> = [];
    for (const account of accounts) {
      if (account.auth_state !== "logging_in" || !account.login_expires_at) continue;
      const expiresAt = new Date(account.login_expires_at).getTime();
      if (Number.isFinite(expiresAt)) entries.push({ accountId: account.id, expiresAt });
    }
    return entries;
  }, [accounts]);

  useEffect(() => {
    if (loginExpiries.length === 0) return;
    // 목록이 바뀐 그 자리에서 지금 시각을 맞춘다. 마운트 때 값이 남아 있으면 남은 분이 틀리게 나온다.
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [loginExpiries]);

  // 남은 시간이 0이 된 계정마다 한 번만 목록을 다시 받아 행이 실제 상태로 바뀌게 한다.
  useEffect(() => {
    const due = loginExpiries.filter(
      (entry) => entry.expiresAt <= nowMs && !expiredLoginsHandled.current.has(`${entry.accountId}:${entry.expiresAt}`),
    );
    if (due.length === 0) return;
    for (const entry of due) expiredLoginsHandled.current.add(`${entry.accountId}:${entry.expiresAt}`);
    void reloadAccounts().catch(() => undefined);
  }, [loginExpiries, nowMs, reloadAccounts]);

  const completeLogin = useCallback(async (accountId: string | null) => {
    const next = await reloadAccounts();
    const added = next.accounts.find((account) => !accountIdsBeforeLogin.current.has(account.id));
    const updated = accountId ? next.accounts.find((account) => account.id === accountId) : null;
    const completed = added ?? updated;
    if (completed) setHighlightAccountId(completed.id);
    setLoginFlow(null);
  }, [reloadAccounts]);

  const startLogin = useCallback(async (accountId: string | null = null) => {
    setActionError(null);
    setNotice(null);
    accountIdsBeforeLogin.current = new Set(accounts.map((account) => account.id));
    const next = await requestClaudeAuthData<ClaudeAuthLoginFlow>(
      request,
      `/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/logins`,
      { method: "POST", body: accountId ? { account_id: accountId } : {} },
    );
    setLoginFlow(next);
    if (next.error?.existing_account_id) setHighlightAccountId(next.error.existing_account_id);
    if (next.state === "done") await completeLogin(next.account_id ?? accountId);
    // 시작·대체된 새 흐름 기준으로 남은 시간이 보이도록 목록을 다시 받는다.
    else if (ACTIVE_LOGIN_STATES.has(next.state)) await reloadAccounts();
    return next;
  }, [accounts, completeLogin, nodeId, reloadAccounts, request]);

  const completeCurrentLogin = useCallback(async () => {
    await completeLogin(loginFlow?.account_id ?? null);
  }, [completeLogin, loginFlow?.account_id]);

  const handleExistingAccount = useCallback((accountId: string) => {
    setHighlightAccountId(accountId);
  }, []);

  const patchAccount = useCallback(async (accountId: string, patch: { enabled?: boolean; priority?: number | null }, optimistic?: (current: ClaudeAccountList) => ClaudeAccountList) => {
    const previous = queryClient.getQueryData<ClaudeAccountList>(queryKey) ?? list;
    const next = optimistic ? optimistic(previous) : replaceAccount(previous, accountId, (account) => ({ ...account, ...patch }));
    queryClient.setQueryData(queryKey, next);
    setBusyAccountId(accountId);
    setActionError(null);
    setNotice(null);
    try {
      const returned = await requestClaudeAuthData<ClaudeAccountList>(request, accountPath(nodeId, accountId), {
        method: "PATCH",
        body: patch,
      });
      queryClient.setQueryData(queryKey, returned);
    } catch (error) {
      queryClient.setQueryData(queryKey, previous);
      setActionError(requestErrorMessage(error));
      const existing = existingAccountId(error);
      if (existing) setHighlightAccountId(existing);
    } finally {
      setBusyAccountId(null);
    }
  }, [list, nodeId, queryClient, queryKey, request]);

  const moveAccount = useCallback(async (account: ClaudeAccount, index: number, direction: -1 | 1) => {
    const destination = index + direction;
    const neighbor = accounts[destination];
    if (!neighbor) return;
    const targetPriority = neighbor.priority ?? destination + 1;
    const sourcePriority = account.priority ?? index + 1;
    const previous = queryClient.getQueryData<ClaudeAccountList>(queryKey) ?? list;
    const next = {
      ...previous,
      accounts: previous.accounts.map((item) => item.id === account.id
        ? { ...item, priority: targetPriority }
        : item.id === neighbor.id ? { ...item, priority: sourcePriority } : item),
    };
    queryClient.setQueryData(queryKey, next);
    setBusyAccountId(account.id);
    setActionError(null);
    setNotice(null);
    try {
      await requestClaudeAuthData<ClaudeAccountList>(request, accountPath(nodeId, neighbor.id), {
        method: "PATCH",
        body: { priority: sourcePriority },
      });
      const returned = await requestClaudeAuthData<ClaudeAccountList>(request, accountPath(nodeId, account.id), {
        method: "PATCH",
        body: { priority: targetPriority },
      });
      queryClient.setQueryData(queryKey, returned);
    } catch (error) {
      try {
        await reloadAccounts();
      } catch {
        queryClient.setQueryData(queryKey, previous);
      }
      setActionError(requestErrorMessage(error));
    } finally {
      setBusyAccountId(null);
    }
  }, [accounts, list, nodeId, queryClient, queryKey, reloadAccounts, request]);

  const deleteAccount = useCallback(async (accountId: string) => {
    const previous = queryClient.getQueryData<ClaudeAccountList>(queryKey) ?? list;
    queryClient.setQueryData(queryKey, { ...previous, accounts: previous.accounts.filter((account) => account.id !== accountId) });
    setBusyAccountId(accountId);
    setActionError(null);
    setNotice(null);
    try {
      const result = await requestClaudeAuthData<ClaudeAccountDeleteResult>(request, accountPath(nodeId, accountId), { method: "DELETE" });
      await reloadAccounts();
      setNotice(result.deferred ? "삭제 예약됨 · 활성 세션 종료 후 제거" : "계정 삭제됨");
      setConfirmingDeleteId(null);
    } catch (error) {
      queryClient.setQueryData(queryKey, previous);
      setActionError(requestErrorMessage(error));
    } finally {
      setBusyAccountId(null);
    }
  }, [list, nodeId, queryClient, queryKey, reloadAccounts, request]);

  async function beginLogin(accountId: string | null = null) {
    setBusyAccountId(accountId);
    try {
      await startLogin(accountId);
    } catch (error) {
      setActionError(requestErrorMessage(error));
      const existing = existingAccountId(error);
      if (existing) setHighlightAccountId(existing);
    } finally {
      setBusyAccountId(null);
    }
  }

  const loginAccount = loginFlow?.account_id
    ? accounts.find((account) => account.id === loginFlow.account_id) ?? null
    : null;

  const available = list.pool?.available_count ?? accounts.filter((account) => account.enabled && account.auth_state !== "idle" && !account.blocked).length;
  const earliestAvailableAt = list.pool?.earliest_available_at ?? null;
  const poolBlocked = list.pool !== null && list.pool.available_count < list.pool.total_count && earliestAvailableAt !== null;
  const releaseLabel = poolBlocked ? localClock(earliestAvailableAt) : null;
  const sessionCount = accounts.reduce((total, account) => total + account.active_sessions, 0);
  const statusColor = available > 0
    ? "var(--color-emerald-400)"
    : enabledCount > 0
      ? "var(--color-amber-400)"
      : "var(--v3-text-tertiary)";

  return <div className="c724-account-row" data-testid="claude-pool-row" data-provider-id="claude">
    <div
      className="c724-account-top"
      data-expandable="true"
      data-testid="claude-pool-row-header"
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
    >
      <div className="c724-account-identity">
        <span className="c724-status-dot" style={{ backgroundColor: statusColor }} />
        <span className="c724-account-email">Claude</span>
        <span className="c724-pool-summary">{summaryText(list)}</span>
        {!expanded && releaseLabel ? <span className="c724-badge c724-badge-warn">{releaseLabel} 해제</span> : null}
        {sessionCount > 0 ? <span className="c724-meta-inline">세션 {sessionCount}</span> : null}
      </div>
      <div className="c724-account-actions" onClick={(event) => event.stopPropagation()}>
        {expanded ? <Button variant="outline" size="sm" disabled={busyAccountId !== null || loginFlow !== null} onClick={() => void beginLogin()}>
          <Plus className="size-4" aria-hidden="true" /> 계정 추가
        </Button> : null}
        {!expanded ? <span className="c724-meta-inline">계정 {accounts.length}</span> : null}
        <DashboardIconCap size="small" label={expanded ? "계정 접기" : "계정 펼치기"} aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          {expanded ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
        </DashboardIconCap>
      </div>
    </div>

    {expanded ? <div className="c724-pool-account-body">
      {notice ? <p className="c724-pool-notice" role="status">{notice}</p> : null}
      {actionError ? <p className="c724-pool-error" role="alert">{actionError}</p> : null}
      <div className="c724-account-list">
        {accounts.map((account, index) => <div key={account.id} className="c724-pool-account-item">
          <ClaudeAccountRow
            account={account}
            index={index}
            enabledCount={enabledCount}
            nowMs={nowMs}
            busy={busyAccountId !== null || loginFlow !== null}
            confirmingDelete={confirmingDeleteId === account.id}
            highlighted={highlightAccountId === account.id}
            onEnabledChange={(enabled) => void patchAccount(account.id, { enabled })}
            onMove={(direction) => moveAccount(account, index, direction)}
            onRelogin={() => void beginLogin(account.id)}
            onRequestDelete={() => { setConfirmingDeleteId(account.id); setActionError(null); setNotice(null); }}
            onCancelDelete={() => setConfirmingDeleteId(null)}
            onDelete={() => void deleteAccount(account.id)}
          />
        </div>)}
      </div>
    </div> : loading ? <ProviderQuotaSkeleton /> : slots.some((slot) => slot !== null)
      ? <ProviderQuotaGrid slots={slots} label="Claude 사용량" />
      : null}

    {loginFlow ? <ClaudeAuthLoginSheet
      nodeId={nodeId}
      request={request}
      account={loginAccount}
      isAdditionalAccount={!loginFlow.account_id && accounts.length > 0}
      initialFlow={loginFlow}
      onClose={() => setLoginFlow(null)}
      onComplete={completeCurrentLogin}
      onExistingAccount={handleExistingAccount}
      onRestart={() => startLogin(loginFlow.account_id)}
    /> : null}
  </div>;
}
