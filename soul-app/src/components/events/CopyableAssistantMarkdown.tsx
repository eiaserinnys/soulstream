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
import { chatImageSource } from '../../lib/chat-image-source';
import { segmentCardReportImages, type CardReportSegment } from '../../lib/card-report-images';
import { ChatRefinedImageGallery, getChatAttachmentFilename, useChatImageMetadata } from '../AttachmentImage';
import { createSessionVisualRoles, DESIGN_HIT_TARGET, useTokens } from '../../theme';
import { segmentMarkdownBlockquotes, type MarkdownBlockSegment } from './blockquoteCopyModel';

const COPY_FEEDBACK_MS = 1600;
const COPY_ICON_SIZE = 16;
type CopyState = 'idle' | 'success' | 'error';

interface Props {
  markdown: string;
  markdownStyle: MarkdownStyle;
  onLinkPress?: (event: { url: string }) => void;
  presentation?: 'default' | 'manuscript';
  serverUrl?: string;
  jwt?: string | null;
}

export function CopyableAssistantMarkdown({
  markdown,
  markdownStyle,
  onLinkPress,
  presentation = 'default',
  serverUrl = '',
  jwt = null,
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(), []);
  const segments = useMemo(
    () => presentation === 'manuscript' && serverUrl
      ? parseAssistantMarkdownImages(markdown)
      : segmentMarkdownBlockquotes(markdown),
    [markdown, presentation, serverUrl],
  );
  const galleryImages = useMemo(() => segments.flatMap((segment) => (
    segment.kind === 'images' ? segment.images.map((image) => ({
      source: chatImageSource(image.url, serverUrl, jwt),
      filename: getChatAttachmentFilename(image.url),
      alt: image.alt,
    })) : []
  )), [segments, serverUrl, jwt]);
  const galleryImagesWithMetadata = useChatImageMetadata(galleryImages, serverUrl);
  let quoteIndex = 0;
  let imageIndex = 0;

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

        if (segment.kind === 'images') {
          const startIndex = imageIndex;
          imageIndex += segment.images.length;
          return <ChatRefinedImageGallery
            key={`images-${segmentIndex}`}
            testID={`assistant-image-gallery-${segmentIndex}`}
            role="assistant"
            images={galleryImagesWithMetadata.slice(startIndex, imageIndex)}
            viewerImages={galleryImagesWithMetadata}
            startIndex={startIndex}
          />;
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

export type AssistantMarkdownImagePart =
  | MarkdownBlockSegment
  | { kind: 'images'; images: Array<{ alt: string; url: string }> };

/** Split only standalone image rows in ordinary assistant Markdown segments. */
export function parseAssistantMarkdownImages(markdown: string): AssistantMarkdownImagePart[] {
  const parts: AssistantMarkdownImagePart[] = [];
  for (const block of segmentMarkdownBlockquotes(markdown)) {
    if (block.kind === 'blockquote') {
      parts.push(block);
      continue;
    }
    appendMarkdownImageRuns(parts, segmentCardReportImages(block.markdown));
  }
  return parts;
}

function appendMarkdownImageRuns(
  target: AssistantMarkdownImagePart[],
  segments: CardReportSegment[],
) {
  let images: Array<{ alt: string; url: string }> = [];
  let whitespace = '';
  const flushImages = (appendWhitespace: boolean) => {
    if (images.length > 0) target.push({ kind: 'images', images });
    images = [];
    if (appendWhitespace && whitespace) target.push({ kind: 'markdown', markdown: whitespace });
    whitespace = '';
  };

  for (const segment of segments) {
    if (segment.kind === 'image') {
      images.push({ alt: segment.alt, url: segment.url });
      continue;
    }
    if (images.length > 0 && !segment.markdown.trim()) {
      whitespace += segment.markdown;
      continue;
    }
    flushImages(true);
    if (segment.markdown) target.push(segment);
  }
  flushImages(false);
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
