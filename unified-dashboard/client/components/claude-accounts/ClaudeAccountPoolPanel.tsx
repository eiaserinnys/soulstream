import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@seosoyoung/soul-ui";
import { Plus } from "lucide-react";
import type { ClaudeAccount, ClaudeAccountDeleteResult, ClaudeAccountList, ClaudeAuthLoginFlow } from "@seosoyoung/soul-ui";
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
};

function ordered(accounts: readonly ClaudeAccount[]): ClaudeAccount[] {
  return [...accounts].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    if (left.priority === null) return right.priority === null ? 0 : 1;
    if (right.priority === null) return -1;
    return left.priority - right.priority;
  });
}

function summaryText(list: ClaudeAccountList): string {
  const pool = list.pool;
  if (!pool) return `${list.accounts.length}개 계정`;
  const weekly = pool.best_weekly_remaining_percent;
  if (pool.total_count === 1) return `주간 잔여 ${weekly === null ? "—" : `${Math.round(weekly)}%`}`;
  return `${pool.available_count}/${pool.total_count} 가용${weekly === null ? "" : ` (주간 최대 잔여 ${Math.round(weekly)}%)`}`;
}

function existingAccountId(error: unknown): string | null {
  return error instanceof ClaudeAuthRequestError ? error.apiError?.existing_account_id ?? null : null;
}

export function ClaudeAccountPoolPanel({ nodeId, request, initialList }: Props) {
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
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [loginFlow, setLoginFlow] = useState<ClaudeAuthLoginFlow | null>(null);
  const [highlightAccountId, setHighlightAccountId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const accountIdsBeforeLogin = useRef<Set<string>>(new Set());

  const reloadAccounts = useCallback(async () => {
    const next = await getClaudeAccounts(request, nodeId);
    queryClient.setQueryData(queryKey, next);
    return next;
  }, [nodeId, queryClient, queryKey, request]);

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
    return next;
  }, [accounts, completeLogin, nodeId, request]);

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

  return <div className="border-t border-border px-3 py-3">
    <section className="c724-pool-section" data-testid="claude-account-pool-panel">
      <div className="c724-pool-header">
        <div className="c724-pool-title-group">
          <span className="c724-pool-title">Claude 계정</span>
          <span className="c724-pool-summary">{summaryText(list)}</span>
        </div>
        <Button variant="outline" size="sm" disabled={busyAccountId !== null || loginFlow !== null} onClick={() => void beginLogin()}>
          <Plus className="size-4" aria-hidden="true" /> 계정 추가
        </Button>
      </div>

      {notice ? <p className="c724-pool-notice" role="status">{notice}</p> : null}
      {actionError ? <p className="c724-pool-error" role="alert">{actionError}</p> : null}
      <div className="c724-account-list">
        {accounts.map((account, index) => <ClaudeAccountRow
          key={account.id}
          account={account}
          index={index}
          enabledCount={enabledCount}
          busy={busyAccountId !== null || loginFlow !== null}
          confirmingDelete={confirmingDeleteId === account.id}
          highlighted={highlightAccountId === account.id}
          onEnabledChange={(enabled) => void patchAccount(account.id, { enabled })}
          onMove={(direction) => moveAccount(account, index, direction)}
          onRelogin={() => void beginLogin(account.id)}
          onRequestDelete={() => { setConfirmingDeleteId(account.id); setActionError(null); setNotice(null); }}
          onCancelDelete={() => setConfirmingDeleteId(null)}
          onDelete={() => void deleteAccount(account.id)}
        />)}
      </div>
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
    </section>
  </div>;
}
