/**
 * NodeProvidersPanel — 노드를 펼쳤을 때 나오는 공급자 중립 사용량 패널.
 *
 * 모든 공급자는 같은 모양의 행 하나씩이고, 세 칸 게이지의 열 뜻은
 * packages/soul-ui 의 providerQuotaSlots 가 정한다. 화면은 창 문자열을 다시 해석하지 않는다.
 */

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, DashboardIconCap, providerQuotaSlots } from "@seosoyoung/soul-ui";
import { RotateCcw, Trash2 } from "lucide-react";
import type {
  ProviderQuotaSlots,
  UsageSummaryNode,
  UsageSummaryProvider,
} from "@seosoyoung/soul-ui";
import { getClaudeAccounts } from "../lib/claude-auth-api";
import { useClaudeAuthFlow } from "../hooks/useClaudeAuthFlow";
import { ClaudePoolRow } from "./claude-accounts/ClaudePoolRow";
import { ProviderQuotaGrid, ProviderQuotaSkeleton } from "./claude-accounts/ProviderQuotaGrid";
import "./claude-accounts/claude-account-pool.css";

type Props = {
  nodeId: string;
  request: typeof fetch;
  node: UsageSummaryNode | null;
  loading: boolean;
};

type ProviderRowSpec = {
  id: "opencode_go" | "codex" | "antigravity";
  label: string;
};

const PROVIDER_ROWS: readonly ProviderRowSpec[] = [
  { id: "opencode_go", label: "OpenCode Go" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
];

function hasAnySlot(slots: ProviderQuotaSlots): boolean {
  return slots.some((slot) => slot !== null);
}

function ProviderRow({ spec, provider }: { spec: ProviderRowSpec; provider: UsageSummaryProvider }) {
  const slots = providerQuotaSlots(provider);
  const dotColor = provider.status === "error"
    ? "var(--color-red-400)"
    : provider.status === "not_configured"
      ? "var(--v3-text-tertiary)"
      : "var(--color-emerald-400)";

  return <div className="c724-account-row" data-provider-id={spec.id} data-state={provider.status}>
    <div className="c724-account-top">
      <div className="c724-account-identity">
        <span className="c724-status-dot" style={{ backgroundColor: dotColor }} />
        <span className="c724-account-email">{spec.label}</span>
      </div>
      {provider.status === "not_configured" ? <span className="c724-meta-inline">미설정</span> : null}
      {provider.status === "error" ? <span className="c724-badge c724-badge-danger">조회 오류</span> : null}
    </div>
    {provider.status === "auto" && hasAnySlot(slots)
      ? <ProviderQuotaGrid slots={slots} label={`${spec.label} 사용량`} />
      : null}
  </div>;
}

type AccountProfile = {
  email: string;
  display_name: string;
  has_claude_max: boolean;
};

function LegacyClaudeRow({ nodeId, request, slots, loading }: {
  nodeId: string;
  request: typeof fetch;
  slots: ProviderQuotaSlots;
  loading: boolean;
}) {
  const basePath = `/api/nodes/${nodeId}/claude-auth`;
  const [profile, setProfile] = useState<AccountProfile | null>(null);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await request(`${basePath}/profile`);
      if (res.ok) {
        const data = await res.json();
        setProfile(data.account ?? null);
      }
    } catch {
      // 프로필 조회 실패는 인증 상태 표시에 영향을 주지 않는다.
    }
  }, [basePath, request]);

  const flow = useClaudeAuthFlow<unknown>({
    request,
    basePath,
    statusPath: "/status",
    onTokenDeleted: () => setProfile(null),
    // 재로그인으로 다른 계정이 되면 이전 프로필이 남지 않도록 다시 읽는다.
    onAuthenticated: () => { void fetchProfile(); },
  });

  const authenticated = flow.tokenStatus?.has_token === true;

  useEffect(() => {
    if (authenticated && profile === null) void fetchProfile();
  }, [authenticated, fetchProfile, profile]);

  const dotColor = authenticated ? "var(--color-emerald-400)" : "var(--v3-text-tertiary)";

  return <div className="c724-account-row" data-provider-id="claude" data-testid="legacy-claude-row">
    <div className="c724-account-top">
      <div className="c724-account-identity">
        <span className="c724-status-dot" style={{ backgroundColor: dotColor }} />
        <span className="c724-account-email">Claude</span>
        {profile ? <span className="c724-meta-inline" title={profile.email}>{profile.email}</span> : null}
        {profile?.has_claude_max ? <span className="c724-badge c724-badge-neutral">Max</span> : null}
        {flow.tokenStatus && !authenticated ? <span className="c724-badge c724-badge-neutral">미인증</span> : null}
      </div>
      <div className="c724-account-actions">
        {authenticated ? <>
          <DashboardIconCap size="small" label="재로그인" onClick={flow.handleLogin}>
            <RotateCcw className="size-4" aria-hidden="true" />
          </DashboardIconCap>
          <DashboardIconCap size="small" label="토큰 삭제" onClick={() => void flow.handleDeleteToken()}>
            <Trash2 className="size-4" aria-hidden="true" />
          </DashboardIconCap>
        </> : <Button size="sm" disabled={flow.loadingStatus} onClick={flow.handleLogin}>
          {flow.loadingStatus ? "확인 중" : "로그인"}
        </Button>}
      </div>
    </div>

    {flow.showCodeInput ? <div className="c724-auth-code-group">
      {flow.authUrl ? <a
        href={flow.authUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="c724-login-open-link inline-flex items-center gap-1 text-xs text-primary underline"
      >
        Anthropic 인증 페이지 열기 →
      </a> : null}
      <div className="c724-auth-hint">Anthropic 페이지에 표시된 코드를 붙여넣으세요.</div>
      <textarea
        className="w-full text-xs font-mono p-1.5 border border-border rounded resize-none bg-background"
        rows={2}
        aria-label="Claude 인증 코드"
        placeholder="YSrAXqZq...#7RVDts..."
        value={flow.codeValue}
        onChange={(event) => flow.setCodeValue(event.target.value)}
      />
      <div className="c724-confirm-actions">
        <Button size="sm" onClick={flow.handleSubmitCode} disabled={flow.submitting}>
          {flow.submitting ? "..." : "확인"}
        </Button>
        <Button size="sm" variant="outline" onClick={flow.handleCancelCode}>취소</Button>
      </div>
    </div> : null}

    {flow.error ? <p className="c724-pool-error" role="alert">{flow.error}</p> : null}

    {loading ? <ProviderQuotaSkeleton /> : hasAnySlot(slots)
      ? <ProviderQuotaGrid slots={slots} label="Claude 사용량" />
      : null}
  </div>;
}

function PendingClaudeRow() {
  return <div className="c724-account-row" data-provider-id="claude" data-state="pending">
    <div className="c724-account-top">
      <div className="c724-account-identity">
        <span className="c724-status-dot" style={{ backgroundColor: "var(--v3-text-tertiary)" }} />
        <span className="c724-account-email">Claude</span>
      </div>
    </div>
    <ProviderQuotaSkeleton />
  </div>;
}

export function NodeProvidersPanel({ nodeId, request, node, loading }: Props) {
  const accounts = useQuery({
    queryKey: ["claude-auth-accounts", nodeId],
    queryFn: () => getClaudeAccounts(request, nodeId),
    retry: false,
    staleTime: Infinity,
  });
  const list = accounts.data ?? null;
  const claudeSlots = providerQuotaSlots(node?.providers.claude ?? null);

  // 풀 API 가 없는 서버에서는 조회가 실패한다. 그때 스켈레톤에 갇히지 않고
  // 레거시 인증 행으로 내려가 로그인과 토큰 삭제를 계속 쓸 수 있게 한다.
  // 배경 재조회가 실패해도 React Query 는 마지막 성공 데이터를 유지하므로,
  // 한 번 풀로 읽힌 노드는 풀 행에 그대로 머문다.
  return <div className="c724-account-list" data-testid="node-providers-panel">
    {accounts.isPending
      ? <PendingClaudeRow />
      : list && list.mode === "pool"
        ? <ClaudePoolRow
          nodeId={nodeId}
          request={request}
          initialList={list}
          slots={claudeSlots}
          loading={loading}
        />
        : <LegacyClaudeRow nodeId={nodeId} request={request} slots={claudeSlots} loading={loading} />}
    {PROVIDER_ROWS.map((spec) => {
      const provider = node?.providers[spec.id] ?? null;
      return provider === null ? null : <ProviderRow key={spec.id} spec={spec} provider={provider} />;
    })}
  </div>;
}
