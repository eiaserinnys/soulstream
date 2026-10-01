import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { SessionCardById } from '../components/SessionCardById';
import { AppGlassPressable } from '../components/AppGlassCard';
import { GlassButton } from '../components/GlassSurface';
import { useSessionStore } from '../store/sessionStore';
import type { DesignTokens } from '../theme';
import { makeSearchScreenStyles } from './SearchScreen.styles';

export function SearchRecents({
  recentQueries,
  recentSessionIds,
  folders,
  styles,
  onQuery,
  onFolder,
  onOpenSession,
}: {
  recentQueries: string[];
  recentSessionIds: string[];
  folders: ReturnType<typeof useSessionStore.getState>['catalog']['folders'];
  styles: ReturnType<typeof makeSearchScreenStyles>;
  onQuery(query: string): void;
  onFolder(folderId: string): void;
  onOpenSession(sessionId: string): void;
}) {
  return (
    <View style={styles.recents}>
      <Text style={styles.heading}>최근 검색</Text>
      <View style={styles.wrap}>
        {recentQueries.length === 0 ? (
          <Text style={styles.muted}>아직 검색 기록이 없습니다.</Text>
        ) : recentQueries.map((query) => (
          <AppGlassPressable
            key={query}
            contentStyle={styles.recentChip}
            accessibilityLabel={`최근 검색, ${query}`}
            onPress={() => onQuery(query)}
          >
            <Text style={styles.recentText}>{query}</Text>
          </AppGlassPressable>
        ))}
      </View>
      {recentSessionIds.length > 0 ? (
        <>
          <Text style={styles.heading}>최근 본 세션</Text>
          {recentSessionIds.map((sessionId) => (
            <SessionCardById
              key={sessionId}
              sessionId={sessionId}
              accessibilityLabelPrefix="최근 본 세션"
              onPress={onOpenSession}
            />
          ))}
        </>
      ) : null}
      {folders.length > 0 ? (
        <>
          <Text style={styles.heading}>폴더에서 찾기</Text>
          <View style={styles.wrap}>
            {folders.map((folder) => (
              <AppGlassPressable
                key={folder.id}
                contentStyle={styles.recentChip}
                accessibilityLabel={`${folder.name} 폴더로 검색 범위 제한`}
                onPress={() => onFolder(folder.id)}
              >
                <Text style={styles.recentText}>{folder.name}</Text>
              </AppGlassPressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

export function SearchEmpty({
  icon,
  title,
  detail,
  onLoadMore,
  styles,
  t,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
  onLoadMore?(): void;
  styles: ReturnType<typeof makeSearchScreenStyles>;
  t: DesignTokens;
}) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={t.iconSize.hero} color={t.colors.textMuted} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDetail}>{detail}</Text>
      {onLoadMore ? (
        <GlassButton
          accessibilityLabel="검색 결과 더 불러오기"
          onPress={onLoadMore}
          style={styles.more}
        >
          <Text style={styles.moreText}>더 넓게 검색</Text>
        </GlassButton>
      ) : null}
    </View>
  );
}
