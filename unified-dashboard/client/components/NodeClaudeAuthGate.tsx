import { useQuery } from "@tanstack/react-query";
import { NodeClaudeAuthPanel } from "./NodeClaudeAuthPanel";
import { ClaudeAccountPoolPanel } from "./claude-accounts/ClaudeAccountPoolPanel";
import { getClaudeAccounts } from "../lib/claude-auth-api";

interface Props {
  request?: typeof fetch;
  nodeId: string;
}

export function NodeClaudeAuthGate({ nodeId, request = fetch }: Props) {
  const accounts = useQuery({
    queryKey: ["claude-auth-accounts", nodeId],
    queryFn: () => getClaudeAccounts(request, nodeId),
    retry: false,
    staleTime: Infinity,
  });

  if (accounts.isPending) {
    return <div className="px-3 py-2 border-t border-border bg-muted/20" aria-live="polite" />;
  }

  if (accounts.data?.mode === "pool") {
    return <ClaudeAccountPoolPanel nodeId={nodeId} request={request} initialList={accounts.data} />;
  }

  return <NodeClaudeAuthPanel nodeId={nodeId} request={request} />;
}
