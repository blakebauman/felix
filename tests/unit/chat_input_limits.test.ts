/**
 * Input-size caps on the public chat surfaces. Without `.max(...)` on the
 * message count and per-message content a single request could carry millions
 * of large messages (JSON-parse blowup, unbounded ConversationDO appends,
 * uncapped model spend) before the limits wrapper ever fires.
 */

import { describe, expect, it } from 'vitest';
import { ChatRequestSchema } from '../../src/api/chat';
import { ChatCompletionRequestSchema } from '../../src/api/openai-compat';
import { MAX_MESSAGE_CHARS, MAX_MESSAGES } from '../../src/api/openapi-shared';

const okMessage = { role: 'user' as const, content: 'hello' };

describe('POST /chat input caps', () => {
  it('accepts a normal payload', () => {
    const r = ChatRequestSchema.safeParse({ manifest: 'quick', messages: [okMessage] });
    expect(r.success).toBe(true);
  });

  it('rejects more than MAX_MESSAGES messages', () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, () => okMessage);
    const r = ChatRequestSchema.safeParse({ manifest: 'quick', messages });
    expect(r.success).toBe(false);
  });

  it('rejects a message whose content exceeds MAX_MESSAGE_CHARS', () => {
    const messages = [{ role: 'user' as const, content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }];
    const r = ChatRequestSchema.safeParse({ manifest: 'quick', messages });
    expect(r.success).toBe(false);
  });

  it('accepts content exactly at the cap', () => {
    const messages = [{ role: 'user' as const, content: 'x'.repeat(MAX_MESSAGE_CHARS) }];
    const r = ChatRequestSchema.safeParse({ manifest: 'quick', messages });
    expect(r.success).toBe(true);
  });
});

describe('POST /v1/chat/completions input caps', () => {
  it('accepts a normal payload', () => {
    const r = ChatCompletionRequestSchema.safeParse({ model: 'quick', messages: [okMessage] });
    expect(r.success).toBe(true);
  });

  it('rejects more than MAX_MESSAGES messages', () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, () => okMessage);
    const r = ChatCompletionRequestSchema.safeParse({ model: 'quick', messages });
    expect(r.success).toBe(false);
  });

  it('rejects oversized message content', () => {
    const messages = [{ role: 'user' as const, content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }];
    const r = ChatCompletionRequestSchema.safeParse({ model: 'quick', messages });
    expect(r.success).toBe(false);
  });
});
