import React from 'react';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';
import { useSessionReviewAcknowledge } from './useSessionReviewAcknowledge';
import { SessionCardView, type SessionCardProps } from './SessionCardView';

export function SessionCard(props: SessionCardProps) {
  const { session } = props;
  const folderName = useSessionStore((s) => {
    const assignment = s.catalog.sessions[session.agentSessionId];
    if (!assignment?.folderId) return null;
    return s.catalog.folders.find((folder) => folder.id === assignment.folderId)?.name ?? null;
  });
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const jwt = useAuthStore((s) => s.jwt);

  const review = useSessionReviewAcknowledge(session.agentSessionId);
  return <SessionCardView {...props} folderName={folderName} serverUrl={serverUrl} jwt={jwt} review={review} />;
}
