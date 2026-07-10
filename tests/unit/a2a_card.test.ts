/**
 * Agent card discovery document — peers fetch this before deciding to
 * call us. Pins:
 *
 *   1. `capabilities` is sourced from `spec.a2a.capabilities` verbatim.
 *   2. `containers` lists every `spec.containers[]` entry by name +
 *      description + image. The gateway URL is intentionally absent —
 *      peers reach the container indirectly through our A2A surface,
 *      not by hitting the gateway themselves.
 *   3. Empty `containers` block renders as `[]` (not absent / undefined).
 */

import { describe, expect, it } from 'vitest';
import { buildAgentCard } from '../../src/a2a/card';
import { ManifestSchema } from '../../src/manifests/schema';

describe('buildAgentCard', () => {
  it('surfaces containers[] entries (name, description, image) and omits the gateway URL', () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'sandboxed', description: 'with sandboxes' },
      spec: {
        pattern: 'react',
        containers: [
          {
            name: 'python_runner',
            description: 'run python in a sandbox',
            gateway_url: 'https://container.example.com/run',
            image: 'py-sandbox:1',
          },
          {
            name: 'shell_runner',
            description: '',
            gateway_url: 'https://container.example.com/run',
            image: 'bash:5',
          },
        ],
      },
    });
    const card = buildAgentCard(manifest, {
      baseUrl: 'https://felix.example.com',
      mcpEnabled: true,
    });
    expect(card.containers).toEqual([
      { name: 'python_runner', description: 'run python in a sandbox', image: 'py-sandbox:1' },
      { name: 'shell_runner', description: '', image: 'bash:5' },
    ]);
    // The gateway URL must never leak — peers reach the container
    // through our A2A surface, not by hitting the gateway themselves.
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain('container.example.com');
  });

  it('renders an empty containers list when none are declared', () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'plain' },
      spec: { pattern: 'react' },
    });
    const card = buildAgentCard(manifest, {
      baseUrl: 'https://felix.example.com',
      mcpEnabled: false,
    });
    expect(card.containers).toEqual([]);
    expect(Array.isArray(card.containers)).toBe(true);
  });

  it('surfaces queues[] entries (name + description only) and omits queue_binding', () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'researcher' },
      spec: {
        pattern: 'react',
        queues: [
          {
            name: 'long_research',
            description: 'kick off a long research job',
            queue_binding: 'JOBS_QUEUE',
          },
          { name: 'compute', queue_binding: 'COMPUTE_QUEUE' },
        ],
      },
    });
    const card = buildAgentCard(manifest, {
      baseUrl: 'https://felix.example.com',
      mcpEnabled: false,
    });
    expect(card.queues).toEqual([
      { name: 'long_research', description: 'kick off a long research job' },
      { name: 'compute', description: '' },
    ]);
    // Binding names are internal infrastructure — they must not leak.
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain('JOBS_QUEUE');
    expect(serialized).not.toContain('COMPUTE_QUEUE');
  });

  it('renders an empty queues list when none are declared', () => {
    const manifest = ManifestSchema.parse({
      apiVersion: 'orchestrator/v1',
      kind: 'Agent',
      metadata: { name: 'plain' },
      spec: { pattern: 'react' },
    });
    const card = buildAgentCard(manifest, {
      baseUrl: 'https://felix.example.com',
      mcpEnabled: false,
    });
    expect(card.queues).toEqual([]);
    expect(Array.isArray(card.queues)).toBe(true);
  });
});
