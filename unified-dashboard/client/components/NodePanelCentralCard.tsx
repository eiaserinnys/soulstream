import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@seosoyoung/soul-ui";
import type { ClaudeAccountList } from "../../../packages/wire-schema/generated/typescript/index";
import {
  CENTRAL_CLAUDE_TARGET,
  getClaudeAccounts,
  requestErrorMessage,
} from "../lib/claude-auth-api";
import { ClaudePoolRow } from "./claude-accounts/ClaudePoolRow";
import { PendingClaudeRow } from "./NodeProvidersPanel";
import { NodeCardBody, NodeCardFrame, NodeCardHeader } from "./NodePanelFrame";

export const CENTRAL_ACCOUNTS_QUERY_KEY = ["claude-auth-accounts", { scope: "central" }] as const;

/**
 * 노드 탭 맨 위의 「중앙 풀」 카드.
 *
 * 머리에는 제목만 두고, 펼치면 중앙 대상의 ClaudePoolRow가 노드 카드 안의 클로드 줄과
 * 같은 모양으로 나온다. 중앙 계정을 바꾸면 그 줄이 같은 키로 목록을 갱신한다.
 */
export function NodePanelCentralCard({ request }: { request: typeof fetch }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const list = useQuery({
    queryKey: CENTRAL_ACCOUNTS_QUERY_KEY,
    queryFn: () => getClaudeAccounts(request, CENTRAL_CLAUDE_TARGET),
    enabled: expanded,
    retry: false,
    staleTime: Infinity,
  });

  return <NodeCardFrame testId="claude-central-pool-card">
    <NodeCardHeader
      testId="claude-central-pool-header"
      expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
    >
      <span className="text-sm font-medium text-foreground truncate flex-auto min-w-0">{t("accounts.claude.centralPool")}</span>
    </NodeCardHeader>
    {expanded ? <NodeCardBody>
      {list.isPending
        ? <PendingClaudeRow />
        : list.isError
          ? <div className="c724-account-row" data-testid="claude-central-list-error">
            <div className="c724-account-top">
              <p className="c724-pool-error" role="alert" data-v3-selectable-content="true">
                {requestErrorMessage(list.error, t)}
              </p>
              <Button variant="outline" size="sm" disabled={list.isFetching} onClick={() => void list.refetch()}>
                {t("accounts.common.retry")}
              </Button>
            </div>
          </div>
          : <ClaudePoolRow
            central
            request={request}
            initialList={list.data as ClaudeAccountList}
            slots={[null, null, null]}
          />}
    </NodeCardBody> : null}
  </NodeCardFrame>;
}
