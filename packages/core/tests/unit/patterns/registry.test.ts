/**
 * The pattern registry is open: registering a name routes through
 * `getPattern` and the builder. Built-ins (`react`, `deep`, `router`,
 * `parallel`, `groupchat`) self-register on import. New patterns can be
 * added without touching `builder.ts`.
 *
 * The registry is a module-level singleton, so these tests share the
 * built-in registrations. Test-local pattern names (`echo`, `debate`)
 * never collide with the built-ins.
 */

// Side-effect imports populate the registry with the built-ins.
import '../../../src/patterns/deep';
import '../../../src/patterns/groupchat';
import '../../../src/patterns/parallel';
import '../../../src/patterns/react';
import '../../../src/patterns/router';

import { describe, expect, it } from 'vitest';
import {
  getPattern,
  getPatternDescriptor,
  isMultiAgentPattern,
  listPatterns,
  registerPattern,
} from '../../../src/patterns/registry';

describe('pattern registry', () => {
  it('exposes the five built-in patterns', () => {
    expect(listPatterns()).toEqual(
      expect.arrayContaining(['react', 'deep', 'router', 'parallel', 'groupchat']),
    );
  });

  it('classifies built-ins as single-agent vs multi-agent', () => {
    expect(isMultiAgentPattern('react')).toBe(false);
    expect(isMultiAgentPattern('deep')).toBe(false);
    expect(isMultiAgentPattern('router')).toBe(true);
    expect(isMultiAgentPattern('parallel')).toBe(true);
    expect(isMultiAgentPattern('groupchat')).toBe(true);
  });

  it('accepts a new pattern registration and routes through getPattern', () => {
    let called = false;
    registerPattern('echo-test-pattern', () => {
      called = true;
      return {
        tools: [],
        pattern: 'echo-test-pattern',
        manifestId: 'm',
        manifestVersion: '1.0.0',
        async invoke() {
          return { messages: [], final: { role: 'assistant', content: '' } };
        },
        async *streamEvents() {},
      };
    });
    const build = getPattern('echo-test-pattern');
    expect(build).toBeDefined();
    expect(getPatternDescriptor('echo-test-pattern')?.kind).toBe('single-agent');
    expect(called).toBe(false); // build is lazy until invoked
  });

  it('accepts kind: "multi-agent" and surfaces it through isMultiAgentPattern', () => {
    registerPattern(
      'debate-test-pattern',
      () => ({
        tools: [],
        pattern: 'debate-test-pattern',
        manifestId: 'm',
        manifestVersion: '1.0.0',
        async invoke() {
          return { messages: [], final: { role: 'assistant', content: '' } };
        },
        async *streamEvents() {},
      }),
      { kind: 'multi-agent' },
    );
    expect(isMultiAgentPattern('debate-test-pattern')).toBe(true);
  });

  it('returns undefined for an unknown name', () => {
    expect(getPattern('totally-fake-name')).toBeUndefined();
    expect(getPatternDescriptor('totally-fake-name')).toBeUndefined();
    expect(isMultiAgentPattern('totally-fake-name')).toBe(false);
  });
});
