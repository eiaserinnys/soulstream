import { useMemo, useState } from 'react';
import { FolderContextSection } from '../components/planner/FolderContextSection';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { useSessionStore } from '../store/sessionStore';
import { createReviewApi } from './fixtures';
import { withFolderContext } from './folder-context-fixtures';
import { ReviewSection } from './ReviewSection';

const options = [
  { value: 'project', label: '직접 정한 폴더' },
  { value: 'child', label: '물려받는 폴더' },
  { value: 'loading', label: '불러오는 중' },
  { value: 'error', label: '조회 실패' },
] as const;
type State = typeof options[number]['value'];

/** Folder screen 「맥락」 summary in its saved, inherited, loading and failed states. */
export function ReviewProject() {
  const [state, setState] = useState<State>('project');
  const folders = useSessionStore((store) => store.catalog.folders);
  const api = useMemo(() => withFolderContext(createReviewApi(
    state === 'loading' ? 'loading' : state === 'error' ? 'error' : 'normal',
  )), [state]);
  const child = state === 'child';
  return <ReviewSection title="폴더 맥락 · 읽기 요약과 설정">
    <SettingsSegmentedControl<State> id="review-context-state" value={state} onChange={setState} options={options} wrap />
    <FolderContextSection key={state} api={api} folders={folders} active
      folderId={child ? 'public-child' : 'public-project'} folderPageId={child ? 'public-child-page' : 'public-page'}
      onOpenSettings={() => undefined} />
  </ReviewSection>;
}
