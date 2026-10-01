import React from 'react';
import type { ApiClient } from '../../api/client';
import { usePlannerActions } from '../../hooks/usePlannerActions';
import { usePlannerPageDetail } from '../../hooks/usePlannerReads';
import { ProjectContextEditorView } from './ProjectContextEditorView';

export function ProjectContextEditor({ api, projectPageId, active }: {
  api: ApiClient | null; projectPageId: string; active: boolean;
}) {
  const actions = usePlannerActions(api);
  const detail = usePlannerPageDetail(api, projectPageId, active);
  return <ProjectContextEditorView projectPageId={projectPageId} detail={detail}
    saveProjectContext={actions.saveProjectContext} />;
}
