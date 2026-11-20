import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Switch,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as WebBrowser from 'expo-web-browser';
import type {
  ClaudeAccount,
  ClaudeAccountList,
  ClaudeAccountPool,
  ClaudeAuthLoginFlow,
} from '../../../../packages/soul-ui/src/lib/usage-summary';
import type { ApiClient } from '../../api/client';
import { ApiHttpError } from '../../api/clientCore';
import { useDeviceType, useTokens } from '../../theme';
import { makeClaudePoolStyles } from './claudeAccountPoolStyles';
import { ClaudeAccountLoginFlowPanel } from './ClaudeAccountLoginFlowPanel';
import { ClaudeCentralReceiveRow, type ClaudeCentralSettingsApi } from './ClaudeCentralReceiveRow';
import { GlassButton } from '../GlassSurface';
import { ProviderQuotaGrid, type QuotaGridCell } from './ProviderQuotaGrid';
import { SettingsDivider } from './SettingsSection';

export type ClaudeAccountPoolApi = Pick<ApiClient,
  | 'getClaudeAuthAccounts'
  | 'patchClaudeAuthAccount'
  | 'deleteClaudeAuthAccount'
  | 'startClaudeAuthLogin'
  | 'getClaudeAuthLogin'
  | 'submitClaudeAuthLoginCode'
  | 'cancelClaudeAuthLogin'
>;

/** 중앙 풀의 같은 동작을 부르는 함수 묶음. 노드 함수와 대상만 다르다. */
export type ClaudeCentralPoolApi = Pick<ApiClient,
  | 'getCentralClaudeAuthAccounts'
  | 'patchCentralClaudeAuthAccount'
  | 'deleteCentralClaudeAuthAccount'
  | 'startCentralClaudeAuthLogin'
  | 'getCentralClaudeAuthLogin'
  | 'submitCentralClaudeAuthLoginCode'
  | 'cancelCentralClaudeAuthLogin'
>;

export type ClaudeAccountPoolSectionHandle = {
  startLogin(): void;
};

type CommonProps = {
  initialList: ClaudeAccountList;
  showHeader?: boolean;
  /** 머리 제목. 중앙 대상은 「중앙 풀」을 넘긴다. */
  title?: string;
  onListChange?(list: ClaudeAccountList): void;
  onLoginStartingChange?(starting: boolean): void;
  /** 노드 목록 맨 위에 「중앙 풀 받기」 한 줄을 그릴 때 넘긴다. */
  centralSettingsApi?: ClaudeCentralSettingsApi;
  /** 중앙 계정을 수정·삭제했거나 로그인을 마쳤을 때 알린다. 노드 화면이 목록과 사용량을 다시 읽는다. */
  onCentralChange?(): void;
};

type Props = CommonProps & (
  | { nodeId: string; central?: false; api: ClaudeAccountPoolApi }
  | { central: true; nodeId?: never; api: ClaudeAccountPoolApi & ClaudeCentralPoolApi }
);

const terminalStates = new Set(['done', 'failed', 'cancelled']);

type TrackedLogin = { scope: string; loginId: string; state: ClaudeAuthLoginFlow['state'] };

function sortedAccounts(accounts: readonly ClaudeAccount[]): ClaudeAccount[] {
  return accounts.map((account, index) => ({ account, index }))
    .sort((left, right) => (left.account.priority ?? Number.MAX_SAFE_INTEGER) - (right.account.priority ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index)
    .map(entry => entry.account);
}

function priorityBetween(accounts: readonly ClaudeAccount[], accountId: string): number | null {
  const index = accounts.findIndex(account => account.id === accountId);
  if (index < 0) return null;
  const others = accounts.filter(account => account.id !== accountId);
  const priorities = others.map(account => account.priority);
  if (priorities.some(priority => priority === null || !Number.isFinite(priority))
    || new Set(priorities).size !== priorities.length) return null;

  const left = accounts[index - 1]?.priority;
  const right = accounts[index + 1]?.priority;
  let candidate: number;
  if (left !== undefined && right !== undefined) {
    if (left === null || right === null || left >= right) return null;
    candidate = left + (right - left) / 2;
    if (candidate <= left || candidate >= right) return null;
  } else if (right !== undefined) {
    if (right === null) return null;
    candidate = right - 1;
  } else if (left !== undefined) {
    if (left === null) return null;
    candidate = left + 1;
  } else {
    return null;
  }
  if (!Number.isFinite(candidate) || priorities.includes(candidate)) return null;
  const simulated = sortedAccounts(accounts.map(account => account.id === accountId
    ? { ...account, priority: candidate }
    : account));
  if (!simulated.every((account, position) => account.id === accounts[position].id)) return null;
  return candidate;
}

function localClock(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function poolSummaryLabel(pool: ClaudeAccountPool | null): string | null {
  if (!pool) return null;
  if (pool.total_count < 2) {
    return pool.best_weekly_remaining_percent === null ? null : `주간 잔여 ${Math.round(pool.best_weekly_remaining_percent)}%`;
  }
  return `${pool.available_count}/${pool.total_count} 가용${pool.best_weekly_remaining_percent === null ? '' : ` (주간 최대 잔여 ${Math.round(pool.best_weekly_remaining_percent)}%)`}`;
}

export function poolAvailabilityLabel(pool: ClaudeAccountPool | null): string | null {
  if (!pool) return null;
  return `${pool.available_count}/${pool.total_count} 가용`;
}

function observedAtLabel(value: string | null): string {
  if (!value) return '';
  const observed = new Date(value);
  if (!Number.isFinite(observed.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfObserved = new Date(observed.getFullYear(), observed.getMonth(), observed.getDate());
  const dayDifference = Math.round((startOfToday.getTime() - startOfObserved.getTime()) / 86_400_000);
  if (dayDifference === 0) return `${localClock(value) ?? ''} 확인`;
  if (dayDifference === 1) return '어제 확인';
  return `${observed.getMonth() + 1}/${observed.getDate()} 확인`;
}

function loginErrorMessage(caught: unknown): string {
  let code: string | undefined;
  let status: number | undefined;
  if (caught instanceof ApiHttpError) {
    status = caught.status;
    try { code = (JSON.parse(caught.body) as { code?: string }).code; } catch { /* response text is not shown */ }
  } else if (caught && typeof caught === 'object') {
    const error = caught as { status?: number; body?: string };
    status = error.status;
    try { code = error.body ? (JSON.parse(error.body) as { code?: string }).code : undefined; } catch { /* response text is not shown */ }
  }
  if (code === 'account_exists') return '이미 등록된 계정입니다.';
  if (code === 'account_identity_mismatch') return '기존 계정과 인증 계정이 일치하지 않습니다.';
  if (code === 'invalid_code' || code === 'invalid_login_code' || code === 'code_expired') return '인증 코드가 만료되었거나 이미 사용되었습니다.';
  if (status === 409) return '이미 진행 중인 인증이 있습니다.';
  return '인증에 실패했습니다. 다시 시도해 주세요.';
}

function loginFlowError(flow: ClaudeAuthLoginFlow): string | null {
  if (flow.state !== 'failed') return null;
  return flow.error
    ? loginErrorMessage({ body: JSON.stringify(flow.error) })
    : '인증에 실패했습니다. 다시 시도해 주세요.';
}

function authStateLabel(account: ClaudeAccount): string | null {
  if (account.auth_state === 'needs_relogin') return '재로그인 필요';
  if (account.auth_state === 'logging_in') return '로그인 중';
  if (account.auth_state === 'idle') return '대기';
  return null;
}

function accountAvailable(account: ClaudeAccount): boolean {
  return account.enabled && account.auth_state === 'ok' && account.blocked?.scope !== 'all';
}

export const ClaudeAccountPoolSection = forwardRef<ClaudeAccountPoolSectionHandle, Props>(function ClaudeAccountPoolSection(
  props,
  ref,
) {
  const {
    initialList, showHeader = true, title = 'Claude 계정',
    onListChange, onLoginStartingChange, centralSettingsApi, onCentralChange,
  } = props;
  const api = props.api;
  const central = props.central === true;
  const centralApi: ClaudeCentralPoolApi | null = props.central === true ? props.api : null;
  const nodeApi: ClaudeAccountPoolApi = props.api;
  const nodeId = props.central === true ? '' : props.nodeId;
  const scopeKey = props.central === true ? 'central' : props.nodeId;
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const [accountList, setAccountList] = useState<ClaudeAccountList>(initialList);
  useEffect(() => { setAccountList(initialList); }, [initialList]);
  const accounts = accountList.accounts;
  const pool = accountList.pool;
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginFlow, setLoginFlow] = useState<ClaudeAuthLoginFlow | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginStarting, setLoginStarting] = useState(false);
  const [submittingCode, setSubmittingCode] = useState(false);
  const [cancellingLogin, setCancellingLogin] = useState(false);
  const [code, setCode] = useState('');
  const submitLock = useRef(false);
  const trackedLoginRef = useRef<TrackedLogin | null>(null);
  const currentLoginFlowRef = useRef<ClaudeAuthLoginFlow | null>(null);
  const closedLoginIdRef = useRef<string | null>(null);
  const currentScopeRef = useRef(scopeKey);
  const previousScopeRef = useRef(scopeKey);
  const mountedRef = useRef(false);
  const cancelRequestRef = useRef<{ scope: string; loginId: string } | null>(null);
  // 노드 목록에는 그 노드의 로컬 계정만 그린다. 중앙 계정은 중앙 풀에서만 다룬다.
  const ordered = useMemo(
    () => sortedAccounts(central ? accounts : accounts.filter(account => account.source !== 'central')),
    [accounts, central],
  );
  const prioritized = useMemo(() => ordered.filter(account => account.enabled), [ordered]);

  const updateLoginFlow = useCallback((flow: ClaudeAuthLoginFlow | null, ownerScope: string) => {
    if (flow && flow.login_id === closedLoginIdRef.current) return;
    currentLoginFlowRef.current = flow;
    trackedLoginRef.current = flow && !terminalStates.has(flow.state)
      ? { scope: ownerScope, loginId: flow.login_id, state: flow.state }
      : null;
    setLoginFlow(flow);
  }, []);

  const cancelTrackedLogin = useCallback((expectedScope?: string) => {
    const tracked = trackedLoginRef.current;
    if (!tracked || terminalStates.has(tracked.state)
      || (expectedScope !== undefined && tracked.scope !== expectedScope)) return;
    trackedLoginRef.current = null;
    closedLoginIdRef.current = tracked.loginId;
    if (centralApi) void centralApi.cancelCentralClaudeAuthLogin(tracked.loginId).catch(() => {});
    else void api.cancelClaudeAuthLogin(tracked.scope, tracked.loginId).catch(() => {});
  }, [api, centralApi]);

  function applyList(result: ClaudeAccountList) {
    setAccountList(result);
  }

  async function refreshAccounts() {
    try {
      const result = centralApi
        ? await centralApi.getCentralClaudeAuthAccounts()
        : await api.getClaudeAuthAccounts(nodeId);
      if (result.mode === 'pool') applyList(result);
    } catch { setNotice('계정 목록을 갱신하지 못했습니다.'); }
  }

  useLayoutEffect(() => {
    currentScopeRef.current = scopeKey;
  }, [scopeKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelTrackedLogin();
    };
  }, [cancelTrackedLogin]);

  useEffect(() => {
    const previousScope = previousScopeRef.current;
    if (previousScope === scopeKey) return;
    previousScopeRef.current = scopeKey;
    cancelTrackedLogin(previousScope);
    updateLoginFlow(null, previousScope);
    closedLoginIdRef.current = null;
    cancelRequestRef.current = null;
    submitLock.current = false;
    setCode('');
    setLoginError(null);
    setLoginStarting(false);
    setSubmittingCode(false);
    setCancellingLogin(false);
  }, [cancelTrackedLogin, scopeKey, updateLoginFlow]);

  useEffect(() => {
    const flow = loginFlow;
    if (!flow || terminalStates.has(flow.state)) return;
    const tracked = trackedLoginRef.current;
    if (!tracked || tracked.loginId !== flow.login_id || tracked.scope !== scopeKey) return;
    const flowScope = tracked.scope;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      let shouldContinue = true;
      try {
        const latest = centralApi
          ? await centralApi.getCentralClaudeAuthLogin(flow.login_id)
          : await api.getClaudeAuthLogin(flowScope, flow.login_id);
        if (!active || closedLoginIdRef.current === flow.login_id) return;
        updateLoginFlow(latest, flowScope);
        setLoginError(loginFlowError(latest));
        shouldContinue = !terminalStates.has(latest.state);
      } catch {
        if (active && closedLoginIdRef.current !== flow.login_id) setLoginError('인증 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
      }
      if (active && shouldContinue) timer = setTimeout(() => { void poll(); }, 1_000);
    };
    timer = setTimeout(() => { void poll(); }, 1_000);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [api, centralApi, loginFlow?.login_id, loginFlow?.state, scopeKey, updateLoginFlow]);

  useEffect(() => {
    if (loginFlow?.state === 'done') {
      updateLoginFlow(null, scopeKey);
      setCode('');
      setLoginError(null);
      setNotice('Claude 계정이 연결되었습니다.');
      void refreshAccounts();
      // 중앙에 계정이 늘면 이 노드가 받는 목록과 사용량도 달라진다.
      if (centralApi) onCentralChange?.();
    } else if (loginFlow?.state === 'cancelled') {
      updateLoginFlow(null, scopeKey);
      setCode('');
      setLoginError(null);
      setNotice('인증을 취소했습니다.');
    }
  }, [loginFlow?.state, scopeKey, updateLoginFlow]);

  async function patchAccount(account: ClaudeAccount, patch: { enabled?: boolean; priority?: number | null }) {
    if (busyAccountId) return;
    const previousList = accountList;
    setBusyAccountId(account.id);
    setNotice(null);
    if (patch.priority !== undefined) {
      setAccountList({
        ...previousList,
        accounts: previousList.accounts.map(item => item.id === account.id ? { ...item, priority: patch.priority! } : item),
      });
    } else if (patch.enabled !== undefined) {
      const beforeAvailable = accountAvailable(account);
      const after = { ...account, enabled: patch.enabled };
      const delta = Number(accountAvailable(after)) - Number(beforeAvailable);
      setAccountList({
        ...previousList,
        accounts: previousList.accounts.map(item => item.id === account.id ? after : item),
        pool: previousList.pool ? {
          ...previousList.pool,
          total_count: Math.max(0, previousList.pool.total_count + Number(patch.enabled) - Number(account.enabled)),
          available_count: Math.max(0, previousList.pool.available_count + delta),
        } : null,
      });
    }
    try {
      if (centralApi) {
        // 중앙은 priority null을 0으로 바꾸므로 null을 보내지 않는다.
        applyList(await centralApi.patchCentralClaudeAuthAccount(account.id, {
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(typeof patch.priority === 'number' ? { priority: patch.priority } : {}),
        }));
        onCentralChange?.();
      } else {
        applyList(await api.patchClaudeAuthAccount(nodeId, account.id, patch));
      }
    } catch {
      setAccountList(previousList);
      setNotice('계정 설정을 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally { setBusyAccountId(null); }
  }

  async function normalizePriorityOrder(account: ClaudeAccount, desiredOrder: readonly ClaudeAccount[]) {
    if (busyAccountId) return;
    const previousList = accountList;
    const normalized = desiredOrder.map((item, index) => ({ ...item, priority: index + 1 }));
    setBusyAccountId(account.id);
    setNotice(null);
    setAccountList({ ...previousList, accounts: normalized });
    try {
      let latest: ClaudeAccountList | null = null;
      for (const item of normalized) {
        if (item.priority === desiredOrder.find(entry => entry.id === item.id)?.priority) continue;
        latest = centralApi
          ? await centralApi.patchCentralClaudeAuthAccount(item.id, { priority: item.priority })
          : await api.patchClaudeAuthAccount(nodeId, item.id, { priority: item.priority });
      }
      if (latest) {
        applyList(latest);
        if (centralApi) onCentralChange?.();
      }
    } catch {
      let reconciled = false;
      try {
        const latest = centralApi
          ? await centralApi.getCentralClaudeAuthAccounts()
          : await api.getClaudeAuthAccounts(nodeId);
        if (latest.mode === 'pool') {
          applyList(latest);
          reconciled = true;
        }
      } catch { /* keep the last confirmed local list */ }
      if (!reconciled) {
        setAccountList(previousList);
      }
      setNotice('우선순위를 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally { setBusyAccountId(null); }
  }

  function movePriority(account: ClaudeAccount, index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    const target = prioritized[targetIndex];
    if (!target || busyAccountId) return;
    const desiredEnabled = [...prioritized];
    [desiredEnabled[index], desiredEnabled[targetIndex]] = [desiredEnabled[targetIndex], desiredEnabled[index]];
    let enabledIndex = 0;
    const desiredOrder = ordered.map(item => item.enabled ? desiredEnabled[enabledIndex++] : item);
    const priority = priorityBetween(desiredOrder, account.id);
    if (priority !== null) {
      void patchAccount(account, { priority });
      return;
    }
    void normalizePriorityOrder(account, desiredOrder);
  }

  async function deleteAccount(accountId: string) {
    setBusyAccountId(accountId);
    setNotice(null);
    try {
      if (centralApi) {
        // 중앙 삭제는 deferred 없이 곧바로 지워지므로 목록을 다시 읽어 화면을 맞춘다.
        await centralApi.deleteCentralClaudeAuthAccount(accountId);
        setConfirmingDelete(null);
        setNotice('Claude 계정을 삭제했습니다.');
        await refreshAccounts();
        onCentralChange?.();
      } else {
        const result = await api.deleteClaudeAuthAccount(nodeId, accountId);
        setAccountList(current => ({ ...current, accounts: result.accounts, pool: result.pool }));
        setConfirmingDelete(null);
        setNotice(result.deferred ? '현재 세션이 끝난 뒤 삭제합니다.' : 'Claude 계정을 삭제했습니다.');
        await refreshAccounts();
      }
    } catch { setNotice('Claude 계정을 삭제하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusyAccountId(null); }
  }

  async function startLogin(accountId?: string) {
    const requestedScope = scopeKey;
    setLoginStarting(true);
    setLoginError(null);
    setCode('');
    setNotice(null);
    try {
      const flow = centralApi
        ? await centralApi.startCentralClaudeAuthLogin(accountId)
        : await api.startClaudeAuthLogin(nodeId, accountId);
      if (!mountedRef.current || currentScopeRef.current !== requestedScope) {
        if (!terminalStates.has(flow.state)) {
          closedLoginIdRef.current = flow.login_id;
          if (centralApi) void centralApi.cancelCentralClaudeAuthLogin(flow.login_id).catch(() => {});
          else void api.cancelClaudeAuthLogin(requestedScope, flow.login_id).catch(() => {});
        }
        return;
      }
      closedLoginIdRef.current = null;
      updateLoginFlow(flow, requestedScope);
      setLoginError(loginFlowError(flow));
    }
    catch (caught) {
      if (mountedRef.current && currentScopeRef.current === requestedScope) setLoginError(loginErrorMessage(caught));
    }
    finally {
      if (mountedRef.current && currentScopeRef.current === requestedScope) setLoginStarting(false);
    }
  }

  async function openAuthPage() {
    if (!loginFlow?.auth_url) return;
    try { await WebBrowser.openBrowserAsync(loginFlow.auth_url); }
    catch { setLoginError('인증 페이지를 열지 못했습니다. 다시 시도해 주세요.'); }
  }

  async function submitCode() {
    const flow = loginFlow;
    const requestScope = scopeKey;
    const value = code.trim();
    if (!flow || !value || submitLock.current) return;
    submitLock.current = true;
    setSubmittingCode(true);
    setLoginError(null);
    try {
      const result = centralApi
        ? await centralApi.submitCentralClaudeAuthLoginCode(flow.login_id, value)
        : await api.submitClaudeAuthLoginCode(requestScope, flow.login_id, value);
      if (!mountedRef.current || currentScopeRef.current !== requestScope
        || closedLoginIdRef.current === flow.login_id) return;
      setCode('');
      updateLoginFlow(result, requestScope);
      setLoginError(loginFlowError(result));
    } catch (caught) {
      if (mountedRef.current && currentScopeRef.current === requestScope
        && closedLoginIdRef.current !== flow.login_id) {
        setCode('');
        setLoginError(loginErrorMessage(caught));
      }
    }
    finally {
      submitLock.current = false;
      if (mountedRef.current && currentScopeRef.current === requestScope) setSubmittingCode(false);
    }
  }

  async function cancelLogin() {
    const flow = loginFlow;
    const requestScope = scopeKey;
    if (!flow || cancellingLogin) return;
    const request = { scope: requestScope, loginId: flow.login_id };
    cancelRequestRef.current = request;
    setCancellingLogin(true);
    let result: ClaudeAuthLoginFlow | null = null;
    let requestFailed = false;
    try {
      result = centralApi
        ? await centralApi.cancelCentralClaudeAuthLogin(flow.login_id)
        : await api.cancelClaudeAuthLogin(requestScope, flow.login_id);
    }
    catch { requestFailed = true; }
    finally {
      const currentFlow = currentLoginFlowRef.current;
      const stillOwnsFlow = currentFlow?.login_id === flow.login_id;
      const currentFlowIsTerminal = terminalStates.has(currentFlow?.state ?? flow.state);
      if (mountedRef.current && currentScopeRef.current === requestScope && stillOwnsFlow) {
        if (requestFailed && !currentFlowIsTerminal) {
          setLoginError('인증을 취소하지 못했습니다. 다시 시도해 주세요.');
        } else {
          closedLoginIdRef.current = flow.login_id;
          trackedLoginRef.current = null;
          updateLoginFlow(null, requestScope);
          setCode('');
          setLoginError(null);
          if (result?.state === 'cancelled') setNotice('인증을 취소했습니다.');
          else if (result?.state === 'done') {
            setNotice('Claude 계정이 연결되었습니다.');
            void refreshAccounts();
          }
        }
      }
      if (cancelRequestRef.current === request) {
        cancelRequestRef.current = null;
        if (mountedRef.current) setCancellingLogin(false);
      }
    }
  }

  useImperativeHandle(ref, () => ({ startLogin: () => { void startLogin(); } }));
  useEffect(() => { onListChange?.(accountList); }, [accountList, onListChange]);
  useEffect(() => { onLoginStartingChange?.(loginStarting); }, [loginStarting, onLoginStartingChange]);

  const summary = poolSummaryLabel(pool);

  return <View testID="claude-account-pool-section" style={styles.section}>
    {showHeader ? <>
      <View style={styles.poolTopBar}>
        <View style={styles.poolTitleRow}>
          <Text style={styles.poolTitle}>{title}</Text>
          {summary ? <Text style={styles.metaText}>{summary}</Text> : null}
        </View>
        <GlassButton testID="claude-account-add" accessibilityLabel="Claude 계정 추가" onPress={() => void startLogin()} busy={loginStarting}>
          {loginStarting ? <ActivityIndicator size="small" color={t.colors.accent} /> : <>
            <Ionicons name="add" size={t.iconSize.compact} color={t.colors.accent} />
            <Text style={styles.accentButtonText}>계정 추가</Text>
          </>}
        </GlassButton>
      </View>
      <SettingsDivider />
    </> : null}
    <View style={styles.accountList}>
      {!central && centralSettingsApi
        ? <ClaudeCentralReceiveRow nodeId={nodeId} api={centralSettingsApi} onSaved={() => void refreshAccounts()} />
        : null}
      {ordered.map((account, index) => <React.Fragment key={account.id}>
        <AccountRow account={account} index={account.enabled ? prioritized.findIndex(item => item.id === account.id) : index} totalCount={prioritized.length}
          confirmingDelete={confirmingDelete === account.id} busy={busyAccountId !== null} central={central}
          onToggle={() => void patchAccount(account, { enabled: !account.enabled })}
          onMoveUp={() => movePriority(account, prioritized.findIndex(item => item.id === account.id), -1)}
          onMoveDown={() => movePriority(account, prioritized.findIndex(item => item.id === account.id), 1)}
          onRelogin={() => void startLogin(account.id)} onAskDelete={() => setConfirmingDelete(account.id)}
          onCancelDelete={() => setConfirmingDelete(null)} onConfirmDelete={() => void deleteAccount(account.id)} />
        {index < ordered.length - 1 ? <SettingsDivider /> : null}
      </React.Fragment>)}
      {loginFlow ? <>
        <SettingsDivider />
        <View style={styles.loginPanel}>
          <ClaudeAccountLoginFlowPanel flow={loginFlow} code={code} error={loginError}
            starting={loginStarting} submitting={submittingCode} cancelling={cancellingLogin}
            existingAccountCount={ordered.length}
            accountEmail={ordered.find(account => account.id === loginFlow.account_id)?.email ?? null}
            onOpenAuth={() => void openAuthPage()} onCodeChange={setCode}
            onSubmit={() => void submitCode()} onCancel={() => void cancelLogin()}
            onRestart={() => void startLogin(loginFlow.account_id ?? undefined)} />
        </View>
      </> : null}
      {!loginFlow && loginError ? <Text accessibilityRole="alert" style={styles.errorText}>{loginError}</Text> : null}
      {notice ? <Text accessibilityRole="text" style={styles.noticeText}>{notice}</Text> : null}
    </View>
  </View>;
});

function AccountRow({
  account, index, totalCount, confirmingDelete, busy, central, onToggle, onMoveUp, onMoveDown,
  onRelogin, onAskDelete, onCancelDelete, onConfirmDelete,
}: {
  account: ClaudeAccount;
  index: number;
  totalCount: number;
  confirmingDelete: boolean;
  busy: boolean;
  central: boolean;
  onToggle(): void;
  onMoveUp(): void;
  onMoveDown(): void;
  onRelogin(): void;
  onAskDelete(): void;
  onCancelDelete(): void;
  onConfirmDelete(): void;
}) {
  const t = useTokens();
  const compact = useDeviceType() === 'phone';
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const statusLabel = authStateLabel(account);
  const quotaCells: (QuotaGridCell | null)[] = [
    account.usage.five_hour ? { label: '5시간', usedPercent: account.usage.five_hour.used_percent, resetAt: account.usage.five_hour.resets_at, short: true, kind: 'short', sevenDay: false } : null,
    account.usage.seven_day ? { label: '7일', usedPercent: account.usage.seven_day.used_percent, resetAt: account.usage.seven_day.resets_at, short: false, kind: 'weekly', sevenDay: true } : null,
    account.usage.fable_weekly ? { label: 'Fable', usedPercent: account.usage.fable_weekly.used_percent, resetAt: account.usage.fable_weekly.resets_at, short: false, kind: 'fable', sevenDay: true } : null,
  ];
  const dotColor = !account.enabled ? t.colors.textMuted
    : account.auth_state === 'needs_relogin' ? t.colors.error
      : account.blocked ? t.colors.warning
        : account.auth_state === 'idle' ? t.colors.textMuted : t.colors.success;

  return <View testID={`claude-account-row-${account.id}`} style={[styles.accountBlock, !account.enabled && styles.disabledAccount]}>
    <View style={compact ? styles.accountHeaderCompactRow : styles.accountHeaderRow}>
      <View style={[styles.accountIdentity, compact && styles.accountIdentityCompact]}>
        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
        <Text numberOfLines={1} style={styles.accountEmail}>{account.email}</Text>
        {account.plan ? <Text numberOfLines={1} style={styles.planBadge}>{account.plan}</Text> : null}
        {totalCount > 1 && account.enabled ? <Text numberOfLines={1} style={styles.rankBadge}>{index + 1}순위</Text> : null}
        {account.active_sessions > 0 ? <Text numberOfLines={1} style={styles.sessionText}>세션 {account.active_sessions}</Text> : null}
        {account.blocked ? <Text numberOfLines={1} style={styles.blockedBadge}>{account.blocked.scope === 'fable' ? `Fable ${localClock(account.blocked.until) ?? ''} 해제` : `${localClock(account.blocked.until) ?? ''} 해제`}</Text> : null}
        {statusLabel ? <Text numberOfLines={1} style={[styles.statusBadge, account.auth_state === 'needs_relogin' && styles.dangerBadge]}>{statusLabel}</Text> : null}
      </View>
      <View style={[styles.controls, compact && styles.compactControls]}>
        <Switch testID={`claude-account-toggle-${account.id}`} accessibilityLabel={`${account.email} 사용`}
          value={account.enabled} onValueChange={onToggle} disabled={busy}
          trackColor={{ false: t.colors.border, true: t.colors.accent }} />
        {totalCount > 1 && account.enabled ? <>
          <GlassButton testID={`claude-priority-up-${account.id}`} iconOnly size="compact" borderRadius={t.foundation.radius.capsule} disabled={index === 0} busy={busy}
            accessibilityLabel="우선순위 올리기" onPress={onMoveUp}>
            <Ionicons name="arrow-up" size={t.iconSize.compact} color={t.colors.textSecondary} />
          </GlassButton>
          <GlassButton testID={`claude-priority-down-${account.id}`} iconOnly size="compact" borderRadius={t.foundation.radius.capsule} disabled={index === totalCount - 1} busy={busy}
            accessibilityLabel="우선순위 내리기" onPress={onMoveDown}>
            <Ionicons name="arrow-down" size={t.iconSize.compact} color={t.colors.textSecondary} />
          </GlassButton>
        </> : null}
        <GlassButton testID={`claude-account-relogin-${account.id}`} iconOnly size="compact" borderRadius={t.foundation.radius.capsule} busy={busy}
          accessibilityLabel="재로그인" onPress={onRelogin}>
          <Ionicons name="refresh" size={t.iconSize.compact} color={t.colors.textSecondary} />
        </GlassButton>
        <GlassButton testID={`claude-account-delete-${account.id}`} iconOnly size="compact" borderRadius={t.foundation.radius.capsule} busy={busy}
          accessibilityLabel="계정 삭제" onPress={onAskDelete}>
          <Ionicons name="trash-outline" size={t.iconSize.compact} color={t.colors.textSecondary} />
        </GlassButton>
      </View>
    </View>
    {quotaCells.some(Boolean) ? <ProviderQuotaGrid prefix={`claude-quota-${account.id}`} cells={quotaCells} /> : <View style={styles.idleRow}>
      <Text style={styles.metaText}>{account.auth_state === 'needs_relogin' ? '인증 만료로 사용량 조회 중단' : '미측정 (실제 호출 시 갱신)'}</Text>
      <Text style={styles.metaText}>{observedAtLabel(account.observed_at)}</Text>
    </View>}
    {confirmingDelete ? <DeleteConfirmation accountId={account.id} central={central} busy={busy} onCancel={onCancelDelete} onConfirm={onConfirmDelete} /> : null}
  </View>;
}

function DeleteConfirmation({ accountId, central, busy, onCancel, onConfirm }: { accountId: string; central: boolean; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  return <View testID={`claude-account-delete-confirmation-${accountId}`} style={styles.confirmRow}>
    <Text style={styles.confirmPrompt}>{central ? '이 계정을 중앙 풀에서 삭제할까요?' : '이 계정을 노드에서 삭제할까요?'}</Text>
    <View style={styles.confirmActions}>
      <GlassButton testID="claude-account-delete-cancel" accessibilityLabel="삭제 취소" onPress={onCancel} busy={busy} style={styles.confirmButton}>
        <Text style={styles.secondaryButtonText}>취소</Text>
      </GlassButton>
      <GlassButton testID={`claude-account-delete-confirm-${accountId}`} accessibilityLabel="계정 삭제 확인" onPress={onConfirm} busy={busy} style={styles.confirmButton} contentStyle={styles.destructiveConfirm}>
        {busy ? <ActivityIndicator size="small" color={t.colors.errorText} /> : <Text style={styles.destructiveButtonText}>삭제</Text>}
      </GlassButton>
    </View>
  </View>;
}
