import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from 'react-native-enriched-markdown';
import { DESIGN_HIT_TARGET, useTokens } from '../../theme';
import { segmentMarkdownBlockquotes } from './blockquoteCopyModel';

const COPY_FEEDBACK_MS = 1600;
const COPY_ICON_SIZE = 16;
type CopyState = 'idle' | 'success' | 'error';

interface Props {
  markdown: string;
  markdownStyle: MarkdownStyle;
  onLinkPress?: (event: { url: string }) => void;
}

export function CopyableAssistantMarkdown({
  markdown,
  markdownStyle,
  onLinkPress,
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(), []);
  const segments = useMemo(
    () => segmentMarkdownBlockquotes(markdown),
    [markdown],
  );
  let quoteIndex = 0;

  return (
    <>
      {segments.map((segment, segmentIndex) => {
        if (segment.kind === 'blockquote') {
          const currentQuoteIndex = quoteIndex;
          quoteIndex += 1;
          return (
            <CopyableBlockquote
              key={`blockquote-${segmentIndex}`}
              index={currentQuoteIndex}
              markdown={segment.markdown}
              plainText={segment.plainText}
              markdownStyle={markdownStyle}
              onLinkPress={onLinkPress}
              iconColor={t.colors.textMuted}
              styles={styles}
            />
          );
        }

        if (!segment.markdown.trim()) return null;
        return (
          <EnrichedMarkdownText
            key={`markdown-${segmentIndex}`}
            testID={segments.length === 1 ? 'assistant-markdown' : `assistant-markdown-${segmentIndex}`}
            markdown={segment.markdown}
            flavor="github"
            markdownStyle={markdownStyle}
            selectable={false}
            onLinkPress={onLinkPress}
          />
        );
      })}
    </>
  );
}

function CopyableBlockquote({
  index,
  markdown,
  plainText,
  markdownStyle,
  onLinkPress,
  iconColor,
  styles,
}: {
  index: number;
  markdown: string;
  plainText: string;
  markdownStyle: MarkdownStyle;
  onLinkPress?: Props['onLinkPress'];
  iconColor: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  const copyQuote = async () => {
    let feedback: string;
    try {
      await Clipboard.setStringAsync(plainText);
      setCopyState('success');
      feedback = '인용문을 복사했습니다';
    } catch {
      setCopyState('error');
      feedback = '인용문을 복사하지 못했습니다';
    }
    AccessibilityInfo.announceForAccessibility(feedback);

    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setCopyState('idle');
      resetTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  };

  const feedback = copyState === 'success'
    ? '인용문을 복사했습니다'
    : copyState === 'error'
      ? '인용문을 복사하지 못했습니다'
      : '';

  return (
    <View style={styles.quoteFrame}>
      <EnrichedMarkdownText
        testID={`assistant-blockquote-content-${index}`}
        markdown={markdown}
        flavor="github"
        markdownStyle={markdownStyle}
        containerStyle={styles.quoteContent}
        selectable={false}
        onLinkPress={onLinkPress}
      />
      <Pressable
        testID={`blockquote-copy-button-${index}`}
        accessibilityRole="button"
        accessibilityLabel="인용문 복사"
        onPress={() => void copyQuote()}
        style={styles.copyButton}
      >
        <Ionicons
          testID={`blockquote-copy-icon-${index}`}
          name={copyState === 'success' ? 'checkmark' : 'copy-outline'}
          size={COPY_ICON_SIZE}
          color={iconColor}
          style={styles.copyIcon}
        />
      </Pressable>
      <Text
        testID={`blockquote-copy-feedback-${index}`}
        accessibilityLiveRegion="polite"
        style={styles.feedback}
      >
        {feedback}
      </Text>
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
    quoteFrame: {
      position: 'relative',
    },
    quoteContent: {
      paddingRight: DESIGN_HIT_TARGET.min,
    },
    copyButton: {
      position: 'absolute',
      top: 0,
      right: 0,
      width: DESIGN_HIT_TARGET.min,
      height: DESIGN_HIT_TARGET.min,
      alignItems: 'center',
      justifyContent: 'center',
    },
    copyIcon: {
      opacity: 0.75,
    },
    feedback: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
    },
  });
}
