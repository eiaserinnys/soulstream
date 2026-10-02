import React, { useLayoutEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { ProjectListScreen } from '../screens/ProjectListScreen';
import { FolderSelectionSheet } from '../components/planner/FolderSelectionSheet';
import { CardCreateSheet } from '../components/planner/CardCreateSheet';
import { GlassButton } from '../components/GlassSurface';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { useTokens } from '../theme';
import { createFolderReviewFixture, installFolderReviewScope, type FolderReviewLength } from './longFolderFixtures';

type Sample = 'project' | 'folder' | 'create';
const params = () => typeof window !== 'undefined' ? new URLSearchParams(window.location?.search) : null;

/** Existing production screens, with only the public data length changed locally. */
export function ReviewLongFolders() {
  const t = useTokens();
  const [length, setLength] = useState<FolderReviewLength>(() => params()?.get('length') === 'long' ? 'long' : 'short');
  const [sample, setSample] = useState<Sample>(() => params()?.get('sample') === 'folder' ? 'folder' : params()?.get('sample') === 'create' ? 'create' : 'project');
  return <View style={{ flex: 1, gap: t.uiSpacing.sm }}>
    <SettingsSegmentedControl<FolderReviewLength> id="review-folder-length" value={length} onChange={setLength}
      options={[{ value: 'short', label: '짧은 목록 · 2개' }, { value: 'long', label: '긴 목록 · 100개' }]} />
    <SettingsSegmentedControl<Sample> id="review-folder-sample" value={sample} onChange={setSample}
      options={[{ value: 'project', label: '프로젝트 목록' }, { value: 'folder', label: '폴더 선택기' }, { value: 'create', label: '새 카드 작성' }]} />
    <FolderSample key={`${length}:${sample}`} length={length} sample={sample} />
  </View>;
}

function FolderSample({ length, sample }: { length: FolderReviewLength; sample: Sample }) {
  const t = useTokens();
  const fixture = useMemo(() => createFolderReviewFixture(length), [length]);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const restore = installFolderReviewScope(fixture);
    setReady(true);
    return restore;
  }, [fixture]);
  if (!ready) return null;
  if (sample === 'project') return <ProjectListScreen />;
  return <>
    <GlassButton accessibilityLabel="검수 샘플 열기" onPress={() => setOpen(true)}>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>검수 샘플 열기</Text>
    </GlassButton>
    {open && sample === 'folder' ? <FolderSelectionSheet api={fixture.api} onSelect={() => setOpen(false)} onClose={() => setOpen(false)} /> : null}
    {open && sample === 'create' ? <CardCreateSheet api={fixture.api} folderId={fixture.catalogFolders[0].id} onClose={() => setOpen(false)} /> : null}
  </>;
}
