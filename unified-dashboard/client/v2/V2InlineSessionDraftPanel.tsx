import { useEffect, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle, MessageSquarePlus, X } from "lucide-react";

import type { AgentInfo, SessionCreationWarning } from "@seosoyoung/soul-ui";

import type { OrchestratorNode } from "../store/orchestrator-store";

export interface V2InlineSessionDraft {
  pageId: string;
  blockId: string;
  recoverySessionId: string;
  prompt: string;
  nodeId: string;
  agentId: string;
  pending: boolean;
  error: string | null;
}

export function createInlineSessionDraft(
  anchor: { pageId: string; blockId: string },
  nodes: readonly OrchestratorNode[],
  recoverySessionId = crypto.randomUUID(),
): V2InlineSessionDraft {
  const connected = nodes.filter((node) => node.status === "connected");
  return {
    ...anchor,
    recoverySessionId,
    prompt: "",
    nodeId: connected.length === 1 ? connected[0]!.nodeId : "",
    agentId: "",
    pending: false,
    error: null,
  };
}

export type InlineSessionDraftTarget =
  | { kind: "ready"; pageAnchor: { pageId: string; blockId: string; expectedVersion: number } }
  | { kind: "recovered"; sessionId: string }
  | { kind: "error"; message: string };

export function resolveInlineSessionDraftTarget(input: {
  draft: V2InlineSessionDraft;
  currentPage: {
    id: string;
    version: number;
    blocks: readonly {
      id: string;
      type: string;
      textValue: string;
      properties: Readonly<Record<string, unknown>>;
    }[];
  } | null;
  connectedNodeIds: ReadonlySet<string>;
}): InlineSessionDraftTarget {
  const { draft, currentPage, connectedNodeIds } = input;
  if (!connectedNodeIds.has(draft.nodeId)) {
    return { kind: "error", message: "The selected node is no longer connected. Choose another node." };
  }
  if (!currentPage || currentPage.id !== draft.pageId) {
    return { kind: "error", message: "This draft belongs to another page. Return to its page before retrying." };
  }
  const target = currentPage.blocks.find((block) => block.id === draft.blockId);
  if (!target) {
    return { kind: "error", message: "The draft block was deleted. No session was created." };
  }
  if (target.type === "session_ref") {
    const sessionId = target.properties.sessionId;
    return typeof sessionId === "string" && sessionId
      ? { kind: "recovered", sessionId }
      : { kind: "error", message: "The draft block changed into an invalid session reference." };
  }
  if (target.textValue.trim() !== "/세션") {
    return { kind: "error", message: "The draft block changed. Restore /세션 before retrying." };
  }
  return {
    kind: "ready",
    pageAnchor: {
      pageId: currentPage.id,
      blockId: target.id,
      expectedVersion: currentPage.version,
    },
  };
}

export function V2InlineSessionDraftPanel({
  draft,
  nodes,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: V2InlineSessionDraft;
  nodes: readonly OrchestratorNode[];
  onChange(patch: Partial<V2InlineSessionDraft>): void;
  onSubmit(): void;
  onCancel(): void;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const connectedNodes = nodes.filter((node) => node.status === "connected");

  useEffect(() => { promptRef.current?.focus(); }, [draft.blockId]);
  useEffect(() => {
    if (!draft.nodeId) {
      setAgents([]);
      setAgentsError(null);
      return;
    }
    const controller = new AbortController();
    setAgentsError(null);
    void fetch(`/api/nodes/${encodeURIComponent(draft.nodeId)}/agents`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Agent list HTTP ${response.status}`);
        return await response.json() as { agents?: AgentInfo[] };
      })
      .then((body) => {
        const next = body.agents ?? [];
        setAgents(next);
        if (next.length === 1) onChange({ agentId: next[0]!.id });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAgents([]);
        setAgentsError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [draft.nodeId, onChange]);

  return (
    <section
      data-testid="v2-inline-session-draft"
      className="flex h-full min-h-0 flex-col bg-background/70"
      aria-labelledby="inline-session-title"
    >
      <header className="flex items-center justify-between border-b border-glass-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquarePlus aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 id="inline-session-title" className="truncate text-sm font-semibold">New session draft</h2>
            <p className="truncate text-xs text-muted-foreground">Block {draft.blockId}</p>
          </div>
        </div>
        <button type="button" aria-label="Close session draft" disabled={draft.pending} onClick={onCancel}>
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Node</span>
          <select
            aria-label="Session node"
            value={draft.nodeId}
            disabled={draft.pending}
            className="w-full rounded-lg border border-glass-border bg-background px-3 py-2"
            onChange={(event) => onChange({ nodeId: event.target.value, agentId: "", error: null })}
          >
            <option value="">Choose a node</option>
            {connectedNodes.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.nodeId}</option>)}
          </select>
        </label>

        <label className="block space-y-1 text-sm">
          <span className="font-medium">Agent</span>
          <select
            aria-label="Session agent"
            value={draft.agentId}
            disabled={draft.pending || !draft.nodeId || agentsError !== null}
            className="w-full rounded-lg border border-glass-border bg-background px-3 py-2"
            onChange={(event) => onChange({ agentId: event.target.value, error: null })}
          >
            <option value="">Choose an agent</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          {agentsError ? <span role="alert" className="text-xs text-destructive">{agentsError}</span> : null}
        </label>

        <label className="block space-y-1 text-sm">
          <span className="font-medium">First prompt</span>
          <textarea
            ref={promptRef}
            aria-label="First session prompt"
            value={draft.prompt}
            disabled={draft.pending}
            rows={8}
            className="w-full resize-y rounded-lg border border-glass-border bg-background px-3 py-2"
            placeholder="What should this session do?"
            onChange={(event) => onChange({ prompt: event.target.value, error: null })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
        </label>

        {draft.error ? (
          <p role="alert" className="flex gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {draft.error}
          </p>
        ) : null}
      </div>

      <footer className="border-t border-glass-border p-4">
        <button
          type="button"
          data-testid="v2-inline-session-send"
          disabled={draft.pending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          onClick={onSubmit}
        >
          {draft.pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
          {draft.pending ? "Creating…" : "Create and send"}
        </button>
      </footer>
    </section>
  );
}

export function V2SessionCreationWarnings({ warnings }: { warnings: readonly SessionCreationWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div role="status" data-testid="v2-session-creation-warnings" className="border-b border-warning/40 bg-warning/15 px-4 py-2 text-sm text-warning-foreground">
      {warnings.map((warning) => <p key={warning.code}>{warning.message}</p>)}
    </div>
  );
}
