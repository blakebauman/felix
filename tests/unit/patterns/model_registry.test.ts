/**
 * The model-provider registry is open: a deployment can register a new
 * provider name without editing `model.ts`. The three built-ins
 * (anthropic, openai, workers-ai) self-register on import.
 */

import '../../../src/patterns/model';

import { describe, expect, it } from 'vitest';
import {
  getModelProvider,
  listModelProviders,
  registerModelProvider,
} from '../../../src/patterns/model-registry';

describe('model provider registry', () => {
  it('exposes the three built-in providers', () => {
    expect(listModelProviders()).toEqual(
      expect.arrayContaining(['anthropic', 'openai', 'workers-ai']),
    );
  });

  it('accepts a new provider registration', () => {
    let constructed = false;
    registerModelProvider('fake-test-vendor', () => {
      constructed = true;
      return {
        modelId: 'fake',
        route: { provider: 'fake-test-vendor', model: 'fake' },
        async chat() {
          return {
            message: { role: 'assistant', content: 'fake' },
            stopReason: 'end_turn' as const,
          };
        },
        async *streamChat() {
          yield '';
          return {
            message: { role: 'assistant', content: 'fake' },
            stopReason: 'end_turn' as const,
          };
        },
      };
    });
    const factory = getModelProvider('fake-test-vendor');
    expect(factory).toBeDefined();
    expect(constructed).toBe(false);
  });

  it('returns undefined for an unknown provider', () => {
    expect(getModelProvider('not-real-name')).toBeUndefined();
  });
});
