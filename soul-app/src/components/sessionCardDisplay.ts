import type { Session } from '../api/types';

export interface SessionCardAvatarDecision {
  uri: string | null;
  fallbackChar: string;
}

export interface SessionCardCallerDecision {
  showIdentity: boolean;
  requestLabel: string | null;
  accessibilityLabel: string | null;
}

const BACKEND_FALLBACK_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  'openai-agents': 'OpenAI Agents',
};

export function shortSessionId(sessionId: string): string {
  const withoutPrefix = sessionId.replace(/^sess-/, '');
  return withoutPrefix.slice(0, 8) || sessionId.slice(0, 8);
}

export function resolveSessionAgentLabel(
  session: Pick<Session, 'agentName' | 'agentId' | 'agentSessionId'>,
): string {
  return session.agentName?.trim()
    || session.agentId?.trim()
    || shortSessionId(session.agentSessionId);
}

export function resolveSessionModelLabel(
  session: Pick<Session, 'modelLabel' | 'backend'>,
): string | null {
  const modelLabel = session.modelLabel?.trim();
  if (modelLabel) return modelLabel;

  const backend = session.backend?.trim();
  if (!backend) return null;
  return BACKEND_FALLBACK_LABELS[backend.toLowerCase()] ?? backend;
}

function resolvePortraitUri(
  portraitUrl: string | null | undefined,
  serverUrl: string | null | undefined,
): string | null {
  if (!portraitUrl) return null;
  if (portraitUrl.startsWith('http')) return portraitUrl;
  if (!serverUrl) return null;
  return `${serverUrl.replace(/\/$/, '')}${portraitUrl}`;
}

export function resolveSessionCardAvatar(
  session: Pick<Session, 'agentName' | 'agentId' | 'agentSessionId' | 'agentPortraitUrl'>,
  serverUrl: string | null | undefined,
): SessionCardAvatarDecision {
  const agentLabel = resolveSessionAgentLabel(session);
  return {
    uri: resolvePortraitUri(session.agentPortraitUrl, serverUrl),
    fallbackChar: agentLabel[0] ?? '·',
  };
}

export function resolveSessionCardCaller(
  session: Pick<Session, 'callerSessionId' | 'userName' | 'userPortraitUrl'>,
  _serverUrl: string | null | undefined,
): SessionCardCallerDecision {
  const showIdentity =
    !!session.callerSessionId &&
    (!!session.userName || !!session.userPortraitUrl);

  if (!showIdentity) {
    return {
      showIdentity: false,
      requestLabel: null,
      accessibilityLabel: null,
    };
  }

  const callerName = session.userName?.trim();
  return {
    showIdentity: true,
    requestLabel: callerName ? `요청 ${callerName}` : '피위임 요청',
    accessibilityLabel: callerName ? `요청 ${callerName}` : '피위임 요청',
  };
}
