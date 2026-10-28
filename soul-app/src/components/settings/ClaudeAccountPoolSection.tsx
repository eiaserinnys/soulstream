import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  ClaudeAuthLoginFlow,
} from '../../../../packages/soul-ui/src/lib/usage-summary';
import type { ApiClient } from '../../api/client';
import { ApiHttpError } from '../../api/clientCore';
import { useDeviceType, useTokens } from '../../theme';
import { makeClaudePoolStyles } from './claudeAccountPoolStyles';
import { ClaudeAccountLoginFlowPanel } from './ClaudeAccountLoginFlowPanel';
import { GlassButton } from '../GlassSurface';
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

type Props = {
  nodeId: string;
  initialList: ClaudeAccountList;
  api: ClaudeAccountPoolApi;
};

const terminalStates = new Set(['done', 'failed', 'cancelled']);

type TrackedLogin = { nodeId: string; loginId: string; state: ClaudeAuthLoginFlow['state'] };

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

function resetLabel(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][date.getDay()];
  return `${weekday} ${localClock(value)}`;
}

function quotaResetLabel(value: ClaudeAccount['usage']['five_hour'], short: boolean): string {
  if (!value) return '—';
  if (short && value.used_percent >= 100) return `${localClock(value.resets_at) ?? '—'} 해제`;
  const date = new Date(value.resets_at ?? '');
  if (!Number.isFinite(date.getTime())) return '—';
  if (!short) return resetLabel(value.resets_at);
  const minutes = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}분 후`;
  return `${Math.ceil(minutes / 60)}시간 후`;
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

export function ClaudeAccountPoolSection({ nodeId, initialList, api }: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  const [accountList, setAccountList] = useState<ClaudeAccountList>(initialList);
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
  const currentNodeIdRef = useRef(nodeId);
  const previousNodeIdRef = useRef(nodeId);
  const mountedRef = useRef(false);
  const cancelRequestRef = useRef<{ nodeId: string; loginId: string } | null>(null);
  const ordered = useMemo(() => sortedAccounts(accounts), [accounts]);
  const prioritized = useMemo(() => ordered.filter(account => account.enabled), [ordered]);

  const updateLoginFlow = useCallback((flow: ClaudeAuthLoginFlow | null, ownerNodeId: string) => {
    if (flow && flow.login_id === closedLoginIdRef.current) return;
    currentLoginFlowRef.current = flow;
    trackedLoginRef.current = flow && !terminalStates.has(flow.state)
      ? { nodeId: ownerNodeId, loginId: flow.login_id, state: flow.state }
      : null;
    setLoginFlow(flow);
  }, []);

  const cancelTrackedLogin = useCallback((expectedNodeId?: string) => {
    const tracked = trackedLoginRef.current;
    if (!tracked || terminalStates.has(tracked.state)
      || (expectedNodeId !== undefined && tracked.nodeId !== expectedNodeId)) return;
    trackedLoginRef.current = null;
    closedLoginIdRef.current = tracked.loginId;
    void api.cancelClaudeAuthLogin(tracked.nodeId, tracked.loginId).catch(() => {});
  }, [api]);

  function applyList(result: ClaudeAccountList) {
    setAccountList(result);
  }

  async function refreshAccounts() {
    try {
      const result = await api.getClaudeAuthAccounts(nodeId);
      if (result.mode === 'pool') applyList(result);
    } catch { setNotice('계정 목록을 갱신하지 못했습니다.'); }
  }

  useLayoutEffect(() => {
    currentNodeIdRef.current = nodeId;
  }, [nodeId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelTrackedLogin();
    };
  }, [cancelTrackedLogin]);

  useEffect(() => {
    const previousNodeId = previousNodeIdRef.current;
    if (previousNodeId === nodeId) return;
    previousNodeIdRef.current = nodeId;
    cancelTrackedLogin(previousNodeId);
    updateLoginFlow(null, previousNodeId);
    closedLoginIdRef.current = null;
    cancelRequestRef.current = null;
    submitLock.current = false;
    setCode('');
    setLoginError(null);
    setLoginStarting(false);
    setSubmittingCode(false);
    setCancellingLogin(false);
  }, [cancelTrackedLogin, nodeId, updateLoginFlow]);

  useEffect(() => {
    const flow = loginFlow;
    if (!flow || terminalStates.has(flow.state)) return;
    const tracked = trackedLoginRef.current;
    if (!tracked || tracked.loginId !== flow.login_id || tracked.nodeId !== nodeId) return;
    const flowNodeId = tracked.nodeId;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      let shouldContinue = true;
      try {
        const latest = await api.getClaudeAuthLogin(flowNodeId, flow.login_id);
        if (!active || closedLoginIdRef.current === flow.login_id) return;
        updateLoginFlow(latest, flowNodeId);
        setLoginError(loginFlowError(latest));
        shouldContinue = !terminalStates.has(latest.state);
      } catch {
        if (active && closedLoginIdRef.current !== flow.login_id) setLoginError('인증 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
      }
      if (active && shouldContinue) timer = setTimeout(() => { void poll(); }, 1_000);
    };
    timer = setTimeout(() => { void poll(); }, 1_000);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [api, loginFlow?.login_id, loginFlow?.state, nodeId, updateLoginFlow]);

  useEffect(() => {
    if (loginFlow?.state === 'done') {
      updateLoginFlow(null, nodeId);
      setCode('');
      setLoginError(null);
      setNotice('Claude 계정이 연결되었습니다.');
      void refreshAccounts();
    } else if (loginFlow?.state === 'cancelled') {
      updateLoginFlow(null, nodeId);
      setCode('');
      setLoginError(null);
      setNotice('인증을 취소했습니다.');
    }
  }, [loginFlow?.state, nodeId, updateLoginFlow]);

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
      applyList(await api.patchClaudeAuthAccount(nodeId, account.id, patch));
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
        latest = await api.patchClaudeAuthAccount(nodeId, item.id, { priority: item.priority });
      }
      if (latest) applyList(latest);
    } catch {
      let reconciled = false;
      try {
        const latest = await api.getClaudeAuthAccounts(nodeId);
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
      const result = await api.deleteClaudeAuthAccount(nodeId, accountId);
      setAccountList(current => ({ ...current, accounts: result.accounts, pool: result.pool }));
      setConfirmingDelete(null);
      setNotice(result.deferred ? '현재 세션이 끝난 뒤 삭제합니다.' : 'Claude 계정을 삭제했습니다.');
      await refreshAccounts();
    } catch { setNotice('Claude 계정을 삭제하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusyAccountId(null); }
  }

  async function startLogin(accountId?: string) {
    const requestedNodeId = nodeId;
    setLoginStarting(true);
    setLoginError(null);
    setCode('');
    setNotice(null);
    try {
      const flow = await api.startClaudeAuthLogin(requestedNodeId, accountId);
      if (!mountedRef.current || currentNodeIdRef.current !== requestedNodeId) {
        if (!terminalStates.has(flow.state)) {
          closedLoginIdRef.current = flow.login_id;
          void api.cancelClaudeAuthLogin(requestedNodeId, flow.login_id).catch(() => {});
        }
        return;
      }
      closedLoginIdRef.current = null;
      updateLoginFlow(flow, requestedNodeId);
      setLoginError(loginFlowError(flow));
    }
    catch (caught) {
      if (mountedRef.current && currentNodeIdRef.current === requestedNodeId) setLoginError(loginErrorMessage(caught));
    }
    finally {
      if (mountedRef.current && currentNodeIdRef.current === requestedNodeId) setLoginStarting(false);
    }
  }

  async function openAuthPage() {
    if (!loginFlow?.auth_url) return;
    try { await WebBrowser.openBrowserAsync(loginFlow.auth_url); }
    catch { setLoginError('인증 페이지를 열지 못했습니다. 다시 시도해 주세요.'); }
  }

  async function submitCode() {
    const flow = loginFlow;
    const requestNodeId = nodeId;
    const value = code.trim();
    if (!flow || !value || submitLock.current) return;
    submitLock.current = true;
    setSubmittingCode(true);
    setLoginError(null);
    try {
      const result = await api.submitClaudeAuthLoginCode(requestNodeId, flow.login_id, value);
      if (!mountedRef.current || currentNodeIdRef.current !== requestNodeId
        || closedLoginIdRef.current === flow.login_id) return;
      setCode('');
      updateLoginFlow(result, requestNodeId);
      setLoginError(loginFlowError(result));
    } catch (caught) {
      if (mountedRef.current && currentNodeIdRef.current === requestNodeId
        && closedLoginIdRef.current !== flow.login_id) {
        setCode('');
        setLoginError(loginErrorMessage(caught));
      }
    }
    finally {
      submitLock.current = false;
      if (mountedRef.current && currentNodeIdRef.current === requestNodeId) setSubmittingCode(false);
    }
  }

  async function cancelLogin() {
    const flow = loginFlow;
    const requestNodeId = nodeId;
    if (!flow || cancellingLogin) return;
    const request = { nodeId: requestNodeId, loginId: flow.login_id };
    cancelRequestRef.current = request;
    setCancellingLogin(true);
    let result: ClaudeAuthLoginFlow | null = null;
    let requestFailed = false;
    try {
      result = await api.cancelClaudeAuthLogin(requestNodeId, flow.login_id);
    }
    catch { requestFailed = true; }
    finally {
      const currentFlow = currentLoginFlowRef.current;
      const stillOwnsFlow = currentFlow?.login_id === flow.login_id;
      const currentFlowIsTerminal = terminalStates.has(currentFlow?.state ?? flow.state);
      if (mountedRef.current && currentNodeIdRef.current === requestNodeId && stillOwnsFlow) {
        if (requestFailed && !currentFlowIsTerminal) {
          setLoginError('인증을 취소하지 못했습니다. 다시 시도해 주세요.');
        } else {
          closedLoginIdRef.current = flow.login_id;
          trackedLoginRef.current = null;
          updateLoginFlow(null, requestNodeId);
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

  const summary = pool
    ? pool.total_count >= 2
      ? `${pool.available_count}/${pool.total_count} 가용${pool.best_weekly_remaining_percent === null ? '' : ` (주간 최대 잔여 ${Math.round(pool.best_weekly_remaining_percent)}%)`}`
      : pool.best_weekly_remaining_percent === null ? null : `주간 잔여 ${Math.round(pool.best_weekly_remaining_percent)}%`
    : null;

  return <View testID="claude-account-pool-section" style={styles.section}>
    <View style={styles.poolTopBar}>
      <View style={styles.poolTitleRow}>
        <Text style={styles.poolTitle}>Claude 계정</Text>
        {summary ? <Text style={styles.metaText}>{summary}</Text> : null}
      </View>
      <GlassButton testID="claude-account-add" accessibilityLabel="Claude 계정 추가" onPress={() => void startLogin()} disabled={loginStarting}>
        {loginStarting ? <ActivityIndicator size="small" color={t.colors.accent} /> : <>
          <Ionicons name="add" size={t.iconSize.compact} color={t.colors.accent} />
          <Text style={styles.accentButtonText}>계정 추가</Text>
        </>}
      </GlassButton>
    </View>
    <SettingsDivider />
    <View style={styles.accountList}>
      {ordered.map((account, index) => <React.Fragment key={account.id}>
        <AccountRow account={account} index={account.enabled ? prioritized.findIndex(item => item.id === account.id) : index} totalCount={prioritized.length}
          confirmingDelete={confirmingDelete === account.id} busy={busyAccountId !== null}
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
            existingAccountCount={accounts.length}
            accountEmail={accounts.find(account => account.id === loginFlow.account_id)?.email ?? null}
            onOpenAuth={() => void openAuthPage()} onCodeChange={setCode}
            onSubmit={() => void submitCode()} onCancel={() => void cancelLogin()}
            onRestart={() => void startLogin(loginFlow.account_id ?? undefined)} />
        </View>
      </> : null}
      {!loginFlow && loginError ? <Text accessibilityRole="alert" style={styles.errorText}>{loginError}</Text> : null}
      {notice ? <Text accessibilityRole="text" style={styles.noticeText}>{notice}</Text> : null}
    </View>
  </View>;
}

function AccountRow({
  account, index, totalCount, confirmingDelete, busy, onToggle, onMoveUp, onMoveDown,
  onRelogin, onAskDelete, onCancelDelete, onConfirmDelete,
}: {
  account: ClaudeAccount;
  index: number;
  totalCount: number;
  confirmingDelete: boolean;
  busy: boolean;
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
  const quotas = [
    { label: '5시간', value: account.usage.five_hour, short: true },
    { label: '7일', value: account.usage.seven_day, short: false },
    { label: 'Fable', value: account.usage.fable_weekly, short: false },
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
          <GlassButton testID={`claude-priority-up-${account.id}`} iconOnly size="compact" borderRadius={t.foundation.radius.round} disabled={index === 0 || busy}
            accessibilityLabel="우선순위 올리기" onPress={onMoveUp}>
            <Ionicons name="arrow-up" size={t.iconSize.compact} color={t.colors.textSecondary} />
          </GlassButton>
          <GlassButton testID={`claude-priority-down-${account.id}`} iconOnly size="compact" borderRadius={t.foundation.radius.round} disabled={index === totalCount - 1 || busy}
            accessibilityLabel="우선순위 내리기" onPress={onMoveDown}>
            <Ionicons name="arrow-down" size={t.iconSize.compact} color={t.colors.textSecondary} />
          </GlassButton>
        </> : null}
        <GlassButton testID={`claude-account-relogin-${account.id}`} iconOnly size="compact" borderRadius={t.foundation.radius.round} disabled={busy}
          accessibilityLabel="재로그인" onPress={onRelogin}>
          <Ionicons name="refresh" size={t.iconSize.compact} color={t.colors.textSecondary} />
        </GlassButton>
        <GlassButton testID={`claude-account-delete-${account.id}`} iconOnly size="compact" borderRadius={t.foundation.radius.round} disabled={busy}
          accessibilityLabel="계정 삭제" onPress={onAskDelete}>
          <Ionicons name="trash-outline" size={t.iconSize.compact} color={t.colors.textSecondary} />
        </GlassButton>
      </View>
    </View>
    {quotas.some(quota => quota.value) ? <View style={styles.quotaGrid}>
      {quotas.map(quota => <QuotaGauge key={quota.label} label={quota.label} value={quota.value} short={quota.short} compact={compact} />)}
    </View> : <View style={styles.idleRow}>
      <Text style={styles.metaText}>{account.auth_state === 'needs_relogin' ? '인증 만료로 사용량 조회 중단' : '미측정 (실제 호출 시 갱신)'}</Text>
      <Text style={styles.metaText}>{observedAtLabel(account.observed_at)}</Text>
    </View>}
    {confirmingDelete ? <DeleteConfirmation accountId={account.id} busy={busy} onCancel={onCancelDelete} onConfirm={onConfirmDelete} /> : null}
  </View>;
}

function QuotaGauge({ label, value, short, compact }: { label: string; value: ClaudeAccount['usage']['five_hour']; short: boolean; compact: boolean }) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  if (!value) return <View style={styles.quotaColumn} accessibilityElementsHidden />;
  const used = Math.max(0, Math.min(100, value.used_percent));
  const color = used >= 95 ? t.colors.error : used >= 80 ? t.colors.warning : t.colors.accent;
  return <View testID={`claude-quota-${label}`} style={styles.quotaColumn}>
    <View style={compact ? styles.quotaCompactLabelRow : styles.quotaLabelRow}>
      <Text numberOfLines={1} style={styles.quotaName}>{label}</Text>
      {compact ? <Text style={styles.quotaPercent}>{Math.round(value.used_percent)}%</Text> : <View style={styles.quotaValueGroup}>
        <Text style={styles.quotaPercent}>{Math.round(value.used_percent)}%</Text>
        <Text numberOfLines={1} style={styles.quotaReset}>{quotaResetLabel(value, short)}</Text>
      </View>}
    </View>
    {compact ? <Text numberOfLines={1} style={styles.quotaReset}>{quotaResetLabel(value, short)}</Text> : null}
    <View style={styles.quotaTrack}>
      <View style={[styles.quotaFill, { width: `${used}%`, backgroundColor: color }]} />
    </View>
  </View>;
}

function DeleteConfirmation({ accountId, busy, onCancel, onConfirm }: { accountId: string; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const t = useTokens();
  const styles = useMemo(() => makeClaudePoolStyles(t), [t]);
  return <View testID={`claude-account-delete-confirmation-${accountId}`} style={styles.confirmRow}>
    <Text style={styles.confirmPrompt}>이 계정을 노드에서 삭제할까요?</Text>
    <View style={styles.confirmActions}>
      <GlassButton testID="claude-account-delete-cancel" accessibilityLabel="삭제 취소" onPress={onCancel} disabled={busy} style={styles.confirmButton}>
        <Text style={styles.secondaryButtonText}>취소</Text>
      </GlassButton>
      <GlassButton testID={`claude-account-delete-confirm-${accountId}`} accessibilityLabel="계정 삭제 확인" onPress={onConfirm} disabled={busy} style={styles.confirmButton} contentStyle={styles.destructiveConfirm}>
        {busy ? <ActivityIndicator size="small" color={t.colors.errorText} /> : <Text style={styles.destructiveButtonText}>삭제</Text>}
      </GlassButton>
    </View>
  </View>;
}
