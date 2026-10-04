import { usePersistentDraft } from '../../hooks/usePersistentDraft';
// Existing title/description editing stays together; this change extracts the virtual scroll owner.
// The remaining 500+ line coordinator is preserved to avoid changing unrelated editing behavior.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { createApiClient, type ApiClient } from '../../api/client';
import type { PlannerFolder } from '../../api/plannerTypes';
import { plannerFolderDetailToSummary } from '../../api/plannerTypes';
import { usePlannerActions } from '../../hooks/usePlannerActions';
import { usePlannerContextMenus } from '../../hooks/usePlannerContextMenus';
import { usePlannerDaily, usePlannerFolderDetail, usePlannerPageDetail } from '../../hooks/usePlannerReads';
import { selectPlannerFolder, usePlannerStore } from '../../store/plannerStore';
import { useUIStore } from '../../store/uiStore';
import { mergeServerDraft } from '../../lib/server-draft';
import { useDeviceType, useTokens } from '../../theme';
import { buildPlannerContextPresentation } from '../../lib/planner-context-presentation';
import { plannerDescriptionText } from '../../lib/planner-description-blocks';
import { useSessionStore } from '../../store/sessionStore';
import { SessionSuccessionHost } from './SessionSuccessionHost';
import { TabletPaneHeader } from '../split/TabletPaneHeader';
import { FolderSessionHistory } from './FolderSessionHistory';
import { FolderCards } from './FolderCards';
import { FolderWorkspaceList } from './FolderWorkspaceList';
import { AppGlassCard } from '../AppGlassCard';
import { FolderBoardContent } from './FolderBoardContent';
import { TabletMarkdownEditor, type TabletMarkdownSaveAttempt } from './TabletMarkdownEditor';
import { FolderWorkspaceDetails } from './FolderWorkspaceDetails';
import {
  coordinateFolderWorkspaceClose,
  plannerFolderTitleSaveCoordinator,
} from '../../lib/planner-folder-title-save';
import { captureAuthScope, useAuthScopeGeneration } from '../../lib/auth-scope';
import { makeFolderWorkspaceStyles } from './FolderWorkspace.styles';
import { FolderWorkspaceToggleActions } from './FolderWorkspaceToggleActions';
import { FolderWorkspaceSections } from './FolderWorkspaceSections';
import { PlannerForegroundCard } from './PlannerForegroundCard';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { folderPage, folderWorkspaceSummary } from './folderWorkspaceModel';
import type { FolderCardDisplay } from './CardBoardWorkspace';

// Existing workspace exceeds 500 lines; this change only forwards the iPad board's controlled view option.
// Splitting unrelated title/description save lifecycles belongs to a separate change.

export function FolderWorkspace({
  api,
  folderPageId,
  folderId,
  active = true,
  onOpenSession,
  onClose,
  onTitleSaved,
  onOpenFolder,
  cardDisplay,
}: {
  api: ApiClient | null;
  folderPageId: string;
  folderId?: string;
  active?: boolean;
  onOpenSession?: (sessionId: string) => void;
  onClose?: () => void;
  onTitleSaved?: (title: string) => void;
  onOpenFolder?: (folderId: string, pageId: string, name: string) => void;
  cardDisplay?: FolderCardDisplay;
}) {
  const t = useTokens();
  const tablet = useDeviceType() !== 'phone';
  const styles = useMemo(() => makeFolderWorkspaceStyles(t), [t]);
  const selector = useMemo(() => selectPlannerFolder(folderPageId), [folderPageId]);
  const storedFolderSummary = usePlannerStore(selector);
  const folders = useSessionStore((state) => state.catalog.folders);
  const catalogFolder = folders.find((candidate) => candidate.id === folderId)
    ?? folders.find((candidate) => candidate.projectPageId === folderPageId);
  const pageDetail = usePlannerPageDetail(api, folderPageId, active);
  const planner = usePlannerFolderDetail(api, catalogFolder?.id ?? folderId ?? null, active);
  const folder = planner.data?.folder ?? catalogFolder;
  const folderSummary = useMemo(() => planner.data && folder?.projectPageId
    ? plannerFolderDetailToSummary(planner.data)
    : storedFolderSummary ?? (folder && folder.projectPageId
    ? folderWorkspaceSummary(
        folder,
        pageDetail.data?.page ?? folderPage(folder),
        pageDetail.data?.blocks ?? [],
      )
    : undefined), [folder, pageDetail.data, planner.data, storedFolderSummary]);
  const today = useUIStore((state) => state.todayDate);
  const todayDaily = usePlannerDaily(api, today, active);
  const folderInToday = todayDaily.data
    ? todayDaily.data.folders.some((candidate) => candidate.page.id === folderPageId)
    : undefined;
  const todayReady = active
    && todayDaily.data !== undefined
    && !todayDaily.loading
    && todayDaily.error === null;
  const todayLoading = !!api && active && todayDaily.error === null && !todayReady;
  const parentPageId = folders.find((candidate) => candidate.id === folder?.parentFolderId)?.projectPageId ?? null;
  const projectPageDetail = usePlannerPageDetail(api, parentPageId, active);
  const scopeGeneration = useAuthScopeGeneration();
  const sessionNearEndRef = useRef<(() => void) | null>(null);
  const notifySessionNearEnd = useCallback(() => {
    sessionNearEndRef.current?.();
  }, []);
  const draftOwnerKey = `${scopeGeneration}\u0000${folderPageId}`;
  const scopedApi = useMemo(() => {
    if (!api) return null;
    const scope = captureAuthScope();
    return scope.serverUrl ? createApiClient(scope.serverUrl, { authScope: scope }) : null;
  }, [api, scopeGeneration]);
  const actions = usePlannerActions(scopedApi, scopeGeneration);
  const menus = usePlannerContextMenus(api);
  const renameWorkspace = useCallback((_current: PlannerFolder, nextTitle: string) => {
    if (!folder) throw new Error('폴더를 불러오는 중입니다.');
    return actions.renameFolder(folder.id, nextTitle);
  }, [actions.renameFolder, folder]);
  const [title, setTitle] = useState(folderSummary?.page.title ?? '');
  const [description, setDescription] = useState(() => plannerDescriptionText(folderSummary?.blocks ?? []));
  const draftFolderPageId = useRef(folderSummary?.page.id ?? folderPageId);
  const draftOwner = useRef(draftOwnerKey);
  const titleDraft = useRef(title);
  const descriptionDraft = useRef(description);
  const titleServer = useRef(title);
  const descriptionServer = useRef(description);
  const persistentDescription = usePersistentDraft('folder-description',
    [folder?.id ?? folderId ?? folderSummary?.folderId ?? folderPageId], descriptionServer.current);
  if (persistentDescription.ready && draftOwner.current === draftOwnerKey) descriptionDraft.current = persistentDescription.value;
  const nextDescriptionSaveToken = useRef(0);
  const latestDescriptionSaveAttempt = useRef<TabletMarkdownSaveAttempt | null>(null);
  const mounted = useRef(true);
  const [saving, setSaving] = useState(false);
  const [, setDescriptionServerRevision] = useState(0);
  const [editingPhoneTitle, setEditingPhoneTitle] = useState(false);
  const [successionId, setSuccessionId] = useState<string | null | undefined>(undefined);
  const [newFolderDraft, setNewFolderDraft] = useState<{ parentPageId: string } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (draftOwner.current !== draftOwnerKey) {
      draftOwner.current = draftOwnerKey;
      latestDescriptionSaveAttempt.current = null;
      const nextServerTitle = folderSummary?.page.title ?? '';
      const nextTitle = folderSummary
        ? plannerFolderTitleSaveCoordinator.preferredTitle(
            folderSummary.page.id,
            nextServerTitle,
            scopeGeneration,
          )
        : '';
      const nextDescription = plannerDescriptionText(folderSummary?.blocks ?? []);
      draftFolderPageId.current = folderSummary?.page.id ?? folderPageId;
      titleDraft.current = nextTitle;
      descriptionDraft.current = nextDescription;
      titleServer.current = nextServerTitle;
      applyCanonicalDescription(nextDescription);
      setTitle(nextTitle);
      setDescription(nextDescription);
      setSaving(false);
      setEditingPhoneTitle(false);
      setSuccessionId(undefined);
      setNewFolderDraft(null);
      return;
    }
    if (!folderSummary) {
      titleDraft.current = '';
      descriptionDraft.current = '';
      titleServer.current = '';
      applyCanonicalDescription('');
      setTitle('');
      setDescription('');
      setEditingPhoneTitle(false);
      return;
    }
    const serverTitle = folderSummary.page.title;
    const nextTitle = plannerFolderTitleSaveCoordinator.preferredTitle(
      folderSummary.page.id,
      serverTitle,
      scopeGeneration,
    );
    const nextDescription = plannerDescriptionText(folderSummary.blocks);
    if (draftFolderPageId.current !== folderSummary.page.id) {
      draftFolderPageId.current = folderSummary.page.id;
      titleDraft.current = nextTitle;
      descriptionDraft.current = nextDescription;
      titleServer.current = serverTitle;
      applyCanonicalDescription(nextDescription);
      setTitle(nextTitle);
      setDescription(nextDescription);
      setEditingPhoneTitle(false);
      return;
    }
    const retainedDraft = titleDraft.current === titleServer.current && nextTitle !== serverTitle
      ? nextTitle
      : titleDraft.current;
    const mergedTitle = mergeServerDraft(retainedDraft, titleServer.current, serverTitle);
    const mergedDescription = mergeServerDraft(
      descriptionDraft.current,
      descriptionServer.current,
      nextDescription,
    );
    titleDraft.current = mergedTitle.draft;
    descriptionDraft.current = mergedDescription.draft;
    titleServer.current = mergedTitle.server;
    applyCanonicalDescription(mergedDescription.server);
    setTitle(mergedTitle.draft);
    setDescription(mergedDescription.draft);
  }, [draftOwnerKey, scopeGeneration, folderSummary, folderPageId]);

  useEffect(() => {
    if (!persistentDescription.ready) return;
    descriptionDraft.current = persistentDescription.value;
    setDescription(persistentDescription.value);
  }, [persistentDescription.key, persistentDescription.value, persistentDescription.ready]);

  useEffect(() => {
    if (!folderSummary || !tablet) return undefined;
    return plannerFolderTitleSaveCoordinator.bind({
      scopeGeneration,
      folder: folderSummary,
      getDraft: () => titleDraft.current,
      getServerTitle: () => titleServer.current,
      save: renameWorkspace,
      onSaved: (submittedTitle) => {
        if (
          folderSummary.page.id === draftFolderPageId.current
          && draftOwner.current === draftOwnerKey
        ) titleServer.current = submittedTitle;
      },
      onError: (error) => {
        if (mounted.current && folderSummary.page.id === draftFolderPageId.current) {
          Alert.alert('폴더 제목을 저장하지 못했습니다.', errorText(error));
        }
      },
    });
  }, [renameWorkspace, draftOwnerKey, scopeGeneration, tablet, folderSummary]);

  useEffect(() => {
    if (tablet) setEditingPhoneTitle(false);
  }, [tablet]);

  if (!folderSummary) {
    return <View style={styles.empty}><Text style={styles.emptyText}>폴더를 불러오는 중입니다.</Text></View>;
  }

  const ownsDraft = draftOwner.current === draftOwnerKey;
  const visibleTitle = ownsDraft ? title : folderSummary.page.title;
  const currentServerDescription = plannerDescriptionText(folderSummary.blocks);
  const visibleDescription = ownsDraft ? persistentDescription.value : currentServerDescription;
  const visibleServerDescription = ownsDraft
    ? descriptionServer.current
    : currentServerDescription;
  function applyCanonicalDescription(canonicalDescription: string) {
    if (descriptionServer.current === canonicalDescription) return;
    descriptionServer.current = canonicalDescription;
    setDescriptionServerRevision((revision) => revision + 1);
  }
  const applyCanonicalTitle = (submittedOwner: string, canonicalTitle: string) => {
    if (draftOwner.current !== submittedOwner) return;
    titleDraft.current = canonicalTitle;
    titleServer.current = canonicalTitle;
    setTitle(canonicalTitle);
    onTitleSaved?.(canonicalTitle);
    setEditingPhoneTitle(false);
  };
  const save = async () => {
    if (!persistentDescription.ready) return;
    const submittedOwner = draftOwner.current;
    const submittedTitle = titleDraft.current.trim();
    const submittedDescription = descriptionDraft.current;
    setSaving(true);
    try {
      if (!submittedTitle) Alert.alert('폴더 제목을 입력해 주세요.');
      else if (titleDraft.current !== titleServer.current) {
        if (submittedTitle !== titleServer.current.trim()) await renameWorkspace(folderSummary, submittedTitle);
        applyCanonicalTitle(submittedOwner, submittedTitle);
      }
      if (submittedDescription !== descriptionServer.current) {
        await actions.saveFolderDescription(folderSummary, submittedDescription);
        persistentDescription.clearIfMatches(submittedDescription);
        if (draftOwner.current === submittedOwner) {
          applyCanonicalDescription(submittedDescription);
        }
      }
    } catch (error) {
      if (draftOwner.current === submittedOwner) {
        Alert.alert('폴더를 저장하지 못했습니다.', errorText(error));
      }
    } finally {
      if (draftOwner.current === submittedOwner) setSaving(false);
    }
  };
  const savePhoneTitle = async () => {
    const submittedOwner = draftOwner.current;
    const submittedTitle = titleDraft.current.trim();
    setSaving(true);
    try {
      if (!submittedTitle) {
        Alert.alert('폴더 제목을 입력해 주세요.');
        return;
      }
      if (submittedTitle !== titleServer.current.trim()) await renameWorkspace(folderSummary, submittedTitle);
      applyCanonicalTitle(submittedOwner, submittedTitle);
    } catch (error) {
      if (draftOwner.current === submittedOwner) {
        Alert.alert('폴더 제목을 저장하지 못했습니다.', errorText(error));
      }
    } finally {
      if (draftOwner.current === submittedOwner) setSaving(false);
    }
  };
  const cancelPhoneTitleEdit = () => {
    titleDraft.current = titleServer.current;
    setTitle(titleServer.current);
    setEditingPhoneTitle(false);
  };

  const queueTabletTitleSave = () => {
    plannerFolderTitleSaveCoordinator.enqueueLatest(folderSummary.page.id, scopeGeneration);
  };

  const requestClose = () => coordinateFolderWorkspaceClose(folderSummary.page.id, onClose);
  const toggleActions = (
    <FolderWorkspaceToggleActions
      key={folderSummary.page.id}
      starred={folderSummary.page.metadata.starred === true}
      inToday={folderInToday === true}
      showToggles={folder?.id !== 'claude' && folder?.id !== 'llm'}
      starredDisabled={!scopedApi}
      todayDisabled={!scopedApi || !todayReady}
      todayLoading={todayLoading}
      onToggleStarred={() => actions.setFolderStarred(
        folderSummary,
        folderSummary.page.metadata.starred !== true,
      )}
      onToggleToday={() => folderInToday === undefined
        ? Promise.resolve()
        : actions.setFolderToday(folderSummary, today, !folderInToday)}
      onError={(action, error) => Alert.alert(
        action === 'starred' ? '중요 폴더를 변경하지 못했습니다.' : '오늘 데일리를 변경하지 못했습니다.',
        errorText(error),
      )}
      onOpenMenu={folder?.projectPageId ? () => menus.openProjectMenu({
        folder,
        projectPageId: folder.projectPageId!,
        onOpen: () => undefined,
        onCreateFolder: () => setNewFolderDraft({ parentPageId: folder.projectPageId! }),
      }) : undefined}
    />
  );

  const saveTabletDescription = async (submittedDescription: string,
    editorAttempt: Readonly<TabletMarkdownSaveAttempt>) => {
    const attempt = {
      ownerKey: editorAttempt.ownerKey,
      token: nextDescriptionSaveToken.current + 1,
    };
    nextDescriptionSaveToken.current = attempt.token;
    latestDescriptionSaveAttempt.current = attempt;
    if (!persistentDescription.ready || submittedDescription === descriptionServer.current) return;
    const submittedFolderPageId = folderSummary.page.id;
    const ownsAttempt = () => {
      const latest = latestDescriptionSaveAttempt.current;
      return draftOwner.current === attempt.ownerKey
        && draftFolderPageId.current === submittedFolderPageId
        && latest?.ownerKey === attempt.ownerKey
        && latest.token === attempt.token;
    };
    try {
      await actions.saveFolderDescription(folderSummary, submittedDescription);
      persistentDescription.clearIfMatches(submittedDescription);
      if (ownsAttempt()) applyCanonicalDescription(submittedDescription);
    } catch (error) {
      if (ownsAttempt()) {
        Alert.alert('폴더 설명을 저장하지 못했습니다.', errorText(error));
      }
      throw error;
    }
  };

  const projectName = folders.find((candidate) => candidate.id === folder?.parentFolderId)?.name ?? '폴더';
  const context = buildPlannerContextPresentation({
    projectName,
    projectBlocks: projectPageDetail.data?.blocks ?? [],
    folderBlocks: folderSummary.blocks,
  });
  const parentFolder = folders.find((candidate) => candidate.id === folder?.parentFolderId);
  return (
    <View style={styles.container}>
      {tablet ? (
        <TabletPaneHeader testID="task-workspace-tablet-header" style={styles.tabletHeader}>
          <TextInput
            testID="task-workspace-tablet-title"
            value={visibleTitle}
            onChangeText={(value) => {
              titleDraft.current = value;
              plannerFolderTitleSaveCoordinator.setDraft(folderSummary.page.id, value, scopeGeneration);
              setTitle(value);
            }}
            onBlur={queueTabletTitleSave}
            multiline
            accessibilityLabel="폴더 제목"
            style={styles.tabletTitle}
          />
          {toggleActions}
          {onClose ? (
            <TouchableOpacity
              testID="task-workspace-close"
              accessibilityLabel="폴더 패널 닫기"
              style={styles.closeButton}
              onPress={requestClose}
            >
              <Ionicons name="close" size={t.iconSize.navigation} color={t.colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </TabletPaneHeader>
      ) : null}
      <FolderWorkspaceList api={api} folderId={folderSummary.folderId} active={active} cardDisplay={cardDisplay} onOpenSession={onOpenSession} onNearEnd={notifySessionNearEnd}
        contentContainerStyle={styles.content}
        header={<>
        {pageDetail.error ? <Text style={styles.error}>{pageDetail.error}</Text> : null}
        <FolderWorkspaceDetails
          api={api}
          folderSummary={folderSummary}
          contexts={context.contexts}
          assignment={context.assignment}
          onEditTitle={!tablet && !editingPhoneTitle
            ? () => setEditingPhoneTitle(true)
            : undefined}
          onSaveAssignment={async (value) => {
            await actions.saveFolderSessionDefaults(folderSummary, {
              ...value,
              blockId: context.assignment?.blockId ?? null,
            });
          }}
        />
        {!tablet ? (
          <View style={styles.topActions}>{toggleActions}</View>
        ) : null}
        {!tablet && editingPhoneTitle ? (
          <AppGlassCard testID="task-workspace-title-editor" style={styles.titleEditor}>
            <TextInput
              testID="task-workspace-title-heading"
              value={visibleTitle}
              onChangeText={(value) => {
                titleDraft.current = value;
                setTitle(value);
              }}
              style={styles.title}
              accessibilityLabel="폴더 제목"
            />
            <View style={styles.titleActions}>
              <TouchableOpacity
                testID="task-workspace-title-cancel-action"
                style={styles.metadataAction}
                disabled={saving}
                onPress={cancelPhoneTitleEdit}
              >
                <Text style={styles.secondaryAction}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="task-workspace-title-save-action"
                style={styles.metadataAction}
                disabled={saving}
                onPress={() => { void savePhoneTitle(); }}
              >
                <Text style={styles.link}>{saving ? '저장 중…' : '저장'}</Text>
              </TouchableOpacity>
            </View>
          </AppGlassCard>
        ) : null}
        <View style={styles.sectionGroup}>
          <PlannerSectionHeader title="설명" testID="planner-section-header-description" />
          {tablet ? (
            <TabletMarkdownEditor ready={persistentDescription.ready}
              testID="task-description"
              ownerKey={draftOwnerKey}
              value={visibleServerDescription}
              draft={visibleDescription}
              onChangeDraft={(value) => {
                descriptionDraft.current = value;
                setDescription(value);
                persistentDescription.setValue(value);
              }}
              onCancel={() => {
                descriptionDraft.current = descriptionServer.current;
                setDescription(descriptionServer.current);
                persistentDescription.clear();
              }}
              onSave={saveTabletDescription}
              emptyText="폴더 설명이 없습니다."
            />
          ) : (
            <>
              <PlannerForegroundCard testID="task-workspace-description-panel"
                glassTestID="folder-description-glass" foregroundTestID="folder-description-foreground">
                <TextInput
                  editable={persistentDescription.ready}
                  testID="folder-description-input"
                  value={visibleDescription}
                  onChangeText={(value) => {
                    descriptionDraft.current = value;
                    setDescription(value);
                    persistentDescription.setValue(value);
                  }}
                  multiline
                  placeholder="폴더 설명"
                  placeholderTextColor={t.colors.textPlaceholder}
                  style={styles.description}
                />
              </PlannerForegroundCard>
              <TouchableOpacity testID="task-workspace-save-action" style={styles.action} onPress={save} disabled={saving || !persistentDescription.ready}>
                <Text style={styles.primaryAction}>{saving ? '저장 중…' : '변경사항 저장'}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
        <FolderCards api={api} folderId={folderSummary.folderId} active={active} onOpenSession={onOpenSession} cardDisplay={cardDisplay} virtualHost/>
        </>}
        footer={<>
        {folder ? (
          <FolderWorkspaceSections
            api={api}
            folder={folder}
            detail={planner.data}
            loading={planner.loading}
            error={planner.error}
            active={active}
            loadMoreSubfolders={planner.loadMoreSubfolders}
            onOpenFolder={onOpenFolder}
            parentFolder={parentFolder}
            newFolderDraft={newFolderDraft}
            onNewFolderDraftChange={setNewFolderDraft}
          />
        ) : null}
        <FolderBoardContent api={api} folderId={folderSummary.folderId} active={active} />
        <View style={styles.sectionGroup}>
          <PlannerSectionHeader title="세션" testID="planner-section-header-sessions"
            actionLabel="새 세션" onAction={() => setSuccessionId(null)} />
          <FolderSessionHistory
            api={api}
            folderId={folderSummary.folderId}
            active={active}
            nearEndRef={sessionNearEndRef}
            sessionSummaries={folderSummary.sessions}
            onOpenSession={onOpenSession}
            onLongPressSession={(sessionId) => menus.openSessionMenu({
              sessionId,
              currentFolder: folderSummary,
            })}
          />
        </View>
        </>}/>
      <SessionSuccessionHost
        api={api}
        request={ownsDraft && successionId !== undefined
          ? { folder: folderSummary, predecessorSessionId: successionId }
          : null}
        onClose={() => setSuccessionId(undefined)}
        onCreated={(sessionId) => onOpenSession?.(sessionId)}
      />
      <SessionSuccessionHost
        api={api}
        request={menus.sessionSuccession}
        onClose={menus.closeSessionSuccession}
        onCreated={(sessionId) => onOpenSession?.(sessionId)}
      />
    </View>
  );
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
