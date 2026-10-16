import { describe, expect, it } from 'vitest';
import { canonicalJson, validateChatUiDocument } from '@soulstream/chat-ui';
import { reviewMessages } from './ChatUiReviewSample';
import { publishedSonnetEvent, publishedSolEvent, reviewDocuments } from './chat-ui-review-documents';

describe('chat ui review publications', () => {
  it.each([['sonnet', publishedSonnetEvent], ['sol', publishedSolEvent]] as const)('preserves the actual %s raw publication through processing and flattening', (name, raw) => {
    const messages = reviewMessages(name, 'rich', 'review-' + name);
    const msg = messages.find(msg => msg.ui)!;
    expect(msg.eventId).toBe(raw.id);
    expect(msg.ui).toBe(raw.payload.ui);
    expect(msg.content).toBe(raw.payload.content);
    expect(messages.filter(msg => msg.role === 'assistant')).toHaveLength(2);
    const result = validateChatUiDocument((msg.ui as typeof raw.payload.ui).document);
    expect(result.ok).toBe(true);
  });
  it.each(['pas', 'normal', 'gallery'] as const)('registers the approved %s document through a raw event', name => {
    const msg = reviewMessages(name, 'rich', 'review-' + name).find(msg => msg.ui)!;
    const result = validateChatUiDocument((msg.ui as { document: unknown }).document);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(canonicalJson(result.document)).toBe(canonicalJson(reviewDocuments[name]));
  });
  it('makes the failure samples differ at their real validation boundary', () => {
    const unsupported = reviewMessages('normal', 'unsupported', 'unsupported').find(msg => msg.ui)!.ui as { schema_version: number; document: unknown };
    expect(unsupported.schema_version).toBe(99);
    expect(validateChatUiDocument(unsupported.document).ok).toBe(true);
    const invalid = reviewMessages('normal', 'invalid', 'invalid').find(msg => msg.ui)!.ui as { document: unknown };
    expect(validateChatUiDocument(invalid.document).ok).toBe(false);
  });
});
