import React, { useMemo, useState } from 'react';
import { ProjectContextEditorView } from '../components/planner/ProjectContextEditorView';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { guidance } from './fixtures';
import { ReviewSection } from './ReviewSection';

const options = [{ value: 'normal', label: '기본' }, { value: 'empty', label: '빈 내용' }, { value: 'error', label: '조회 실패' }] as const;
export function ReviewProject() {
  const [state, setState] = useState<typeof options[number]['value']>('normal');
  const detail = useMemo(() => ({
    data: { blocks: [{ parentId: null, blockType: 'paragraph',
      properties: {}, text: state === 'empty' ? '' : guidance }] },
    error: state === 'error' ? '공개 예시: 컨텍스트를 불러오지 못했습니다.' : null,
  }), [state]);
  return <ReviewSection title="프로젝트 컨텍스트 · 읽기·펼치기·편집·저장·취소">
    <SettingsSegmentedControl<typeof options[number]['value']> id="review-context-state" value={state} onChange={setState} options={options} />
    <ProjectContextEditorView key={state} projectPageId="public-context" detail={detail}
      saveProjectContext={async () => { await new Promise((resolve) => setTimeout(resolve, 600)); }} />
  </ReviewSection>;
}
