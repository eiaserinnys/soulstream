import type { Session } from '../../api/types';
import type { ChatAttachment } from '../../hooks/useChatAttachments';
import { appendAttachmentPathNotes } from '../../utils/attachmentPathNotes';
import {
  buildOptimisticSession,
  resolveOptimisticAgent,
  type SessionAgentOption,
} from './optimisticSession';

export interface NewSessionCreatePayload {
  prompt: string;
  folderId?: string;
  agentId?: string;
  nodeId?: string;
  attachmentPaths?: string[];
}

interface BuildNewSessionCreatePayloadArgs {
  text: string;
  selectedFolderId: string | null;
  agentId: string | null;
  selectedNodeId: string | null;
  settingsNodeId: string | null;
  attachments: ChatAttachment[];
}

export interface NewSessionCreatePayloadResult {
  payload: NewSessionCreatePayload;
  submitNodeId: string | undefined;
  attachmentPaths: string[];
}

interface NewSessionCreationResponse {
  agentSessionId?: string;
  nodeId?: unknown;
}

interface CommitNewSessionCreationArgs {
  response: NewSessionCreationResponse;
  text: string;
  selectedFolderId: string | null;
  submitNodeId: string | undefined;
  agentId: string | null;
  agents: SessionAgentOption[];
  upsertSession: (session: Session) => void;
  assignSessionToCatalog: (
    agentSessionId: string,
    folderId: string | null,
    displayName?: string | null,
  ) => void;
  setPendingFirstMessage: (sessionId: string, text: string) => void;
  onCreated: (sessionId: string) => void;
  clearAttachments: () => void;
  onClose: () => void;
  now?: string;
}

export function buildNewSessionCreatePayload({
  text,
  selectedFolderId,
  agentId,
  selectedNodeId,
  settingsNodeId,
  attachments,
}: BuildNewSessionCreatePayloadArgs): NewSessionCreatePayloadResult {
  const attachmentPaths = attachments.map((a) => a.path);
  const submitNodeId =
    selectedNodeId ?? (attachmentPaths.length > 0 ? settingsNodeId : undefined);
  const prompt = appendAttachmentPathNotes(text, attachmentPaths);

  return {
    payload: {
      prompt,
      folderId: selectedFolderId ?? undefined,
      agentId: agentId ?? undefined,
      // 첨부가 있으면 업로드한 노드와 실행 노드를 맞춘다.
      nodeId: submitNodeId ?? undefined,
      attachmentPaths: attachmentPaths.length > 0 ? attachmentPaths : undefined,
    },
    submitNodeId: submitNodeId ?? undefined,
    attachmentPaths,
  };
}

export function commitNewSessionCreation({
  response,
  text,
  selectedFolderId,
  submitNodeId,
  agentId,
  agents,
  upsertSession,
  assignSessionToCatalog,
  setPendingFirstMessage,
  onCreated,
  clearAttachments,
  onClose,
  now,
}: CommitNewSessionCreationArgs): string {
  const sid = response.agentSessionId;
  if (!sid) throw new Error('서버 응답에 세션 ID가 없습니다.');

  const optimisticAgent = resolveOptimisticAgent(agentId, agents);
  upsertSession(
    buildOptimisticSession({
      agentSessionId: sid,
      prompt: text,
      folderId: selectedFolderId,
      nodeId: typeof response.nodeId === 'string' ? response.nodeId : submitNodeId,
      agent: optimisticAgent,
      now,
    }),
  );
  assignSessionToCatalog(sid, selectedFolderId ?? null, null);
  setPendingFirstMessage(sid, text);
  onCreated(sid);
  clearAttachments();
  onClose();

  return sid;
}
