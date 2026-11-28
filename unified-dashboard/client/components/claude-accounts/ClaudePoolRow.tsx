import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, DashboardIconCap, type ProviderQuotaSlots } from "@seosoyoung/soul-ui";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import type { ClaudeAccount, ClaudeAccountDeleteResult, ClaudeAccountList, ClaudeAuthLoginFlow } from "../../../../packages/wire-schema/generated/typescript/index";
import { accountClockLabel, ProviderQuotaGrid, ProviderQuotaSkeleton } from "./ProviderQuotaGrid";
import {
  accountPath,
  CENTRAL_CLAUDE_TARGET,
  claudeLoginsPath,
  ClaudeAuthRequestError,
  getClaudeAccounts,
  nodeClaudeTarget,
  requestClaudeAuthData,
  requestErrorMessage,
  replaceAccount,
  type ClaudeAccountPatch,
  type ClaudeAccountTarget,
} from "../../lib/claude-auth-api";
import { ClaudeAccountRow } from "./ClaudeAccountRow";
import { ClaudeAuthLoginSheet } from "./ClaudeAuthLoginSheet";
import { planPriorityMove } from "./priority-order";
import "./claude-account-pool.css";

/**
 * 같은 풀 줄이 대상만 바꿔 그린다. 노드는 그 노드의 계정 API를, 중앙은 오케스트레이터의
 * 중앙 풀 API를 부른다. 기존 호출지와 시험은 `nodeId`만 넘긴다.
 */
type TargetProps =
  | { nodeId: string; central?: false }
  | { central: true; nodeId?: never };

type Props = TargetProps & {
  request: typeof fetch;
  initialList: ClaudeAccountList;
  slots: ProviderQuotaSlots;
  loading?: boolean;
  /** 노드 대상의 펼친 영역 맨 위에 그릴 줄(중앙 풀 받기). 중앙 대상에는 그리지 않는다. */
  centralReceiveRow?: ReactNode;
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
function summaryText(list: ClaudeAccountList, t: ReturnType<typeof useTranslation>["t"]): string {
  const pool = list.pool;
  if (!pool) return t("accounts.claude.accountTotal", { value: list.accounts.length });
  return t("accounts.claude.available", { value: pool.available_count, value1: pool.total_count });
}

function existingAccountId(error: unknown): string | null {
  return error instanceof ClaudeAuthRequestError ? error.apiError?.existing_account_id ?? null : null;
}

/** 중앙은 priority null을 0으로 바꾸므로 null을 보내지 않는다. */
function patchBody(target: ClaudeAccountTarget, patch: ClaudeAccountPatch): ClaudeAccountPatch {
  if (target.scope !== "central") return patch;
  return {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(typeof patch.priority === "number" ? { priority: patch.priority } : {}),
  };
}

/** 새 흐름이 살아 있는 상태. 이 상태로 시작·대체되면 계정 목록을 다시 받아 남은 시간을 맞춘다. */
const ACTIVE_LOGIN_STATES: ReadonlySet<ClaudeAuthLoginFlow["state"]> = new Set([
  "requested",
  "url_ready",
  "code_submitted",
  "verifying",
]);

export function ClaudePoolRow(props: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { request, initialList, slots, loading = false, centralReceiveRow } = props;
  const target = useMemo<ClaudeAccountTarget>(
    () => props.central ? CENTRAL_CLAUDE_TARGET : nodeClaudeTarget(props.nodeId),
    [props.central, props.nodeId],
  );
  const isCentral = target.scope === "central";
  const nodeId = target.scope === "node" ? target.nodeId : null;
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["claude-auth-accounts", nodeId ?? { scope: "central" }] as const,
    [nodeId],
  );
  const query = useQuery({
    queryKey,
    queryFn: () => getClaudeAccounts(request, target),
    initialData: initialList,
    staleTime: Infinity,
  });
  const list = query.data ?? initialList;
  const orderedAccounts = useMemo(() => ordered(list.accounts), [list.accounts]);
  // 노드 목록에는 그 노드의 로컬 계정만 그린다. 중앙 계정은 중앙 풀에서만 다룬다.
  const accounts = useMemo(
    () => isCentral ? orderedAccounts : orderedAccounts.filter((account) => account.source !== "central"),
    [isCentral, orderedAccounts],
  );
  const enabledCount = accounts.filter((account) => account.enabled).length;
  const [expanded, setExpanded] = useState(false);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [loginFlow, setLoginFlow] = useState<ClaudeAuthLoginFlow | null>(null);
  const [highlightAccountId, setHighlightAccountId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const accountIdsBeforeLogin = useRef<Set<string>>(new Set());
  const loginOpenerRef = useRef<HTMLElement | null>(null);
  const loginSheetWasOpen = useRef(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const expiredLoginsHandled = useRef<Set<string>>(new Set());

  // 시트를 닫으면 연 요소로 초점을 돌린다(ui-design 0절 14번). 그 사이 행이 사라졌으면 옮기지 않는다.
  useEffect(() => {
    if (loginFlow) {
      loginSheetWasOpen.current = true;
      return;
    }
    if (!loginSheetWasOpen.current) return;
    loginSheetWasOpen.current = false;
    const opener = loginOpenerRef.current;
    if (opener?.isConnected) opener.focus();
    loginOpenerRef.current = null;
  }, [loginFlow]);

  const reloadAccounts = useCallback(async () => {
    const next = await getClaudeAccounts(request, target);
    queryClient.setQueryData(queryKey, next);
    return next;
  }, [queryClient, queryKey, request, target]);

  /** 중앙을 바꾼 뒤에는 노드가 받는 계정도 달라지므로 노드 계정 목록 질의를 무효로 한다. */
  const invalidateNodeAccounts = useCallback(() => {
    if (!isCentral) return;
    void queryClient.invalidateQueries({
      predicate: (candidate) => candidate.queryKey[0] === "claude-auth-accounts" && typeof candidate.queryKey[1] === "string",
    });
  }, [isCentral, queryClient]);

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
    const added = next.accounts.find((account) => !accountIdsBeforeLogin.current.has(account.id)
      && (isCentral || account.source !== "central"));
    const updated = accountId ? next.accounts.find((account) => account.id === accountId) : null;
    const completed = added ?? updated;
    if (completed) setHighlightAccountId(completed.id);
    setLoginFlow(null);
    invalidateNodeAccounts();
  }, [invalidateNodeAccounts, isCentral, reloadAccounts]);

  const startLogin = useCallback(async (accountId: string | null = null) => {
    setActionError(null);
    setNotice(null);
    accountIdsBeforeLogin.current = new Set(accounts.map((account) => account.id));
    const next = await requestClaudeAuthData<ClaudeAuthLoginFlow>(
      request,
      claudeLoginsPath(target),
      { method: "POST", body: accountId ? { account_id: accountId } : {} },
    );
    setLoginFlow(next);
    if (next.error?.existing_account_id) setHighlightAccountId(next.error.existing_account_id);
    if (next.state === "done") await completeLogin(next.account_id ?? accountId);
    // 시작·대체된 새 흐름 기준으로 남은 시간이 보이도록 목록을 다시 받는다.
    else if (ACTIVE_LOGIN_STATES.has(next.state)) await reloadAccounts();
    return next;
  }, [accounts, completeLogin, reloadAccounts, request, target]);

  const completeCurrentLogin = useCallback(async () => {
    await completeLogin(loginFlow?.account_id ?? null);
  }, [completeLogin, loginFlow?.account_id]);

  const handleExistingAccount = useCallback((accountId: string) => {
    setHighlightAccountId(accountId);
  }, []);

  const patchAccount = useCallback(async (accountId: string, patch: ClaudeAccountPatch, optimistic?: (current: ClaudeAccountList) => ClaudeAccountList) => {
    const previous = queryClient.getQueryData<ClaudeAccountList>(queryKey) ?? list;
    const next = optimistic ? optimistic(previous) : replaceAccount(previous, accountId, (account) => ({ ...account, ...patch }));
    queryClient.setQueryData(queryKey, next);
    setBusyAccountId(accountId);
    setActionError(null);
    setNotice(null);
    try {
      const returned = await requestClaudeAuthData<ClaudeAccountList>(request, accountPath(target, accountId), {
        method: "PATCH",
        body: patchBody(target, patch),
      });
      queryClient.setQueryData(queryKey, returned);
      invalidateNodeAccounts();
    } catch (error) {
      queryClient.setQueryData(queryKey, previous);
      setActionError(requestErrorMessage(error, t));
      const existing = existingAccountId(error);
      if (existing) setHighlightAccountId(existing);
    } finally {
      setBusyAccountId(null);
    }
  }, [invalidateNodeAccounts, list, queryClient, queryKey, request, t, target]);

  const moveAccount = useCallback(async (account: ClaudeAccount, index: number, direction: -1 | 1) => {
    // 순위와 이동은 보이는 로컬 계정만으로 센다. 중앙 계정의 순서에는 손대지 않는다.
    const plan = planPriorityMove(accounts, index, direction);
    if (!plan) return;
    const previous = queryClient.getQueryData<ClaudeAccountList>(queryKey) ?? list;
    // 숨긴 중앙 계정은 그대로 두고, 보이는 로컬 계정의 우선순위만 먼저 바꿔 그린다.
    const planned = new Map(plan.accounts.map((item) => [item.id, item]));
    queryClient.setQueryData(queryKey, {
      ...previous,
      accounts: previous.accounts.map((item) => planned.get(item.id) ?? item),
    });
    setBusyAccountId(account.id);
    setActionError(null);
    setNotice(null);
    try {
      // 저장 순서(서버 목록 순서)대로 보낸다. 중간 응답이 마지막 상태를 덮지 않도록 마지막 응답만 화면에 쓴다.
      const storedPositions = new Map(previous.accounts.map((item, position) => [item.id, position]));
      const patches = [...plan.patches].sort((left, right) => (
        (storedPositions.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (storedPositions.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      ));
      let latest: ClaudeAccountList | null = null;
      for (const patch of patches) {
        latest = await requestClaudeAuthData<ClaudeAccountList>(request, accountPath(target, patch.id), {
          method: "PATCH",
          body: patchBody(target, { priority: patch.priority }),
        });
      }
      if (latest) queryClient.setQueryData(queryKey, latest);
      invalidateNodeAccounts();
    } catch (error) {
      try {
        await reloadAccounts();
      } catch {
        queryClient.setQueryData(queryKey, previous);
      }
      setActionError(requestErrorMessage(error, t));
    } finally {
      setBusyAccountId(null);
    }
  }, [accounts, invalidateNodeAccounts, list, queryClient, queryKey, reloadAccounts, request, t, target]);

  const deleteAccount = useCallback(async (accountId: string) => {
    const previous = queryClient.getQueryData<ClaudeAccountList>(queryKey) ?? list;
    queryClient.setQueryData(queryKey, { ...previous, accounts: previous.accounts.filter((account) => account.id !== accountId) });
    setBusyAccountId(accountId);
    setActionError(null);
    setNotice(null);
    try {
      if (isCentral) {
        // 중앙 삭제는 deferred 없이 곧바로 지워지므로 목록을 다시 읽어 화면을 맞춘다.
        await requestClaudeAuthData<{ success: boolean }>(request, accountPath(target, accountId), { method: "DELETE" });
        await reloadAccounts();
        setNotice(t("accounts.claude.removed"));
      } else {
        const result = await requestClaudeAuthData<ClaudeAccountDeleteResult>(request, accountPath(target, accountId), { method: "DELETE" });
        await reloadAccounts();
        setNotice(result.deferred ? t("accounts.claude.deferredRemoval") : t("accounts.claude.removed"));
      }
      setConfirmingDeleteId(null);
      invalidateNodeAccounts();
    } catch (error) {
      queryClient.setQueryData(queryKey, previous);
      setActionError(requestErrorMessage(error, t));
    } finally {
      setBusyAccountId(null);
    }
  }, [invalidateNodeAccounts, isCentral, list, queryClient, queryKey, reloadAccounts, request, t, target]);

  async function beginLogin(accountId: string | null = null) {
    loginOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusyAccountId(accountId);
    try {
      await startLogin(accountId);
    } catch (error) {
      setActionError(requestErrorMessage(error, t));
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
  const releaseLabel = poolBlocked ? accountClockLabel(earliestAvailableAt, locale) : null;
  const unconfigured = list.pool?.total_count === 0;
  const sessionCount = list.accounts.reduce((total, account) => total + account.active_sessions, 0);
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
        {unconfigured ? null : <span className="c724-pool-summary">{summaryText(list, t)}</span>}
        {!expanded && releaseLabel ? <span className="c724-badge c724-badge-warn">{t("accounts.quota.resets", { value: releaseLabel })}</span> : null}
        {sessionCount > 0 ? <span className="c724-meta-inline">{t("accounts.claude.sessions", { number: sessionCount })}</span> : null}
      </div>
      {unconfigured ? <span className="c724-meta-inline">{t("accounts.common.unconfigured")}</span> : null}
      <div className="c724-account-actions" onClick={(event) => event.stopPropagation()}>
        {expanded ? <Button variant="outline" size="sm" disabled={busyAccountId !== null || loginFlow !== null} onClick={() => void beginLogin()}>
          <Plus className="size-4" aria-hidden="true" />{" "}{t("accounts.claude.addAccount")}
        </Button> : null}
        {!expanded && unconfigured
          ? <Button size="sm" disabled={busyAccountId !== null || loginFlow !== null} onClick={() => void beginLogin()}>{t("accounts.common.connect")}</Button>
          : null}
        {!expanded && !unconfigured ? <span className="c724-meta-inline">{t("accounts.claude.accountCount", { number: accounts.length })}</span> : null}
        <DashboardIconCap size="small" label={expanded ? t("accounts.claude.collapseAccounts") : t("accounts.claude.expandAccounts")} aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          {expanded ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
        </DashboardIconCap>
      </div>
    </div>

    {expanded ? <div className="c724-pool-account-body">
      {!isCentral && centralReceiveRow ? centralReceiveRow : null}
      {notice ? <p className="c724-pool-notice" role="status">{notice}</p> : null}
      {actionError ? <p className="c724-pool-error" role="alert" data-v3-selectable-content="true">{actionError}</p> : null}
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
            central={isCentral}
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
      ? <ProviderQuotaGrid slots={slots} label={t("accounts.claude.usage")} />
      : null}

    {loginFlow ? <ClaudeAuthLoginSheet
      target={target}
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
