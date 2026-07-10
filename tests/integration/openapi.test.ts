/**
 * OpenAPI + Scalar wiring.
 *
 * /openapi.json should return a valid OpenAPI 3 document listing the
 * documented public surface; /docs should serve the Scalar reference UI
 * as HTML. Both endpoints bypass rate-limit + manifest-auth gating so a
 * cold client can discover the API without credentials.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('OpenAPI spec', () => {
  it('serves /openapi.json with the documented public surface', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/openapi.json');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/application\/json/);
    const doc = (await resp.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
      tags?: Array<{ name: string }>;
    };
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.title).toBe('Felix');
    // Documented routes show up.
    expect(doc.paths['/health']).toBeDefined();
    expect(doc.paths['/.well-known/agent-card.json']).toBeDefined();
    expect(doc.paths['/v1/models']).toBeDefined();
    expect(doc.paths['/v1/chat/completions']).toBeDefined();
    // Components are reused (the .openapi(name) call promotes schemas).
    expect(doc.components?.schemas?.Health).toBeDefined();
    expect(doc.components?.schemas?.ChatCompletionRequest).toBeDefined();
  });

  // Completion gate: every public Felix route must be in the spec. When a
  // new router is added, document it here so /openapi.json stays exhaustive.
  it('documents every public path', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/openapi.json');
    const doc = (await resp.json()) as {
      paths: Record<string, Record<string, unknown>>;
      tags?: Array<{ name: string }>;
    };
    const expected = [
      '/health',
      '/.well-known/agent-card.json',
      '/v1/models',
      '/v1/chat/completions',
      '/chat',
      '/chat/stream',
      '/chat/history/{thread_id}',
      '/audit',
      '/audit/metrics',
      '/approvals',
      '/approvals/{id}',
      '/approvals/{id}/decide',
      '/plans',
      '/plans/{id}',
      '/jobs/list',
      '/jobs/{name}',
      '/jobs',
      '/jobs/run/{name}',
      '/manifests',
      '/manifests/{name}',
      '/manifests/{name}/versions',
      '/manifests/{name}/versions/{version}',
      '/manifests/{name}/activate',
      '/manifests/{name}/canary',
      '/manifests/{name}/rollback',
      '/eval/datasets',
      '/eval/datasets/{name}',
      '/eval/datasets/{name}/items',
      '/eval/datasets/{name}/run',
      '/eval/runs',
      '/eval/runs/{id}',
      '/a2a',
      '/mcp',
    ];
    for (const path of expected) {
      expect(doc.paths[path], `missing path ${path}`).toBeDefined();
    }
    // Internal back-channel routes are `hide: true` — they must NOT leak into
    // the public spec even though they're mounted.
    for (const hidden of Object.keys(doc.paths).filter((p) => p.startsWith('/internal'))) {
      throw new Error(`internal route leaked into spec: ${hidden}`);
    }
    // Tag taxonomy is in place for Scalar grouping.
    const tags = (doc.tags ?? []).map((t) => t.name);
    expect(tags).toEqual(
      expect.arrayContaining([
        'System',
        'OpenAI',
        'Threads',
        'A2A',
        'MCP',
        'Manifests',
        'Audit',
        'Approvals',
        'Plans',
        'Jobs',
        'Eval',
      ]),
    );
  });

  it('registers reusable domain schemas as components', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/openapi.json');
    const doc = (await resp.json()) as { components: { schemas: Record<string, unknown> } };
    // A sampling of schemas every router contributes.
    for (const name of [
      'AuditEvent',
      'ApprovalRequest',
      'ApprovalDecisionRequest',
      'Plan',
      'JobRecord',
      'JobCreateRequest',
      'Manifest',
      'ManifestCreateRequest',
      'ChatMessage',
      'ChatRequest',
      'A2ARequest',
      'McpRequest',
      'ErrorBody',
      // Manifest sub-schemas surfaced for self-serve authoring.
      'AgentSpec',
      'Pattern',
      'Model',
      'SystemPrompt',
      'Memory',
      'InboundAuth',
      'AuthRequirement',
      'Limits',
      'Guardrails',
      'Policy',
      'ApprovalRule',
      // SSE envelope shared by /chat/stream and A2A tasks/sendSubscribe.
      'StreamEvent',
    ]) {
      expect(doc.components.schemas[name], `missing component ${name}`).toBeDefined();
    }
  });

  it('serves a rich hero description and per-tag prose', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/openapi.json');
    const doc = (await resp.json()) as {
      info: {
        description: string;
        license?: { name: string; identifier?: string };
        termsOfService?: string;
        'x-logo'?: { url: string };
      };
      externalDocs?: { url: string };
      tags?: Array<{ name: string; description: string; externalDocs?: { url: string } }>;
    };
    // Hero is no longer a 1-paragraph blurb.
    expect(doc.info.description.length).toBeGreaterThan(1000);
    expect(doc.info.description).toMatch(/## Try it/);
    expect(doc.info.description).toMatch(/## Authentication/);
    expect(doc.info.description).toMatch(/## Read more/);
    // Branding wired in.
    expect(doc.info.license?.name).toBe('MIT');
    expect(doc.info.termsOfService).toBeDefined();
    expect(doc.info['x-logo']?.url).toMatch(/logo\.svg$/);
    expect(doc.externalDocs?.url).toBeDefined();
    // Every tag has a real description and an externalDocs link.
    const tags = doc.tags ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag.description.length, `tag ${tag.name} description is too short`).toBeGreaterThan(
        60,
      );
    }
    // The non-System tags carry external doc links.
    const namedTagsWithDocs = tags.filter((t) => t.name !== 'System' && t.externalDocs?.url);
    expect(namedTagsWithDocs.length).toBeGreaterThanOrEqual(8);
  });

  it('describes manifest schema fields inline so /docs is self-serve', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/openapi.json');
    const doc = (await resp.json()) as {
      components: {
        schemas: Record<
          string,
          { description?: string; properties?: Record<string, { description?: string }> }
        >;
      };
    };
    // Inline-primitive fields on AgentSpec carry their own descriptions.
    // (`pattern` / `limits` use named-component $ref; their prose lives
    // on the referenced component, not on the property.)
    const agentSpec = doc.components.schemas.AgentSpec;
    expect(agentSpec?.properties?.tools?.description).toBeTruthy();
    expect(agentSpec?.properties?.sub_agents?.description).toMatch(/router|parallel|groupchat/);
    expect(agentSpec?.properties?.aggregator_prompt?.description).toMatch(/parallel/);
    // Inline-primitive fields on Limits carry their own descriptions.
    const limits = doc.components.schemas.Limits;
    expect(limits?.properties?.max_tool_calls?.description).toMatch(/ceiling/i);
    expect(limits?.properties?.precount?.description).toMatch(/count_tokens/);
    // Manifest itself has a description and a worked example.
    const manifest = doc.components.schemas.Manifest as {
      description?: string;
      example?: unknown;
    };
    expect(manifest?.description).toBeTruthy();
    expect(manifest?.example).toBeTruthy();
  });
});

describe('Scalar docs UI', () => {
  it('serves /docs as HTML pointing at /openapi.json', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/docs');
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toMatch(/text\/html/);
    const html = await resp.text();
    // Scalar embeds the spec URL in its config script.
    expect(html).toMatch(/openapi\.json/);
  });
});
